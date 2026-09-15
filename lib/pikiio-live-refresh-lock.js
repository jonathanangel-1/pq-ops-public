"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");

const {
  shouldReclaimNestedTmsLock,
} = require("./pikiio-agent-governance");

const OPERATION_SCHEMA = "pikiio-live-refresh-operation-v1";
const RUN_LOCK_SCHEMA = "pikiio-live-refresh-lock-v2";

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function lockError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

async function readJsonFile(filePath, code) {
  let source;
  try {
    source = await fs.readFile(filePath, "utf8");
    return { source: source.trim(), payload: JSON.parse(source) };
  } catch (cause) {
    const error = lockError(code, `Lock evidence is unreadable: ${filePath}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
      source: String(source || "").slice(0, 1000),
    });
    error.cause = cause;
    throw error;
  }
}

async function removePathStillOwned(filePath, handle) {
  let opened;
  try {
    opened = await handle.stat();
  } catch {
    return false;
  }
  let current;
  try {
    current = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (opened.dev !== current.dev || opened.ino !== current.ino) return false;
  await fs.unlink(filePath);
  return true;
}

async function acquireSerialization({
  operationPath,
  purpose,
  pid,
  host,
  nowMs,
  isPidAlive,
  maximumAttempts,
  retryDelayMs,
}) {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const operationId = crypto.randomUUID();
    let handle;
    let created = false;
    try {
      handle = await fs.open(operationPath, "wx", 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify({
        schema: OPERATION_SCHEMA,
        operationId,
        purpose,
        pid,
        host,
        startedAt: new Date(nowMs()).toISOString(),
      })}\n`);
      return async () => {
        await handle.close().catch(() => {});
        let current;
        try {
          current = await readJsonFile(
            operationPath,
            "LIVE_REFRESH_OPERATION_OWNERSHIP_AMBIGUOUS",
          );
        } catch (error) {
          if (error.cause?.code === "ENOENT") return;
          throw error;
        }
        if (
          current.payload.schema !== OPERATION_SCHEMA ||
          current.payload.operationId !== operationId ||
          current.payload.pid !== pid ||
          current.payload.host !== host
        ) {
          throw lockError(
            "LIVE_REFRESH_OPERATION_OWNERSHIP_CHANGED",
            "Nested lock serialization ownership changed before release",
          );
        }
        await fs.unlink(operationPath);
      };
    } catch (error) {
      if (created && handle) {
        await removePathStillOwned(operationPath, handle).catch(() => {});
      }
      await handle?.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      let current;
      try {
        current = await readJsonFile(
          operationPath,
          "LIVE_REFRESH_OPERATION_OWNERSHIP_AMBIGUOUS",
        );
      } catch (readError) {
        if (readError.cause?.code === "ENOENT") continue;
        throw readError;
      }
      if (
        current.payload.schema !== OPERATION_SCHEMA ||
        !current.payload.operationId ||
        !Number.isSafeInteger(current.payload.pid) ||
        !current.payload.host
      ) {
        throw lockError(
          "LIVE_REFRESH_OPERATION_OWNERSHIP_AMBIGUOUS",
          "Nested lock serialization evidence is malformed",
        );
      }
      if (current.payload.host !== host) {
        throw lockError(
          "LIVE_REFRESH_OPERATION_FOREIGN_HOST",
          "Nested lock serialization is owned by another host",
          { ownerHost: current.payload.host },
        );
      }
      if (isPidAlive(current.payload.pid)) {
        if (attempt === maximumAttempts) {
          throw lockError(
            "LIVE_REFRESH_OPERATION_BUSY",
            "Nested lock serialization is owned by a live process",
            { ownerPid: current.payload.pid, purpose: current.payload.purpose },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      const stalePath =
        `${operationPath}.stale-${nowMs()}-${current.payload.operationId}`;
      try {
        await fs.rename(operationPath, stalePath);
      } catch (renameError) {
        if (renameError.code === "ENOENT") continue;
        throw renameError;
      }
    }
  }
  throw lockError(
    "LIVE_REFRESH_OPERATION_BUSY",
    "Nested lock serialization could not be acquired",
  );
}

async function acquireNestedRunLock({
  lockPath,
  operationPath,
  staleMs = 90 * 60 * 1000,
  pid = process.pid,
  host = os.hostname(),
  nowMs = Date.now,
  isPidAlive = pidAlive,
  maximumSerializationAttempts = 50,
  serializationRetryDelayMs = 20,
} = {}) {
  if (!lockPath || !operationPath || lockPath === operationPath) {
    throw lockError(
      "LIVE_REFRESH_LOCK_PATH_INVALID",
      "Distinct run-lock and serialization paths are required",
    );
  }
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    typeof host !== "string" ||
    host.trim() === "" ||
    typeof nowMs !== "function" ||
    typeof isPidAlive !== "function" ||
    !Number.isFinite(staleMs) ||
    staleMs < 0 ||
    !Number.isSafeInteger(maximumSerializationAttempts) ||
    maximumSerializationAttempts < 1 ||
    !Number.isFinite(serializationRetryDelayMs) ||
    serializationRetryDelayMs < 0
  ) {
    throw lockError(
      "LIVE_REFRESH_LOCK_POLICY_INVALID",
      "Nested run-lock policy inputs are invalid",
    );
  }
  const lockId = crypto.randomUUID();
  const startedAt = new Date(nowMs()).toISOString();
  const serialized = (purpose) =>
    acquireSerialization({
      operationPath,
      purpose,
      pid,
      host,
      nowMs,
      isPidAlive,
      maximumAttempts: maximumSerializationAttempts,
      retryDelayMs: serializationRetryDelayMs,
    });

  const releaseSerialization = await serialized("acquire");
  try {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let current;
      let stat;
      try {
        [current, stat] = await Promise.all([
          readJsonFile(lockPath, "LIVE_REFRESH_LOCK_AMBIGUOUS"),
          fs.stat(lockPath),
        ]);
      } catch (readError) {
        if (
          readError.code === "ENOENT" ||
          readError.cause?.code === "ENOENT"
        ) {
          handle = await fs.open(lockPath, "wx", 0o600);
        } else {
          throw readError;
        }
      }
      if (!handle) {
        const payload = current.payload;
        if (
          payload.schema !== RUN_LOCK_SCHEMA ||
          !payload.lockId ||
          !Number.isSafeInteger(payload.pid) ||
          !payload.host
        ) {
          throw lockError(
            "LIVE_REFRESH_LOCK_AMBIGUOUS",
            "Nested TMS lock evidence is malformed",
          );
        }
        if (payload.host !== host) {
          throw lockError(
            "LIVE_REFRESH_LOCK_FOREIGN_HOST",
            "Nested TMS lock is owned by another host",
            { ownerHost: payload.host },
          );
        }
        let ownerAlive;
        try {
          ownerAlive = isPidAlive(payload.pid);
        } catch (cause) {
          throw lockError(
            "LIVE_REFRESH_LOCK_LIVENESS_UNKNOWN",
            "Nested TMS lock owner liveness could not be established",
            { cause: cause instanceof Error ? cause.message : String(cause) },
          );
        }
        const stale = shouldReclaimNestedTmsLock({
          ageExpired: nowMs() - stat.mtimeMs > staleMs,
          pidPresent: true,
          pidIsAlive: ownerAlive,
        });
        if (!stale) {
          throw lockError(
            "LIVE_REFRESH_LOCK_BUSY",
            "live-refresh is already running; refusing a second TMS session",
            { ownerPid: payload.pid, startedAt: payload.startedAt },
          );
        }
        const stalePath = `${lockPath}.stale-${nowMs()}-${payload.lockId}`;
        await fs.rename(lockPath, stalePath);
        handle = await fs.open(lockPath, "wx", 0o600);
      }
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        schema: RUN_LOCK_SCHEMA,
        lockId,
        pid,
        host,
        startedAt,
      })}\n`);
    } catch (error) {
      await removePathStillOwned(lockPath, handle).catch(() => {});
      throw error;
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    await releaseSerialization();
  }

  let released = false;
  return async () => {
    if (released) return { ok: true, alreadyReleased: true };
    const releaseOperation = await serialized("release");
    try {
      const current = await readJsonFile(
        lockPath,
        "LIVE_REFRESH_LOCK_AMBIGUOUS",
      );
      if (
        current.payload.schema !== RUN_LOCK_SCHEMA ||
        current.payload.lockId !== lockId ||
        current.payload.pid !== pid ||
        current.payload.host !== host
      ) {
        throw lockError(
          "LIVE_REFRESH_LOCK_OWNERSHIP_CHANGED",
          "Nested TMS lock ownership changed before release",
        );
      }
      await fs.unlink(lockPath);
      released = true;
      return { ok: true, alreadyReleased: false };
    } finally {
      await releaseOperation();
    }
  };
}

module.exports = {
  OPERATION_SCHEMA,
  RUN_LOCK_SCHEMA,
  acquireNestedRunLock,
  pidAlive,
  removePathStillOwned,
};
