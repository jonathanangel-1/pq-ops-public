"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const proofStore = require("../lib/pikiio-proof-store");

function temporaryRoot(prefix = "pikiio-proof-store-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function expectCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function digest(value) {
  return proofStore.sha256(Buffer.from(String(value), "utf8"));
}

function commit(character) {
  return character.repeat(40);
}

function canonical(value) {
  return proofStore.canonicalJsonBytes(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recursiveSnapshot(root) {
  if (!fs.existsSync(root)) return [];
  const values = [];
  function visit(current, relative) {
    const stat = fs.lstatSync(current, { bigint: true });
    values.push({
      path: relative || ".",
      type: stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "directory"
          : "file",
      mode: (stat.mode & 0o777n).toString(8),
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      links: stat.nlink.toString(),
      owner: stat.uid.toString(),
      group: stat.gid.toString(),
      size: stat.size.toString(),
      modifiedNanoseconds: stat.mtimeNs.toString(),
      changedNanoseconds: stat.ctimeNs.toString(),
      content:
        stat.isFile() && !stat.isSymbolicLink()
          ? proofStore.sha256(fs.readFileSync(current))
          : null,
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of fs.readdirSync(current).sort()) {
      visit(path.join(current, name), relative ? `${relative}/${name}` : name);
    }
  }
  visit(root, "");
  return values;
}

function schemaPayload(role, policy, variant) {
  if (policy.mediaType === "application/json") {
    if (role === "evidenceManifest") {
      throw new Error("evidence manifest is constructed separately");
    }
    const value = {
      role,
      variant,
    };
    if (policy.payloadSchema !== null) value.schema = policy.payloadSchema;
    return canonical(value);
  }
  return Buffer.from(`${role}:${variant}\n`, "utf8");
}

function buildArchiveFixture({
  root = temporaryRoot(),
  variant = "one",
  runId = "101",
  runAttempt = "1",
  requestNonce = digest("request-nonce"),
  rawLabels = ["unit", "gherkin", "mutation"],
} = {}) {
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  const rawArtifacts = rawLabels
    .map((label) =>
      proofStore.storeBlob(store, {
        bytes: Buffer.from(`raw:${label}:${variant}\n`, "utf8"),
        mediaType: "application/octet-stream",
        payloadSchema: null,
      }).reference,
    )
    .sort((left, right) => left.address.localeCompare(right.address));
  const externalEvidence = rawArtifacts.map((reference) => ({
    address: reference.address,
    sha256: reference.address.slice(7),
    byteLength: reference.byteLength,
  }));
  const roles = {};
  for (const role of proofStore.ARCHIVE_ROLE_NAMES) {
    const policy = proofStore.ARCHIVE_ROLE_TABLE[role];
    const bytes =
      role === "evidenceManifest"
        ? canonical(externalEvidence)
        : schemaPayload(role, policy, variant);
    roles[role] = proofStore.storeBlob(store, {
      bytes,
      mediaType: policy.mediaType,
      payloadSchema: policy.payloadSchema,
    }).reference;
  }
  const manifest = {
    schema: proofStore.ARCHIVE_ROOT_SCHEMA,
    proofStoreIdentitySha256: proofStore.proofStoreIdentitySha256(store),
    repository: "demo-maintainer/Pikiio-app-",
    phaseId: "GOV-00",
    authorityCommit: commit("a"),
    scopeBaseCommit: commit("b"),
    candidateCommit: commit("c"),
    requestNonce,
    run: {
      runId,
      runAttempt,
    },
    roles,
    rawArtifacts,
    bindings: {
      externalPackageHash: digest(`package:${variant}`),
      certificationHash: digest(`certification:${variant}`),
      attestationBodySha256: digest(`attestation:${variant}`),
      qualityVerdictHash: digest(`verdict:${variant}`),
      evidenceManifestSha256: proofStore.sha256(
        Buffer.from(proofStore.stableJson(externalEvidence), "utf8"),
      ),
      rawArtifactSetSha256:
        proofStore.rawArtifactSetSha256(rawArtifacts),
      replayKeySha256: digest(`replay:${variant}`),
      trustedAuthoritySha256: digest(`authority:${variant}`),
      jwksRegistrySha256: digest(`jwks:${variant}`),
      toolchainSha256: digest(`toolchain:${variant}`),
      authorityPolicySha256: digest(`policy:${variant}`),
    },
    transport: {
      artifactId: "9001",
      artifactDigest: `sha256:${digest(`transport:${variant}`)}`,
      runId,
      runAttempt,
    },
    productionAuthority: false,
  };
  const archive = proofStore.storeArchiveRoot(store, manifest);
  return {
    root,
    store,
    rawArtifacts,
    externalEvidence,
    roles,
    manifest,
    archiveRoot: archive.archiveRoot,
  };
}

test("canonical serialization, layout, and fixed-root policy are deterministic", () => {
  assert.equal(
    proofStore.stableJson({ z: 1, a: [true, null, "x"] }),
    '{"a":[true,null,"x"],"z":1}',
  );
  assert.deepEqual(
    proofStore.canonicalJsonBytes({ b: 2, a: 1 }),
    Buffer.from('{"a":1,"b":2}\n'),
  );
  assert.match(proofStore.LAYOUT_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(
    proofStore.LAYOUT_SHA256,
    proofStore.sha256(proofStore.canonicalJsonBytes(proofStore.LAYOUT)),
  );
  assert.equal(Object.isFrozen(proofStore.LAYOUT), true);
  assert.equal(Object.isFrozen(proofStore.ARCHIVE_ROLE_TABLE), true);
  assert.deepEqual(
    proofStore.ARCHIVE_ROLE_NAMES,
    Object.keys(proofStore.ARCHIVE_ROLE_TABLE),
  );
  assert.equal(
    proofStore.canonicalProofStoreRoot(),
    path.join(
      fs.realpathSync(os.userInfo().homedir),
      ".codex",
      "runtime",
      "pikiio-agent",
      "proof-store-v1",
    ),
  );

  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [undefined, Number.NaN, Infinity, -0, cyclic, new Date()]) {
    expectCode(() => proofStore.stableJson(value), "NON_CANONICAL_JSON");
  }
  expectCode(
    () => proofStore.canonicalJsonBytes("x".repeat(100), 8),
    "JSON_SIZE_INVALID",
  );
  expectCode(
    () => proofStore.rawArtifactSetSha256(null),
    "RAW_ARTIFACT_SET_INVALID",
  );
  expectCode(
    () => proofStore.initializeIsolatedNonAuthorizingTestStore("relative"),
    "INVALID_PATH",
  );
});

test("read-only open never initializes an empty or missing isolated store", () => {
  const empty = temporaryRoot("pikiio-proof-store-empty-");
  const before = recursiveSnapshot(empty);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(empty),
    "FILE_UNREADABLE",
  );
  assert.deepEqual(recursiveSnapshot(empty), before);

  const missing = path.join(os.tmpdir(), `pikiio-missing-${cryptoId()}`);
  assert.equal(fs.existsSync(missing), false);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(missing),
    "DIRECTORY_UNREADABLE",
  );
  assert.equal(fs.existsSync(missing), false);

  const nonempty = temporaryRoot("pikiio-proof-store-nonempty-");
  fs.writeFileSync(path.join(nonempty, "attacker"), "x");
  expectCode(
    () => proofStore.initializeIsolatedNonAuthorizingTestStore(nonempty),
    "GENESIS_PREIMAGE_NOT_EMPTY",
  );
  assert.deepEqual(fs.readdirSync(nonempty), ["attacker"]);
});

function cryptoId() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPath(filePath, maximumMilliseconds = 10_000) {
  const deadline = Date.now() + maximumMilliseconds;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(10);
  }
}

async function waitForJson(filePath, maximumMilliseconds = 10_000) {
  const deadline = Date.now() + maximumMilliseconds;
  while (true) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (
        error.code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for complete JSON at ${filePath}`);
      }
      await delay(10);
    }
  }
}

function spawnCaptured(argumentsList) {
  const child = childProcess.spawn(process.execPath, argumentsList, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
  return { child, completion };
}

function genesisStagePath(
  root,
  pid,
  nonce = "00000000-0000-4000-8000-000000000000",
) {
  return path.join(
    root,
    `.genesis.json.publish-stage.${pid}.${nonce}.tmp`,
  );
}

function killCaptured(spawned) {
  if (
    spawned &&
    spawned.child.exitCode === null &&
    spawned.child.signalCode === null
  ) {
    spawned.child.kill("SIGKILL");
  }
}

test("concurrent first initialization waits on sealed live genesis and converges", async () => {
  const root = temporaryRoot("pikiio-proof-store-concurrent-genesis-");
  const control = temporaryRoot("pikiio-genesis-live-barrier-");
  const marker = path.join(control, "sealed");
  const release = path.join(control, "release");
  const modulePath = path.resolve(__dirname, "../lib/pikiio-proof-store.js");
  const heldSource = `
    "use strict";
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[2];
    const marker = process.argv[3];
    const release = process.argv[4];
    const originalLink = fs.linkSync;
    const waitWord = new Int32Array(new SharedArrayBuffer(4));
    let held = false;
    fs.linkSync = function (source, target) {
      if (!held && path.basename(String(target)) === "genesis.json") {
        held = true;
        const stat = fs.lstatSync(source, { bigint: true });
        fs.writeFileSync(marker, JSON.stringify({
          source,
          mode: (stat.mode & 0o777n).toString(8),
          links: stat.nlink.toString()
        }), { flag: "wx" });
        while (!fs.existsSync(release)) Atomics.wait(waitWord, 0, 0, 5);
      }
      return originalLink.call(fs, source, target);
    };
    const p = require(process.argv[1]);
    const store = p.initializeIsolatedNonAuthorizingTestStore(root);
    process.stdout.write(JSON.stringify({
      identity: p.proofStoreIdentitySha256(store),
      mode: store.mode,
      builderAuthority: store.builderAuthority,
      productionAuthority: store.productionAuthority
    }));
  `;
  const normalSource = `
    "use strict";
    const p = require(process.argv[1]);
    const store = p.initializeIsolatedNonAuthorizingTestStore(process.argv[2]);
    process.stdout.write(JSON.stringify({
      identity: p.proofStoreIdentitySha256(store),
      mode: store.mode,
      builderAuthority: store.builderAuthority,
      productionAuthority: store.productionAuthority
    }));
  `;
  let publisher = null;
  let contender = null;
  try {
    publisher = spawnCaptured([
      "-e",
      heldSource,
      modulePath,
      root,
      marker,
      release,
    ]);
    const held = await waitForJson(marker);
    assert.equal(held.mode, "400");
    assert.equal(held.links, "1");
    assert.equal(path.dirname(held.source), root);
    assert.deepEqual(fs.readdirSync(root), [path.basename(held.source)]);

    contender = spawnCaptured(["-e", normalSource, modulePath, root]);
    let contenderSettled = false;
    contender.completion.then(() => {
      contenderSettled = true;
    });
    await delay(150);
    assert.equal(contenderSettled, false);
    fs.writeFileSync(release, "release", { flag: "wx" });

    const [publisherResult, contenderResult] = await Promise.all([
      publisher.completion,
      contender.completion,
    ]);
    assert.equal(publisherResult.status, 0, publisherResult.stderr);
    assert.equal(contenderResult.status, 0, contenderResult.stderr);
    const outputs = [
      JSON.parse(publisherResult.stdout),
      JSON.parse(contenderResult.stdout),
    ];
    assert.equal(new Set(outputs.map((entry) => entry.identity)).size, 1);
    assert.equal(
      outputs.every(
        (entry) =>
          entry.mode === "isolated_test_foundation_writer_non_authorizing" &&
          entry.builderAuthority === false &&
          entry.productionAuthority === false,
      ),
      true,
    );
    assert.equal(
      fs
        .readdirSync(root)
        .some((name) => name.includes(".publish-stage.")),
      false,
    );
    assert.deepEqual(fs.readdirSync(root).sort(), [
      "genesis.json",
      "indexes",
      "objects",
    ]);
  } finally {
    killCaptured(contender);
    killCaptured(publisher);
    if (!fs.existsSync(release)) fs.writeFileSync(release, "release");
    if (publisher) await publisher.completion;
    if (contender) await contender.completion;
  }
});

test("real pre-link SIGKILL is reader-inert and exactly writer-recoverable", async () => {
  const root = temporaryRoot("pikiio-proof-store-killed-genesis-");
  const control = temporaryRoot("pikiio-genesis-kill-barrier-");
  const marker = path.join(control, "sealed");
  const modulePath = path.resolve(__dirname, "../lib/pikiio-proof-store.js");
  const source = `
    "use strict";
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[2];
    const marker = process.argv[3];
    const originalLink = fs.linkSync;
    const waitWord = new Int32Array(new SharedArrayBuffer(4));
    fs.linkSync = function (source, target) {
      if (path.basename(String(target)) === "genesis.json") {
        const stat = fs.lstatSync(source, { bigint: true });
        fs.writeFileSync(marker, JSON.stringify({
          source,
          mode: (stat.mode & 0o777n).toString(8),
          links: stat.nlink.toString()
        }), { flag: "wx" });
        while (true) Atomics.wait(waitWord, 0, 0, 1_000);
      }
      return originalLink.call(fs, source, target);
    };
    const p = require(process.argv[1]);
    p.initializeIsolatedNonAuthorizingTestStore(root);
  `;
  const worker = spawnCaptured(["-e", source, modulePath, root, marker]);
  try {
    const held = await waitForJson(marker);
    assert.equal(held.mode, "400");
    assert.equal(held.links, "1");
    assert.equal(path.dirname(held.source), root);
    worker.child.kill("SIGKILL");
    const killed = await worker.completion;
    assert.equal(killed.status, null);
    assert.equal(killed.signal, "SIGKILL");

    const names = fs.readdirSync(root);
    assert.deepEqual(names, [path.basename(held.source)]);
    const stageStat = fs.lstatSync(held.source, { bigint: true });
    assert.equal(stageStat.isFile(), true);
    assert.equal(stageStat.isSymbolicLink(), false);
    assert.equal(stageStat.nlink, 1n);
    assert.equal(stageStat.mode & 0o777n, 0o400n);
    const beforeReader = recursiveSnapshot(root);
    expectCode(
      () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
      "FILE_UNREADABLE",
    );
    assert.deepEqual(recursiveSnapshot(root), beforeReader);

    const recovered =
      proofStore.initializeIsolatedNonAuthorizingTestStore(root);
    assert.equal(recovered.builderAuthority, false);
    assert.equal(recovered.productionAuthority, false);
    assert.equal(fs.existsSync(held.source), false);
    assert.deepEqual(fs.readdirSync(root).sort(), [
      "genesis.json",
      "indexes",
      "objects",
    ]);
    assert.match(
      proofStore.proofStoreIdentitySha256(recovered),
      /^[a-f0-9]{64}$/,
    );
  } finally {
    killCaptured(worker);
    await worker.completion;
  }
});

test("ambiguous genesis preimages are refused without mutation", () => {
  const deadPid = 2_147_483_647;
  const validBytes = Buffer.from('{"sealed":"not-truth"}\n', "utf8");

  function assertRefused(setup, code = "GENESIS_PREIMAGE_NOT_EMPTY") {
    const root = temporaryRoot("pikiio-proof-store-bad-genesis-");
    const controls = setup(root) || {};
    const before = recursiveSnapshot(root);
    if (controls.activate) controls.activate();
    try {
      expectCode(
        () => proofStore.initializeIsolatedNonAuthorizingTestStore(root),
        code,
      );
    } finally {
      if (controls.restoreInstrumentation) {
        controls.restoreInstrumentation();
      }
    }
    assert.deepEqual(recursiveSnapshot(root), before);
    if (controls.cleanup) controls.cleanup();
  }

  assertRefused((root) => {
    fs.writeFileSync(path.join(root, "unknown"), validBytes, { mode: 0o400 });
  });
  assertRefused((root) => {
    fs.writeFileSync(
      path.join(root, ".genesis.json.publish-stage.bad.invalid.tmp"),
      validBytes,
      { mode: 0o400 },
    );
  });
  assertRefused((root) => {
    fs.writeFileSync(genesisStagePath(root, deadPid), validBytes, {
      mode: 0o600,
    });
  });
  assertRefused((root) => {
    const stage = genesisStagePath(root, deadPid);
    fs.mkdirSync(stage, { mode: 0o700 });
    fs.chmodSync(stage, 0o400);
  });
  assertRefused((root) => {
    const stage = genesisStagePath(root, deadPid);
    const outside = `${root}-symlink-target`;
    fs.writeFileSync(outside, validBytes, { mode: 0o400 });
    fs.symlinkSync(outside, stage);
    return {
      cleanup() {
        if (fs.existsSync(outside)) fs.unlinkSync(outside);
      },
    };
  });
  assertRefused((root) => {
    fs.writeFileSync(genesisStagePath(root, deadPid), Buffer.alloc(0), {
      mode: 0o400,
    });
  });
  assertRefused((root) => {
    fs.writeFileSync(
      genesisStagePath(root, deadPid),
      Buffer.alloc(64 * 1024 + 1),
      { mode: 0o400 },
    );
  });
  assertRefused((root) => {
    const stage = genesisStagePath(root, deadPid);
    const outside = `${root}-hardlink`;
    fs.writeFileSync(stage, validBytes, { mode: 0o400 });
    fs.linkSync(stage, outside);
    return {
      cleanup() {
        if (fs.existsSync(outside)) fs.unlinkSync(outside);
      },
    };
  });
  assertRefused((root) => {
    fs.writeFileSync(genesisStagePath(root, deadPid), validBytes, {
      mode: 0o400,
    });
    fs.writeFileSync(
      genesisStagePath(
        root,
        deadPid,
        "00000000-0000-4000-8000-000000000001",
      ),
      validBytes,
      { mode: 0o400 },
    );
  });
  assertRefused((root) => {
    const stage = genesisStagePath(root, deadPid);
    fs.writeFileSync(stage, validBytes, { mode: 0o400 });
    const originalLstat = fs.lstatSync;
    let injectForeignOwner = false;
    fs.lstatSync = function (filePath, options) {
      const stat = originalLstat.call(fs, filePath, options);
      if (!injectForeignOwner || String(filePath) !== stage) return stat;
      return new Proxy(stat, {
        get(target, property) {
          if (property === "uid") return target.uid + 1n;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    return {
      activate() {
        injectForeignOwner = true;
      },
      restoreInstrumentation() {
        fs.lstatSync = originalLstat;
      },
    };
  });
  assertRefused(
    (root) => {
      fs.writeFileSync(
        genesisStagePath(root, process.pid),
        validBytes,
        { mode: 0o400 },
      );
      const originalNow = Date.now;
      let instant = originalNow();
      return {
        activate() {
          Date.now = () => {
            instant += 6_000;
            return instant;
          };
        },
        restoreInstrumentation() {
          Date.now = originalNow;
        },
      };
    },
    "PUBLICATION_BUSY",
  );
  assertRefused((root) => {
    const originalLstat = fs.lstatSync;
    let active = false;
    let rootInspections = 0;
    fs.lstatSync = function (filePath, options) {
      const stat = originalLstat.call(fs, filePath, options);
      if (!active || String(filePath) !== root) return stat;
      rootInspections += 1;
      if (rootInspections === 1) return stat;
      return new Proxy(stat, {
        get(target, property) {
          if (property === "ino") return target.ino + 1n;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    return {
      activate() {
        active = true;
      },
      restoreInstrumentation() {
        fs.lstatSync = originalLstat;
      },
    };
  }, "ROOT_CHANGED");
  assertRefused((root) => {
    const originalReadDirectory = fs.readdirSync;
    let active = false;
    fs.readdirSync = function (directory, options) {
      if (active && String(directory) === root) {
        const error = new Error("injected enumeration refusal");
        error.code = "EACCES";
        throw error;
      }
      return originalReadDirectory.call(fs, directory, options);
    };
    return {
      activate() {
        active = true;
      },
      restoreInstrumentation() {
        fs.readdirSync = originalReadDirectory;
      },
    };
  }, "DIRECTORY_UNREADABLE");
  assertRefused((root) => {
    const stage = genesisStagePath(root, deadPid);
    fs.writeFileSync(stage, validBytes, { mode: 0o400 });
    const originalReadDirectory = fs.readdirSync;
    let active = false;
    let enumerations = 0;
    fs.readdirSync = function (directory, options) {
      if (active && String(directory) === root) {
        enumerations += 1;
        if (enumerations === 2) {
          const error = new Error("injected revalidation refusal");
          error.code = "EACCES";
          throw error;
        }
      }
      return originalReadDirectory.call(fs, directory, options);
    };
    return {
      activate() {
        active = true;
      },
      restoreInstrumentation() {
        fs.readdirSync = originalReadDirectory;
      },
    };
  }, "DIRECTORY_UNREADABLE");
  assertRefused((root) => {
    const stage = genesisStagePath(root, deadPid);
    fs.writeFileSync(stage, validBytes, { mode: 0o400 });
    const originalLstat = fs.lstatSync;
    let active = false;
    let stageInspections = 0;
    fs.lstatSync = function (filePath, options) {
      const stat = originalLstat.call(fs, filePath, options);
      if (!active || String(filePath) !== stage) return stat;
      stageInspections += 1;
      if (stageInspections === 1) return stat;
      return new Proxy(stat, {
        get(target, property) {
          if (property === "ctimeNs") return target.ctimeNs + 1n;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    return {
      activate() {
        active = true;
      },
      restoreInstrumentation() {
        fs.lstatSync = originalLstat;
      },
    };
  });
  assertRefused((root) => {
    const stage = genesisStagePath(root, deadPid);
    fs.writeFileSync(stage, validBytes, { mode: 0o400 });
    const originalUnlink = fs.unlinkSync;
    let active = false;
    fs.unlinkSync = function (filePath) {
      if (active && String(filePath) === stage) {
        const error = new Error("injected unlink refusal");
        error.code = "EACCES";
        throw error;
      }
      return originalUnlink.call(fs, filePath);
    };
    return {
      activate() {
        active = true;
      },
      restoreInstrumentation() {
        fs.unlinkSync = originalUnlink;
      },
    };
  }, "PUBLICATION_RECOVERY_FAILED");
  assertRefused((root) => {
    fs.writeFileSync(genesisStagePath(root, deadPid), validBytes, {
      mode: 0o400,
    });
    const originalKill = process.kill;
    let active = false;
    process.kill = function (pid, signal) {
      if (active && pid === deadPid) {
        const error = new Error("injected process probe refusal");
        error.code = "EINVAL";
        throw error;
      }
      return originalKill.call(process, pid, signal);
    };
    return {
      activate() {
        active = true;
      },
      restoreInstrumentation() {
        process.kill = originalKill;
      },
    };
  }, "PUBLICATION_PROCESS_CHECK_FAILED");
});

test("isolated handles are authentic, reopenable, and categorically non-authorizing", () => {
  const root = temporaryRoot();
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  assert.deepEqual(Object.keys(store).sort(), [
    "builderAuthority",
    "mode",
    "productionAuthority",
    "schema",
  ]);
  assert.equal(
    store.mode,
    "isolated_test_foundation_writer_non_authorizing",
  );
  assert.equal(store.builderAuthority, false);
  assert.equal(store.productionAuthority, false);
  const identity = proofStore.proofStoreIdentitySha256(store);
  assert.match(identity, /^[a-f0-9]{64}$/);
  const descriptor = proofStore.describeProofStore(store);
  assert.deepEqual(descriptor, {
    schema: proofStore.STORE_SCHEMA,
    mode: "isolated_test_foundation_writer_non_authorizing",
    proofStoreIdentitySha256: identity,
    builderAuthority: false,
    productionAuthority: false,
  });
  const reopened =
    proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root);
  assert.equal(proofStore.proofStoreIdentitySha256(reopened), identity);
  assert.equal(reopened.mode, "isolated_test_read_only_non_authorizing");
  assert.equal(
    proofStore.initializeIsolatedNonAuthorizingTestStore(root).mode,
    "isolated_test_foundation_writer_non_authorizing",
  );
  expectCode(() => proofStore.describeProofStore({}), "INVALID_STORE_HANDLE");
  expectCode(
    () =>
      proofStore.storeBlob({}, {
        bytes: Buffer.from("x"),
        mediaType: "text/plain",
      }),
    "INVALID_STORE_HANDLE",
  );

  const objects = path.join(root, "objects", "sha256");
  fs.rmSync(objects, { recursive: true });
  const brokenSnapshot = recursiveSnapshot(root);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
    "DIRECTORY_UNREADABLE",
  );
  assert.deepEqual(recursiveSnapshot(root), brokenSnapshot);
  proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  assert.equal(fs.statSync(objects).isDirectory(), true);
});

test("isolated readers cannot mutate, recover, initialize, or upgrade their private capability", () => {
  const fixture = buildArchiveFixture({});
  const reader =
    proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(fixture.root);
  const readableRole = fixture.manifest.roles.externalPackage;
  assert.deepEqual(
    proofStore.readBlob(reader, readableRole),
    proofStore.readBlob(fixture.store, readableRole),
  );
  assert.deepEqual(
    proofStore.readArchiveRoot(reader, fixture.archiveRoot).manifest,
    fixture.manifest,
  );
  assert.equal(
    proofStore.materializeArchiveOffline(reader, fixture.archiveRoot)
      .productionAuthority,
    false,
  );

  const mutators = [
    () =>
      proofStore.storeBlob(reader, {
        bytes: Buffer.from("reader cannot store", "utf8"),
        mediaType: "text/plain",
      }),
    () => proofStore.storeBlob(reader, null),
    () => proofStore.storeArchiveRoot(reader, fixture.manifest),
    () => proofStore.storeArchiveRoot(reader, null),
    () => proofStore.adoptArchiveImport(reader, fixture.archiveRoot),
    () => proofStore.adoptArchiveImport(reader, null),
  ];
  for (const mutate of mutators) {
    const before = recursiveSnapshot(fixture.root);
    expectCode(mutate, "PROOF_STORE_READ_ONLY");
    assert.deepEqual(recursiveSnapshot(fixture.root), before);
  }

  assert.equal(
    Reflect.set(
      reader,
      "mode",
      "isolated_test_foundation_writer_non_authorizing",
    ),
    false,
  );
  const forgedHandles = [
    { ...reader },
    Object.freeze({
      ...reader,
      mode: "isolated_test_foundation_writer_non_authorizing",
    }),
    Object.create(reader),
    Object.assign(Object.create(null), reader),
    Object.freeze({ ...fixture.store }),
  ];
  for (const forged of forgedHandles) {
    const before = recursiveSnapshot(fixture.root);
    expectCode(
      () =>
        proofStore.storeBlob(forged, {
          bytes: Buffer.from("forged", "utf8"),
          mediaType: "text/plain",
        }),
      "INVALID_STORE_HANDLE",
    );
    assert.deepEqual(recursiveSnapshot(fixture.root), before);
  }

  const staleReader =
    proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(fixture.root);
  const writerResult = proofStore.storeBlob(fixture.store, {
    bytes: Buffer.from("writer-only addition", "utf8"),
    mediaType: "text/plain",
  });
  assert.deepEqual(
    proofStore.readBlob(staleReader, writerResult.reference),
    Buffer.from("writer-only addition", "utf8"),
  );
  const afterWriter = recursiveSnapshot(fixture.root);
  expectCode(
    () =>
      proofStore.storeBlob(staleReader, {
        bytes: Buffer.from("stale reader mutation", "utf8"),
        mediaType: "text/plain",
      }),
    "PROOF_STORE_READ_ONLY",
  );
  assert.deepEqual(recursiveSnapshot(fixture.root), afterWriter);

  const reopened =
    proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(fixture.root);
  const reopenedSnapshot = recursiveSnapshot(fixture.root);
  expectCode(
    () => proofStore.adoptArchiveImport(reopened, fixture.archiveRoot),
    "PROOF_STORE_READ_ONLY",
  );
  assert.deepEqual(recursiveSnapshot(fixture.root), reopenedSnapshot);
});

test("canonical readers are read-only under a redirected non-live account home", () => {
  const accountHome = temporaryRoot("pikiio-proof-canonical-test-");
  let parent = accountHome;
  for (const component of [".codex", "runtime", "pikiio-agent"]) {
    parent = path.join(parent, component);
    fs.mkdirSync(parent, { mode: 0o700 });
    fs.chmodSync(parent, 0o700);
  }
  const originalUserInfo = os.userInfo;
  os.userInfo = () => ({
    ...originalUserInfo(),
    homedir: accountHome,
  });
  try {
    const writer = proofStore.initializeCanonicalProofStoreFoundation();
    assert.equal(
      writer.mode,
      "canonical_foundation_writer_non_authorizing",
    );
    const stored = proofStore.storeBlob(writer, {
      bytes: Buffer.from("canonical redirected fixture", "utf8"),
      mediaType: "text/plain",
    });
    const reader = proofStore.openCanonicalProofStoreReadOnly();
    assert.equal(reader.mode, "canonical_read_only_non_authorizing");
    assert.deepEqual(
      proofStore.readBlob(reader, stored.reference),
      Buffer.from("canonical redirected fixture", "utf8"),
    );
    const canonicalRoot = proofStore.canonicalProofStoreRoot();
    for (const mutate of [
      () =>
        proofStore.storeBlob(reader, {
          bytes: Buffer.from("refused", "utf8"),
          mediaType: "text/plain",
        }),
      () => proofStore.storeArchiveRoot(reader, null),
      () => proofStore.adoptArchiveImport(reader, null),
    ]) {
      const before = recursiveSnapshot(canonicalRoot);
      expectCode(mutate, "PROOF_STORE_READ_ONLY");
      assert.deepEqual(recursiveSnapshot(canonicalRoot), before);
    }
  } finally {
    os.userInfo = originalUserInfo;
  }
});

test("exact-byte CAS rejects arbitrary and logical addresses and preserves byte identity", () => {
  const root = temporaryRoot();
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  const bytes = Buffer.from('{"answer":42}\n', "utf8");
  const expectedSha256 = proofStore.sha256(bytes);
  const first = proofStore.storeBlob(store, {
    bytes,
    mediaType: "application/json",
    payloadSchema: null,
    expectedSha256,
  });
  assert.equal(first.created, true);
  assert.equal(first.reference.address, `sha256:${expectedSha256}`);
  assert.equal(first.builderAuthority, false);
  assert.deepEqual(proofStore.readBlob(store, first.reference), bytes);
  const repeated = proofStore.storeBlob(store, {
    bytes: new Uint8Array(bytes),
    mediaType: "application/json",
    payloadSchema: null,
    expectedSha256,
  });
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.reference, first.reference);

  expectCode(
    () =>
      proofStore.storeBlob(store, {
        bytes,
        mediaType: "application/json",
        expectedSha256: digest("arbitrary-key"),
      }),
    "BYTE_ADDRESS_MISMATCH",
  );
  const logicalHash = proofStore.sha256(
    Buffer.from(proofStore.stableJson({ answer: 42 }), "utf8"),
  );
  assert.notEqual(logicalHash, expectedSha256);
  expectCode(
    () =>
      proofStore.storeBlob(store, {
        bytes,
        mediaType: "application/json",
        expectedSha256: logicalHash,
      }),
    "BYTE_ADDRESS_MISMATCH",
  );

  const compact = proofStore.storeBlob(store, {
    bytes: Buffer.from('{"answer":42}', "utf8"),
    mediaType: "application/json",
  }).reference;
  const spaced = proofStore.storeBlob(store, {
    bytes: Buffer.from('{ "answer": 42 }\n', "utf8"),
    mediaType: "application/json",
  }).reference;
  assert.notEqual(compact.address, first.reference.address);
  assert.notEqual(spaced.address, first.reference.address);
  assert.notEqual(compact.address, spaced.address);
});

test("blob-reference and storage scalar boundaries fail closed", () => {
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(
    temporaryRoot(),
  );
  const valid = proofStore.storeBlob(store, {
    bytes: Buffer.from("proof"),
    mediaType: "text/plain",
  }).reference;
  assert.deepEqual(proofStore.validateBlobReference(valid), valid);

  const invalidReferences = [
    [{ ...valid, extra: true }, "UNEXPECTED_FIELDS"],
    [{ ...valid, schema: "v0" }, "BLOB_REFERENCE_SCHEMA_INVALID"],
    [{ ...valid, address: "md5:deadbeef" }, "BLOB_ADDRESS_INVALID"],
    [{ ...valid, address: "sha256:bad" }, "INVALID_SHA256"],
    [{ ...valid, byteLength: 0 }, "BLOB_LENGTH_INVALID"],
    [{ ...valid, byteLength: proofStore.MAX_BLOB_BYTES + 1 }, "BLOB_LENGTH_INVALID"],
    [{ ...valid, mediaType: "bad type" }, "BLOB_MEDIA_TYPE_INVALID"],
    [{ ...valid, payloadSchema: "BAD" }, "BLOB_PAYLOAD_SCHEMA_INVALID"],
  ];
  for (const [value, code] of invalidReferences) {
    expectCode(() => proofStore.validateBlobReference(value), code);
  }

  for (const value of [null, Buffer.alloc(0), "string"]) {
    expectCode(
      () =>
        proofStore.storeBlob(store, {
          bytes: value,
          mediaType: "text/plain",
        }),
      "INVALID_BYTES",
    );
  }
  expectCode(
    () =>
      proofStore.storeBlob(store, {
        bytes: Buffer.from("x"),
        mediaType: "bad",
      }),
    "BLOB_MEDIA_TYPE_INVALID",
  );
  expectCode(
    () =>
      proofStore.storeBlob(store, {
        bytes: Buffer.from("x"),
        mediaType: "text/plain",
        expectedSha256: "bad",
      }),
    "INVALID_SHA256",
  );
});

test("forged paths, collisions, symlinks, and hardlinks cannot change byte-CAS truth", () => {
  const root = temporaryRoot();
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);

  const expected = Buffer.from("expected bytes");
  const expectedHash = proofStore.sha256(expected);
  const collisionDir = path.join(root, "objects", "sha256", expectedHash.slice(0, 2));
  fs.mkdirSync(collisionDir, { mode: 0o700 });
  const collisionPath = path.join(collisionDir, expectedHash);
  fs.writeFileSync(collisionPath, "attacker bytes", { mode: 0o400 });
  expectCode(
    () =>
      proofStore.storeBlob(store, {
        bytes: expected,
        mediaType: "text/plain",
        expectedSha256: expectedHash,
      }),
    "BYTE_CAS_COLLISION",
  );

  const stored = proofStore.storeBlob(store, {
    bytes: Buffer.from("real object"),
    mediaType: "text/plain",
  }).reference;
  const forgedHash = digest("forged-path");
  const forgedDir = path.join(root, "objects", "sha256", forgedHash.slice(0, 2));
  fs.mkdirSync(forgedDir, { mode: 0o700 });
  fs.writeFileSync(path.join(forgedDir, forgedHash), "wrong bytes", {
    mode: 0o400,
  });
  expectCode(
    () =>
      proofStore.readBlob(store, {
        ...stored,
        address: `sha256:${forgedHash}`,
        byteLength: Buffer.byteLength("wrong bytes"),
      }),
    "BYTE_CAS_OBJECT_MISMATCH",
  );

  const symlinkHash = digest("symlink-object");
  const symlinkDir = path.join(root, "objects", "sha256", symlinkHash.slice(0, 2));
  fs.mkdirSync(symlinkDir, { mode: 0o700 });
  const outside = path.join(root, "outside");
  fs.writeFileSync(outside, "outside", { mode: 0o400 });
  fs.symlinkSync(outside, path.join(symlinkDir, symlinkHash));
  expectCode(
    () =>
      proofStore.readBlob(store, {
        ...stored,
        address: `sha256:${symlinkHash}`,
        byteLength: 7,
      }),
    "FILE_IDENTITY_INVALID",
  );

  const storedPath = path.join(
    root,
    "objects",
    "sha256",
    stored.address.slice(7, 9),
    stored.address.slice(7),
  );
  const hardlink = path.join(root, "hardlink");
  fs.linkSync(storedPath, hardlink);
  expectCode(
    () => proofStore.readBlob(store, stored),
    "FILE_IDENTITY_INVALID",
  );
  expectCode(
    () =>
      proofStore.storeBlob(store, {
        bytes: Buffer.from("real object"),
        mediaType: "text/plain",
      }),
    "FILE_IDENTITY_INVALID",
  );
  assert.equal(fs.existsSync(hardlink), true);
  assert.equal(fs.lstatSync(storedPath, { bigint: true }).nlink, 2n);
  fs.unlinkSync(hardlink);

  const invalidStage = path.join(
    path.dirname(storedPath),
    `.${path.basename(storedPath)}.publish-stage.bad.invalid.tmp`,
  );
  fs.linkSync(storedPath, invalidStage);
  expectCode(
    () => proofStore.readBlob(store, stored),
    "FILE_IDENTITY_INVALID",
  );
  fs.unlinkSync(invalidStage);

  const liveStage = path.join(
    path.dirname(storedPath),
    `.${path.basename(storedPath)}.publish-stage.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`,
  );
  fs.linkSync(storedPath, liveStage);
  const busyStartedAt = Date.now();
  expectCode(
    () => proofStore.readBlob(store, stored),
    "PUBLICATION_BUSY",
  );
  assert.equal(Date.now() - busyStartedAt >= 4_500, true);
  assert.equal(fs.existsSync(liveStage), true);
  fs.unlinkSync(liveStage);
  assert.equal(proofStore.readBlob(store, stored).toString(), "real object");
});

test("publication classification refuses decoy stages and excess hardlinks", () => {
  const root = temporaryRoot();
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  const stored = proofStore.storeBlob(store, {
    bytes: Buffer.from("publication classifier", "utf8"),
    mediaType: "text/plain",
  }).reference;
  const target = path.join(
    root,
    "objects",
    "sha256",
    stored.address.slice(7, 9),
    stored.address.slice(7),
  );
  const decoy = path.join(
    path.dirname(target),
    `.${path.basename(target)}.publish-stage.2147483647.00000000-0000-4000-8000-000000000000.tmp`,
  );
  const firstLink = `${root}-persistent-link-one`;
  fs.writeFileSync(decoy, "different inode", { mode: 0o400 });
  fs.linkSync(target, firstLink);
  const decoySnapshot = recursiveSnapshot(root);
  expectCode(() => proofStore.readBlob(store, stored), "FILE_IDENTITY_INVALID");
  assert.deepEqual(recursiveSnapshot(root), decoySnapshot);
  fs.unlinkSync(firstLink);
  fs.unlinkSync(decoy);

  const secondLink = `${root}-persistent-link-two`;
  const thirdLink = `${root}-persistent-link-three`;
  fs.linkSync(target, secondLink);
  fs.linkSync(target, thirdLink);
  const fanoutSnapshot = recursiveSnapshot(root);
  expectCode(() => proofStore.readBlob(store, stored), "FILE_IDENTITY_INVALID");
  assert.deepEqual(recursiveSnapshot(root), fanoutSnapshot);
  fs.unlinkSync(secondLink);
  fs.unlinkSync(thirdLink);

  const stage = path.join(
    path.dirname(target),
    `.${path.basename(target)}.publish-stage.2147483647.00000000-0000-4000-8000-000000000001.tmp`,
  );
  fs.linkSync(target, stage);
  const invalidStageSnapshot = recursiveSnapshot(root);
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function (filePath, options) {
    const stat = originalLstat.call(fs, filePath, options);
    if (String(filePath) !== stage) return stat;
    return new Proxy(stat, {
      get(targetStat, property) {
        if (property === "uid") return targetStat.uid + 1n;
        const value = Reflect.get(targetStat, property, targetStat);
        return typeof value === "function"
          ? value.bind(targetStat)
          : value;
      },
    });
  };
  try {
    expectCode(
      () => proofStore.readBlob(store, stored),
      "FILE_IDENTITY_INVALID",
    );
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.deepEqual(recursiveSnapshot(root), invalidStageSnapshot);
  fs.unlinkSync(stage);

  fs.linkSync(target, stage);
  const changedRecoverySnapshot = recursiveSnapshot(root);
  let stageInspections = 0;
  fs.lstatSync = function (filePath, options) {
    const stat = originalLstat.call(fs, filePath, options);
    if (String(filePath) !== stage) return stat;
    stageInspections += 1;
    if (stageInspections === 1) return stat;
    return new Proxy(stat, {
      get(targetStat, property) {
        if (property === "ctimeNs") return targetStat.ctimeNs + 1n;
        const value = Reflect.get(targetStat, property, targetStat);
        return typeof value === "function"
          ? value.bind(targetStat)
          : value;
      },
    });
  };
  try {
    expectCode(
      () =>
        proofStore.storeBlob(store, {
          bytes: Buffer.from("publication classifier", "utf8"),
          mediaType: "text/plain",
        }),
      "FILE_IDENTITY_INVALID",
    );
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.deepEqual(recursiveSnapshot(root), changedRecoverySnapshot);

  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function (filePath) {
    if (String(filePath) === stage) {
      const error = new Error("injected post-link recovery refusal");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlink.call(fs, filePath);
  };
  try {
    expectCode(
      () =>
        proofStore.storeBlob(store, {
          bytes: Buffer.from("publication classifier", "utf8"),
          mediaType: "text/plain",
        }),
      "PUBLICATION_RECOVERY_FAILED",
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.deepEqual(recursiveSnapshot(root), changedRecoverySnapshot);
  fs.unlinkSync(stage);
});

test("genesis, directory, permissions, and same-path replacement are bound", () => {
  const root = temporaryRoot();
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  const identity = proofStore.proofStoreIdentitySha256(store);
  const genesis = fs.readFileSync(path.join(root, "genesis.json"));

  fs.chmodSync(root, 0o755);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
    "DIRECTORY_IDENTITY_INVALID",
  );
  fs.chmodSync(root, 0o700);

  fs.chmodSync(path.join(root, "genesis.json"), 0o600);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
    "FILE_IDENTITY_INVALID",
  );
  fs.chmodSync(path.join(root, "genesis.json"), 0o400);

  const originalGenesis = JSON.parse(genesis.toString("utf8"));
  function replaceGenesis(value) {
    const genesisPath = path.join(root, "genesis.json");
    fs.chmodSync(genesisPath, 0o600);
    fs.writeFileSync(genesisPath, canonical(value));
    fs.chmodSync(genesisPath, 0o400);
  }
  const invalidLayout = clone(originalGenesis);
  invalidLayout.layoutSha256 = digest("wrong-layout");
  replaceGenesis(invalidLayout);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
    "GENESIS_LAYOUT_MISMATCH",
  );
  const invalidIdentity = clone(originalGenesis);
  invalidIdentity.ownerUid = "01";
  replaceGenesis(invalidIdentity);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
    "GENESIS_IDENTITY_INVALID",
  );
  const invalidTimestamp = clone(originalGenesis);
  invalidTimestamp.createdAt = "not-a-time";
  replaceGenesis(invalidTimestamp);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
    "INVALID_TIMESTAMP",
  );
  replaceGenesis(originalGenesis);

  const alias = `${root}-alias`;
  fs.symlinkSync(root, alias);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(alias),
    "DIRECTORY_IDENTITY_INVALID",
  );

  const moved = `${root}-original`;
  fs.renameSync(root, moved);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "genesis.json"), genesis, { mode: 0o400 });
  fs.mkdirSync(path.join(root, "objects"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "objects", "sha256"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "indexes"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "indexes", "import"), { mode: 0o700 });
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
    "GENESIS_IDENTITY_MISMATCH",
  );
  fs.rmSync(root, { recursive: true });
  fs.renameSync(moved, root);
  assert.equal(proofStore.proofStoreIdentitySha256(store), identity);

  const copied = temporaryRoot();
  fs.writeFileSync(path.join(copied, "genesis.json"), genesis, { mode: 0o400 });
  fs.mkdirSync(path.join(copied, "objects"), { mode: 0o700 });
  fs.mkdirSync(path.join(copied, "objects", "sha256"), { mode: 0o700 });
  fs.mkdirSync(path.join(copied, "indexes"), { mode: 0o700 });
  fs.mkdirSync(path.join(copied, "indexes", "import"), { mode: 0o700 });
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(copied),
    "GENESIS_IDENTITY_MISMATCH",
  );

  const objects = path.join(root, "objects");
  const realObjects = `${objects}-real`;
  fs.renameSync(objects, realObjects);
  fs.symlinkSync(realObjects, objects);
  expectCode(
    () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
    "DIRECTORY_IDENTITY_INVALID",
  );
});

test("root descriptor failures and post-open identity drift fail closed", () => {
  const root = temporaryRoot();
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  const before = recursiveSnapshot(root);

  const originalFstat = fs.fstatSync;
  let refuseFstat = true;
  fs.fstatSync = function (descriptor, options) {
    if (refuseFstat) {
      const error = new Error("injected descriptor refusal");
      error.code = "EIO";
      throw error;
    }
    return originalFstat.call(fs, descriptor, options);
  };
  try {
    expectCode(
      () => proofStore.proofStoreIdentitySha256(store),
      "ROOT_HANDLE_INVALID",
    );
  } finally {
    refuseFstat = false;
    fs.fstatSync = originalFstat;
  }
  assert.deepEqual(recursiveSnapshot(root), before);

  fs.fstatSync = function (descriptor, options) {
    const stat = originalFstat.call(fs, descriptor, options);
    if (!stat.isDirectory()) return stat;
    return new Proxy(stat, {
      get(target, property) {
        if (property === "ino") return target.ino + 1n;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  try {
    expectCode(
      () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
      "ROOT_CHANGED",
    );
  } finally {
    fs.fstatSync = originalFstat;
  }
  assert.deepEqual(recursiveSnapshot(root), before);

  const originalOpen = fs.openSync;
  fs.openSync = function (filePath, flags, mode) {
    if (String(filePath) === root) {
      const error = new Error("injected root open refusal");
      error.code = "EACCES";
      throw error;
    }
    return originalOpen.call(fs, filePath, flags, mode);
  };
  try {
    expectCode(
      () => proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root),
      "ROOT_HANDLE_INVALID",
    );
  } finally {
    fs.openSync = originalOpen;
  }
  assert.deepEqual(recursiveSnapshot(root), before);

  const genesisPath = path.join(root, "genesis.json");
  const changedGenesis = JSON.parse(fs.readFileSync(genesisPath, "utf8"));
  changedGenesis.nonce = digest("post-open-genesis-replacement");
  fs.chmodSync(genesisPath, 0o600);
  fs.writeFileSync(genesisPath, canonical(changedGenesis));
  fs.chmodSync(genesisPath, 0o400);
  expectCode(
    () => proofStore.proofStoreIdentitySha256(store),
    "ROOT_CHANGED",
  );
});

test("complete archive stores, reads, imports, and materializes offline without authority", () => {
  const fixture = buildArchiveFixture({});
  const before = recursiveSnapshot(fixture.root);
  const validated = proofStore.validateArchiveRootManifest(
    fixture.store,
    fixture.manifest,
  );
  assert.equal(validated.builderAuthority, false);
  assert.equal(validated.productionAuthority, false);
  const archive = proofStore.readArchiveRoot(
    fixture.store,
    fixture.archiveRoot,
  );
  assert.deepEqual(archive.manifest, fixture.manifest);
  assert.deepEqual(
    archive.bytes,
    proofStore.canonicalJsonBytes(fixture.manifest),
  );

  const materialized = proofStore.materializeArchiveOffline(
    fixture.store,
    fixture.archiveRoot,
  );
  assert.equal(
    materialized.schema,
    proofStore.OFFLINE_MATERIALIZATION_SCHEMA,
  );
  assert.equal(materialized.historicalEvidenceOnly, true);
  assert.equal(materialized.builderAuthority, false);
  assert.equal(materialized.productionAuthority, false);
  assert.deepEqual(
    Object.keys(materialized.roles),
    proofStore.ARCHIVE_ROLE_NAMES,
  );
  assert.equal(
    materialized.rawArtifacts.length,
    fixture.rawArtifacts.length,
  );
  assert.deepEqual(recursiveSnapshot(fixture.root), before);

  const first = proofStore.adoptArchiveImport(
    fixture.store,
    fixture.archiveRoot,
  );
  assert.equal(first.created, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.builderAuthority, false);
  const repeated = proofStore.adoptArchiveImport(
    fixture.store,
    fixture.archiveRoot,
  );
  assert.equal(repeated.created, false);
  assert.equal(repeated.idempotent, true);
  assert.deepEqual(repeated.index, first.index);
  const readBack = proofStore.readImportIndex(
    fixture.store,
    first.index.importKeySha256,
  );
  assert.deepEqual(readBack.index, first.index);
  assert.equal(readBack.indexByteSha256, first.indexByteSha256);
  assert.equal(
    proofStore.deriveImportKeySha256(fixture.manifest),
    first.index.importKeySha256,
  );
});

test("archive shape and scalar sabotage fail closed", () => {
  const fixture = buildArchiveFixture({});
  const cases = [
    [
      (value) => {
        value.extra = true;
      },
      "UNEXPECTED_FIELDS",
    ],
    [
      (value) => {
        value.schema = "v0";
      },
      "ARCHIVE_AUTHORITY_INVALID",
    ],
    [
      (value) => {
        value.repository = "attacker/repo";
      },
      "ARCHIVE_AUTHORITY_INVALID",
    ],
    [
      (value) => {
        value.productionAuthority = true;
      },
      "ARCHIVE_AUTHORITY_INVALID",
    ],
    [
      (value) => {
        value.proofStoreIdentitySha256 = "bad";
      },
      "INVALID_SHA256",
    ],
    [
      (value) => {
        value.phaseId = "BAD";
      },
      "ARCHIVE_PHASE_INVALID",
    ],
    [
      (value) => {
        value.authorityCommit = "bad";
      },
      "INVALID_COMMIT",
    ],
    [
      (value) => {
        value.scopeBaseCommit = value.authorityCommit;
      },
      "ARCHIVE_COMMIT_ROLE_COLLISION",
    ],
    [
      (value) => {
        value.candidateCommit = value.scopeBaseCommit;
      },
      "ARCHIVE_COMMIT_ROLE_COLLISION",
    ],
    [
      (value) => {
        value.candidateCommit = value.authorityCommit;
      },
      "ARCHIVE_COMMIT_ROLE_COLLISION",
    ],
    [
      (value) => {
        value.requestNonce = "bad";
      },
      "INVALID_SHA256",
    ],
    [
      (value) => {
        value.run.runId = "01";
      },
      "ARCHIVE_RUN_INVALID",
    ],
    [
      (value) => {
        delete value.roles.request;
      },
      "UNEXPECTED_FIELDS",
    ],
    [
      (value) => {
        value.rawArtifacts = [];
      },
      "RAW_ARTIFACT_SET_INVALID",
    ],
    [
      (value) => {
        value.rawArtifacts.reverse();
      },
      "RAW_ARTIFACT_SET_INVALID",
    ],
    [
      (value) => {
        value.bindings.toolchainSha256 = "bad";
      },
      "INVALID_SHA256",
    ],
    [
      (value) => {
        value.bindings.rawArtifactSetSha256 = digest("wrong");
      },
      "RAW_ARTIFACT_SET_HASH_MISMATCH",
    ],
    [
      (value) => {
        value.transport.artifactId = "0";
      },
      "ARCHIVE_TRANSPORT_INVALID",
    ],
    [
      (value) => {
        value.transport.artifactDigest = "sha256:bad";
      },
      "INVALID_SHA256",
    ],
    [
      (value) => {
        value.transport.runAttempt = "2";
      },
      "ARCHIVE_TRANSPORT_INVALID",
    ],
  ];
  for (const [mutate, code] of cases) {
    const changed = clone(fixture.manifest);
    mutate(changed);
    expectCode(
      () => proofStore.validateArchiveRootManifest(fixture.store, changed),
      code,
    );
  }
});

test("wrong role, wrong payload schema, and foreign store identity fail", () => {
  const fixture = buildArchiveFixture({});
  const swapped = clone(fixture.manifest);
  swapped.roles.request = swapped.roles.materialization;
  expectCode(
    () => proofStore.validateArchiveRootManifest(fixture.store, swapped),
    "ARCHIVE_ROLE_TYPE_MISMATCH",
  );

  const wrongRequest = proofStore.storeBlob(fixture.store, {
    bytes: canonical({
      schema: "pikiio-external-ci-materialization-v3",
      role: "request",
    }),
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-request-v3",
  }).reference;
  const wrongPayload = clone(fixture.manifest);
  wrongPayload.roles.request = wrongRequest;
  expectCode(
    () =>
      proofStore.validateArchiveRootManifest(
        fixture.store,
        wrongPayload,
      ),
    "ARCHIVE_ROLE_PAYLOAD_SCHEMA_MISMATCH",
  );

  const invalidJson = proofStore.storeBlob(fixture.store, {
    bytes: Buffer.from("{"),
    mediaType: "application/json",
    payloadSchema: "pikiio-external-ci-request-v3",
  }).reference;
  const badJson = clone(fixture.manifest);
  badJson.roles.request = invalidJson;
  expectCode(
    () => proofStore.validateArchiveRootManifest(fixture.store, badJson),
    "ARCHIVE_ROLE_JSON_INVALID",
  );

  const foreign = buildArchiveFixture({ variant: "foreign" });
  expectCode(
    () =>
      proofStore.validateArchiveRootManifest(
        fixture.store,
        foreign.manifest,
      ),
    "ARCHIVE_STORE_IDENTITY_MISMATCH",
  );
});

test("missing, extra, reordered, malformed, or hash-divergent raw evidence fails", () => {
  const fixture = buildArchiveFixture({});

  const missing = clone(fixture.manifest);
  missing.rawArtifacts.pop();
  missing.bindings.rawArtifactSetSha256 =
    proofStore.rawArtifactSetSha256(missing.rawArtifacts);
  expectCode(
    () => proofStore.validateArchiveRootManifest(fixture.store, missing),
    "RAW_ARTIFACT_SET_MISMATCH",
  );

  const extraRef = proofStore.storeBlob(fixture.store, {
    bytes: Buffer.from("extra evidence"),
    mediaType: "application/octet-stream",
  }).reference;
  const extra = clone(fixture.manifest);
  extra.rawArtifacts.push(extraRef);
  extra.rawArtifacts.sort((left, right) =>
    left.address.localeCompare(right.address),
  );
  extra.bindings.rawArtifactSetSha256 =
    proofStore.rawArtifactSetSha256(extra.rawArtifacts);
  expectCode(
    () => proofStore.validateArchiveRootManifest(fixture.store, extra),
    "RAW_ARTIFACT_SET_MISMATCH",
  );

  const wrongEvidenceHash = clone(fixture.manifest);
  wrongEvidenceHash.bindings.evidenceManifestSha256 = digest("wrong");
  expectCode(
    () =>
      proofStore.validateArchiveRootManifest(
        fixture.store,
        wrongEvidenceHash,
      ),
    "EVIDENCE_MANIFEST_HASH_MISMATCH",
  );

  const malformedEntries = [
    [{ address: "bad", sha256: "bad", byteLength: 1 }, "INVALID_SHA256"],
    [
      {
        address: `sha256:${digest("x")}`,
        sha256: digest("y"),
        byteLength: 1,
      },
      "EVIDENCE_MANIFEST_INVALID",
    ],
    [
      {
        address: `sha256:${digest("x")}`,
        sha256: digest("x"),
        byteLength: 0,
      },
      "EVIDENCE_MANIFEST_INVALID",
    ],
  ];
  for (const [entry, code] of malformedEntries) {
    const role = proofStore.storeBlob(fixture.store, {
      bytes: canonical([entry]),
      mediaType: "application/json",
      payloadSchema: null,
    }).reference;
    const changed = clone(fixture.manifest);
    changed.roles.evidenceManifest = role;
    expectCode(
      () => proofStore.validateArchiveRootManifest(fixture.store, changed),
      code,
    );
  }

  const duplicateManifest = proofStore.storeBlob(fixture.store, {
    bytes: canonical([
      fixture.externalEvidence[0],
      fixture.externalEvidence[0],
    ]),
    mediaType: "application/json",
    payloadSchema: null,
  }).reference;
  const duplicate = clone(fixture.manifest);
  duplicate.roles.evidenceManifest = duplicateManifest;
  expectCode(
    () => proofStore.validateArchiveRootManifest(fixture.store, duplicate),
    "EVIDENCE_MANIFEST_INVALID",
  );

  const emptyManifest = proofStore.storeBlob(fixture.store, {
    bytes: canonical([]),
    mediaType: "application/json",
    payloadSchema: null,
  }).reference;
  const empty = clone(fixture.manifest);
  empty.roles.evidenceManifest = emptyManifest;
  expectCode(
    () => proofStore.validateArchiveRootManifest(fixture.store, empty),
    "EVIDENCE_MANIFEST_INVALID",
  );

  const raw = fixture.rawArtifacts[0];
  const rawPath = path.join(
    fixture.root,
    "objects",
    "sha256",
    raw.address.slice(7, 9),
    raw.address.slice(7),
  );
  fs.unlinkSync(rawPath);
  expectCode(
    () =>
      proofStore.validateArchiveRootManifest(
        fixture.store,
        fixture.manifest,
      ),
    "FILE_UNREADABLE",
  );
});

test("archive-root references and import indexes are typed and immutable", () => {
  const fixture = buildArchiveFixture({});
  const wrongType = {
    ...fixture.archiveRoot,
    payloadSchema: "pikiio-external-ci-package-v3",
  };
  expectCode(
    () => proofStore.readArchiveRoot(fixture.store, wrongType),
    "ARCHIVE_ROOT_TYPE_INVALID",
  );

  const noncanonicalManifest = proofStore.storeBlob(fixture.store, {
    bytes: Buffer.from(
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
      "utf8",
    ),
    mediaType: "application/json",
    payloadSchema: proofStore.ARCHIVE_ROOT_SCHEMA,
  }).reference;
  expectCode(
    () => proofStore.readArchiveRoot(fixture.store, noncanonicalManifest),
    "NON_CANONICAL_JSON_BYTES",
  );

  const adopted = proofStore.adoptArchiveImport(
    fixture.store,
    fixture.archiveRoot,
  );
  const indexPath = path.join(
    fixture.root,
    "indexes",
    "import",
    `${adopted.index.importKeySha256}.json`,
  );
  fs.chmodSync(indexPath, 0o600);
  expectCode(
    () =>
      proofStore.readImportIndex(
        fixture.store,
        adopted.index.importKeySha256,
      ),
    "FILE_IDENTITY_INVALID",
  );
  fs.chmodSync(indexPath, 0o400);
  expectCode(
    () => proofStore.readImportIndex(fixture.store, "bad"),
    "INVALID_SHA256",
  );
});

test("one import key adopts exactly one archive and refuses divergence", () => {
  const root = temporaryRoot();
  const first = buildArchiveFixture({ root, variant: "one" });
  const second = buildArchiveFixture({ root, variant: "two" });
  assert.equal(
    proofStore.deriveImportKeySha256(first.manifest),
    proofStore.deriveImportKeySha256(second.manifest),
  );
  assert.notEqual(first.archiveRoot.address, second.archiveRoot.address);
  proofStore.adoptArchiveImport(first.store, first.archiveRoot);
  expectCode(
    () => proofStore.adoptArchiveImport(second.store, second.archiveRoot),
    "IMPORT_DIVERGENCE",
  );
});

test("concurrent identical import adoption converges without skips or divergence", async () => {
  const fixture = buildArchiveFixture({});
  const modulePath = path.resolve(__dirname, "../lib/pikiio-proof-store.js");
  const encodedReference = Buffer.from(
    JSON.stringify(fixture.archiveRoot),
    "utf8",
  ).toString("base64url");
  const source = `
    "use strict";
    const p = require(process.argv[1]);
    const root = process.argv[2];
    const ref = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
    const store = p.initializeIsolatedNonAuthorizingTestStore(root);
    const result = p.adoptArchiveImport(store, ref);
    process.stdout.write(JSON.stringify({
      created: result.created,
      idempotent: result.idempotent,
      builderAuthority: result.builderAuthority,
      productionAuthority: result.productionAuthority,
      importKeySha256: result.index.importKeySha256
    }));
  `;
  const runs = Array.from({ length: 6 }, () =>
    new Promise((resolve, reject) => {
      const child = childProcess.spawn(
        process.execPath,
        ["-e", source, modulePath, fixture.root, encodedReference],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status !== 0) {
          reject(new Error(`child failed ${status}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout));
      });
    }),
  );
  const results = await Promise.all(runs);
  assert.equal(results.filter((entry) => entry.created).length, 1);
  assert.equal(results.filter((entry) => entry.idempotent).length, 5);
  assert.equal(new Set(results.map((entry) => entry.importKeySha256)).size, 1);
  assert.equal(results.every((entry) => entry.builderAuthority === false), true);
  assert.equal(results.every((entry) => entry.productionAuthority === false), true);
});

test("deterministic held publication makes identical import readers wait, then converge", async () => {
  const fixture = buildArchiveFixture({});
  const modulePath = path.resolve(__dirname, "../lib/pikiio-proof-store.js");
  const encodedReference = Buffer.from(
    JSON.stringify(fixture.archiveRoot),
    "utf8",
  ).toString("base64url");
  const importKey = proofStore.deriveImportKeySha256(fixture.manifest);
  const targetName = `${importKey}.json`;
  const target = path.join(
    fixture.root,
    "indexes",
    "import",
    targetName,
  );
  const control = temporaryRoot("pikiio-publication-barrier-");
  const marker = path.join(control, "published");
  const release = path.join(control, "release");
  const writerSource = `
    "use strict";
    const fs = require("node:fs");
    const path = require("node:path");
    const p = require(process.argv[1]);
    const root = process.argv[2];
    const ref = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
    const targetName = process.argv[4];
    const marker = process.argv[5];
    const release = process.argv[6];
    const originalUnlink = fs.unlinkSync;
    const waitWord = new Int32Array(new SharedArrayBuffer(4));
    let held = false;
    fs.unlinkSync = function (filePath) {
      const name = path.basename(String(filePath));
      if (
        !held &&
        name.startsWith("." + targetName + ".") &&
        name.endsWith(".tmp")
      ) {
        held = true;
        fs.writeFileSync(marker, "published", { flag: "wx" });
        while (!fs.existsSync(release)) Atomics.wait(waitWord, 0, 0, 5);
      }
      return originalUnlink.call(fs, filePath);
    };
    const store = p.initializeIsolatedNonAuthorizingTestStore(root);
    const result = p.adoptArchiveImport(store, ref);
    process.stdout.write(JSON.stringify({
      created: result.created,
      idempotent: result.idempotent
    }));
  `;
  const readerSource = `
    "use strict";
    const p = require(process.argv[1]);
    const root = process.argv[2];
    const ref = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
    try {
      const store = p.initializeIsolatedNonAuthorizingTestStore(root);
      const result = p.adoptArchiveImport(store, ref);
      process.stdout.write(JSON.stringify({
        ok: true,
        created: result.created,
        idempotent: result.idempotent
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
      process.exitCode = 2;
    }
  `;
  const writer = spawnCaptured([
    "-e",
    writerSource,
    modulePath,
    fixture.root,
    encodedReference,
    targetName,
    marker,
    release,
  ]);
  await waitForPath(marker);
  assert.equal(fs.lstatSync(target, { bigint: true }).nlink, 2n);

  const reader = spawnCaptured([
    "-e",
    readerSource,
    modulePath,
    fixture.root,
    encodedReference,
  ]);
  let readerSettled = false;
  reader.completion.then(() => {
    readerSettled = true;
  });
  await delay(150);
  const wasHeldAtBarrier = !readerSettled;
  fs.writeFileSync(release, "release", { flag: "wx" });

  const [writerResult, readerResult] = await Promise.all([
    writer.completion,
    reader.completion,
  ]);
  assert.equal(wasHeldAtBarrier, true);
  assert.equal(writerResult.status, 0, writerResult.stderr);
  assert.equal(readerResult.status, 0, readerResult.stderr);
  assert.deepEqual(JSON.parse(writerResult.stdout), {
    created: true,
    idempotent: false,
  });
  assert.deepEqual(JSON.parse(readerResult.stdout), {
    ok: true,
    created: false,
    idempotent: true,
  });
  assert.equal(fs.lstatSync(target, { bigint: true }).nlink, 1n);
});

test("crash after no-clobber publish is read-only refused and writer-recoverable", async () => {
  const root = temporaryRoot();
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  const bytes = Buffer.from("crash-bound exact bytes", "utf8");
  const objectSha256 = proofStore.sha256(bytes);
  const reference = {
    schema: proofStore.BLOB_REFERENCE_SCHEMA,
    address: `sha256:${objectSha256}`,
    byteLength: bytes.length,
    mediaType: "application/octet-stream",
    payloadSchema: null,
  };
  const targetName = objectSha256;
  const targetDirectory = path.join(
    root,
    "objects",
    "sha256",
    objectSha256.slice(0, 2),
  );
  fs.mkdirSync(targetDirectory, { mode: 0o700 });
  const target = path.join(targetDirectory, targetName);
  const control = temporaryRoot("pikiio-publication-crash-");
  const marker = path.join(control, "published");
  const modulePath = path.resolve(__dirname, "../lib/pikiio-proof-store.js");
  const source = `
    "use strict";
    const fs = require("node:fs");
    const path = require("node:path");
    const p = require(process.argv[1]);
    const root = process.argv[2];
    const bytes = Buffer.from(process.argv[3], "base64url");
    const targetName = process.argv[4];
    const marker = process.argv[5];
    const originalUnlink = fs.unlinkSync;
    const waitWord = new Int32Array(new SharedArrayBuffer(4));
    let crashed = false;
    fs.unlinkSync = function (filePath) {
      const name = path.basename(String(filePath));
      if (
        !crashed &&
        name.startsWith("." + targetName + ".") &&
        name.endsWith(".tmp")
      ) {
        crashed = true;
        fs.writeFileSync(marker, "published", { flag: "wx" });
        process.kill(process.pid, "SIGKILL");
        while (true) Atomics.wait(waitWord, 0, 0, 1_000);
      }
      return originalUnlink.call(fs, filePath);
    };
    const store = p.initializeIsolatedNonAuthorizingTestStore(root);
    p.storeBlob(store, {
      bytes,
      mediaType: "application/octet-stream"
    });
  `;
  const worker = spawnCaptured([
    "-e",
    source,
    modulePath,
    root,
    bytes.toString("base64url"),
    targetName,
    marker,
  ]);
  await waitForPath(marker);
  const crashResult = await worker.completion;
  assert.equal(crashResult.status, null);
  assert.equal(crashResult.signal, "SIGKILL");
  assert.equal(fs.lstatSync(target, { bigint: true }).nlink, 2n);
  const stageNames = fs
    .readdirSync(targetDirectory)
    .filter((name) => name.includes(".publish-stage."));
  assert.equal(stageNames.length, 1);

  const beforeRead = recursiveSnapshot(root);
  const readOnly =
    proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(root);
  expectCode(
    () => proofStore.readBlob(readOnly, reference),
    "PUBLICATION_RECOVERY_REQUIRED",
  );
  assert.deepEqual(recursiveSnapshot(root), beforeRead);
  expectCode(
    () =>
      proofStore.storeBlob(readOnly, {
        bytes,
        mediaType: "application/octet-stream",
      }),
    "PROOF_STORE_READ_ONLY",
  );
  assert.deepEqual(recursiveSnapshot(root), beforeRead);

  const recovered = proofStore.storeBlob(store, {
    bytes,
    mediaType: "application/octet-stream",
  });
  assert.equal(recovered.created, false);
  assert.deepEqual(recovered.reference, reference);
  assert.equal(fs.lstatSync(target, { bigint: true }).nlink, 1n);
  assert.equal(
    fs
      .readdirSync(targetDirectory)
      .filter((name) => name.includes(".publish-stage.")).length,
    0,
  );
  assert.deepEqual(proofStore.readBlob(store, reference), bytes);
});

test("concurrent divergent import adoption permits one winner and refuses the other", async () => {
  const root = temporaryRoot();
  const first = buildArchiveFixture({ root, variant: "concurrent-one" });
  const second = buildArchiveFixture({ root, variant: "concurrent-two" });
  assert.equal(
    proofStore.deriveImportKeySha256(first.manifest),
    proofStore.deriveImportKeySha256(second.manifest),
  );
  const modulePath = path.resolve(__dirname, "../lib/pikiio-proof-store.js");
  const source = `
    "use strict";
    const p = require(process.argv[1]);
    const root = process.argv[2];
    const ref = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
    const store = p.initializeIsolatedNonAuthorizingTestStore(root);
    try {
      const result = p.adoptArchiveImport(store, ref);
      process.stdout.write(JSON.stringify({ ok: true, created: result.created }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
    }
  `;
  const references = [first.archiveRoot, second.archiveRoot];
  const runs = references.map((reference) =>
    new Promise((resolve, reject) => {
      const encodedReference = Buffer.from(
        JSON.stringify(reference),
        "utf8",
      ).toString("base64url");
      const child = childProcess.spawn(
        process.execPath,
        ["-e", source, modulePath, root, encodedReference],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status !== 0) {
          reject(new Error(`child failed ${status}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout));
      });
    }),
  );
  const results = await Promise.all(runs);
  assert.equal(results.filter((entry) => entry.ok).length, 1);
  assert.equal(results.find((entry) => entry.ok).created, true);
  assert.deepEqual(
    results.filter((entry) => !entry.ok).map((entry) => entry.code),
    ["IMPORT_DIVERGENCE"],
  );
});

test("import index path substitution, malformed JSON, and field forgery fail", () => {
  const fixture = buildArchiveFixture({});
  const adopted = proofStore.adoptArchiveImport(
    fixture.store,
    fixture.archiveRoot,
  );
  const imports = path.join(fixture.root, "indexes", "import");
  const originalPath = path.join(
    imports,
    `${adopted.index.importKeySha256}.json`,
  );
  const original = fs.readFileSync(originalPath);

  fs.chmodSync(originalPath, 0o600);
  fs.writeFileSync(originalPath, Buffer.from("{broken\n"));
  fs.chmodSync(originalPath, 0o400);
  expectCode(
    () =>
      proofStore.readImportIndex(
        fixture.store,
        adopted.index.importKeySha256,
      ),
    "INVALID_JSON",
  );

  fs.chmodSync(originalPath, 0o600);
  fs.writeFileSync(originalPath, original);
  fs.chmodSync(originalPath, 0o400);
  const unauthorized = clone(adopted.index);
  unauthorized.builderAuthority = true;
  fs.chmodSync(originalPath, 0o600);
  fs.writeFileSync(
    originalPath,
    proofStore.canonicalJsonBytes(unauthorized),
  );
  fs.chmodSync(originalPath, 0o400);
  expectCode(
    () =>
      proofStore.readImportIndex(
        fixture.store,
        adopted.index.importKeySha256,
      ),
    "IMPORT_INDEX_AUTHORITY_INVALID",
  );

  fs.chmodSync(originalPath, 0o600);
  fs.writeFileSync(originalPath, original);
  fs.chmodSync(originalPath, 0o400);
  const forgedKey = digest("forged-index-path");
  fs.copyFileSync(originalPath, path.join(imports, `${forgedKey}.json`));
  fs.chmodSync(path.join(imports, `${forgedKey}.json`), 0o400);
  expectCode(
    () => proofStore.readImportIndex(fixture.store, forgedKey),
    "IMPORT_KEY_MISMATCH",
  );

  const foreign = clone(adopted.index);
  foreign.proofStoreIdentitySha256 = digest("foreign-store");
  const foreignKey = digest("foreign-index");
  foreign.importKeySha256 = foreignKey;
  fs.writeFileSync(
    path.join(imports, `${foreignKey}.json`),
    proofStore.canonicalJsonBytes(foreign),
    { mode: 0o400 },
  );
  expectCode(
    () => proofStore.readImportIndex(fixture.store, foreignKey),
    "IMPORT_STORE_IDENTITY_MISMATCH",
  );
});

test("handle-bound root fence refuses substitution during import-index read", () => {
  const fixture = buildArchiveFixture({});
  const adopted = proofStore.adoptArchiveImport(
    fixture.store,
    fixture.archiveRoot,
  );
  const reader =
    proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(fixture.root);
  const indexName = `${adopted.index.importKeySha256}.json`;
  const originalIndex = path.join(
    fixture.root,
    "indexes",
    "import",
    indexName,
  );
  const replacement = temporaryRoot("pikiio-proof-store-replacement-");
  fs.mkdirSync(path.join(replacement, "indexes"), { mode: 0o700 });
  fs.mkdirSync(path.join(replacement, "indexes", "import"), { mode: 0o700 });
  fs.copyFileSync(
    originalIndex,
    path.join(replacement, "indexes", "import", indexName),
  );
  fs.chmodSync(
    path.join(replacement, "indexes", "import", indexName),
    0o400,
  );

  const moved = `${fixture.root}-bound-original`;
  const originalLstat = fs.lstatSync;
  let swapped = false;
  let originalAfterSwap = null;
  let replacementAfterSwap = null;
  fs.lstatSync = function (filePath, options) {
    if (!swapped && String(filePath) === originalIndex) {
      swapped = true;
      fs.renameSync(fixture.root, moved);
      fs.renameSync(replacement, fixture.root);
      originalAfterSwap = recursiveSnapshot(moved);
      replacementAfterSwap = recursiveSnapshot(fixture.root);
    }
    return originalLstat.call(fs, filePath, options);
  };
  try {
    expectCode(
      () =>
        proofStore.readImportIndex(
          reader,
          adopted.index.importKeySha256,
        ),
      "ROOT_CHANGED",
    );
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(swapped, true);
  assert.deepEqual(recursiveSnapshot(moved), originalAfterSwap);
  assert.deepEqual(
    recursiveSnapshot(fixture.root),
    replacementAfterSwap,
  );

  /*
   * Node exposes no portable openat(2) path for this synchronous API. The
   * persistent directory descriptor plus before/after physical-identity fence
   * rejects a one-way swap. A same-UID attacker that swaps the original inode
   * away and back wholly between both fences is the explicit residual ABA
   * assumption; this test does not claim otherwise.
   */
});

test("import-index after-fence runs even when replacement bytes are malformed", () => {
  const fixture = buildArchiveFixture({});
  const adopted = proofStore.adoptArchiveImport(
    fixture.store,
    fixture.archiveRoot,
  );
  const reader =
    proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(fixture.root);
  const indexName = `${adopted.index.importKeySha256}.json`;
  const originalIndex = path.join(
    fixture.root,
    "indexes",
    "import",
    indexName,
  );
  const replacement = temporaryRoot(
    "pikiio-proof-store-malformed-replacement-",
  );
  fs.mkdirSync(path.join(replacement, "indexes"), { mode: 0o700 });
  fs.mkdirSync(path.join(replacement, "indexes", "import"), { mode: 0o700 });
  fs.writeFileSync(
    path.join(replacement, "indexes", "import", indexName),
    Buffer.from("{", "utf8"),
    { mode: 0o400 },
  );

  const moved = `${fixture.root}-malformed-bound-original`;
  const originalLstat = fs.lstatSync;
  let swapped = false;
  let originalAfterSwap = null;
  let replacementAfterSwap = null;
  fs.lstatSync = function (filePath, options) {
    if (!swapped && String(filePath) === originalIndex) {
      swapped = true;
      fs.renameSync(fixture.root, moved);
      fs.renameSync(replacement, fixture.root);
      originalAfterSwap = recursiveSnapshot(moved);
      replacementAfterSwap = recursiveSnapshot(fixture.root);
    }
    return originalLstat.call(fs, filePath, options);
  };
  try {
    expectCode(
      () =>
        proofStore.readImportIndex(
          reader,
          adopted.index.importKeySha256,
        ),
      "ROOT_CHANGED",
    );
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(swapped, true);
  assert.deepEqual(recursiveSnapshot(moved), originalAfterSwap);
  assert.deepEqual(
    recursiveSnapshot(fixture.root),
    replacementAfterSwap,
  );
});
