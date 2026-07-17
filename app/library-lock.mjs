import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const LIBRARY_LOCK_FILENAME = ".margin-library.lock";

const LOCK_VERSION = 1;
const MAX_LOCK_BYTES = 8 * 1024;
const OPEN_NOFOLLOW = constants.O_NOFOLLOW || 0;
const OPEN_NONBLOCK = constants.O_NONBLOCK || 0;

function lockError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseLock(text, canonicalRoot) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw lockError("The learning-library lock is malformed and was left untouched.", "MARGIN_LIBRARY_LOCK_UNSAFE", cause);
  }

  if (
    value?.version !== LOCK_VERSION
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || typeof value.token !== "string"
    || !/^[a-f0-9-]{36}$/i.test(value.token)
    || value.libraryPath !== canonicalRoot
  ) {
    throw lockError("The learning-library lock has invalid ownership data and was left untouched.", "MARGIN_LIBRARY_LOCK_UNSAFE");
  }
  return value;
}

async function readLock(lockPath, canonicalRoot) {
  let before;
  try {
    before = await lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw lockError("The learning-library lock path is not a regular file and was left untouched.", "MARGIN_LIBRARY_LOCK_UNSAFE");
  }
  if (before.size > MAX_LOCK_BYTES) {
    throw lockError("The learning-library lock is unexpectedly large and was left untouched.", "MARGIN_LIBRARY_LOCK_UNSAFE");
  }

  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_NONBLOCK);
    const current = await handle.stat();
    if (!current.isFile() || !sameFile(before, current) || current.size > MAX_LOCK_BYTES) {
      throw lockError("The learning-library lock changed while it was inspected and was left untouched.", "MARGIN_LIBRARY_LOCK_UNSAFE");
    }
    const owner = parseLock(await handle.readFile("utf8"), canonicalRoot);
    return { identity: current, owner };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw lockError("The learning-library lock path is a symbolic link and was left untouched.", "MARGIN_LIBRARY_LOCK_UNSAFE", error);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function unlinkIfSameLock(lockPath, canonicalRoot, expected) {
  const current = await readLock(lockPath, canonicalRoot);
  if (!current) return false;
  if (
    !sameFile(current.identity, expected.identity)
    || current.owner.pid !== expected.owner.pid
    || current.owner.token !== expected.owner.token
  ) {
    return false;
  }
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function unlinkIfSameFile(lockPath, expectedIdentity) {
  let current;
  try {
    current = await lstat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (current.isSymbolicLink() || !current.isFile() || !sameFile(current, expectedIdentity)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createLock(lockPath, owner) {
  const unpublishedPath = `${lockPath}.${owner.token}.create`;
  let handle;
  let unpublishedIdentity;
  try {
    handle = await open(
      unpublishedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | OPEN_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    unpublishedIdentity = await handle.stat();
    await handle.close();
    handle = null;
    await link(unpublishedPath, lockPath);
    return await lstat(lockPath);
  } finally {
    if (!unpublishedIdentity && handle) unpublishedIdentity = await handle.stat().catch(() => null);
    await handle?.close();
    if (unpublishedIdentity) await unlinkIfSameFile(unpublishedPath, unpublishedIdentity).catch(() => {});
  }
}

async function replaceLock(lockPath, owner) {
  const temporaryPath = `${lockPath}.${owner.token}.tmp`;
  let temporaryIdentity;
  try {
    temporaryIdentity = await createLock(temporaryPath, owner);
    await rename(temporaryPath, lockPath);
    temporaryIdentity = null;
    return await lstat(lockPath);
  } finally {
    if (temporaryIdentity) await unlinkIfSameFile(temporaryPath, temporaryIdentity).catch(() => {});
  }
}

function lockedBy(owner, action = "using") {
  return lockError(
    `Another Margin process is ${action} this learning library (PID ${owner.pid}).`,
    "MARGIN_LIBRARY_LOCKED",
  );
}

export async function acquireLibraryLock(libraryPath) {
  const canonicalRoot = await realpath(path.resolve(libraryPath));
  const rootInfo = await stat(canonicalRoot);
  if (!rootInfo.isDirectory()) throw new Error("The learning library must be a directory.");

  const lockPath = path.join(canonicalRoot, LIBRARY_LOCK_FILENAME);
  const recoveryPath = `${lockPath}.recovery`;
  const owner = {
    version: LOCK_VERSION,
    pid: process.pid,
    token: randomUUID(),
    libraryPath: canonicalRoot,
    createdAt: new Date().toISOString(),
  };

  let identity;
  for (;;) {
    try {
      identity = await createLock(lockPath, owner);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const existing = await readLock(lockPath, canonicalRoot);
    if (!existing) continue;
    if (processIsAlive(existing.owner.pid)) throw lockedBy(existing.owner);

    let recoveryIdentity;
    try {
      recoveryIdentity = await createLock(recoveryPath, owner);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const recovery = await readLock(recoveryPath, canonicalRoot);
      if (!recovery) continue;
      if (processIsAlive(recovery.owner.pid)) throw lockedBy(recovery.owner, "recovering");
      await unlinkIfSameLock(recoveryPath, canonicalRoot, recovery);
      continue;
    }

    try {
      const current = await readLock(lockPath, canonicalRoot);
      if (!current) continue;
      if (processIsAlive(current.owner.pid)) throw lockedBy(current.owner);
      identity = await replaceLock(lockPath, owner);
      break;
    } finally {
      await unlinkIfSameLock(recoveryPath, canonicalRoot, { identity: recoveryIdentity, owner });
    }
  }

  let releasePromise;
  const release = () => {
    releasePromise ??= unlinkIfSameLock(lockPath, canonicalRoot, { identity, owner });
    return releasePromise;
  };

  return Object.freeze({ libraryPath: canonicalRoot, lockPath, release });
}
