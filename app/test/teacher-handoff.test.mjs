import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  classifyTeacherInterruption,
  createTeacherHandoff,
  discardTeacherHandoff,
  readTeacherHandoff,
  teacherHandoffPrompt,
} from "../teacher-handoff.mjs";

test("classifies learner pauses, session limits, stalls, and crashes separately", () => {
  assert.equal(classifyTeacherInterruption({ provider: "claude", requested: "pause" }).kind, "paused");
  assert.equal(classifyTeacherInterruption({
    provider: "claude",
    message: "You have hit your usage limit · resets at 5pm",
    code: 1,
  }).kind, "session-limit");
  assert.equal(classifyTeacherInterruption({ provider: "codex", stalled: true }).kind, "stalled");
  assert.equal(classifyTeacherInterruption({
    provider: "codex",
    stalled: true,
    diagnostic: "An earlier request mentioned a rate limit",
  }).kind, "stalled");
  assert.equal(classifyTeacherInterruption({ provider: "codex", signal: "SIGKILL" }).kind, "crashed");
  assert.equal(classifyTeacherInterruption({ provider: "codex", message: "Validation failed" }).kind, "failed");
});

test("moves partial course work into a durable handoff and discards it explicitly", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "margin-handoff-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const partial = path.join(workspace, ".partial-course");
  await mkdir(path.join(partial, "lessons"), { recursive: true });
  await writeFile(path.join(partial, "lessons", "0001-draft.html"), "<h1>Partial draft</h1>");
  const operationId = "handoff-test-1";
  const sessionId = "12345678-1234-4123-8123-123456789abc";

  const created = await createTeacherHandoff(workspace, {
    operationId,
    action: "revise",
    provider: "claude",
    kind: "stalled",
    sessionId,
    requestHash: "a".repeat(64),
    courseId: "systems",
    chapterId: "foundations",
    lesson: "lessons/0001-draft.html",
    message: "Claude Code stopped producing activity.",
  }, { partialCourseRoot: partial });
  assert.equal(created.id, operationId);
  assert.equal(created.hasPartialWork, true);
  await assert.rejects(lstat(partial), { code: "ENOENT" });

  const handoff = await readTeacherHandoff(workspace, operationId);
  assert.equal(handoff.sessionId, sessionId);
  assert.equal(await readFile(path.join(handoff.partialRoot, "lessons", "0001-draft.html"), "utf8"), "<h1>Partial draft</h1>");
  assert.match(teacherHandoffPrompt(handoff), /Read and compare every listed partial course with the live selected course/);
  assert.match(teacherHandoffPrompt(handoff), new RegExp(handoff.partialRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(await discardTeacherHandoff(workspace, operationId), true);
  assert.equal(await readTeacherHandoff(workspace, operationId), null);
  assert.equal(await discardTeacherHandoff(workspace, operationId), false);
});

test("a failed recovery nests its previous file checkpoint until success or abandon", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "margin-handoff-chain-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const firstPartial = path.join(workspace, ".first-partial");
  const secondPartial = path.join(workspace, ".second-partial");
  await mkdir(firstPartial);
  await mkdir(secondPartial);
  await writeFile(path.join(firstPartial, "first.txt"), "first teacher");
  await writeFile(path.join(secondPartial, "second.txt"), "second teacher");

  const common = {
    action: "revise",
    requestHash: "b".repeat(64),
    courseId: "systems",
    chapterId: "foundations",
    lesson: "lessons/0001-draft.html",
  };
  const firstId = "handoff-chain-1";
  const secondId = "handoff-chain-2";
  await createTeacherHandoff(workspace, {
    ...common,
    operationId: firstId,
    provider: "codex",
    kind: "session-limit",
    message: "Codex reached its limit.",
  }, { partialCourseRoot: firstPartial });
  const second = await createTeacherHandoff(workspace, {
    ...common,
    operationId: secondId,
    provider: "claude",
    kind: "crashed",
    message: "Claude Code stopped unexpectedly.",
  }, {
    partialCourseRoot: secondPartial,
    previousHandoffId: firstId,
  });

  assert.equal(await readTeacherHandoff(workspace, firstId), null);
  assert.equal(second.hasPartialWork, true);
  assert.equal(second.partialRoots.length, 2);
  assert.equal(await readFile(path.join(second.partialRoots[0], "second.txt"), "utf8"), "second teacher");
  assert.equal(await readFile(path.join(second.partialRoots[1], "first.txt"), "utf8"), "first teacher");
  const prompt = teacherHandoffPrompt(second);
  assert.match(prompt, new RegExp(second.partialRoots[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, new RegExp(second.partialRoots[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(await discardTeacherHandoff(workspace, secondId), true);
  assert.equal(await readTeacherHandoff(workspace, secondId), null);
});
