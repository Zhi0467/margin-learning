import path from "node:path";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";

const TRANSACTION_DIRECTORY = ".margin-course-transactions";
const METADATA_FILE = "transaction.json";
const SNAPSHOT_DIRECTORY = "snapshot";
const FAILED_COURSE_DIRECTORY = "failed-course";
const TRANSACTION_VERSION = 1;
const COURSE_ID = /^[a-zA-Z0-9_-]+$/;
const TRANSACTION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STATES = new Set(["preparing", "pending", "committed", "rolled-back"]);
const METADATA_LIMIT = 16 * 1024;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertCourseId(courseId) {
  if (typeof courseId !== "string" || !COURSE_ID.test(courseId)) throw new Error("Invalid course transaction id");
  return courseId;
}

function assertTransactionId(transactionId) {
  if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) {
    throw new Error("Invalid course transaction identifier");
  }
  return transactionId;
}

async function pathInfo(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function directoryIdentity(filename, label) {
  const info = await lstat(filename, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a regular directory`);
  return { device: info.dev.toString(), inode: info.ino.toString() };
}

function identityMatches(actual, expected) {
  return Boolean(actual && expected && actual.device === expected.device && actual.inode === expected.inode);
}

async function canonicalWorkspaceRoot(workspaceRoot) {
  const resolved = await realpath(path.resolve(workspaceRoot));
  await directoryIdentity(resolved, "The teaching workspace");
  return resolved;
}

async function transactionArea(workspaceRoot, { create = true } = {}) {
  const area = path.join(workspaceRoot, TRANSACTION_DIRECTORY);
  let info = await pathInfo(area);
  if (!info && !create) return "";
  if (!info) {
    await mkdir(area, { mode: 0o700 });
    info = await lstat(area);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("The course transaction area must be a regular directory");
  }
  const [workspaceIdentity, areaIdentity] = await Promise.all([
    directoryIdentity(workspaceRoot, "The teaching workspace"),
    directoryIdentity(area, "The course transaction area"),
  ]);
  if (workspaceIdentity.device !== areaIdentity.device) {
    throw new Error("The course transaction area must be on the same filesystem as the teaching workspace");
  }
  return area;
}

function metadataPath(transactionRoot) {
  return path.join(transactionRoot, METADATA_FILE);
}

async function writeMetadata(transactionRoot, metadata) {
  const temporary = path.join(transactionRoot, `.transaction-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, metadataPath(transactionRoot));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validateMetadata(parsed, transactionId = "") {
  if (parsed?.version !== TRANSACTION_VERSION
    || !TRANSACTION_ID.test(parsed.id || "")
    || (transactionId && parsed.id !== transactionId)
    || !COURSE_ID.test(parsed.courseId || "")
    || !STATES.has(parsed.state)
    || typeof parsed.createdAt !== "string") {
    throw new Error("Invalid course transaction metadata");
  }
  if (parsed.state !== "preparing") {
    if (typeof parsed.snapshotIdentity?.device !== "string" || typeof parsed.snapshotIdentity?.inode !== "string") {
      throw new Error("Invalid course transaction snapshot identity");
    }
  }
  return parsed;
}

async function readMetadata(transactionRoot, transactionId = "") {
  const filename = metadataPath(transactionRoot);
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile() || info.size > METADATA_LIMIT) {
    throw new Error("Invalid course transaction metadata file");
  }
  return validateMetadata(JSON.parse(await readFile(filename, "utf8")), transactionId);
}

async function validateSymlink(filename, relative, physicalRoot, logicalRoot) {
  const target = await readlink(filename);
  const logicalLink = path.join(logicalRoot, relative);
  const pointed = path.isAbsolute(target)
    ? path.normalize(target)
    : path.resolve(path.dirname(logicalLink), target);
  if (!isWithin(logicalRoot, pointed)) {
    throw new Error(`Course symbolic link points outside the course: ${relative}`);
  }

  try {
    const resolved = await realpath(filename);
    if (!isWithin(physicalRoot, resolved) && !isWithin(logicalRoot, resolved)) {
      throw new Error(`Course symbolic link resolves outside the course: ${relative}`);
    }
  } catch (error) {
    // A broken link whose textual target remains inside the course is safe to
    // preserve. Other resolution failures (including loops) are not.
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

async function inspectCourseTree(physicalRoot, logicalRoot = physicalRoot) {
  const links = new Map();
  const walk = async (directory, relativeDirectory = "") => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const filename = path.join(directory, entry.name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) {
        links.set(relative, await validateSymlink(filename, relative, physicalRoot, logicalRoot));
      } else if (info.isDirectory()) {
        await walk(filename, relative);
      } else if (!info.isFile()) {
        throw new Error(`Unsupported course filesystem entry: ${relative}`);
      }
    }
  };
  await walk(physicalRoot);
  return links;
}

function sameLinks(left, right) {
  if (left.size !== right.size) return false;
  for (const [relative, target] of left) {
    if (right.get(relative) !== target) return false;
  }
  return true;
}

function transactionHandle(workspaceRoot, metadata) {
  const area = path.join(workspaceRoot, TRANSACTION_DIRECTORY);
  return Object.freeze({
    id: metadata.id,
    courseId: metadata.courseId,
    workspaceRoot,
    courseRoot: path.join(workspaceRoot, metadata.courseId),
    transactionRoot: path.join(area, metadata.id),
  });
}

async function loadTransaction(transaction) {
  if (!transaction || typeof transaction !== "object") throw new Error("Course transaction is required");
  const workspaceRoot = await canonicalWorkspaceRoot(transaction.workspaceRoot);
  const id = assertTransactionId(transaction.id);
  const root = path.join(await transactionArea(workspaceRoot), id);
  if (path.resolve(transaction.transactionRoot || root) !== root) throw new Error("Invalid course transaction path");
  await directoryIdentity(root, "The course transaction");
  const metadata = await readMetadata(root, id);
  if (transaction.courseId && transaction.courseId !== metadata.courseId) throw new Error("Course transaction target changed");
  return { metadata, handle: transactionHandle(workspaceRoot, metadata) };
}

async function removeTransaction(transactionRoot) {
  try {
    await rm(transactionRoot, { recursive: true, force: true });
    return false;
  } catch {
    return true;
  }
}

export async function beginCourseTransaction(workspaceRoot, courseId, courseRoot = "") {
  const workspace = await canonicalWorkspaceRoot(workspaceRoot);
  const id = assertCourseId(courseId);
  const expectedCourseRoot = path.join(workspace, id);
  const suppliedCourseRoot = path.resolve(courseRoot || expectedCourseRoot);
  const canonicalCourseRoot = await realpath(suppliedCourseRoot);
  if (canonicalCourseRoot !== expectedCourseRoot) {
    throw new Error("The course transaction target must be a direct teaching-workspace child");
  }
  const courseInfo = await lstat(expectedCourseRoot);
  if (courseInfo.isSymbolicLink() || !courseInfo.isDirectory()) throw new Error("The course must be a regular directory");

  const area = await transactionArea(workspace);
  const areaInfo = await stat(area);
  if (String(courseInfo.dev) !== String(areaInfo.dev)) {
    throw new Error("The course snapshot must be on the same filesystem as the course");
  }

  const transactionId = randomUUID();
  const root = path.join(area, transactionId);
  const snapshotRoot = path.join(root, SNAPSHOT_DIRECTORY);
  await mkdir(root, { mode: 0o700 });
  let metadata = {
    version: TRANSACTION_VERSION,
    id: transactionId,
    courseId: id,
    state: "preparing",
    createdAt: new Date().toISOString(),
  };
  try {
    await writeMetadata(root, metadata);
    const sourceLinks = await inspectCourseTree(expectedCourseRoot);
    await cp(expectedCourseRoot, snapshotRoot, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const snapshotLinks = await inspectCourseTree(snapshotRoot, expectedCourseRoot);
    if (!sameLinks(sourceLinks, snapshotLinks)) throw new Error("The course snapshot did not preserve symbolic links");
    metadata = {
      ...metadata,
      state: "pending",
      snapshotIdentity: await directoryIdentity(snapshotRoot, "The course snapshot"),
    };
    await writeMetadata(root, metadata);
    return transactionHandle(workspace, metadata);
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function commitCourseTransaction(transaction, { cleanup = true } = {}) {
  const { metadata, handle } = await loadTransaction(transaction);
  if (metadata.state === "rolled-back") throw new Error("A rolled-back course transaction cannot be committed");
  if (metadata.state === "preparing") throw new Error("The course transaction snapshot is incomplete");

  let committed = metadata;
  if (metadata.state === "pending") {
    committed = { ...metadata, state: "committed" };
    await writeMetadata(handle.transactionRoot, committed);
  }
  const cleanupPending = cleanup ? await removeTransaction(handle.transactionRoot) : true;
  return { committed: true, cleanupPending };
}

export async function rollbackCourseTransaction(transaction, { renameEntry = rename } = {}) {
  const { metadata, handle } = await loadTransaction(transaction);
  if (metadata.state === "committed") throw new Error("A committed course transaction cannot be rolled back");
  if (metadata.state === "preparing") {
    return { restored: false, cleanupPending: await removeTransaction(handle.transactionRoot) };
  }
  if (metadata.state === "rolled-back") {
    return { restored: true, cleanupPending: await removeTransaction(handle.transactionRoot) };
  }

  const snapshotRoot = path.join(handle.transactionRoot, SNAPSHOT_DIRECTORY);
  const failedRoot = path.join(handle.transactionRoot, FAILED_COURSE_DIRECTORY);
  let snapshotInfo = await pathInfo(snapshotRoot);
  let courseInfo = await pathInfo(handle.courseRoot);
  let failedInfo = await pathInfo(failedRoot);

  if (!snapshotInfo) {
    const currentIdentity = courseInfo && courseInfo.isDirectory() && !courseInfo.isSymbolicLink()
      ? await directoryIdentity(handle.courseRoot, "The restored course")
      : null;
    if (!identityMatches(currentIdentity, metadata.snapshotIdentity)) {
      throw new Error("The course snapshot is missing before rollback completed");
    }
  } else {
    if (snapshotInfo.isSymbolicLink() || !snapshotInfo.isDirectory()) throw new Error("The course snapshot was replaced");
    const currentSnapshotIdentity = await directoryIdentity(snapshotRoot, "The course snapshot");
    if (!identityMatches(currentSnapshotIdentity, metadata.snapshotIdentity)) {
      throw new Error("The course snapshot identity changed");
    }
    if (failedInfo && courseInfo) throw new Error("Course rollback has ambiguous live and quarantined state");

    if (!failedInfo && courseInfo) {
      await renameEntry(handle.courseRoot, failedRoot);
      courseInfo = null;
      failedInfo = await pathInfo(failedRoot);
    }

    try {
      await renameEntry(snapshotRoot, handle.courseRoot);
      snapshotInfo = null;
      courseInfo = await pathInfo(handle.courseRoot);
    } catch (restoreError) {
      let liveRecoveryError = null;
      if (!courseInfo && failedInfo) {
        try {
          await renameEntry(failedRoot, handle.courseRoot);
        } catch (error) {
          liveRecoveryError = error;
        }
      }
      if (liveRecoveryError) {
        throw new AggregateError(
          [restoreError, liveRecoveryError],
          `Course rollback could not restore either snapshot or live course: ${restoreError.message}; ${liveRecoveryError.message}`,
        );
      }
      throw new Error(`Course rollback could not install the snapshot: ${restoreError.message}`, { cause: restoreError });
    }

    const restoredIdentity = courseInfo && courseInfo.isDirectory() && !courseInfo.isSymbolicLink()
      ? await directoryIdentity(handle.courseRoot, "The restored course")
      : null;
    if (!identityMatches(restoredIdentity, metadata.snapshotIdentity)) {
      throw new Error("The restored course does not match the rollback snapshot");
    }
  }

  await writeMetadata(handle.transactionRoot, { ...metadata, state: "rolled-back" });
  return { restored: true, cleanupPending: await removeTransaction(handle.transactionRoot) };
}

export async function recoverCourseTransactions(workspaceRoot) {
  const workspace = await canonicalWorkspaceRoot(workspaceRoot);
  const area = await transactionArea(workspace, { create: false });
  const result = { restored: [], cleaned: [] };
  if (!area) return result;

  const entries = (await readdir(area, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !TRANSACTION_ID.test(entry.name)) {
      throw new Error(`Invalid entry in the course transaction area: ${entry.name}`);
    }
    const root = path.join(area, entry.name);
    let metadata;
    try {
      metadata = await readMetadata(root, entry.name);
    } catch (error) {
      if (error?.code === "ENOENT") {
        // beginCourseTransaction never exposes a transaction before valid
        // pending metadata is durable, so a metadata-free directory is an
        // abandoned preparation and cannot have touched the live course.
        await rm(root, { recursive: true, force: true });
        result.cleaned.push(entry.name);
        continue;
      }
      throw error;
    }

    const handle = transactionHandle(workspace, metadata);
    if (metadata.state === "pending") {
      await rollbackCourseTransaction(handle);
      result.restored.push(metadata.courseId);
    } else {
      await rm(root, { recursive: true, force: true });
      result.cleaned.push(entry.name);
    }
  }
  return result;
}

export const courseTransactionPaths = Object.freeze({
  directory: TRANSACTION_DIRECTORY,
  metadata: METADATA_FILE,
  snapshot: SNAPSHOT_DIRECTORY,
  failedCourse: FAILED_COURSE_DIRECTORY,
});
