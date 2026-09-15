"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ceremony = require("../lib/pikiio-proof-ceremony-v5");
const offlineChild = require("../scripts/pikiio-proof-v5-offline-verify-child");
const proofStore = require("../lib/pikiio-proof-store");

const ROOT = path.resolve(__dirname, "..");
const CEREMONY_PATH = path.join(ROOT, "lib", "pikiio-proof-ceremony-v5.js");
const CHILD_PATH = path.join(
  ROOT,
  "scripts",
  "pikiio-proof-v5-offline-verify-child.js",
);
let makeExternalFixture;

function expectCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

function canonical(value) {
  return proofStore.canonicalJsonBytes(value);
}

function digest(value) {
  return proofStore.sha256(Buffer.from(String(value), "utf8"));
}

function commit(character) {
  return character.repeat(40);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function temporaryRoot(prefix = "pikiio-proof-v5-test-") {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix)),
  );
}

function recursiveSnapshot(root) {
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
      mtime: stat.mtimeNs.toString(),
      ctime: stat.ctimeNs.toString(),
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

function roleBytes(role, policy, variant) {
  if (policy.mediaType !== "application/json") {
    return Buffer.from(`${role}:${variant}\n`, "utf8");
  }
  const value = { role, variant };
  if (policy.payloadSchema !== null) value.schema = policy.payloadSchema;
  return canonical(value);
}

function buildArchiveFixture({
  root = temporaryRoot(),
  variant = "one",
} = {}) {
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  const rawArtifacts = ["unit", "gherkin", "mutation"]
    .map((label) =>
      proofStore.storeBlob(store, {
        bytes: Buffer.from(`raw:${label}:${variant}\n`, "utf8"),
        mediaType: "application/octet-stream",
        payloadSchema: null,
      }).reference,
    )
    .sort((left, right) => left.address.localeCompare(right.address));
  const evidenceManifest = rawArtifacts.map((reference) => ({
    address: reference.address,
    sha256: reference.address.slice(7),
    byteLength: reference.byteLength,
  }));
  const roles = {};
  for (const role of proofStore.ARCHIVE_ROLE_NAMES) {
    const policy = proofStore.ARCHIVE_ROLE_TABLE[role];
    roles[role] = proofStore.storeBlob(store, {
      bytes:
        role === "evidenceManifest"
          ? canonical(evidenceManifest)
          : roleBytes(role, policy, variant),
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
    requestNonce: digest(`nonce:${variant}`),
    run: {
      runId: "101",
      runAttempt: "1",
    },
    roles,
    rawArtifacts,
    bindings: {
      externalPackageHash: digest(`package:${variant}`),
      certificationHash: digest(`certification:${variant}`),
      attestationBodySha256: digest(`attestation:${variant}`),
      qualityVerdictHash: digest(`verdict:${variant}`),
      evidenceManifestSha256: proofStore.sha256(
        Buffer.from(proofStore.stableJson(evidenceManifest), "utf8"),
      ),
      rawArtifactSetSha256: proofStore.rawArtifactSetSha256(rawArtifacts),
      replayKeySha256: digest(`replay:${variant}`),
      trustedAuthoritySha256: digest(`authority:${variant}`),
      jwksRegistrySha256: digest(`jwks:${variant}`),
      toolchainSha256: digest(`toolchain:${variant}`),
      authorityPolicySha256: digest(`policy:${variant}`),
    },
    transport: {
      artifactId: "9001",
      artifactDigest: `sha256:${digest(`transport:${variant}`)}`,
      runId: "101",
      runAttempt: "1",
    },
    productionAuthority: false,
  };
  const stored = proofStore.storeArchiveRoot(store, manifest);
  return {
    root,
    store,
    manifest,
    archiveRoot: stored.archiveRoot,
  };
}

function successPayload(fixture, processId = process.pid + 10_000) {
  return {
    schema: ceremony.OFFLINE_RESULT_SCHEMA,
    ok: true,
    processId,
    archiveRoot: fixture.archiveRoot,
    verification: {
      valid: true,
      phaseId: fixture.manifest.phaseId,
      authorityCommit: fixture.manifest.authorityCommit,
      phaseScopeBaseCommit: fixture.manifest.scopeBaseCommit,
      scopeBaseCommit: fixture.manifest.scopeBaseCommit,
      candidateCommit: fixture.manifest.candidateCommit,
      requestNonce: fixture.manifest.requestNonce,
      qualityVerdictHash:
        fixture.manifest.bindings.qualityVerdictHash,
      evidenceManifestSha256:
        fixture.manifest.bindings.evidenceManifestSha256,
      replayKeySha256: fixture.manifest.bindings.replayKeySha256,
      attestationBodySha256:
        fixture.manifest.bindings.attestationBodySha256,
      certificationHash: fixture.manifest.bindings.certificationHash,
      productionAuthority: false,
    },
    verificationClass: ceremony.HISTORICAL_VERIFICATION_CLASS,
    archiveSuppliedTrustPolicy: true,
    controllerAuthorityPinned: false,
    historicalEvidenceOnly: true,
    builderAuthority: false,
    productionAuthority: false,
  };
}

function failurePayload(code = "ARCHIVE_REJECTED") {
  return {
    schema: ceremony.OFFLINE_RESULT_SCHEMA,
    ok: false,
    code,
    error: "archive rejected",
    verificationClass: ceremony.HISTORICAL_VERIFICATION_CLASS,
    archiveSuppliedTrustPolicy: true,
    controllerAuthorityPinned: false,
    historicalEvidenceOnly: true,
    builderAuthority: false,
    productionAuthority: false,
  };
}

function processResult({
  payload,
  stdout,
  stderr = Buffer.alloc(0),
  status = 0,
  signal = null,
  error = undefined,
}) {
  return {
    error,
    signal,
    stderr,
    status,
    stdout:
      stdout === undefined
        ? Buffer.from(JSON.stringify(payload), "utf8")
        : stdout,
  };
}

function withSpawnResult(result, operation) {
  const original = childProcess.spawnSync;
  const calls = [];
  childProcess.spawnSync = (...args) => {
    calls.push(args);
    return result;
  };
  try {
    return {
      value: operation(),
      calls,
    };
  } finally {
    childProcess.spawnSync = original;
  }
}

function inspectWithPayload(fixture, payload, overrides = {}) {
  const controller = ceremony.createIsolatedAuditControllerForTests(
    fixture.root,
  );
  return withSpawnResult(
    processResult({ payload, ...overrides }),
    () => controller.inspect(fixture.archiveRoot),
  );
}

function childRequest(root, archiveRoot) {
  return {
    archiveRoot,
    schema: "pikiio-proof-offline-verification-request-v5",
    store: {
      mode: "isolated_test_non_authorizing",
      root,
    },
  };
}

function externalFixtureFactory() {
  if (makeExternalFixture) return makeExternalFixture;
  const filename = path.join(ROOT, "tests", "pikiio-external-ci-proof.test.js");
  const source = fs.readFileSync(filename, "utf8");
  const boundary = source.indexOf("\ndescribe(");
  assert.ok(boundary > 0, "external fixture authority must precede its suites");
  const fixtureModule = new Module(filename, module);
  fixtureModule.filename = filename;
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(filename));
  fixtureModule._compile(
    `${source.slice(0, boundary)}\nmodule.exports = { makeFixture };\n`,
    filename,
  );
  makeExternalFixture = fixtureModule.exports.makeFixture;
  return makeExternalFixture;
}

function buildVerifiedArchiveFixture() {
  const externalFixture = externalFixtureFactory()("GOV-00");
  const root = temporaryRoot();
  const store = proofStore.initializeIsolatedNonAuthorizingTestStore(root);
  const rawArtifacts = externalFixture.bundle.evidenceManifest
    .map((entry) => {
      const bytes = externalFixture.artifacts.get(entry.address);
      assert.ok(bytes, `missing external fixture artifact ${entry.address}`);
      const stored = proofStore.storeBlob(store, {
        bytes,
        mediaType: "application/octet-stream",
        payloadSchema: null,
      }).reference;
      assert.equal(stored.address, entry.address);
      assert.equal(stored.byteLength, entry.byteLength);
      return stored;
    })
    .sort((left, right) => left.address.localeCompare(right.address));
  const evidenceManifest = rawArtifacts.map((reference) => ({
    address: reference.address,
    sha256: reference.address.slice(7),
    byteLength: reference.byteLength,
  }));
  const jsonRoles = {
    request: externalFixture.request,
    materialization: externalFixture.materialization,
    macosJudge: externalFixture.macosJudge,
    macosAuthorityAttestation: {
      schema: "pikiio-external-ci-macos-authority-v1",
      evidenceSha256: digest(
        proofStore.stableJson(externalFixture.macosIdentityEvidence),
      ),
    },
    primaryJudge: externalFixture.primaryJudge,
    independentJudge: externalFixture.independentJudge,
    verdict: externalFixture.verdict,
    certification: externalFixture.certification,
    externalPackage: externalFixture.bundle,
    evidenceManifest,
    trustedAuthority: externalFixture.trustedAuthority,
    jwksRegistry: externalFixture.jwksRegistry,
    toolchainProvenance: {
      schema: "pikiio-proof-v3-toolchain-provenance-v1",
    },
    sourceManifest: {
      schema: "pikiio-external-ci-source-manifest-v3",
    },
    phaseProofRegistry: {
      schema: "pikiio-phase-proof-registry-v1",
    },
    toolchainCommissioningReceipt: {
      schema: "pikiio-proof-v3-toolchain-commissioning-receipt-v1",
    },
    toolchainSbom: {},
    toolchainDependencyManifest: {},
    packageLock: {},
  };
  const byteRoles = {
    authorityWorkflow: fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "pikiio-proof-collector-v3.yml"),
    ),
    requestWorkflow: fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "pikiio-proof-request-v3.yml"),
    ),
    externalVerifierSource: fs.readFileSync(
      path.join(ROOT, "lib", "pikiio-external-ci-proof.js"),
    ),
    oidcVerifierSource: fs.readFileSync(
      path.join(ROOT, "lib", "pikiio-github-oidc-collector-v3.js"),
    ),
    judgeDockerfile: fs.readFileSync(
      path.join(ROOT, "ops", "pikiio-proof-v3-judge", "Dockerfile"),
    ),
    childRunner: fs.readFileSync(
      path.join(ROOT, "ops", "pikiio-proof-v3-judge", "child-runner.js"),
    ),
    authorityGitObjectProof: Buffer.from("historical-object-proof\n", "utf8"),
    packageManifest: Buffer.from("historical package manifest\n", "utf8"),
    transportArchive: Buffer.from("historical transport archive\n", "utf8"),
  };
  const roles = {};
  for (const role of proofStore.ARCHIVE_ROLE_NAMES) {
    const policy = proofStore.ARCHIVE_ROLE_TABLE[role];
    const bytes = Object.hasOwn(jsonRoles, role)
      ? canonical(jsonRoles[role])
      : byteRoles[role];
    assert.ok(Buffer.isBuffer(bytes), `fixture role ${role} must have bytes`);
    roles[role] = proofStore.storeBlob(store, {
      bytes,
      mediaType: policy.mediaType,
      payloadSchema: policy.payloadSchema,
    }).reference;
  }
  const materialization = externalFixture.materialization;
  const manifest = {
    schema: proofStore.ARCHIVE_ROOT_SCHEMA,
    proofStoreIdentitySha256: proofStore.proofStoreIdentitySha256(store),
    repository: "demo-maintainer/Pikiio-app-",
    phaseId: materialization.phase.phaseId,
    authorityCommit: materialization.authority.commit,
    scopeBaseCommit: materialization.phase.scopeBaseCommit,
    candidateCommit: materialization.candidate.commit,
    requestNonce: materialization.run.requestNonce,
    run: {
      runId: materialization.run.runId,
      runAttempt: materialization.run.runAttempt,
    },
    roles,
    rawArtifacts,
    bindings: {
      externalPackageHash: externalFixture.bundle.packageHash,
      certificationHash: externalFixture.certification.certificationHash,
      attestationBodySha256:
        externalFixture.certification.attestationBodySha256,
      qualityVerdictHash: externalFixture.verdict.receiptHash,
      evidenceManifestSha256:
        externalFixture.verdict.evidenceManifestSha256,
      rawArtifactSetSha256: proofStore.rawArtifactSetSha256(rawArtifacts),
      replayKeySha256:
        externalFixture.certification.replay.replayKeySha256,
      trustedAuthoritySha256: digest(
        proofStore.stableJson(externalFixture.trustedAuthority),
      ),
      jwksRegistrySha256:
        materialization.authority.jwksRegistrySha256,
      toolchainSha256: materialization.authority.toolchainSha256,
      authorityPolicySha256: digest("historical-self-consistency-only"),
    },
    transport: {
      artifactId: "99001",
      artifactDigest: `sha256:${digest("historical-transport")}`,
      runId: materialization.run.runId,
      runAttempt: materialization.run.runAttempt,
    },
    productionAuthority: false,
  };
  const stored = proofStore.storeArchiveRoot(store, manifest);
  return {
    root,
    store,
    manifest,
    archiveRoot: stored.archiveRoot,
    externalFixture,
  };
}

function loadMutant(filename, replacements, internalExports) {
  let source = fs.readFileSync(filename, "utf8");
  for (const [find, replacement] of replacements) {
    assert.equal(
      source.split(find).length - 1,
      1,
      `mutation target must be unique: ${find}`,
    );
    source = source.replace(find, replacement);
  }
  source = source.replace(
    "module.exports = Object.freeze({",
    `module.exports = Object.freeze({ __testOnly: Object.freeze({ ${internalExports} }),`,
  );
  const mutantFilename =
    `${filename}?ceremony-mutant=${digest(source).slice(0, 16)}`;
  const mutant = new Module(mutantFilename, module);
  mutant.filename = mutantFilename;
  mutant.paths = Module._nodeModulePaths(path.dirname(filename));
  mutant._compile(source, mutantFilename);
  return mutant.exports;
}

test("certified proof-store pins and archive references are exact", () => {
  assert.equal(
    proofStore.sha256(fs.readFileSync(require.resolve("../lib/pikiio-proof-store"))),
    ceremony.PROOF_STORE_SOURCE_SHA256,
  );
  assert.equal(
    proofStore.sha256(fs.readFileSync(path.join(ROOT, "tests", "pikiio-proof-store.test.js"))),
    ceremony.PROOF_STORE_TEST_SOURCE_SHA256,
  );
  assert.equal(ceremony.CURRENT_EXTERNAL_AUTHORITY_STATE, "uncommissioned");
  assert.equal(
    ceremony.HISTORICAL_VERIFICATION_CLASS,
    "archive_supplied_policy_self_consistency_only",
  );
  const fixture = buildArchiveFixture({});
  assert.deepEqual(
    ceremony.archiveReference({
      address: fixture.archiveRoot.address,
      byteLength: fixture.archiveRoot.byteLength,
    }),
    fixture.archiveRoot,
  );
  for (const invalid of [
    null,
    [],
    {},
    { ...fixture.archiveRoot, extra: true },
    Object.assign(Object.create({ inherited: true }), fixture.archiveRoot),
  ]) {
    expectCode(() => ceremony.validateArchiveReference(invalid), "V5_SHAPE_INVALID");
  }
  const symbolized = { ...fixture.archiveRoot };
  symbolized[Symbol("unknown")] = true;
  expectCode(
    () => ceremony.validateArchiveReference(symbolized),
    "V5_SHAPE_INVALID",
  );
  expectCode(() => ceremony.archiveReference(null), "V5_SHAPE_INVALID");
  expectCode(
    () =>
      ceremony.archiveReference({
        address: fixture.archiveRoot.address,
        byteLength: fixture.archiveRoot.byteLength,
        extra: true,
      }),
    "V5_SHAPE_INVALID",
  );
});

test("live refusal is immediate and performs zero invocation-time I/O", () => {
  const isolatedLive =
    ceremony.createIsolatedAuditControllerForTests(
      path.join(
        fs.realpathSync(os.tmpdir()),
        "pikiio-proof-v5-test-does-not-exist",
      ),
    ).live;
  const originalRead = fs.readFileSync;
  const originalSpawn = childProcess.spawnSync;
  let reads = 0;
  let spawns = 0;
  fs.readFileSync = (...args) => {
    reads += 1;
    return originalRead(...args);
  };
  childProcess.spawnSync = () => {
    spawns += 1;
    throw new Error("live must not spawn");
  };
  try {
    for (const input of [
      undefined,
      null,
      {},
      Symbol("hostile"),
      { schema: "attacker" },
    ]) {
      expectCode(
        () => ceremony.runCanonicalLiveCeremony(input),
        "EXTERNAL_AUTHORITY_CONTRACT_UNCOMMISSIONED",
      );
      expectCode(
        () => isolatedLive(input),
        "EXTERNAL_AUTHORITY_CONTRACT_UNCOMMISSIONED",
      );
    }
  } finally {
    fs.readFileSync = originalRead;
    childProcess.spawnSync = originalSpawn;
  }
  assert.equal(reads, 0);
  assert.equal(spawns, 0);
});

test("isolated roots reject missing, nested, aliased, foreign-shape, and non-store paths", () => {
  const temporary = fs.realpathSync(os.tmpdir());
  const valid = buildArchiveFixture({});
  assert.ok(ceremony.createIsolatedAuditControllerForTests(valid.root));
  const rejectRoot = (root, code) =>
    expectCode(
      () =>
        ceremony
          .createIsolatedAuditControllerForTests(root)
          .inspect(valid.archiveRoot),
      code,
    );

  const missingParent = path.join(
    temporary,
    "pikiio-proof-v5-missing-parent",
    "pikiio-proof-v5-test-child",
  );
  rejectRoot(missingParent, "TEST_STORE_ROOT_UNAVAILABLE");
  const missingRoot = path.join(
    temporary,
    "pikiio-proof-v5-test-not-present",
  );
  rejectRoot(missingRoot, "TEST_STORE_ROOT_UNAVAILABLE");
  rejectRoot("relative", "TEST_STORE_ROOT_INVALID");
  rejectRoot(
    `${valid.root}/../${path.basename(valid.root)}`,
    "TEST_STORE_ROOT_INVALID",
  );
  if (valid.root.startsWith("/private/var/")) {
    rejectRoot(
      valid.root.replace(/^\/private\/var/, "/var"),
      "TEST_STORE_ROOT_INVALID",
    );
  }

  const wrongPrefix = temporaryRoot("wrong-proof-root-");
  rejectRoot(wrongPrefix, "TEST_STORE_ROOT_INVALID");
  const barePrefix = path.join(temporary, "pikiio-proof-v5-test-");
  fs.mkdirSync(barePrefix, { mode: 0o700 });
  try {
    rejectRoot(barePrefix, "TEST_STORE_ROOT_INVALID");
  } finally {
    fs.rmdirSync(barePrefix);
  }
  const regularFile = path.join(
    temporary,
    `pikiio-proof-v5-test-file-${process.pid}`,
  );
  fs.writeFileSync(regularFile, "not a directory", { mode: 0o600 });
  try {
    rejectRoot(regularFile, "TEST_STORE_ROOT_INVALID");
  } finally {
    fs.unlinkSync(regularFile);
  }
  const nested = path.join(valid.root, "pikiio-proof-v5-test-nested");
  fs.mkdirSync(nested, { mode: 0o700 });
  rejectRoot(nested, "TEST_STORE_ROOT_INVALID");
  const alias = path.join(
    temporary,
    `pikiio-proof-v5-test-alias-${process.pid}`,
  );
  fs.symlinkSync(valid.root, alias);
  try {
    rejectRoot(alias, "TEST_STORE_ROOT_INVALID");
  } finally {
    fs.unlinkSync(alias);
  }
  const permissive = temporaryRoot();
  fs.chmodSync(permissive, 0o755);
  rejectRoot(permissive, "TEST_STORE_ROOT_INVALID");
  const junk = temporaryRoot();
  fs.writeFileSync(path.join(junk, "junk"), "not a proof store");
  rejectRoot(junk, "TEST_STORE_ROOT_CHANGED");
  const originalLstat = fs.lstatSync;
  fs.lstatSync = function (target, options) {
    const stat = originalLstat.call(fs, target, options);
    if (String(target) !== valid.root) return stat;
    return new Proxy(stat, {
      get(object, property) {
        if (property === "uid") return object.uid + 1n;
        const value = Reflect.get(object, property, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  };
  try {
    rejectRoot(valid.root, "TEST_STORE_ROOT_INVALID");
  } finally {
    fs.lstatSync = originalLstat;
  }
});

test("previously uncovered parent refusal branches are direct and typed", () => {
  const direct = loadMutant(
    CEREMONY_PATH,
    [],
    [
      "createController",
      "openStoreWritable",
      "runOfflineVerification",
      "validateChildFailure",
      "validateStoreSpec",
    ].join(", "),
  ).__testOnly;
  assert.deepEqual(
    direct.validateStoreSpec({ mode: "canonical", root: null }),
    { mode: "canonical", root: null },
  );
  expectCode(
    () =>
      direct.validateStoreSpec({
        mode: "canonical",
        root: fs.realpathSync(os.tmpdir()),
      }),
    "CANONICAL_ROOT_INJECTION_REFUSED",
  );
  expectCode(
    () => direct.validateStoreSpec({ mode: "invented", root: null }),
    "STORE_MODE_INVALID",
  );
  const isolatedRoot = temporaryRoot();
  assert.deepEqual(
    direct.validateStoreSpec({
      mode: "isolated_test_non_authorizing",
      root: isolatedRoot,
    }),
    {
      mode: "isolated_test_non_authorizing",
      root: isolatedRoot,
    },
  );

  const absentRoot = path.join(
    fs.realpathSync(os.tmpdir()),
    `pikiio-proof-v5-test-absent-writer-${process.pid}-${digest(
      isolatedRoot,
    ).slice(0, 8)}`,
  );
  let writerFailure;
  try {
    direct.openStoreWritable({
      mode: "isolated_test_non_authorizing",
      root: absentRoot,
    });
  } catch (error) {
    writerFailure = error;
  }
  assert.equal(writerFailure?.code, "TEST_STORE_ROOT_CHANGED");
  assert.equal(typeof writerFailure?.details?.causeCode, "string");

  const hostileFailureShape = new Proxy({}, {
    ownKeys() {
      throw new Error("hostile ownKeys trap");
    },
  });
  assert.throws(
    () => direct.validateChildFailure(hostileFailureShape),
    /hostile ownKeys trap/,
  );

  const originalRealpath = fs.realpathSync;
  const declaredTemporaryRoot = os.tmpdir();
  fs.realpathSync = function (target, ...args) {
    if (String(target) === declaredTemporaryRoot) {
      const error = new Error("injected temporary-root refusal");
      error.code = "EACCES";
      throw error;
    }
    return originalRealpath.call(fs, target, ...args);
  };
  try {
    let environmentFailure;
    try {
      direct.runOfflineVerification(
        { mode: "canonical", root: null },
        { historical: "reference-not-read-before-environment-refusal" },
      );
    } catch (error) {
      environmentFailure = error;
    }
    assert.equal(
      environmentFailure?.code,
      "OFFLINE_VERIFIER_ENVIRONMENT_INVALID",
    );
    assert.equal(environmentFailure?.details?.causeCode, "EACCES");
  } finally {
    fs.realpathSync = originalRealpath;
  }

  expectCode(
    () =>
      direct.createController(
        { mode: "canonical", root: null },
        { afterImport() {} },
      ),
    "TEST_HOOKS_INVALID",
  );
});

test("inspect, plan, and dry-run are read-only and explicitly non-authorizing", () => {
  const fixture = buildArchiveFixture({});
  const controller = ceremony.createIsolatedAuditControllerForTests(
    fixture.root,
  );
  const before = recursiveSnapshot(fixture.root);
  const payload = successPayload(fixture);
  const ambientAttack = {
    HOME: "/attacker/home",
    NODE_OPTIONS: "--require=/attacker/preload.js",
    NODE_V8_COVERAGE: "/attacker/coverage",
    OPENAI_API_KEY: "attacker-openai-key",
    PATH: "/attacker/bin",
    PIKIIO_AMBIENT_SECRET: "must-not-cross",
    SUPABASE_ACCESS_TOKEN: "attacker-supabase-token",
    VERCEL_TOKEN: "attacker-vercel-token",
  };
  const previousEnvironment = new Map(
    Object.keys(ambientAttack).map((key) => [key, process.env[key]]),
  );
  let captured;
  try {
    Object.assign(process.env, ambientAttack);
    captured = withSpawnResult(
      processResult({ payload }),
      () => [
        controller.inspect(fixture.archiveRoot),
        controller.plan(fixture.archiveRoot),
        controller.dryRun(fixture.archiveRoot),
      ],
    );
  } finally {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const { value: values, calls } = captured;
  const [inspection, plan, dryRun] = values;
  assert.deepEqual(recursiveSnapshot(fixture.root), before);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call[0], process.execPath);
    assert.equal(path.isAbsolute(call[0]), true);
    assert.deepEqual(call[1], [CHILD_PATH]);
    assert.deepEqual(call[2].env, {
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: fs.realpathSync(os.tmpdir()),
    });
    assert.equal(call[2].env.TMPDIR, path.dirname(fixture.root));
    for (const forbidden of [
      "HOME",
      "PATH",
      "NODE_OPTIONS",
      "NODE_V8_COVERAGE",
      "OPENAI_API_KEY",
      "PIKIIO_AMBIENT_SECRET",
      "SUPABASE_ACCESS_TOKEN",
      "VERCEL_TOKEN",
    ]) {
      assert.equal(Object.hasOwn(call[2].env, forbidden), false);
    }
    assert.equal(call[2].encoding, undefined);
    assert.ok(Buffer.isBuffer(call[2].input));
  }
  assert.equal(
    inspection.externalVerification,
    "archive_self_consistency_checked_historical_non_authorizing",
  );
  assert.equal(
    inspection.verificationClass,
    ceremony.HISTORICAL_VERIFICATION_CLASS,
  );
  assert.equal(inspection.archiveSuppliedTrustPolicy, true);
  assert.equal(inspection.controllerAuthorityPinned, false);
  assert.equal(inspection.historicalEvidenceOnly, true);
  assert.equal(inspection.builderAuthority, false);
  assert.equal(inspection.productionAuthority, false);
  assert.equal(plan.decision, "blocked");
  assert.equal(plan.reasonCode, "EXTERNAL_AUTHORITY_CONTRACT_UNCOMMISSIONED");
  assert.deepEqual(plan.irreversibleSideEffectBoundaries, []);
  assert.equal(plan.filesystemWritesPlanned, 0);
  assert.equal(plan.gitWritesPlanned, 0);
  assert.equal(plan.remoteWritesPlanned, 0);
  assert.equal(plan.ledgerWritesPlanned, 0);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.authorizing, false);
  assert.equal(dryRun.builderAuthority, false);
  assert.equal(dryRun.productionAuthority, false);
});

test("frozen proof-store mismatch refuses before store or child work", () => {
  const fixture = buildArchiveFixture({});
  const controller = ceremony.createIsolatedAuditControllerForTests(
    fixture.root,
  );
  const originalRead = fs.readFileSync;
  let spawnCount = 0;
  const originalSpawn = childProcess.spawnSync;
  fs.readFileSync = function (file, ...args) {
    const bytes = originalRead.call(fs, file, ...args);
    return path.resolve(String(file)) ===
      path.resolve(require.resolve("../lib/pikiio-proof-store"))
      ? Buffer.concat([Buffer.from(bytes), Buffer.from("tamper")])
      : bytes;
  };
  childProcess.spawnSync = () => {
    spawnCount += 1;
    throw new Error("must not spawn");
  };
  try {
    expectCode(
      () => controller.inspect(fixture.archiveRoot),
      "PROOF_STORE_FREEZE_MISMATCH",
    );
  } finally {
    fs.readFileSync = originalRead;
    childProcess.spawnSync = originalSpawn;
  }
  assert.equal(spawnCount, 0);
});

test("both proof-store source pins fail closed on unreadable or changed bytes", () => {
  const fixture = buildArchiveFixture({ variant: "source-pins" });
  const controller = ceremony.createIsolatedAuditControllerForTests(
    fixture.root,
  );
  const targets = [
    {
      path: path.join(ROOT, "lib", "pikiio-proof-store.js"),
      unreadable: "PROOF_STORE_SOURCE_UNREADABLE",
      mismatch: "PROOF_STORE_FREEZE_MISMATCH",
    },
    {
      path: path.join(ROOT, "tests", "pikiio-proof-store.test.js"),
      unreadable: "PROOF_STORE_TEST_SOURCE_UNREADABLE",
      mismatch: "PROOF_STORE_TEST_FREEZE_MISMATCH",
    },
  ];
  for (const target of targets) {
    for (const mode of ["unreadable", "mismatch"]) {
      const originalRead = fs.readFileSync;
      fs.readFileSync = function (file, ...args) {
        if (path.resolve(String(file)) === path.resolve(target.path)) {
          if (mode === "unreadable") {
            const error = new Error("injected source refusal");
            error.code = "EACCES";
            throw error;
          }
          return Buffer.concat([
            Buffer.from(originalRead.call(fs, file, ...args)),
            Buffer.from("tamper"),
          ]);
        }
        return originalRead.call(fs, file, ...args);
      };
      try {
        expectCode(
          () => controller.inspect(fixture.archiveRoot),
          target[mode],
        );
      } finally {
        fs.readFileSync = originalRead;
      }
    }
  }
});

test("offline protocol rejects malformed bytes, replacement characters, process failures, and stderr", () => {
  const fixture = buildArchiveFixture({});
  const controller = ceremony.createIsolatedAuditControllerForTests(
    fixture.root,
  );
  const invalidUtf8 = Buffer.from([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  const cases = [
    processResult({ stdout: "not raw bytes", status: 0 }),
    processResult({ stdout: Buffer.alloc(0), status: 0 }),
    processResult({ stdout: invalidUtf8, status: 0 }),
    processResult({
      stdout: Buffer.from('{"x":"\uFFFD"}', "utf8"),
      status: 0,
    }),
    processResult({
      stdout: Buffer.from('{"x":"\\ufffd"}', "utf8"),
      status: 0,
    }),
    processResult({ stdout: Buffer.from("{", "utf8"), status: 0 }),
    processResult({
      payload: successPayload(fixture),
      stderr: Buffer.from("unexpected", "utf8"),
    }),
  ];
  for (const result of cases) {
    expectCode(
      () =>
        withSpawnResult(result, () =>
          controller.inspect(fixture.archiveRoot),
        ),
      "OFFLINE_VERIFIER_PROTOCOL_INVALID",
    );
  }
  const ioError = new Error("injected");
  ioError.code = "EIO";
  expectCode(
    () =>
      withSpawnResult(
        processResult({
          payload: successPayload(fixture),
          error: ioError,
        }),
        () => controller.inspect(fixture.archiveRoot),
      ),
    "OFFLINE_VERIFIER_PROCESS_FAILED",
  );
  expectCode(
    () =>
      withSpawnResult(
        processResult({
          payload: successPayload(fixture),
          signal: "SIGKILL",
        }),
        () => controller.inspect(fixture.archiveRoot),
      ),
    "OFFLINE_VERIFIER_PROCESS_KILLED",
  );
  expectCode(
    () =>
      withSpawnResult(
        processResult({
          payload: successPayload(fixture),
          status: 9,
        }),
        () => controller.inspect(fixture.archiveRoot),
      ),
    "OFFLINE_VERIFIER_PROCESS_FAILED",
  );
  let failed;
  try {
    withSpawnResult(
      processResult({
        payload: failurePayload("HISTORICAL_PACKAGE_REJECTED"),
        status: 1,
      }),
      () => controller.inspect(fixture.archiveRoot),
    );
  } catch (error) {
    failed = error;
  }
  assert.ok(failed);
  assert.equal(failed.code, "OFFLINE_ARCHIVE_VERIFICATION_FAILED");
  assert.equal(failed.details.causeCode, "HISTORICAL_PACKAGE_REJECTED");
});

test("offline success and failure protocol require exact roots, nested verification, and positive fresh PID", () => {
  const fixture = buildArchiveFixture({});
  const mutateSuccess = [
    (value) => {
      value.extra = true;
    },
    (value) => {
      delete value.builderAuthority;
    },
    (value) => {
      value.archiveRoot.extra = true;
    },
    (value) => {
      value.verification.extra = true;
    },
    (value) => {
      delete value.verification.requestNonce;
    },
    (value) => {
      value.processId = 0;
    },
    (value) => {
      value.processId = process.pid;
    },
    (value) => {
      value.processId = 1.5;
    },
    (value) => {
      value.verification.phaseScopeBaseCommit = commit("d");
    },
    (value) => {
      value.verification.phaseId = "bad";
    },
    (value) => {
      value.verification.authorityCommit = "a";
    },
    (value) => {
      value.verification.requestNonce = "a";
    },
    (value) => {
      value.verification.productionAuthority = true;
    },
    (value) => {
      value.verificationClass = "controller_pinned";
    },
    (value) => {
      value.archiveSuppliedTrustPolicy = false;
    },
    (value) => {
      value.controllerAuthorityPinned = true;
    },
    (value) => {
      value.historicalEvidenceOnly = false;
    },
    (value) => {
      value.productionAuthority = true;
    },
  ];
  for (const mutate of mutateSuccess) {
    const payload = clone(successPayload(fixture));
    mutate(payload);
    expectCode(
      () => inspectWithPayload(fixture, payload),
      "OFFLINE_VERIFIER_PROTOCOL_INVALID",
    );
  }

  const mutateFailure = [
    (value) => {
      value.extra = true;
    },
    (value) => {
      delete value.error;
    },
    (value) => {
      value.code = "bad";
    },
    (value) => {
      value.error = "";
    },
    (value) => {
      value.verificationClass = "controller_pinned";
    },
    (value) => {
      value.archiveSuppliedTrustPolicy = false;
    },
    (value) => {
      value.controllerAuthorityPinned = true;
    },
    (value) => {
      value.builderAuthority = true;
    },
  ];
  for (const mutate of mutateFailure) {
    const payload = clone(failurePayload());
    mutate(payload);
    expectCode(
      () =>
        inspectWithPayload(fixture, payload, {
          status: 1,
        }),
      "OFFLINE_VERIFIER_PROTOCOL_INVALID",
    );
  }
});

test("every verification binding is rechecked against the archived manifest", () => {
  const fixture = buildArchiveFixture({});
  const mutations = [
    ["phaseId", "TRUTH-01"],
    ["authorityCommit", commit("d")],
    ["candidateCommit", commit("d")],
    ["requestNonce", digest("wrong nonce")],
    ["qualityVerdictHash", digest("wrong verdict")],
    ["evidenceManifestSha256", digest("wrong manifest")],
    ["replayKeySha256", digest("wrong replay")],
    ["attestationBodySha256", digest("wrong attestation")],
    ["certificationHash", digest("wrong certification")],
  ];
  for (const [key, replacement] of mutations) {
    const payload = clone(successPayload(fixture));
    payload.verification[key] = replacement;
    expectCode(
      () => inspectWithPayload(fixture, payload),
      "ARCHIVE_VERIFICATION_BINDING_MISMATCH",
    );
  }
  const scope = clone(successPayload(fixture));
  scope.verification.scopeBaseCommit = commit("d");
  scope.verification.phaseScopeBaseCommit = commit("d");
  expectCode(
    () => inspectWithPayload(fixture, scope),
    "ARCHIVE_VERIFICATION_BINDING_MISMATCH",
  );
});

test("audit adoption has an isolated writer, exact idempotency, and partial-adoption recovery", () => {
  const fixture = buildArchiveFixture({});
  const controller = ceremony.createIsolatedAuditControllerForTests(
    fixture.root,
  );
  const payload = successPayload(fixture);
  const first = withSpawnResult(
    processResult({ payload }),
    () => controller.adoptAudit(fixture.archiveRoot),
  ).value;
  assert.equal(first.operation, "audit_adoption");
  assert.equal(first.idempotent, false);
  assert.equal(first.recoveredAfterPartialAdoption, false);
  assert.equal(
    first.receipt.verificationClass,
    ceremony.HISTORICAL_VERIFICATION_CLASS,
  );
  assert.equal(first.receipt.archiveSuppliedTrustPolicy, true);
  assert.equal(first.receipt.controllerAuthorityPinned, false);
  assert.equal(first.historicalEvidenceOnly, true);
  assert.equal(first.builderAuthority, false);
  assert.equal(first.productionAuthority, false);
  const readBack = proofStore.readImportIndex(
    proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(fixture.root),
    first.importIndex.importKeySha256,
  );
  assert.deepEqual(readBack.index, first.importIndex);
  const repeated = withSpawnResult(
    processResult({ payload }),
    () => controller.adoptAudit(fixture.archiveRoot),
  ).value;
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.recoveredAfterPartialAdoption, false);
  assert.deepEqual(repeated.receiptReference, first.receiptReference);

  const partial = buildArchiveFixture({ variant: "partial" });
  const injected = new Error("injected crash boundary");
  const crashing = ceremony.createIsolatedAuditControllerForTests(
    partial.root,
    {
      afterImport() {
        throw injected;
      },
    },
  );
  assert.throws(
    () =>
      withSpawnResult(
        processResult({ payload: successPayload(partial) }),
        () => crashing.adoptAudit(partial.archiveRoot),
      ),
    (error) => error === injected,
  );
  const recovered = withSpawnResult(
    processResult({ payload: successPayload(partial) }),
    () =>
      ceremony
        .createIsolatedAuditControllerForTests(partial.root)
        .adoptAudit(partial.archiveRoot),
  ).value;
  assert.equal(recovered.idempotent, false);
  assert.equal(recovered.recoveredAfterPartialAdoption, true);
  const settled = withSpawnResult(
    processResult({ payload: successPayload(partial) }),
    () =>
      ceremony
        .createIsolatedAuditControllerForTests(partial.root)
        .adoptAudit(partial.archiveRoot),
  ).value;
  assert.equal(settled.idempotent, true);
  assert.equal(settled.recoveredAfterPartialAdoption, false);

  for (const hooks of [{}, { afterImport: true }, { afterImport() {}, extra: 1 }]) {
    expectCode(
      () =>
        ceremony.createIsolatedAuditControllerForTests(partial.root, hooks),
      hooks.afterImport === true ? "TEST_HOOKS_INVALID" : "V5_SHAPE_INVALID",
    );
  }
});

test("SIGKILL after import publication recovers exactly once", () => {
  const fixture = buildArchiveFixture({ variant: "sigkill" });
  const payload = successPayload(fixture, process.pid + 20_000);
  const script = `
    const cp = require("node:child_process");
    cp.spawnSync = () => ({
      error: undefined,
      signal: null,
      stderr: Buffer.alloc(0),
      status: 0,
      stdout: Buffer.from(process.env.PAYLOAD, "utf8"),
    });
    const ceremony = require(process.env.CEREMONY_PATH);
    const controller = ceremony.createIsolatedAuditControllerForTests(
      process.env.STORE_ROOT,
      { afterImport() { process.kill(process.pid, "SIGKILL"); } },
    );
    controller.adoptAudit(JSON.parse(process.env.ARCHIVE_ROOT));
    process.exit(91);
  `;
  const killed = childProcess.spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT,
    env: {
      ARCHIVE_ROOT: JSON.stringify(fixture.archiveRoot),
      CEREMONY_PATH,
      LANG: "C",
      LC_ALL: "C",
      PAYLOAD: JSON.stringify(payload),
      STORE_ROOT: fixture.root,
      TMPDIR: fs.realpathSync(os.tmpdir()),
    },
    timeout: 20_000,
  });
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(killed.status, null);

  const recovered = withSpawnResult(
    processResult({ payload }),
    () =>
      ceremony
        .createIsolatedAuditControllerForTests(fixture.root)
        .adoptAudit(fixture.archiveRoot),
  ).value;
  assert.equal(recovered.recoveredAfterPartialAdoption, true);
  assert.equal(recovered.idempotent, false);
  const repeated = withSpawnResult(
    processResult({ payload }),
    () =>
      ceremony
        .createIsolatedAuditControllerForTests(fixture.root)
        .adoptAudit(fixture.archiveRoot),
  ).value;
  assert.equal(repeated.recoveredAfterPartialAdoption, false);
  assert.equal(repeated.idempotent, true);
});

test("offline child independently enforces exact requests, canonical roots, and bounded fatal UTF-8 input", () => {
  const fixture = buildArchiveFixture({ variant: "child" });
  const valid = childRequest(fixture.root, fixture.archiveRoot);
  assert.deepEqual(offlineChild.validateRequest(valid), valid);
  for (const invalid of [
    null,
    {},
    { ...valid, extra: true },
    { ...valid, schema: "v0" },
    { ...valid, store: { ...valid.store, extra: true } },
  ]) {
    expectCode(
      () => offlineChild.validateRequest(invalid),
      "OFFLINE_REQUEST_INVALID",
    );
  }
  for (const invalidRoot of [
    null,
    "relative",
    `${fixture.root}/../${path.basename(fixture.root)}`,
    path.join(fixture.root, "pikiio-proof-v5-test-nested"),
  ]) {
    const request = clone(valid);
    request.store.root = invalidRoot;
    expectCode(
      () => offlineChild.validateRequest(request),
      "OFFLINE_STORE_INVALID",
    );
  }
  const badReference = clone(valid);
  badReference.archiveRoot.extra = true;
  expectCode(
    () => offlineChild.validateRequest(badReference),
    "OFFLINE_ARCHIVE_REFERENCE_INVALID",
  );
  const canonicalInjected = clone(valid);
  canonicalInjected.store = { mode: "canonical", root: fixture.root };
  expectCode(
    () => offlineChild.validateRequest(canonicalInjected),
    "OFFLINE_STORE_INVALID",
  );
  const canonicalValid = clone(valid);
  canonicalValid.store = { mode: "canonical", root: null };
  assert.deepEqual(offlineChild.validateRequest(canonicalValid), canonicalValid);
  const badMode = clone(valid);
  badMode.store = { mode: "other", root: null };
  expectCode(
    () => offlineChild.validateRequest(badMode),
    "OFFLINE_STORE_INVALID",
  );
  const emptyRoot = temporaryRoot();
  const emptyBefore = recursiveSnapshot(emptyRoot);
  expectCode(
    () =>
      offlineChild.verify(
        childRequest(emptyRoot, fixture.archiveRoot),
      ),
    "OFFLINE_STORE_INVALID",
  );
  assert.deepEqual(recursiveSnapshot(emptyRoot), emptyBefore);
  const alias = path.join(
    fs.realpathSync(os.tmpdir()),
    `pikiio-proof-v5-test-child-alias-${process.pid}`,
  );
  fs.symlinkSync(fixture.root, alias);
  try {
    const aliasRequest = clone(valid);
    aliasRequest.store.root = alias;
    expectCode(
      () => offlineChild.validateRequest(aliasRequest),
      "OFFLINE_STORE_INVALID",
    );
  } finally {
    fs.unlinkSync(alias);
  }
  if (fixture.root.startsWith("/private/var/")) {
    const macAliasRequest = clone(valid);
    macAliasRequest.store.root = fixture.root.replace(
      /^\/private\/var/,
      "/var",
    );
    expectCode(
      () => offlineChild.validateRequest(macAliasRequest),
      "OFFLINE_STORE_INVALID",
    );
  }

  const run = (input) =>
    childProcess.spawnSync(process.execPath, [CHILD_PATH], {
      cwd: ROOT,
      env: { LANG: "C", LC_ALL: "C" },
      input,
      maxBuffer: 512 * 1024,
    });
  for (const [input, expectedCode] of [
    [Buffer.alloc(0), "OFFLINE_REQUEST_SIZE_INVALID"],
    [Buffer.from([0x7b, 0xc3, 0x28, 0x7d]), "OFFLINE_JSON_INVALID"],
    // Three bytes clear the size gate so this fixture reaches JSON parsing.
    [Buffer.from("{x}", "utf8"), "OFFLINE_JSON_INVALID"],
    [Buffer.from('{"x":"\uFFFD"}', "utf8"), "OFFLINE_JSON_INVALID"],
    [Buffer.alloc(64 * 1024 + 1, 0x20), "OFFLINE_REQUEST_SIZE_INVALID"],
  ]) {
    const result = run(input);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.length, 0);
    const error = JSON.parse(result.stdout.toString("utf8"));
    assert.equal(error.ok, false);
    assert.equal(error.code, expectedCode);
    assert.equal(
      error.verificationClass,
      ceremony.HISTORICAL_VERIFICATION_CLASS,
    );
    assert.equal(error.archiveSuppliedTrustPolicy, true);
    assert.equal(error.controllerAuthorityPinned, false);
    assert.equal(error.historicalEvidenceOnly, true);
    assert.equal(error.builderAuthority, false);
    assert.equal(error.productionAuthority, false);
  }

  expectCode(
    () => offlineChild.verify(valid),
    "OFFLINE_EXTERNAL_VERIFIER_SOURCE_MISMATCH",
  );
});

test("fresh child and parent reproduce one complete historical self-consistency verification without authority", () => {
  const fixture = buildVerifiedArchiveFixture();
  const request = childRequest(fixture.root, fixture.archiveRoot);
  const written = [];
  const status = offlineChild.execute(
    () => request,
    (value) => written.push(value),
  );
  assert.equal(status, 0);
  assert.equal(written.length, 1);
  const direct = JSON.parse(written[0]);
  assert.equal(direct.ok, true);
  assert.equal(direct.verification.valid, true);
  assert.equal(
    direct.verificationClass,
    ceremony.HISTORICAL_VERIFICATION_CLASS,
  );
  assert.equal(direct.archiveSuppliedTrustPolicy, true);
  assert.equal(direct.controllerAuthorityPinned, false);
  assert.equal(direct.historicalEvidenceOnly, true);
  assert.equal(direct.builderAuthority, false);
  assert.equal(direct.productionAuthority, false);

  const before = recursiveSnapshot(fixture.root);
  const inspection = ceremony
    .createIsolatedAuditControllerForTests(fixture.root)
    .inspect(fixture.archiveRoot);
  assert.deepEqual(recursiveSnapshot(fixture.root), before);
  assert.notEqual(inspection.freshProcessId, process.pid);
  assert.equal(
    inspection.externalVerification,
    "archive_self_consistency_checked_historical_non_authorizing",
  );
  assert.equal(inspection.controllerAuthorityPinned, false);
  assert.equal(inspection.builderAuthority, false);
  assert.equal(inspection.productionAuthority, false);
});

test("previously uncovered offline-child verification refusals are direct and typed", () => {
  const fixture = buildVerifiedArchiveFixture();
  const request = childRequest(fixture.root, fixture.archiveRoot);
  const direct = loadMutant(
    CHILD_PATH,
    [],
    [
      "assertVerificationBindings",
      "openStore",
      "parseJsonBytes",
      "requireLocalSource",
    ].join(", "),
  ).__testOnly;

  expectCode(
    () =>
      direct.parseJsonBytes(
        Buffer.from("{", "utf8"),
        "direct invalid JSON",
      ),
    "OFFLINE_JSON_INVALID",
  );

  let canonicalOpen;
  try {
    canonicalOpen = direct.openStore({ mode: "canonical", root: null });
  } catch (error) {
    assert.equal(error?.code, "OFFLINE_STORE_INVALID");
  }
  if (canonicalOpen !== undefined) {
    assert.equal(
      typeof proofStore.proofStoreIdentitySha256(canonicalOpen),
      "string",
    );
  }

  expectCode(
    () =>
      direct.assertVerificationBindings(
        {
          store: fixture.store,
          archiveRoot: fixture.archiveRoot,
          packageValue: fixture.externalFixture.bundle,
        },
        {},
      ),
    "OFFLINE_VERIFICATION_RESULT_INVALID",
  );

  const externalSourcePath = require.resolve("../lib/pikiio-external-ci-proof");
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    if (path.resolve(String(target)) === path.resolve(externalSourcePath)) {
      const error = new Error("injected external-verifier source refusal");
      error.code = "EACCES";
      throw error;
    }
    return originalRead.call(fs, target, ...args);
  };
  try {
    expectCode(
      () => offlineChild.verify(request),
      "OFFLINE_EXTERNAL_VERIFIER_SOURCE_MISMATCH",
    );
  } finally {
    fs.readFileSync = originalRead;
  }

  const mismatchedManifest = clone(fixture.manifest);
  mismatchedManifest.bindings.qualityVerdictHash = digest(
    "offline-child-binding-mismatch",
  );
  const mismatchedRoot = proofStore.storeArchiveRoot(
    fixture.store,
    mismatchedManifest,
  ).archiveRoot;
  expectCode(
    () =>
      offlineChild.verify(
        childRequest(fixture.root, mismatchedRoot),
      ),
    "OFFLINE_ARCHIVE_BINDING_MISMATCH",
  );

  const invalidTimePackage = clone(fixture.externalFixture.bundle);
  invalidTimePackage.certification.verifiedAt = "not-a-timestamp";
  const externalPolicy = proofStore.ARCHIVE_ROLE_TABLE.externalPackage;
  const invalidTimePackageReference = proofStore.storeBlob(fixture.store, {
    bytes: canonical(invalidTimePackage),
    mediaType: externalPolicy.mediaType,
    payloadSchema: externalPolicy.payloadSchema,
  }).reference;
  const invalidTimeManifest = clone(fixture.manifest);
  invalidTimeManifest.roles.externalPackage = invalidTimePackageReference;
  const invalidTimeRoot = proofStore.storeArchiveRoot(
    fixture.store,
    invalidTimeManifest,
  ).archiveRoot;
  expectCode(
    () =>
      offlineChild.verify(
        childRequest(fixture.root, invalidTimeRoot),
      ),
    "OFFLINE_VERIFICATION_TIME_INVALID",
  );
});

test("offline child error rendering is exact, bounded, and always non-authorizing", () => {
  const outputs = [];
  const typedStatus = offlineChild.execute(
    () => {
      const error = new Error("typed historical refusal");
      error.code = "TYPED_HISTORICAL_REFUSAL";
      throw error;
    },
    (value) => outputs.push(value),
  );
  assert.equal(typedStatus, 1);
  const typed = JSON.parse(outputs.pop());
  assert.deepEqual(Object.keys(typed), [
    "schema",
    "ok",
    "code",
    "error",
    "verificationClass",
    "archiveSuppliedTrustPolicy",
    "controllerAuthorityPinned",
    "historicalEvidenceOnly",
    "builderAuthority",
    "productionAuthority",
  ]);
  assert.equal(typed.code, "TYPED_HISTORICAL_REFUSAL");
  assert.equal(typed.error, "typed historical refusal");
  assert.equal(typed.archiveSuppliedTrustPolicy, true);
  assert.equal(typed.controllerAuthorityPinned, false);
  assert.equal(typed.builderAuthority, false);
  assert.equal(typed.productionAuthority, false);

  const untypedStatus = offlineChild.execute(
    () => {
      const error = new Error("x".repeat(3_000));
      error.code = "bad-code";
      throw error;
    },
    (value) => outputs.push(value),
  );
  assert.equal(untypedStatus, 1);
  const untyped = JSON.parse(outputs.pop());
  assert.equal(untyped.code, "OFFLINE_VERIFICATION_FAILED");
  assert.equal(untyped.error.length, 2_048);

  const scalarStatus = offlineChild.execute(
    () => {
      throw "";
    },
    (value) => outputs.push(value),
  );
  assert.equal(scalarStatus, 1);
  const scalar = JSON.parse(outputs.pop());
  assert.equal(scalar.error, "offline verification failed");
});

test("critical ceremony guard-removal mutants are exposed by the focused invariants", () => {
  const fixture = buildArchiveFixture({ variant: "parent-mutants" });
  const payload = successPayload(fixture);
  let mutants = 0;

  const liveMutant = loadMutant(
    CEREMONY_PATH,
    [[
      "    live() {\n      fail(",
      "    live() {\n      return Object.freeze({ builderAuthority: true });\n      fail(",
    ]],
    "parseChildOutput, validateIsolatedStoreRoot",
  );
  mutants += 1;
  assert.deepEqual(liveMutant.runCanonicalLiveCeremony({}), {
    builderAuthority: true,
  });

  const writerMutant = loadMutant(
    CEREMONY_PATH,
    [[
      ": proofStore.initializeIsolatedNonAuthorizingTestStore(storeSpec.root);",
      ": proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(storeSpec.root);",
    ]],
    "parseChildOutput, validateIsolatedStoreRoot",
  );
  mutants += 1;
  expectCode(
    () =>
      withSpawnResult(
        processResult({ payload }),
        () =>
          writerMutant
            .createIsolatedAuditControllerForTests(fixture.root)
            .adoptAudit(fixture.archiveRoot),
      ),
    "PROOF_STORE_READ_ONLY",
  );

  const exactRootMutant = loadMutant(
    CEREMONY_PATH,
    [[
      "Reflect.ownKeys(value).length !== expected.length ||",
      "false ||",
    ]],
    "parseChildOutput, validateIsolatedStoreRoot",
  );
  mutants += 1;
  const extraVerification = clone(payload);
  extraVerification.verification.attackerControlledRoot = true;
  assert.doesNotThrow(() =>
    withSpawnResult(
      processResult({ payload: extraVerification }),
      () =>
        exactRootMutant
          .createIsolatedAuditControllerForTests(fixture.root)
          .inspect(fixture.archiveRoot),
    ),
  );

  const pidMutant = loadMutant(
    CEREMONY_PATH,
    [["    payload.processId <= 0 ||", "    false ||"]],
    "parseChildOutput, validateIsolatedStoreRoot",
  );
  mutants += 1;
  const zeroPid = clone(payload);
  zeroPid.processId = 0;
  assert.doesNotThrow(() =>
    withSpawnResult(
      processResult({ payload: zeroPid }),
      () =>
        pidMutant
          .createIsolatedAuditControllerForTests(fixture.root)
          .inspect(fixture.archiveRoot),
    ),
  );

  const utf8Mutant = loadMutant(
    CEREMONY_PATH,
    [
      ['new TextDecoder("utf-8", { fatal: true })', 'new TextDecoder("utf-8")'],
      ['if (decoded.includes("\\uFFFD")) {', "if (false) {"],
    ],
    "parseChildOutput, validateIsolatedStoreRoot",
  );
  mutants += 1;
  assert.deepEqual(
    utf8Mutant.__testOnly.parseChildOutput(
      Buffer.from([
        0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
      ]),
    ),
    { x: "\uFFFD(" },
  );

  const pathMutant = loadMutant(
    CEREMONY_PATH,
    [
      ["    realRoot !== root ||", "    false ||"],
      ["    rootStat.isSymbolicLink() ||", "    false ||"],
      ["    !rootStat.isDirectory() ||", "    false ||"],
      [
        "    Number(rootStat.mode & 0o777n) !== 0o700",
        "    false",
      ],
    ],
    "parseChildOutput, validateIsolatedStoreRoot",
  );
  mutants += 1;
  const alias = path.join(
    fs.realpathSync(os.tmpdir()),
    `pikiio-proof-v5-test-mutant-alias-${process.pid}`,
  );
  fs.symlinkSync(fixture.root, alias);
  try {
    assert.equal(
      pathMutant.__testOnly.validateIsolatedStoreRoot(alias),
      alias,
    );
  } finally {
    fs.unlinkSync(alias);
  }

  const freezeMutant = loadMutant(
    CEREMONY_PATH,
    [["    if (actual !== pin.expected) {", "    if (false) {"]],
    "parseChildOutput, validateIsolatedStoreRoot",
  );
  mutants += 1;
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    const bytes = originalRead.call(fs, file, ...args);
    return path.resolve(String(file)) ===
      path.join(ROOT, "lib", "pikiio-proof-store.js")
      ? Buffer.concat([Buffer.from(bytes), Buffer.from("tamper")])
      : bytes;
  };
  try {
    assert.doesNotThrow(() =>
      withSpawnResult(
        processResult({ payload }),
        () =>
          freezeMutant
            .createIsolatedAuditControllerForTests(fixture.root)
            .inspect(fixture.archiveRoot),
      ),
    );
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(mutants, 7);
});

test("critical offline-child guard-removal mutants are exposed by the focused invariants", () => {
  const fixture = buildArchiveFixture({ variant: "child-mutants" });
  const valid = childRequest(fixture.root, fixture.archiveRoot);
  let mutants = 0;

  const exactRootMutant = loadMutant(
    CHILD_PATH,
    [[
      "Reflect.ownKeys(value).length === keys.length &&",
      "true &&",
    ]],
    "parseJsonBytes, validateIsolatedStoreRoot",
  );
  mutants += 1;
  assert.doesNotThrow(() =>
    exactRootMutant.validateRequest({ ...valid, attackerControlledRoot: true }),
  );

  const utf8Mutant = loadMutant(
    CHILD_PATH,
    [
      [
        'new TextDecoder("utf-8", { fatal: true })',
        'new TextDecoder("utf-8")',
      ],
      ['if (decoded.includes("\\uFFFD")) {', "if (false) {"],
    ],
    "parseJsonBytes, validateIsolatedStoreRoot",
  );
  mutants += 1;
  assert.deepEqual(
    utf8Mutant.__testOnly.parseJsonBytes(
      Buffer.from([
        0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
      ]),
      "mutant",
    ),
    { x: "\uFFFD(" },
  );

  const pathMutant = loadMutant(
    CHILD_PATH,
    [
      ["    realRoot !== root ||", "    false ||"],
      ["    rootStat.isSymbolicLink() ||", "    false ||"],
      ["    !rootStat.isDirectory() ||", "    false ||"],
      [
        "    Number(rootStat.mode & 0o777n) !== 0o700",
        "    false",
      ],
    ],
    "parseJsonBytes, validateIsolatedStoreRoot",
  );
  mutants += 1;
  const alias = path.join(
    fs.realpathSync(os.tmpdir()),
    `pikiio-proof-v5-test-child-mutant-alias-${process.pid}`,
  );
  fs.symlinkSync(fixture.root, alias);
  try {
    assert.equal(
      pathMutant.__testOnly.validateIsolatedStoreRoot(alias),
      alias,
    );
  } finally {
    fs.unlinkSync(alias);
  }

  const writerMutant = loadMutant(
    CHILD_PATH,
    [[
      "return proofStore.openIsolatedNonAuthorizingTestStoreReadOnly(\n      storeSpec.root,\n    );",
      "return proofStore.initializeIsolatedNonAuthorizingTestStore(\n      storeSpec.root,\n    );",
    ]],
    "parseJsonBytes, validateIsolatedStoreRoot",
  );
  mutants += 1;
  const emptyRoot = temporaryRoot();
  const before = recursiveSnapshot(emptyRoot);
  const request = childRequest(emptyRoot, fixture.archiveRoot);
  assert.throws(() => writerMutant.verify(request));
  assert.notDeepEqual(recursiveSnapshot(emptyRoot), before);
  assert.equal(mutants, 4);
});
