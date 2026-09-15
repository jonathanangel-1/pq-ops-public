"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  OPERATION_SCHEMA,
  RUN_LOCK_SCHEMA,
  acquireNestedRunLock,
  pidAlive,
} = require("../lib/pikiio-live-refresh-lock");

const FIXED_NOW = Date.parse("2026-07-24T12:00:00.000Z");
const LOCAL_HOST = "pikiio-test-host";

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-live-lock-"));
  return {
    root,
    lockPath: path.join(root, "live-refresh.lock"),
    operationPath: path.join(root, "live-refresh.lock.operation"),
  };
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function operationFixture(overrides = {}) {
  return {
    schema: OPERATION_SCHEMA,
    operationId: "operation-fixture",
    purpose: "acquire",
    pid: 4101,
    host: LOCAL_HOST,
    startedAt: "2026-07-24T11:55:00.000Z",
    ...overrides,
  };
}

function runLockFixture(overrides = {}) {
  return {
    schema: RUN_LOCK_SCHEMA,
    lockId: "run-lock-fixture",
    pid: 4201,
    host: LOCAL_HOST,
    startedAt: "2026-07-24T11:55:00.000Z",
    ...overrides,
  };
}

function acquireOptions(paths, overrides = {}) {
  return {
    lockPath: paths.lockPath,
    operationPath: paths.operationPath,
    pid: 4001,
    host: LOCAL_HOST,
    nowMs: () => FIXED_NOW,
    isPidAlive: () => false,
    maximumSerializationAttempts: 2,
    serializationRetryDelayMs: 0,
    ...overrides,
  };
}

function staleNames(root, prefix) {
  return fs.readdirSync(root).filter((name) => name.startsWith(prefix)).sort();
}

test("normal acquisition refuses a live owner and release is idempotent", async () => {
  const paths = tempPaths();
  try {
    const options = acquireOptions(paths, {
      pid: 4001,
      isPidAlive: (candidatePid) => candidatePid === 4001,
      maximumSerializationAttempts: 1,
    });
    const release = await acquireNestedRunLock(options);
    const firstLock = readJson(paths.lockPath);

    assert.equal(firstLock.schema, RUN_LOCK_SCHEMA);
    assert.equal(firstLock.pid, 4001);
    assert.equal(firstLock.host, LOCAL_HOST);
    assert.match(firstLock.lockId, /^[0-9a-f-]{36}$/);
    assert.equal(fs.existsSync(paths.operationPath), false);

    await assert.rejects(
      acquireNestedRunLock(options),
      (error) =>
        error.code === "LIVE_REFRESH_LOCK_BUSY" &&
        error.details.ownerPid === 4001,
    );
    assert.deepEqual(readJson(paths.lockPath), firstLock);
    assert.deepEqual(staleNames(paths.root, "live-refresh.lock.stale-"), []);
    assert.equal(fs.existsSync(paths.operationPath), false);

    assert.deepEqual(await release(), {
      ok: true,
      alreadyReleased: false,
    });
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.deepEqual(await release(), {
      ok: true,
      alreadyReleased: true,
    });
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a dead serializer is archived before acquisition proceeds", async () => {
  const paths = tempPaths();
  try {
    writeJson(
      paths.operationPath,
      operationFixture({ operationId: "dead-operation", pid: 4102 }),
    );

    const release = await acquireNestedRunLock(
      acquireOptions(paths, {
        isPidAlive: (candidatePid) => candidatePid !== 4102,
      }),
    );

    assert.deepEqual(
      staleNames(paths.root, "live-refresh.lock.operation.stale-"),
      [`live-refresh.lock.operation.stale-${FIXED_NOW}-dead-operation`],
    );
    assert.equal(fs.existsSync(paths.operationPath), false);
    assert.equal(readJson(paths.lockPath).pid, 4001);
    await release();
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a live serializer is never stolen even when its evidence is ancient", async () => {
  const paths = tempPaths();
  try {
    const owner = operationFixture({
      operationId: "live-operation",
      pid: 4103,
      startedAt: "2001-01-01T00:00:00.000Z",
    });
    writeJson(paths.operationPath, owner);
    fs.utimesSync(paths.operationPath, new Date(0), new Date(0));

    await assert.rejects(
      acquireNestedRunLock(
        acquireOptions(paths, {
          isPidAlive: (candidatePid) => candidatePid === 4103,
          maximumSerializationAttempts: 1,
        }),
      ),
      (error) =>
        error.code === "LIVE_REFRESH_OPERATION_BUSY" &&
        error.details.ownerPid === 4103,
    );

    assert.deepEqual(readJson(paths.operationPath), owner);
    assert.deepEqual(
      staleNames(paths.root, "live-refresh.lock.operation.stale-"),
      [],
    );
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a dead run lock is recovered even when its file is fresh", async () => {
  const paths = tempPaths();
  try {
    const deadOwner = runLockFixture({
      lockId: "fresh-but-dead",
      pid: 4202,
    });
    writeJson(paths.lockPath, deadOwner);

    const release = await acquireNestedRunLock(
      acquireOptions(paths, {
        staleMs: Number.MAX_SAFE_INTEGER,
        isPidAlive: (candidatePid) => candidatePid !== 4202,
      }),
    );

    assert.deepEqual(
      staleNames(paths.root, "live-refresh.lock.stale-"),
      [`live-refresh.lock.stale-${FIXED_NOW}-fresh-but-dead`],
    );
    assert.deepEqual(
      readJson(path.join(
        paths.root,
        `live-refresh.lock.stale-${FIXED_NOW}-fresh-but-dead`,
      )),
      deadOwner,
    );
    assert.notEqual(readJson(paths.lockPath).lockId, deadOwner.lockId);
    await release();
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a live run lock is never stolen even when its file is stale", async () => {
  const paths = tempPaths();
  try {
    const liveOwner = runLockFixture({
      lockId: "ancient-but-live",
      pid: 4203,
      startedAt: "2001-01-01T00:00:00.000Z",
    });
    writeJson(paths.lockPath, liveOwner);
    fs.utimesSync(paths.lockPath, new Date(0), new Date(0));

    await assert.rejects(
      acquireNestedRunLock(
        acquireOptions(paths, {
          staleMs: 1,
          isPidAlive: (candidatePid) => candidatePid === 4203,
        }),
      ),
      (error) =>
        error.code === "LIVE_REFRESH_LOCK_BUSY" &&
        error.details.ownerPid === 4203,
    );

    assert.deepEqual(readJson(paths.lockPath), liveOwner);
    assert.deepEqual(staleNames(paths.root, "live-refresh.lock.stale-"), []);
    assert.equal(fs.existsSync(paths.operationPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("malformed serializer evidence fails closed", async (t) => {
  for (const fixture of [
    {
      name: "unparseable JSON",
      write: (filePath) => fs.writeFileSync(filePath, "{not-json\n"),
    },
    {
      name: "wrong schema",
      write: (filePath) =>
        writeJson(filePath, operationFixture({ schema: "unknown-schema" })),
    },
    {
      name: "invalid owner pid",
      write: (filePath) =>
        writeJson(filePath, operationFixture({ pid: "4104" })),
    },
  ]) {
    await t.test(fixture.name, async () => {
      const paths = tempPaths();
      try {
        fixture.write(paths.operationPath);
        const before = fs.readFileSync(paths.operationPath);
        await assert.rejects(
          acquireNestedRunLock(acquireOptions(paths)),
          { code: "LIVE_REFRESH_OPERATION_OWNERSHIP_AMBIGUOUS" },
        );
        assert.deepEqual(fs.readFileSync(paths.operationPath), before);
        assert.equal(fs.existsSync(paths.lockPath), false);
      } finally {
        fs.rmSync(paths.root, { recursive: true, force: true });
      }
    });
  }
});

test("foreign-host serializer evidence fails closed", async () => {
  const paths = tempPaths();
  try {
    const foreignOwner = operationFixture({ host: "foreign-test-host" });
    writeJson(paths.operationPath, foreignOwner);

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      (error) =>
        error.code === "LIVE_REFRESH_OPERATION_FOREIGN_HOST" &&
        error.details.ownerHost === "foreign-test-host",
    );

    assert.deepEqual(readJson(paths.operationPath), foreignOwner);
    assert.deepEqual(
      staleNames(paths.root, "live-refresh.lock.operation.stale-"),
      [],
    );
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("malformed run-lock evidence fails closed", async (t) => {
  for (const fixture of [
    {
      name: "unparseable JSON",
      write: (filePath) => fs.writeFileSync(filePath, "{not-json\n"),
    },
    {
      name: "wrong schema",
      write: (filePath) =>
        writeJson(filePath, runLockFixture({ schema: "unknown-schema" })),
    },
    {
      name: "missing lock identity",
      write: (filePath) =>
        writeJson(filePath, runLockFixture({ lockId: "" })),
    },
    {
      name: "invalid owner pid",
      write: (filePath) =>
        writeJson(filePath, runLockFixture({ pid: 1.5 })),
    },
  ]) {
    await t.test(fixture.name, async () => {
      const paths = tempPaths();
      try {
        fixture.write(paths.lockPath);
        const before = fs.readFileSync(paths.lockPath);
        await assert.rejects(
          acquireNestedRunLock(acquireOptions(paths)),
          { code: "LIVE_REFRESH_LOCK_AMBIGUOUS" },
        );
        assert.deepEqual(fs.readFileSync(paths.lockPath), before);
        assert.equal(fs.existsSync(paths.operationPath), false);
        assert.deepEqual(staleNames(paths.root, "live-refresh.lock.stale-"), []);
      } finally {
        fs.rmSync(paths.root, { recursive: true, force: true });
      }
    });
  }
});

test("foreign-host run-lock evidence fails closed", async () => {
  const paths = tempPaths();
  try {
    const foreignOwner = runLockFixture({ host: "foreign-test-host" });
    writeJson(paths.lockPath, foreignOwner);

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      (error) =>
        error.code === "LIVE_REFRESH_LOCK_FOREIGN_HOST" &&
        error.details.ownerHost === "foreign-test-host",
    );

    assert.deepEqual(readJson(paths.lockPath), foreignOwner);
    assert.equal(fs.existsSync(paths.operationPath), false);
    assert.deepEqual(staleNames(paths.root, "live-refresh.lock.stale-"), []);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("unknown run-lock owner liveness fails closed", async () => {
  const paths = tempPaths();
  try {
    const owner = runLockFixture({ pid: 4204 });
    writeJson(paths.lockPath, owner);

    await assert.rejects(
      acquireNestedRunLock(
        acquireOptions(paths, {
          isPidAlive: () => {
            throw new Error("kernel liveness probe unavailable");
          },
        }),
      ),
      (error) =>
        error.code === "LIVE_REFRESH_LOCK_LIVENESS_UNKNOWN" &&
        error.details.cause === "kernel liveness probe unavailable",
    );

    assert.deepEqual(readJson(paths.lockPath), owner);
    assert.equal(fs.existsSync(paths.operationPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("release rejects ownership substitution and preserves the replacement", async () => {
  const paths = tempPaths();
  try {
    const release = await acquireNestedRunLock(acquireOptions(paths));
    const replacement = runLockFixture({
      lockId: "replacement-lock",
      pid: 4999,
    });
    writeJson(paths.lockPath, replacement);

    await assert.rejects(release(), {
      code: "LIVE_REFRESH_LOCK_OWNERSHIP_CHANGED",
    });

    assert.deepEqual(readJson(paths.lockPath), replacement);
    assert.equal(fs.existsSync(paths.operationPath), false);
    await assert.rejects(release(), {
      code: "LIVE_REFRESH_LOCK_OWNERSHIP_CHANGED",
    });
    assert.deepEqual(readJson(paths.lockPath), replacement);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("missing or equal lock paths are rejected before touching disk", async () => {
  const paths = tempPaths();
  try {
    await assert.rejects(
      acquireNestedRunLock({
        lockPath: paths.lockPath,
        operationPath: paths.lockPath,
      }),
      { code: "LIVE_REFRESH_LOCK_PATH_INVALID" },
    );
    await assert.rejects(
      acquireNestedRunLock({
        lockPath: paths.lockPath,
      }),
      { code: "LIVE_REFRESH_LOCK_PATH_INVALID" },
    );
    await assert.rejects(
      acquireNestedRunLock({
        operationPath: paths.operationPath,
      }),
      { code: "LIVE_REFRESH_LOCK_PATH_INVALID" },
    );
    assert.deepEqual(fs.readdirSync(paths.root), []);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("pidAlive treats invalid, gone, permission-denied, and unknown probes safely", () => {
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(1.5), false);
  assert.equal(pidAlive("1"), false);
  assert.equal(pidAlive(process.pid), true);

  const originalKill = process.kill;
  try {
    process.kill = () => {};
    assert.equal(pidAlive(5001), true);

    process.kill = () => {
      const error = new Error("gone");
      error.code = "ESRCH";
      throw error;
    };
    assert.equal(pidAlive(5001), false);

    process.kill = () => {
      const error = new Error("permission denied");
      error.code = "EPERM";
      throw error;
    };
    assert.equal(pidAlive(5001), true);

    process.kill = () => {
      const error = new Error("unexpected kernel error");
      error.code = "EIO";
      throw error;
    };
    assert.throws(() => pidAlive(5001), /unexpected kernel error/);
  } finally {
    process.kill = originalKill;
  }
});

test("a live serializer is retried only within its explicit bound", async () => {
  const paths = tempPaths();
  try {
    writeJson(paths.operationPath, operationFixture({ pid: 5101 }));
    let livenessChecks = 0;

    await assert.rejects(
      acquireNestedRunLock(
        acquireOptions(paths, {
          maximumSerializationAttempts: 2,
          serializationRetryDelayMs: 0,
          isPidAlive: (candidatePid) => {
            assert.equal(candidatePid, 5101);
            livenessChecks += 1;
            return true;
          },
        }),
      ),
      { code: "LIVE_REFRESH_OPERATION_BUSY" },
    );

    assert.equal(livenessChecks, 2);
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.deepEqual(staleNames(paths.root, "live-refresh.lock.operation.stale-"), []);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a zero serializer-attempt budget fails closed without creating files", async () => {
  const paths = tempPaths();
  try {
    await assert.rejects(
      acquireNestedRunLock(
        acquireOptions(paths, {
          maximumSerializationAttempts: 0,
        }),
      ),
      { code: "LIVE_REFRESH_LOCK_POLICY_INVALID" },
    );
    assert.deepEqual(fs.readdirSync(paths.root), []);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("invalid lock-policy inputs are rejected before touching disk", async (t) => {
  for (const fixture of [
    { name: "fractional pid", overrides: { pid: 1.5 } },
    { name: "empty host", overrides: { host: " " } },
    { name: "non-function clock", overrides: { nowMs: FIXED_NOW } },
    { name: "non-function liveness probe", overrides: { isPidAlive: false } },
    { name: "negative stale window", overrides: { staleMs: -1 } },
    {
      name: "fractional attempt budget",
      overrides: { maximumSerializationAttempts: 1.5 },
    },
    { name: "negative retry delay", overrides: { serializationRetryDelayMs: -1 } },
  ]) {
    await t.test(fixture.name, async () => {
      const paths = tempPaths();
      try {
        await assert.rejects(
          acquireNestedRunLock(acquireOptions(paths, fixture.overrides)),
          { code: "LIVE_REFRESH_LOCK_POLICY_INVALID" },
        );
        assert.deepEqual(fs.readdirSync(paths.root), []);
      } finally {
        fs.rmSync(paths.root, { recursive: true, force: true });
      }
    });
  }
});

test("a run lock that disappears after EEXIST is acquired without ambiguity", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    writeJson(paths.lockPath, runLockFixture({ lockId: "vanishing-lock" }));
    let simulated = false;
    fsPromises.open = async (...args) => {
      try {
        return await originalOpen(...args);
      } catch (error) {
        if (
          !simulated &&
          args[0] === paths.lockPath &&
          args[1] === "wx" &&
          error.code === "EEXIST"
        ) {
          simulated = true;
          await fsPromises.unlink(paths.lockPath);
        }
        throw error;
      }
    };

    const release = await acquireNestedRunLock(acquireOptions(paths));
    assert.equal(simulated, true);
    assert.equal(readJson(paths.lockPath).pid, 4001);
    await release();
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a dead serializer disappearance during archival is safely retried", async (t) => {
  const paths = tempPaths();
  const originalRename = fsPromises.rename;
  t.after(() => {
    fsPromises.rename = originalRename;
  });
  try {
    writeJson(
      paths.operationPath,
      operationFixture({ operationId: "vanishing-operation", pid: 5102 }),
    );
    let simulated = false;
    fsPromises.rename = async (source, destination) => {
      if (!simulated && source === paths.operationPath) {
        simulated = true;
        await fsPromises.unlink(source);
        const error = new Error("operation disappeared");
        error.code = "ENOENT";
        throw error;
      }
      return originalRename(source, destination);
    };

    const release = await acquireNestedRunLock(
      acquireOptions(paths, {
        isPidAlive: (candidatePid) => candidatePid !== 5102,
      }),
    );
    assert.equal(simulated, true);
    assert.equal(readJson(paths.lockPath).pid, 4001);
    assert.deepEqual(
      staleNames(paths.root, "live-refresh.lock.operation.stale-"),
      [],
    );
    await release();
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("a serializer archival error other than disappearance propagates", async (t) => {
  const paths = tempPaths();
  const originalRename = fsPromises.rename;
  t.after(() => {
    fsPromises.rename = originalRename;
  });
  try {
    const owner = operationFixture({ pid: 5103 });
    writeJson(paths.operationPath, owner);
    fsPromises.rename = async (source, destination) => {
      if (source === paths.operationPath) {
        const error = new Error(`refused rename to ${destination}`);
        error.code = "EACCES";
        throw error;
      }
      return originalRename(source, destination);
    };

    await assert.rejects(
      acquireNestedRunLock(
        acquireOptions(paths, {
          isPidAlive: (candidatePid) => candidatePid !== 5103,
        }),
      ),
      { code: "EACCES" },
    );
    assert.deepEqual(readJson(paths.operationPath), owner);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("serializer write failure removes the empty file only while inode ownership matches", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    let injected = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!injected && args[0] === paths.operationPath && args[1] === "wx") {
        injected = true;
        const originalClose = handle.close.bind(handle);
        handle.writeFile = async () => {
          const error = new Error("simulated serializer write failure");
          error.code = "EIO";
          throw error;
        };
        handle.close = async () => {
          await originalClose();
          const error = new Error("simulated close receipt failure");
          error.code = "EIO";
          throw error;
        };
      }
      return handle;
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      { code: "EIO" },
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(paths.operationPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("serializer write cleanup preserves an inode-substituted replacement", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    const replacement = operationFixture({
      operationId: "replacement-operation",
      pid: 5199,
    });
    let injected = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!injected && args[0] === paths.operationPath && args[1] === "wx") {
        injected = true;
        handle.writeFile = async () => {
          await fsPromises.unlink(paths.operationPath);
          writeJson(paths.operationPath, replacement);
          const error = new Error("simulated write failure after substitution");
          error.code = "EIO";
          throw error;
        };
      }
      return handle;
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      { code: "EIO" },
    );
    assert.equal(injected, true);
    assert.deepEqual(readJson(paths.operationPath), replacement);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("serializer write cleanup tolerates the created file disappearing", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    let injected = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!injected && args[0] === paths.operationPath && args[1] === "wx") {
        injected = true;
        handle.writeFile = async () => {
          await fsPromises.unlink(paths.operationPath);
          const error = new Error("simulated write failure after disappearance");
          error.code = "EIO";
          throw error;
        };
      }
      return handle;
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      { code: "EIO" },
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(paths.operationPath), false);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("run-lock write failure removes only the newly created run lock", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    let injected = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!injected && args[0] === paths.lockPath && args[1] === "wx") {
        injected = true;
        handle.writeFile = async () => {
          const error = new Error("simulated run-lock write failure");
          error.code = "ENOSPC";
          throw error;
        };
      }
      return handle;
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      { code: "ENOSPC" },
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(fs.existsSync(paths.operationPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("serializer disappearance before release is treated as already gone", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    let simulated = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!simulated && args[0] === paths.lockPath && args[1] === "wx") {
        simulated = true;
        await fsPromises.unlink(paths.operationPath);
      }
      return handle;
    };

    const release = await acquireNestedRunLock(acquireOptions(paths));
    assert.equal(simulated, true);
    assert.equal(readJson(paths.lockPath).pid, 4001);
    await release();
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("serializer ownership substitution aborts acquisition without deleting evidence", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    const replacement = operationFixture({
      operationId: "replacement-during-release",
      pid: 5198,
    });
    let simulated = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!simulated && args[0] === paths.lockPath && args[1] === "wx") {
        simulated = true;
        await fsPromises.unlink(paths.operationPath);
        writeJson(paths.operationPath, replacement);
      }
      return handle;
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      { code: "LIVE_REFRESH_OPERATION_OWNERSHIP_CHANGED" },
    );
    assert.equal(simulated, true);
    assert.deepEqual(readJson(paths.operationPath), replacement);
    assert.equal(readJson(paths.lockPath).pid, 4001);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("release fails closed if its run lock has disappeared", async () => {
  const paths = tempPaths();
  try {
    const release = await acquireNestedRunLock(acquireOptions(paths));
    fs.unlinkSync(paths.lockPath);

    await assert.rejects(
      release(),
      (error) =>
        error.code === "LIVE_REFRESH_LOCK_AMBIGUOUS" &&
        error.cause?.code === "ENOENT",
    );
    assert.equal(fs.existsSync(paths.operationPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("default identity and liveness options acquire an uncontended temporary lock", async () => {
  const paths = tempPaths();
  try {
    const release = await acquireNestedRunLock({
      lockPath: paths.lockPath,
      operationPath: paths.operationPath,
    });
    const payload = readJson(paths.lockPath);
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.host, os.hostname());
    assert.equal(new Date(payload.startedAt).toISOString(), payload.startedAt);
    await release();
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("serializer cleanup fails closed when its own file-handle identity cannot be read", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    let injected = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!injected && args[0] === paths.operationPath && args[1] === "wx") {
        injected = true;
        handle.writeFile = async () => {
          const error = new Error("simulated serializer write failure");
          error.code = "EIO";
          throw error;
        };
        handle.stat = async () => {
          const error = new Error("simulated handle identity failure");
          error.code = "ESTALE";
          throw error;
        };
      }
      return handle;
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      { code: "EIO" },
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(paths.operationPath), true);
    assert.equal(fs.statSync(paths.operationPath).size, 0);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("serializer cleanup preserves evidence when path identity inspection is denied", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  const originalLstat = fsPromises.lstat;
  t.after(() => {
    fsPromises.open = originalOpen;
    fsPromises.lstat = originalLstat;
  });
  try {
    let injected = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!injected && args[0] === paths.operationPath && args[1] === "wx") {
        injected = true;
        handle.writeFile = async () => {
          const error = new Error("simulated serializer write failure");
          error.code = "EIO";
          throw error;
        };
      }
      return handle;
    };
    fsPromises.lstat = async (targetPath) => {
      if (targetPath === paths.operationPath) {
        const error = new Error("simulated path identity denial");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(targetPath);
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      { code: "EIO" },
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(paths.operationPath), true);
    assert.equal(fs.statSync(paths.operationPath).size, 0);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("unreadable replacement at serializer release aborts without deleting it", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    let simulated = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!simulated && args[0] === paths.lockPath && args[1] === "wx") {
        simulated = true;
        await fsPromises.unlink(paths.operationPath);
        fs.mkdirSync(paths.operationPath);
      }
      return handle;
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      (error) =>
        error.code === "LIVE_REFRESH_OPERATION_OWNERSHIP_AMBIGUOUS" &&
        error.cause?.code === "EISDIR",
    );
    assert.equal(simulated, true);
    assert.equal(fs.statSync(paths.operationPath).isDirectory(), true);
    assert.equal(readJson(paths.lockPath).pid, 4001);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("post-close reporting errors cannot prevent successful lock cleanup", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  t.after(() => {
    fsPromises.open = originalOpen;
  });
  try {
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (
        (args[0] === paths.operationPath || args[0] === paths.lockPath) &&
        args[1] === "wx"
      ) {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          await originalClose();
          const error = new Error("simulated post-close reporting error");
          error.code = "EIO";
          throw error;
        };
      }
      return handle;
    };

    const release = await acquireNestedRunLock(acquireOptions(paths));
    assert.equal(readJson(paths.lockPath).pid, 4001);
    assert.equal(fs.existsSync(paths.operationPath), false);
    assert.deepEqual(await release(), {
      ok: true,
      alreadyReleased: false,
    });
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(fs.existsSync(paths.operationPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});

test("run-lock cleanup preserves evidence when path identity inspection is denied", async (t) => {
  const paths = tempPaths();
  const originalOpen = fsPromises.open;
  const originalLstat = fsPromises.lstat;
  t.after(() => {
    fsPromises.open = originalOpen;
    fsPromises.lstat = originalLstat;
  });
  try {
    let injected = false;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (!injected && args[0] === paths.lockPath && args[1] === "wx") {
        injected = true;
        handle.writeFile = async () => {
          const error = new Error("simulated run-lock write failure");
          error.code = "ENOSPC";
          throw error;
        };
      }
      return handle;
    };
    fsPromises.lstat = async (targetPath) => {
      if (targetPath === paths.lockPath) {
        const error = new Error("simulated run-lock identity denial");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat(targetPath);
    };

    await assert.rejects(
      acquireNestedRunLock(acquireOptions(paths)),
      { code: "ENOSPC" },
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(paths.lockPath), true);
    assert.equal(fs.statSync(paths.lockPath).size, 0);
    assert.equal(fs.existsSync(paths.operationPath), false);
  } finally {
    fs.rmSync(paths.root, { recursive: true, force: true });
  }
});
