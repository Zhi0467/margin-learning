import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { acquireLibraryLock, LIBRARY_LOCK_FILENAME } from "../library-lock.mjs";

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), "margin-library-lock-test-"));
  const root = path.join(parent, "library");
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, lockPath: path.join(root, LIBRARY_LOCK_FILENAME) };
}

async function waitForLine(stream, expected) {
  let text = "";
  for await (const chunk of stream) {
    text += chunk.toString("utf8");
    if (text.includes(expected)) return;
  }
  throw new Error(`Child exited before writing ${expected}`);
}

function runContender(root, moduleUrl, { env = {} } = {}) {
  const script = `
    import { acquireLibraryLock } from ${JSON.stringify(moduleUrl)};
    try {
      const lock = await acquireLibraryLock(${JSON.stringify(root)});
      process.stdout.write("ACQUIRED\\n");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await lock.release();
    } catch (error) {
      process.stdout.write(String(error.code || error.message) + "\\n");
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `Lock contender exited with code ${code}`));
    });
  });
}

test("holds one lock across canonical and symlinked library paths", async (t) => {
  const { parent, root } = await fixture(t);
  const alias = path.join(parent, "library-alias");
  await symlink(root, alias, "dir");

  const first = await acquireLibraryLock(alias);
  assert.equal(first.libraryPath, await realpath(root));
  await assert.rejects(
    acquireLibraryLock(root),
    (error) => error?.code === "MARGIN_LIBRARY_LOCKED" && error.message.includes(String(process.pid)),
  );
  assert.equal(await first.release(), true);

  const second = await acquireLibraryLock(root);
  assert.equal(await second.release(), true);
});

test("honors a live lock when process inspection returns no command", async (t) => {
  const { parent, root } = await fixture(t);
  const fakeBin = path.join(parent, "fake-bin");
  await mkdir(fakeBin);
  await writeFile(path.join(fakeBin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../library-lock.mjs")).href;
  const first = await acquireLibraryLock(root);

  try {
    assert.equal(
      await runContender(root, moduleUrl, { env: { PATH: fakeBin } }),
      "MARGIN_LIBRARY_LOCKED",
    );
  } finally {
    await first.release();
  }
});

test("recovers a valid lock after its owner process dies", async (t) => {
  const { root } = await fixture(t);
  const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../library-lock.mjs")).href;
  const script = `
    import { acquireLibraryLock } from ${JSON.stringify(moduleUrl)};
    await acquireLibraryLock(${JSON.stringify(root)});
    process.stdout.write("LOCKED\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });
  await waitForLine(child.stdout, "LOCKED\n");

  await assert.rejects(acquireLibraryLock(root), { code: "MARGIN_LIBRARY_LOCKED" });
  child.kill("SIGKILL");
  await once(child, "close");

  const recovered = await acquireLibraryLock(root);
  assert.equal(await recovered.release(), true);
});

test("simultaneous stale-lock recovery admits only one backend", async (t) => {
  const { root, lockPath } = await fixture(t);
  const canonicalRoot = await realpath(root);
  const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../library-lock.mjs")).href;
  const formerOwner = spawn(process.execPath, ["--eval", ""], { stdio: "ignore" });
  const deadPid = formerOwner.pid;
  await once(formerOwner, "close");
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: deadPid,
    token: "00000000-0000-4000-8000-000000000000",
    libraryPath: canonicalRoot,
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });

  const outcomes = await Promise.all([runContender(root, moduleUrl), runContender(root, moduleUrl)]);
  assert.deepEqual(outcomes.sort(), ["ACQUIRED", "MARGIN_LIBRARY_LOCKED"]);
});

test("leaves symbolic-link and non-regular lock paths untouched", async (t) => {
  const symbolic = await fixture(t);
  const target = path.join(symbolic.parent, "do-not-touch.txt");
  await writeFile(target, "keep me", "utf8");
  await symlink(target, symbolic.lockPath);

  await assert.rejects(acquireLibraryLock(symbolic.root), { code: "MARGIN_LIBRARY_LOCK_UNSAFE" });
  assert.equal(await readFile(target, "utf8"), "keep me");

  const nonRegular = await fixture(t);
  await mkdir(nonRegular.lockPath);
  await assert.rejects(acquireLibraryLock(nonRegular.root), { code: "MARGIN_LIBRARY_LOCK_UNSAFE" });
});

test("release does not remove a lock it no longer owns", async (t) => {
  const { root, lockPath } = await fixture(t);
  const lock = await acquireLibraryLock(root);
  await rm(lockPath);
  const replacement = `${JSON.stringify({
    version: 1,
    pid: process.pid,
    token: "00000000-0000-4000-8000-000000000000",
    libraryPath: lock.libraryPath,
    createdAt: new Date().toISOString(),
  })}\n`;
  await writeFile(lockPath, replacement, { mode: 0o600 });

  assert.equal(await lock.release(), false);
  assert.equal(await readFile(lockPath, "utf8"), replacement);
});

test("does not reclaim malformed regular lock files", async (t) => {
  const { root, lockPath } = await fixture(t);
  await writeFile(lockPath, "not owner metadata\n", { mode: 0o600 });

  await assert.rejects(acquireLibraryLock(root), { code: "MARGIN_LIBRARY_LOCK_UNSAFE" });
  assert.equal(await readFile(lockPath, "utf8"), "not owner metadata\n");
});
