import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  beginCourseTransaction,
  commitCourseTransaction,
  courseTransactionPaths,
  recoverCourseTransactions,
  rollbackCourseTransaction,
} from "../course-transaction.mjs";

async function createFixture(t, courseId = "test-course") {
  const parent = await mkdtemp(path.join(tmpdir(), "margin-course-transaction-test-"));
  const workspaceRoot = path.join(parent, "workspace");
  const courseRoot = path.join(workspaceRoot, courseId);
  await mkdir(path.join(courseRoot, "lessons"), { recursive: true });
  await mkdir(path.join(courseRoot, "assets"));
  await mkdir(path.join(courseRoot, "references"));
  await mkdir(path.join(courseRoot, "learning-records"));
  await mkdir(path.join(courseRoot, ".learn"));
  await writeFile(path.join(courseRoot, "MISSION.md"), "# Learn transactions\n", "utf8");
  await writeFile(path.join(courseRoot, "COURSE.json"), `${JSON.stringify({ title: "Transactions" })}\n`, "utf8");
  await writeFile(path.join(courseRoot, "lessons", "01.md"), "# Original lesson\n", "utf8");
  await writeFile(path.join(courseRoot, "assets", "diagram.txt"), "original diagram\n", "utf8");
  await writeFile(path.join(courseRoot, "references", "source.md"), "original source\n", "utf8");
  await writeFile(path.join(courseRoot, "learning-records", "progress.json"), "{\"score\":1}\n", "utf8");
  await writeFile(path.join(courseRoot, ".learn", "annotations.json"), "[]\n", "utf8");
  await writeFile(path.join(courseRoot, "vocabulary.json"), "{\"term\":\"original\"}\n", "utf8");
  await writeFile(path.join(courseRoot, "tool.mjs"), "export const value = 1;\n", "utf8");
  await symlink("../assets/diagram.txt", path.join(courseRoot, "references", "latest-diagram"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, workspaceRoot, courseRoot, courseId };
}

async function treeManifest(root) {
  const result = [];
  const walk = async (directory, relativeDirectory = "") => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const filename = path.join(directory, entry.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) {
        result.push([relative, "link", await readlink(filename)]);
      } else if (info.isDirectory()) {
        result.push([relative, "directory"]);
        await walk(filename, relative);
      } else if (info.isFile()) {
        const digest = createHash("sha256").update(await readFile(filename)).digest("hex");
        result.push([relative, "file", info.size, digest]);
      } else {
        result.push([relative, "special"]);
      }
    }
  };
  await walk(root);
  return result;
}

async function transactionEntries(workspaceRoot) {
  return readdir(path.join(workspaceRoot, courseTransactionPaths.directory));
}

test("rollback restores every course artifact and preserves internal symbolic links", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.parent, "outside.txt");
  await writeFile(outside, "do not touch\n", "utf8");
  const before = await treeManifest(fixture.courseRoot);

  const transaction = await beginCourseTransaction(
    fixture.workspaceRoot,
    fixture.courseId,
    fixture.courseRoot,
  );
  assert.equal(
    await readFile(path.join(transaction.transactionRoot, courseTransactionPaths.snapshot, "vocabulary.json"), "utf8"),
    "{\"term\":\"original\"}\n",
  );

  await writeFile(path.join(fixture.courseRoot, "lessons", "01.md"), "# Partial new lesson\n", "utf8");
  await writeFile(path.join(fixture.courseRoot, "COURSE.json"), "{\"title\":\"partial\"}\n", "utf8");
  await writeFile(path.join(fixture.courseRoot, ".learn", "annotations.json"), "[{\"used\":true}]\n", "utf8");
  await writeFile(path.join(fixture.courseRoot, "vocabulary.json"), "{\"term\":\"partial\"}\n", "utf8");
  await rm(path.join(fixture.courseRoot, "assets"), { recursive: true });
  await mkdir(path.join(fixture.courseRoot, "notes"));
  await writeFile(path.join(fixture.courseRoot, "notes", "partial.md"), "partial\n", "utf8");
  await rm(path.join(fixture.courseRoot, "references", "latest-diagram"));
  await symlink(outside, path.join(fixture.courseRoot, "references", "latest-diagram"));

  assert.deepEqual(await rollbackCourseTransaction(transaction), { restored: true, cleanupPending: false });
  assert.deepEqual(await treeManifest(fixture.courseRoot), before);
  assert.equal(await readFile(outside, "utf8"), "do not touch\n");
  assert.deepEqual(await transactionEntries(fixture.workspaceRoot), []);
});

test("startup recovery rolls back a pending transaction", async (t) => {
  const fixture = await createFixture(t);
  const before = await treeManifest(fixture.courseRoot);
  await beginCourseTransaction(fixture.workspaceRoot, fixture.courseId);

  await writeFile(path.join(fixture.courseRoot, "references", "source.md"), "partial source\n", "utf8");
  await rm(path.join(fixture.courseRoot, "learning-records"), { recursive: true });
  await writeFile(path.join(fixture.courseRoot, "new-supporting-artifact.json"), "{}\n", "utf8");

  const recovery = await recoverCourseTransactions(fixture.workspaceRoot);
  assert.deepEqual(recovery, { restored: [fixture.courseId], cleaned: [] });
  assert.deepEqual(await treeManifest(fixture.courseRoot), before);
  assert.deepEqual(await transactionEntries(fixture.workspaceRoot), []);
});

test("committed transactions retain changes and are cleaned during startup recovery", async (t) => {
  const fixture = await createFixture(t);
  const transaction = await beginCourseTransaction(fixture.workspaceRoot, fixture.courseId);
  await writeFile(path.join(fixture.courseRoot, "vocabulary.json"), "{\"term\":\"committed\"}\n", "utf8");
  await writeFile(path.join(fixture.courseRoot, "lessons", "02.md"), "# Committed lesson\n", "utf8");

  assert.deepEqual(
    await commitCourseTransaction(transaction, { cleanup: false }),
    { committed: true, cleanupPending: true },
  );
  const metadata = JSON.parse(await readFile(
    path.join(transaction.transactionRoot, courseTransactionPaths.metadata),
    "utf8",
  ));
  assert.equal(metadata.state, "committed");

  const recovery = await recoverCourseTransactions(fixture.workspaceRoot);
  assert.deepEqual(recovery, { restored: [], cleaned: [transaction.id] });
  assert.equal(
    await readFile(path.join(fixture.courseRoot, "vocabulary.json"), "utf8"),
    "{\"term\":\"committed\"}\n",
  );
  assert.equal(await readFile(path.join(fixture.courseRoot, "lessons", "02.md"), "utf8"), "# Committed lesson\n");
  assert.deepEqual(await transactionEntries(fixture.workspaceRoot), []);
});

test("rejects a course snapshot containing a symbolic link outside the course", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.parent, "outside.txt");
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, path.join(fixture.courseRoot, "references", "outside"));

  await assert.rejects(
    beginCourseTransaction(fixture.workspaceRoot, fixture.courseId),
    /symbolic link points outside the course/,
  );
  assert.equal(await readFile(outside, "utf8"), "outside\n");
  assert.deepEqual(await transactionEntries(fixture.workspaceRoot), []);
});

test("an interrupted rollback remains recoverable after both immediate renames fail", async (t) => {
  const fixture = await createFixture(t);
  const before = await treeManifest(fixture.courseRoot);
  const transaction = await beginCourseTransaction(fixture.workspaceRoot, fixture.courseId);
  await writeFile(path.join(fixture.courseRoot, "vocabulary.json"), "partial\n", "utf8");

  let call = 0;
  const injectedRename = async (from, to) => {
    call += 1;
    if (call === 1) return rename(from, to);
    const error = new Error(`injected rename failure ${call}`);
    error.code = "EIO";
    throw error;
  };
  await assert.rejects(
    rollbackCourseTransaction(transaction, { renameEntry: injectedRename }),
    /could not restore either snapshot or live course/,
  );
  await assert.rejects(lstat(fixture.courseRoot), { code: "ENOENT" });
  assert.ok((await lstat(path.join(transaction.transactionRoot, courseTransactionPaths.snapshot))).isDirectory());
  assert.ok((await lstat(path.join(transaction.transactionRoot, courseTransactionPaths.failedCourse))).isDirectory());

  const recovery = await recoverCourseTransactions(fixture.workspaceRoot);
  assert.deepEqual(recovery, { restored: [fixture.courseId], cleaned: [] });
  assert.deepEqual(await treeManifest(fixture.courseRoot), before);
  assert.deepEqual(await transactionEntries(fixture.workspaceRoot), []);
});
