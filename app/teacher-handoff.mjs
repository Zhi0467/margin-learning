import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";

const HANDOFF_DIRECTORY = ".margin-teacher-handoffs";
const HANDOFF_METADATA = "handoff.json";
const PARTIAL_COURSE_DIRECTORY = "partial-course";
const PREVIOUS_HANDOFF_DIRECTORY = "previous-handoff";
const HANDOFF_VERSION = 1;
const MAX_HANDOFF_DEPTH = 16;
const OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const REQUEST_HASH = /^[a-f0-9]{64}$/;
const HANDOFF_METADATA_LIMIT = 32 * 1024;
const INTERRUPTION_KINDS = new Set(["paused", "session-limit", "stalled", "crashed", "failed"]);
const ACTIONS = new Set(["create", "revise", "next"]);
const PROVIDERS = new Set(["claude", "codex"]);

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) throw new Error("Invalid teacher handoff id");
  return value;
}

function boundedText(value, limit = 4000) {
  const text = String(value || "").replace(/\0/g, "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function validateMetadata(value, operationId = "") {
  if (!value || value.version !== HANDOFF_VERSION
    || !OPERATION_ID.test(value.id || "")
    || (operationId && value.id !== operationId)
    || !ACTIONS.has(value.action)
    || !PROVIDERS.has(value.provider)
    || !INTERRUPTION_KINDS.has(value.kind)
    || !REQUEST_HASH.test(value.requestHash || "")
    || typeof value.createdAt !== "string"
    || typeof value.message !== "string"
    || typeof value.courseId !== "string"
    || typeof value.chapterId !== "string"
    || typeof value.lesson !== "string"
    || typeof value.title !== "string"
    || typeof value.initialRequest !== "string"
    || typeof value.hasPartialWork !== "boolean"
    || (value.sessionId && !SESSION_ID.test(value.sessionId))) {
    throw new Error("Invalid teacher handoff metadata");
  }
  return value;
}

async function regularDirectory(filename, label, { create = false } = {}) {
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
    await mkdir(filename, { mode: 0o700 });
    info = await lstat(filename);
  }
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(filename) !== filename) {
    throw new Error(`${label} must be a regular directory`);
  }
  return filename;
}

async function workspaceRoot(value) {
  const root = await realpath(path.resolve(value));
  await regularDirectory(root, "The teaching workspace");
  return root;
}

async function handoffArea(root, { create = false } = {}) {
  const directory = path.join(root, HANDOFF_DIRECTORY);
  try {
    return await regularDirectory(directory, "The teacher handoff area", { create });
  } catch (error) {
    if (!create && error?.code === "ENOENT") return "";
    throw error;
  }
}

function handoffRoot(root, operationId) {
  return path.join(root, HANDOFF_DIRECTORY, assertOperationId(operationId));
}

function publicHandoff(metadata, hasPartialWork = metadata.hasPartialWork) {
  return {
    id: metadata.id,
    action: metadata.action,
    provider: metadata.provider,
    kind: metadata.kind,
    sessionId: metadata.sessionId,
    courseId: metadata.courseId,
    chapterId: metadata.chapterId,
    lesson: metadata.lesson,
    title: metadata.title,
    initialRequest: metadata.initialRequest,
    message: metadata.message,
    createdAt: metadata.createdAt,
    hasPartialWork,
  };
}

export function classifyTeacherInterruption({
  provider,
  message = "",
  diagnostic = "",
  code = null,
  signal = "",
  stalled = false,
  requested = "",
} = {}) {
  const providerName = provider === "claude" ? "Claude Code" : "Codex";
  const detail = boundedText([message, diagnostic].filter(Boolean).join(" "), 2000);
  if (requested === "pause") {
    return { kind: "paused", message: `${providerName} was paused. Its checkpoint is ready to resume, switch, or abandon.` };
  }
  if (stalled) {
    return { kind: "stalled", message: `${providerName} stopped producing activity and was checkpointed so it would not block Margin.` };
  }
  const limitPattern = /(?:5[- ]hour|weekly|session|usage|rate)[ _-]?(?:limit|quota)|limit (?:has been )?reached|hit (?:your|the) limit|too many requests|rate_limit|status(?: code)?[: ]+429|\b429\b.*(?:limit|request)|resets? (?:at|in|on)/i;
  if (limitPattern.test(detail)) {
    return { kind: "session-limit", message: detail || `${providerName} reached its session limit.` };
  }
  if (signal || (Number.isInteger(code) && code !== 0)) {
    return { kind: "crashed", message: detail || `${providerName} exited unexpectedly${signal ? ` (${signal})` : ` with code ${code}`}.` };
  }
  return { kind: "failed", message: detail || `${providerName} stopped without completing the task.` };
}

export async function createTeacherHandoff(workspace, details, {
  partialCourseRoot = "",
  previousHandoffId = "",
} = {}) {
  const root = await workspaceRoot(workspace);
  const id = assertOperationId(details.operationId);
  const area = await handoffArea(root, { create: true });
  const destination = path.join(area, id);
  try {
    await lstat(destination);
    throw new Error("A teacher handoff already exists for this operation");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let source = "";
  if (partialCourseRoot) {
    source = await realpath(path.resolve(partialCourseRoot));
    if (!isWithin(root, source) || source === root) throw new Error("The partial teacher course is outside the teaching workspace");
    await regularDirectory(source, "The partial teacher course");
  }

  let previousRoot = "";
  if (previousHandoffId) {
    const previousId = assertOperationId(previousHandoffId);
    if (previousId === id) throw new Error("A teacher handoff cannot inherit itself");
    const previous = await readTeacherHandoff(root, previousId);
    if (!previous) throw new Error("The previous teacher handoff no longer exists");
    previousRoot = previous.root;
    if (source && (isWithin(source, previousRoot) || isWithin(previousRoot, source))) {
      throw new Error("The partial course and previous handoff overlap");
    }
  }

  const metadata = validateMetadata({
    version: HANDOFF_VERSION,
    id,
    action: details.action,
    provider: details.provider,
    kind: details.kind,
    sessionId: details.sessionId || "",
    requestHash: details.requestHash,
    courseId: details.courseId || "",
    chapterId: details.chapterId || "",
    lesson: details.lesson || "",
    title: boundedText(details.title, 200),
    initialRequest: boundedText(details.initialRequest, 16 * 1024),
    message: boundedText(details.message),
    createdAt: new Date().toISOString(),
    hasPartialWork: Boolean(source),
  }, id);

  const temporary = path.join(area, `.${id}-${randomUUID()}.tmp`);
  await mkdir(temporary, { mode: 0o700 });
  let movedSource = false;
  let movedPrevious = false;
  try {
    if (source) {
      await rename(source, path.join(temporary, PARTIAL_COURSE_DIRECTORY));
      movedSource = true;
    }
    if (previousRoot) {
      await rename(previousRoot, path.join(temporary, PREVIOUS_HANDOFF_DIRECTORY));
      movedPrevious = true;
    }
    await writeFile(path.join(temporary, HANDOFF_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    const restoreErrors = [];
    if (movedPrevious) {
      try {
        await rename(path.join(temporary, PREVIOUS_HANDOFF_DIRECTORY), previousRoot);
        movedPrevious = false;
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (movedSource) {
      try {
        await rename(path.join(temporary, PARTIAL_COURSE_DIRECTORY), source);
        movedSource = false;
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length) {
      throw new AggregateError(
        [error, ...restoreErrors],
        `Teacher handoff failed and preserved recovery data remains at ${temporary}`,
      );
    }
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return readTeacherHandoff(root, id);
}

async function readHandoffDirectory(directory, operationId = "", ancestry = new Set()) {
  if (ancestry.size >= MAX_HANDOFF_DEPTH) throw new Error("Teacher handoff history is too deep");
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
    throw new Error("Invalid teacher handoff directory");
  }
  const metadataFile = path.join(directory, HANDOFF_METADATA);
  const metadataInfo = await lstat(metadataFile);
  if (metadataInfo.isSymbolicLink() || !metadataInfo.isFile() || metadataInfo.size > HANDOFF_METADATA_LIMIT) {
    throw new Error("Invalid teacher handoff metadata file");
  }
  const metadata = validateMetadata(JSON.parse(await readFile(metadataFile, "utf8")), operationId);
  if (ancestry.has(metadata.id)) throw new Error("Teacher handoff history contains a cycle");
  const nextAncestry = new Set(ancestry).add(metadata.id);
  const partialRoot = path.join(directory, PARTIAL_COURSE_DIRECTORY);
  let partialInfo = null;
  try {
    partialInfo = await lstat(partialRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (metadata.hasPartialWork !== Boolean(partialInfo)) throw new Error("Teacher handoff partial-work state changed");
  if (partialInfo && (partialInfo.isSymbolicLink() || !partialInfo.isDirectory() || await realpath(partialRoot) !== partialRoot)) {
    throw new Error("Invalid teacher handoff partial course");
  }

  const previousRoot = path.join(directory, PREVIOUS_HANDOFF_DIRECTORY);
  let previous = null;
  let previousInfo = null;
  try {
    previousInfo = await lstat(previousRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (previousInfo) previous = await readHandoffDirectory(previousRoot, "", nextAncestry);
  if (previous && (
    previous.action !== metadata.action
    || previous.courseId !== metadata.courseId
    || previous.chapterId !== metadata.chapterId
    || previous.lesson !== metadata.lesson
    || (metadata.action === "create"
      && (previous.title !== metadata.title || previous.initialRequest !== metadata.initialRequest))
  )) {
    throw new Error("Teacher handoff history belongs to a different task");
  }
  const partialRoots = [
    ...(partialInfo ? [partialRoot] : []),
    ...(previous?.partialRoots || []),
  ];
  return {
    ...publicHandoff(metadata, partialRoots.length > 0),
    requestHash: metadata.requestHash,
    root: directory,
    partialRoot: partialInfo ? partialRoot : "",
    partialRoots,
  };
}

export async function readTeacherHandoff(workspace, operationId) {
  const root = await workspaceRoot(workspace);
  const area = await handoffArea(root);
  if (!area) return null;
  const directory = handoffRoot(root, operationId);
  try {
    await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return readHandoffDirectory(directory, operationId);
}

export async function discardTeacherHandoff(workspace, operationId) {
  const root = await workspaceRoot(workspace);
  const area = await handoffArea(root);
  if (!area) return false;
  const directory = handoffRoot(root, operationId);
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
    throw new Error("Invalid teacher handoff directory");
  }
  await rm(directory, { recursive: true, force: false });
  return true;
}

export function teacherHandoffPrompt(handoff) {
  if (!handoff) return "";
  const lines = [
    "",
    "## Previous teacher checkpoint",
    `A ${handoff.provider === "claude" ? "Claude Code" : "Codex"} attempt was interrupted (${handoff.kind}).`,
    "Margin restored the live course before starting this attempt.",
  ];
  const partialRoots = handoff.partialRoots?.length
    ? handoff.partialRoots
    : handoff.partialRoot ? [handoff.partialRoot] : [];
  if (partialRoots.length) {
    lines.push(
      "Partial filesystem work from this and any earlier attempts is preserved at:",
      ...partialRoots.map((root) => `- ${root}`),
      "Read and compare every listed partial course with the live selected course. Carry forward any sound unfinished work into the live course, but treat the checkpoints as read-only.",
    );
  } else {
    lines.push("No course files changed before the checkpoint; continue from the restored live course and the conversation context available to you.");
  }
  lines.push("Complete the original requested action and obey all of its exact validation constraints.");
  return lines.join("\n");
}

export const teacherHandoffPaths = Object.freeze({
  directory: HANDOFF_DIRECTORY,
  metadata: HANDOFF_METADATA,
  partialCourse: PARTIAL_COURSE_DIRECTORY,
  previousHandoff: PREVIOUS_HANDOFF_DIRECTORY,
});
