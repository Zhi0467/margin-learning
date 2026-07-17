import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  findLectureOperation,
  readLectureHistory,
  recordLectureVersion,
} from "../lib.mjs";

const LESSON = "lessons/0001-start.html";
const OTHER_LESSON = "lessons/0002-follow-up.html";

function requestHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "margin-operation-history-"));
  const course = path.join(root, "course");
  await mkdir(path.join(course, "lessons"), { recursive: true });
  await writeFile(path.join(course, LESSON), "<h1>First lecture</h1>\n", "utf8");
  await writeFile(path.join(course, OTHER_LESSON), "<h1>Second lecture</h1>\n", "utf8");
  return { root, course };
}

async function readLedger(course) {
  return JSON.parse(await readFile(path.join(course, ".learn", "lecture-history.json"), "utf8"));
}

async function writeLedger(course, ledger) {
  await writeFile(path.join(course, ".learn", "lecture-history.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

test("persists and reloads a receipt when teacher output leaves lecture content unchanged", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const seeded = await readLectureHistory(course, LESSON);
  const baseline = seeded.lectures[0].current;
  assert.equal(baseline.version, 1);
  assert.equal(Object.hasOwn(baseline, "operationId"), false);
  assert.equal(Object.hasOwn(baseline, "requestHash"), false);
  assert.equal(Object.hasOwn(baseline, "operationAction"), false);

  const operationId = "op_12345678";
  const hash = requestHash("revise the examples");
  const recorded = await recordLectureVersion(course, LESSON, {
    action: "revise",
    provider: "codex",
    operationId,
    operationAction: "revise",
    requestHash: hash,
  });

  assert.equal(recorded.version, 2);
  assert.equal(recorded.parent, baseline.id);
  assert.equal(recorded.hash, baseline.hash);
  assert.equal(recorded.operationId, operationId);
  assert.equal(recorded.operationAction, "revise");
  assert.equal(recorded.requestHash, hash);

  const found = await findLectureOperation(course, operationId);
  assert.equal(found.lesson, LESSON);
  assert.deepEqual(found.commit, recorded);

  const replayed = await recordLectureVersion(course, LESSON, {
    action: "revise",
    provider: "codex",
    operationId,
    operationAction: "revise",
    requestHash: hash,
  });
  assert.deepEqual(replayed, recorded);

  const reloaded = await readLectureHistory(course, LESSON);
  assert.equal(reloaded.lectures[0].commits.length, 2);
  assert.equal(reloaded.lectures[0].current.id, recorded.id);
  assert.equal(await findLectureOperation(course, "unknown_operation"), null);
});

test("rejects invalid teacher operation metadata before changing history", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await readLectureHistory(course, LESSON);
  const before = await readFile(path.join(course, ".learn", "lecture-history.json"));

  for (const operationId of ["short", "has a space", "unsafe/slash", "unsafe.dot", "op_éabcdef", `a${"b".repeat(128)}`]) {
    await assert.rejects(
      recordLectureVersion(course, LESSON, { operationId, operationAction: "revise" }),
      /Invalid teacher operation id/,
    );
  }
  for (const hash of ["a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`]) {
    await assert.rejects(recordLectureVersion(course, LESSON, { requestHash: hash }), /Invalid teacher request hash/);
  }
  await assert.rejects(
    recordLectureVersion(course, LESSON, { operationId: "op_12345678" }),
    /id, action, and request hash must be provided together/,
  );
  await assert.rejects(
    recordLectureVersion(course, LESSON, { operationAction: "revise" }),
    /id, action, and request hash must be provided together/,
  );
  await assert.rejects(
    recordLectureVersion(course, LESSON, { requestHash: requestHash("orphaned") }),
    /id, action, and request hash must be provided together/,
  );
  await assert.rejects(
    recordLectureVersion(course, LESSON, { operationId: "op_12345678", operationAction: "restore" }),
    /Invalid teacher operation action/,
  );
  await assert.rejects(findLectureOperation(course, "bad/id/value"), /Invalid teacher operation id/);

  assert.deepEqual(await readFile(path.join(course, ".learn", "lecture-history.json")), before);
});

test("makes operation replay idempotent and rejects receipt mismatches", async (t) => {
  const { root, course } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await readLectureHistory(course);

  const operationId = "operation_abcdef";
  const hash = requestHash("first request");
  const recorded = await recordLectureVersion(course, LESSON, {
    operationId,
    operationAction: "revise",
    requestHash: hash,
  });

  await assert.rejects(
    recordLectureVersion(course, LESSON, {
      operationId,
      operationAction: "revise",
      requestHash: requestHash("different request"),
    }),
    /receipt does not match this request/,
  );
  await assert.rejects(
    recordLectureVersion(course, LESSON, {
      operationId,
      operationAction: "next",
      requestHash: hash,
    }),
    /receipt does not match this request/,
  );
  await assert.rejects(
    recordLectureVersion(course, OTHER_LESSON, {
      operationId,
      operationAction: "revise",
      requestHash: hash,
    }),
    /receipt does not match this request/,
  );

  const history = await readLectureHistory(course, LESSON);
  assert.equal(history.lectures[0].commits.filter((commit) => commit.operationId === operationId).length, 1);
  assert.equal(history.lectures[0].current.id, recorded.id);
});

test("rejects malformed and duplicate operation receipts stored in the ledger", async (t) => {
  await t.test("malformed operation id", async () => {
    const { root, course } = await fixture();
    try {
      await readLectureHistory(course, LESSON);
      const ledger = await readLedger(course);
      ledger.lectures[LESSON].commits[0].operationId = "bad id";
      ledger.lectures[LESSON].commits[0].operationAction = "revise";
      await writeLedger(course, ledger);
      await assert.rejects(findLectureOperation(course, "op_12345678"), /Invalid lecture history/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("malformed request hash", async () => {
    const { root, course } = await fixture();
    try {
      await readLectureHistory(course, LESSON);
      const ledger = await readLedger(course);
      ledger.lectures[LESSON].commits[0].requestHash = "A".repeat(64);
      await writeLedger(course, ledger);
      await assert.rejects(readLectureHistory(course, LESSON), /Invalid lecture history/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("invalid operation action", async () => {
    const { root, course } = await fixture();
    try {
      await readLectureHistory(course, LESSON);
      const ledger = await readLedger(course);
      ledger.lectures[LESSON].commits[0].operationId = "op_12345678";
      ledger.lectures[LESSON].commits[0].operationAction = "restore";
      await writeLedger(course, ledger);
      await assert.rejects(readLectureHistory(course, LESSON), /Invalid lecture history/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("operation action without an operation id", async () => {
    const { root, course } = await fixture();
    try {
      await readLectureHistory(course, LESSON);
      const ledger = await readLedger(course);
      ledger.lectures[LESSON].commits[0].operationAction = "revise";
      await writeLedger(course, ledger);
      await assert.rejects(readLectureHistory(course, LESSON), /Invalid lecture history/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("duplicate operation ids", async () => {
    const { root, course } = await fixture();
    try {
      await readLectureHistory(course, LESSON);
      const firstId = "operation_first";
      await recordLectureVersion(course, LESSON, {
        operationId: firstId,
        operationAction: "revise",
        requestHash: requestHash("first"),
      });
      await writeFile(path.join(course, LESSON), "<h1>Changed lecture</h1>\n", "utf8");
      await recordLectureVersion(course, LESSON, {
        operationId: "operation_second",
        operationAction: "revise",
        requestHash: requestHash("second"),
      });
      const ledger = await readLedger(course);
      ledger.lectures[LESSON].commits.at(-1).operationId = firstId;
      await writeLedger(course, ledger);
      await assert.rejects(findLectureOperation(course, firstId), /Invalid lecture history/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
