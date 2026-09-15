"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, describe, test } = require("node:test");

const {
  buildAttestationBody,
  buildIssuerRecord,
  sha256,
  stableJson,
} = require("../lib/pikiio-phase-attestation");
const {
  ERROR_SCHEMA,
  MAX_PRIVATE_KEY_BYTES,
  PhaseAttestationSignerError,
  REQUEST_SCHEMA,
  importPrivateEd25519Key,
  parseCanonicalJson,
  readBoundedRegularFile,
  runSignerCli,
  safeErrorCode,
  signControllerRequest,
  validateAbsolutePath,
  validateSignRequest,
  validateSignerEnvironment,
} = require("../scripts/pikiio-phase-attestation-signer");

const controllerKeys = crypto.generateKeyPairSync("ed25519");
const collectorKeys = crypto.generateKeyPairSync("ed25519");
const wrongKeys = crypto.generateKeyPairSync("ed25519");
const temporaryRoots = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digest(character) {
  return character.repeat(64);
}

function artifact(character) {
  const value = digest(character);
  return { address: `sha256:${value}`, sha256: value };
}

function writeFile(root, name, bytes, mode = 0o600) {
  const target = path.join(root, name);
  fs.writeFileSync(target, bytes, { mode });
  fs.chmodSync(target, mode);
  return target;
}

function makeRegistry() {
  return {
    schema: "pikiio-phase-attestation-issuer-registry-v1",
    revision: 1,
    issuers: {
      controller: buildIssuerRecord({
        role: "controller",
        issuerId: "controller-primary",
        publicKey: controllerKeys.publicKey,
      }),
      collector: buildIssuerRecord({
        role: "collector",
        issuerId: "collector-independent",
        publicKey: collectorKeys.publicKey,
      }),
    },
  };
}

function makeBody(registry) {
  return buildAttestationBody({
    phaseId: "GOV-00",
    issuerRegistrySha256: sha256(stableJson(registry)),
    ledgerRevision: 2,
    ledgerSha256: digest("a"),
    candidateCommit: "b".repeat(40),
    candidateTree: "c".repeat(40),
    strictQualityReceiptHash: digest("d"),
    commandPlanHash: digest("e"),
    primaryRawArtifactHash: digest("f"),
    independentRawArtifactHash: digest("1"),
    receiptHashes: {
      candidate: digest("2"),
      rehearsal: digest("3"),
      change: digest("4"),
      promotion: digest("5"),
    },
    artifacts: {
      primaryRaw: artifact("f"),
      independentRaw: artifact("1"),
      candidateReceipt: artifact("2"),
      rehearsalReceipt: artifact("3"),
      changeReceipt: artifact("4"),
      promotionReceipt: artifact("5"),
    },
  });
}

function makeFixture(role = "controller") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-signer-"));
  temporaryRoots.push(root);
  const registry = makeRegistry();
  const body = makeBody(registry);
  const registryBytes = Buffer.from(stableJson(registry));
  const bodyBytes = Buffer.from(stableJson(body));
  const privateKey =
    role === "controller" ? controllerKeys.privateKey : collectorKeys.privateKey;
  const keyBytes = Buffer.from(
    privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const registryPath = writeFile(root, "registry.json", registryBytes);
  const bodyPath = writeFile(root, "body.json", bodyBytes);
  const privateKeyPath = writeFile(root, "issuer-key.pem", keyBytes, 0o600);
  const request = {
    schema: REQUEST_SCHEMA,
    role,
    issuerId: registry.issuers[role].issuerId,
    issuerRegistryPath: registryPath,
    issuerRegistrySha256: sha256(registryBytes),
    attestationBodyPath: bodyPath,
    attestationBodySha256: sha256(bodyBytes),
    privateKeyPath,
  };
  const requestPath = writeFile(
    root,
    "request.json",
    Buffer.from(stableJson(request)),
  );
  return {
    root,
    registry,
    body,
    request,
    requestPath,
    registryPath,
    bodyPath,
    privateKeyPath,
    keyBytes,
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof PhaseAttestationSignerError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function invokeCli(requestPath, overrides = {}) {
  let stdout = "";
  let stderr = "";
  const status = runSignerCli({
    argv: ["--request", requestPath],
    environment: { PATH: "/usr/bin" },
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
    ...overrides,
  });
  return { status, stdout, stderr };
}

function rewriteCanonical(filePath, value) {
  const bytes = Buffer.from(stableJson(value));
  fs.writeFileSync(filePath, bytes);
  return sha256(bytes);
}

function fakeStat(stat, changes = {}) {
  return {
    ...stat,
    ...changes,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

after(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("single-role signer positive path", () => {
  test("controller request produces one exact self-verifying signature", () => {
    const fixture = makeFixture("controller");
    const signature = signControllerRequest(fixture.request);
    assert.deepEqual(Object.keys(signature).sort(), [
      "algorithm",
      "issuerId",
      "role",
      "signatureBase64",
    ]);
    assert.equal(signature.role, "controller");
    assert.equal(Buffer.from(signature.signatureBase64, "base64").length, 64);
    assert.equal(signature.signatureBase64.includes(fixture.keyBytes.toString()), false);
  });

  test("local collector signing is categorically forbidden", () => {
    const fixture = makeFixture("collector");
    expectCode("LOCAL_COLLECTOR_FORBIDDEN", () =>
      signControllerRequest(fixture.request),
    );
  });

  test("CLI emits exact signature JSON and an empty stderr", () => {
    const fixture = makeFixture();
    const result = invokeCli(fixture.requestPath);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(`${stableJson(JSON.parse(result.stdout))}\n`, result.stdout);
    assert.equal(JSON.parse(result.stdout).role, "controller");
  });

  test("real CLI entry point has the same bounded output contract", () => {
    const fixture = makeFixture();
    const run = spawnSync(
      process.execPath,
      [
        path.join(__dirname, "../scripts/pikiio-phase-attestation-signer.js"),
        "--request",
        fixture.requestPath,
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    assert.equal(JSON.parse(run.stdout).issuerId, "controller-primary");
  });

  test("private PKCS8 import accepts only Ed25519 private keys", () => {
    const fixture = makeFixture();
    const key = importPrivateEd25519Key(Buffer.from(fixture.keyBytes));
    assert.equal(key.type, "private");
    assert.equal(key.asymmetricKeyType, "ed25519");
  });

  test("regular-file reader returns exact bytes", () => {
    const fixture = makeFixture();
    assert.deepEqual(
      readBoundedRegularFile(fixture.bodyPath, { maximumBytes: 65536 }),
      Buffer.from(stableJson(fixture.body)),
    );
  });

  test("absolute normalized paths pass validation", () => {
    const fixture = makeFixture();
    assert.equal(validateAbsolutePath(fixture.requestPath), fixture.requestPath);
  });

  test("valid request is returned without widening", () => {
    const fixture = makeFixture();
    assert.equal(validateSignRequest(fixture.request), fixture.request);
  });
});

describe("bounded file transport refuses filesystem attacks", () => {
  test("relative paths are refused", () => {
    expectCode("INVALID_PATH", () =>
      readBoundedRegularFile("request.json", { maximumBytes: 1024 }),
    );
  });

  test("non-normalized absolute paths are refused", () => {
    const fixture = makeFixture();
    expectCode("INVALID_PATH", () =>
      validateAbsolutePath(`${fixture.root}/x/../request.json`),
    );
  });

  test("NUL-bearing paths are refused", () => {
    expectCode("INVALID_PATH", () => validateAbsolutePath("/tmp/a\0b"));
  });

  test("missing files produce a scrubbed refusal", () => {
    expectCode("FILE_UNAVAILABLE", () =>
      readBoundedRegularFile("/tmp/pikiio-signer-does-not-exist", {
        maximumBytes: 1024,
      }),
    );
  });

  test("directories are not regular files", () => {
    const fixture = makeFixture();
    expectCode("FILE_NOT_REGULAR", () =>
      readBoundedRegularFile(fixture.root, { maximumBytes: 1024 }),
    );
  });

  test("symlinks are refused before open", () => {
    const fixture = makeFixture();
    const link = path.join(fixture.root, "request-link");
    fs.symlinkSync(fixture.requestPath, link);
    expectCode("FILE_NOT_REGULAR", () =>
      readBoundedRegularFile(link, { maximumBytes: 16384 }),
    );
  });

  test("an ambiguous file-plus-symlink stat fails closed", () => {
    const fixture = makeFixture();
    const actual = fs.lstatSync(fixture.bodyPath, { bigint: true });
    const fileSystem = {
      constants: fs.constants,
      lstatSync: () => ({
        ...actual,
        isFile: () => true,
        isSymbolicLink: () => true,
      }),
    };
    expectCode("FILE_NOT_REGULAR", () =>
      readBoundedRegularFile(fixture.bodyPath, {
        maximumBytes: 65536,
        fileSystem,
      }),
    );
  });

  test("empty files are refused", () => {
    const fixture = makeFixture();
    const empty = writeFile(fixture.root, "empty", Buffer.alloc(0));
    expectCode("FILE_EMPTY", () =>
      readBoundedRegularFile(empty, { maximumBytes: 10 }),
    );
  });

  test("oversized files are refused before allocation", () => {
    const fixture = makeFixture();
    const large = writeFile(fixture.root, "large", Buffer.alloc(33));
    expectCode("FILE_TOO_LARGE", () =>
      readBoundedRegularFile(large, { maximumBytes: 32 }),
    );
  });

  test("invalid caller size limits are refused", () => {
    const fixture = makeFixture();
    expectCode("INVALID_SIZE_LIMIT", () =>
      readBoundedRegularFile(fixture.bodyPath, { maximumBytes: 0 }),
    );
  });

  test("private keys require owner-only mode", () => {
    const fixture = makeFixture();
    fs.chmodSync(fixture.privateKeyPath, 0o644);
    expectCode("PRIVATE_KEY_PERMISSIONS", () =>
      readBoundedRegularFile(fixture.privateKeyPath, {
        maximumBytes: MAX_PRIVATE_KEY_BYTES,
        privateKey: true,
      }),
    );
  });

  test("private key executable mode is refused", () => {
    const fixture = makeFixture();
    fs.chmodSync(fixture.privateKeyPath, 0o700);
    expectCode("PRIVATE_KEY_PERMISSIONS", () =>
      readBoundedRegularFile(fixture.privateKeyPath, {
        maximumBytes: MAX_PRIVATE_KEY_BYTES,
        privateKey: true,
      }),
    );
  });

  test("private keys with another hard link are refused", () => {
    const fixture = makeFixture();
    fs.linkSync(fixture.privateKeyPath, path.join(fixture.root, "second-key-link"));
    expectCode("PRIVATE_KEY_LINK_COUNT", () =>
      readBoundedRegularFile(fixture.privateKeyPath, {
        maximumBytes: MAX_PRIVATE_KEY_BYTES,
        privateKey: true,
      }),
    );
  });

  test("private key signing refuses unsupported platforms", () => {
    const fixture = makeFixture();
    expectCode("UNSUPPORTED_PRIVATE_KEY_PLATFORM", () =>
      readBoundedRegularFile(fixture.privateKeyPath, {
        maximumBytes: MAX_PRIVATE_KEY_BYTES,
        privateKey: true,
        platform: "win32",
      }),
    );
  });

  test("private key signing requires a known effective owner", () => {
    const fixture = makeFixture();
    expectCode("PRIVATE_KEY_OWNER_UNAVAILABLE", () =>
      readBoundedRegularFile(fixture.privateKeyPath, {
        maximumBytes: MAX_PRIVATE_KEY_BYTES,
        privateKey: true,
        effectiveUid: null,
      }),
    );
  });

  test("private key owner mismatch is refused", () => {
    const fixture = makeFixture();
    expectCode("PRIVATE_KEY_OWNER_MISMATCH", () =>
      readBoundedRegularFile(fixture.privateKeyPath, {
        maximumBytes: MAX_PRIVATE_KEY_BYTES,
        privateKey: true,
        effectiveUid: process.geteuid() + 1,
      }),
    );
  });

  test("lstat to open identity changes are refused", () => {
    const fixture = makeFixture();
    const real = fs.lstatSync(fixture.bodyPath, { bigint: true });
    const fileSystem = {
      ...fs,
      constants: fs.constants,
      lstatSync: fs.lstatSync,
      openSync: fs.openSync,
      fstatSync: (descriptor) =>
        fakeStat(fs.fstatSync(descriptor, { bigint: true }), {
          ino: real.ino + 1n,
        }),
      readSync: fs.readSync,
      closeSync: fs.closeSync,
    };
    expectCode("FILE_CHANGED_DURING_OPEN", () =>
      readBoundedRegularFile(fixture.bodyPath, {
        maximumBytes: 65536,
        fileSystem,
      }),
    );
  });

  test("short reads fail closed and still close the descriptor", () => {
    const fixture = makeFixture();
    let closed = false;
    const fileSystem = {
      ...fs,
      constants: fs.constants,
      lstatSync: fs.lstatSync,
      openSync: fs.openSync,
      fstatSync: fs.fstatSync,
      readSync: () => 0,
      closeSync: (descriptor) => {
        closed = true;
        fs.closeSync(descriptor);
      },
    };
    expectCode("FILE_SHORT_READ", () =>
      readBoundedRegularFile(fixture.bodyPath, {
        maximumBytes: 65536,
        fileSystem,
      }),
    );
    assert.equal(closed, true);
  });

  test("growth beyond the opened size is refused", () => {
    const fixture = makeFixture();
    let calls = 0;
    const fileSystem = {
      ...fs,
      constants: fs.constants,
      lstatSync: fs.lstatSync,
      openSync: fs.openSync,
      fstatSync: fs.fstatSync,
      readSync: (...args) => {
        calls += 1;
        if (calls === 2) return 1;
        return fs.readSync(...args);
      },
      closeSync: fs.closeSync,
    };
    expectCode("FILE_GREW_DURING_READ", () =>
      readBoundedRegularFile(fixture.bodyPath, {
        maximumBytes: 65536,
        fileSystem,
      }),
    );
  });

  test("descriptor metadata changes during read are refused", () => {
    const fixture = makeFixture();
    let calls = 0;
    const fileSystem = {
      ...fs,
      constants: fs.constants,
      lstatSync: fs.lstatSync,
      openSync: fs.openSync,
      fstatSync: (descriptor) => {
        calls += 1;
        const actual = fs.fstatSync(descriptor, { bigint: true });
        return calls === 2 ? fakeStat(actual, { mtimeNs: actual.mtimeNs + 1n }) : actual;
      },
      readSync: fs.readSync,
      closeSync: fs.closeSync,
    };
    expectCode("FILE_CHANGED_DURING_READ", () =>
      readBoundedRegularFile(fixture.bodyPath, {
        maximumBytes: 65536,
        fileSystem,
      }),
    );
  });

  test("path replacement after read is refused", () => {
    const fixture = makeFixture();
    let calls = 0;
    const fileSystem = {
      ...fs,
      constants: fs.constants,
      lstatSync: (target, options) => {
        calls += 1;
        const actual = fs.lstatSync(target, options);
        return calls === 2 ? fakeStat(actual, { ino: actual.ino + 1n }) : actual;
      },
      openSync: fs.openSync,
      fstatSync: fs.fstatSync,
      readSync: fs.readSync,
      closeSync: fs.closeSync,
    };
    expectCode("FILE_CHANGED_AFTER_READ", () =>
      readBoundedRegularFile(fixture.bodyPath, {
        maximumBytes: 65536,
        fileSystem,
      }),
    );
  });
});

describe("canonical input and authority binding", () => {
  test("invalid UTF-8 is refused", () => {
    expectCode("BODY_UTF8_INVALID", () =>
      parseCanonicalJson(Buffer.from([0xff]), "BODY"),
    );
  });

  test("UTF-8 BOM is refused", () => {
    expectCode("BODY_BOM_FORBIDDEN", () =>
      parseCanonicalJson(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
        "BODY",
      ),
    );
  });

  test("invalid JSON is refused", () => {
    expectCode("BODY_JSON_INVALID", () =>
      parseCanonicalJson(Buffer.from("{"), "BODY"),
    );
  });

  test("noncanonical whitespace is refused", () => {
    expectCode("BODY_JSON_NOT_CANONICAL", () =>
      parseCanonicalJson(Buffer.from('{ "a": 1 }'), "BODY"),
    );
  });

  test("request extra fields are refused", () => {
    const fixture = makeFixture();
    fixture.request.extra = true;
    expectCode("REQUEST_FIELDS_INVALID", () =>
      validateSignRequest(fixture.request),
    );
  });

  test("request schema is exact", () => {
    const fixture = makeFixture();
    fixture.request.schema = "pikiio-phase-attestation-sign-request-v2";
    expectCode("REQUEST_SCHEMA_INVALID", () =>
      validateSignRequest(fixture.request),
    );
  });

  test("every non-controller request role is categorically forbidden", () => {
    const fixture = makeFixture();
    fixture.request.role = "both";
    expectCode("LOCAL_COLLECTOR_FORBIDDEN", () =>
      validateSignRequest(fixture.request),
    );
  });

  test("request issuer ID is constrained", () => {
    const fixture = makeFixture();
    fixture.request.issuerId = "controller primary";
    expectCode("REQUEST_ISSUER_INVALID", () =>
      validateSignRequest(fixture.request),
    );
  });

  test("request paths must be distinct", () => {
    const fixture = makeFixture();
    fixture.request.privateKeyPath = fixture.request.attestationBodyPath;
    expectCode("REQUEST_PATH_COLLISION", () =>
      validateSignRequest(fixture.request),
    );
  });

  test("request hashes are exact lowercase SHA-256", () => {
    const fixture = makeFixture();
    fixture.request.attestationBodySha256 = "A".repeat(64);
    expectCode("REQUEST_HASH_INVALID", () =>
      validateSignRequest(fixture.request),
    );
  });

  test("registry file bytes are pinned by request", () => {
    const fixture = makeFixture();
    fixture.request.issuerRegistrySha256 = digest("9");
    expectCode("REGISTRY_FILE_HASH_MISMATCH", () =>
      signControllerRequest(fixture.request),
    );
  });

  test("registry contract failures are scrubbed", () => {
    const fixture = makeFixture();
    const registry = clone(fixture.registry);
    registry.revision = 2;
    fixture.request.issuerRegistrySha256 = rewriteCanonical(
      fixture.registryPath,
      registry,
    );
    expectCode("REGISTRY_CONTRACT_INVALID", () =>
      signControllerRequest(fixture.request),
    );
  });

  test("body file bytes are pinned by request", () => {
    const fixture = makeFixture();
    fixture.request.attestationBodySha256 = digest("9");
    expectCode("BODY_FILE_HASH_MISMATCH", () =>
      signControllerRequest(fixture.request),
    );
  });

  test("body contract failures are scrubbed", () => {
    const fixture = makeFixture();
    const body = clone(fixture.body);
    body.phaseId = "invalid";
    fixture.request.attestationBodySha256 = rewriteCanonical(
      fixture.bodyPath,
      body,
    );
    expectCode("BODY_CONTRACT_INVALID", () =>
      signControllerRequest(fixture.request),
    );
  });

  test("body must bind the exact supplied issuer registry", () => {
    const fixture = makeFixture();
    const body = clone(fixture.body);
    body.issuerRegistrySha256 = digest("9");
    fixture.request.attestationBodySha256 = rewriteCanonical(
      fixture.bodyPath,
      body,
    );
    expectCode("BODY_REGISTRY_BINDING_MISMATCH", () =>
      signControllerRequest(fixture.request),
    );
  });

  test("request issuer must match the registry role", () => {
    const fixture = makeFixture();
    fixture.request.issuerId = "collector-independent";
    expectCode("REQUEST_ISSUER_MISMATCH", () =>
      signControllerRequest(fixture.request),
    );
  });

  test("private key must use exact unencrypted PKCS8 PEM framing", () => {
    expectCode("PRIVATE_KEY_FORMAT_INVALID", () =>
      importPrivateEd25519Key(Buffer.from("secret")),
    );
  });

  test("malformed PKCS8 is refused without parser details", () => {
    expectCode("PRIVATE_KEY_IMPORT_FAILED", () =>
      importPrivateEd25519Key(
        Buffer.from(
          "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
        ),
      ),
    );
  });

  test("non-Ed25519 PKCS8 keys are refused", () => {
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    const pem = Buffer.from(
      rsa.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    expectCode("PRIVATE_KEY_ALGORITHM_INVALID", () =>
      importPrivateEd25519Key(pem),
    );
  });

  test("a different private key cannot impersonate the pinned issuer", () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      fixture.privateKeyPath,
      wrongKeys.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    fs.chmodSync(fixture.privateKeyPath, 0o600);
    expectCode("SIGNING_AUTHORITY_REFUSED", () =>
      signControllerRequest(fixture.request),
    );
  });

  test("self-verification is mandatory before signature output", () => {
    const fixture = makeFixture();
    const originalVerify = crypto.verify;
    crypto.verify = () => false;
    try {
      expectCode("SIGNATURE_SELF_VERIFICATION_FAILED", () =>
        signControllerRequest(fixture.request),
      );
    } finally {
      crypto.verify = originalVerify;
    }
  });
});

describe("CLI rejects widening and emits scrubbed failures", () => {
  test("CLI never emits a local collector signature", () => {
    const fixture = makeFixture("collector");
    const result = invokeCli(fixture.requestPath);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "LOCAL_COLLECTOR_FORBIDDEN");
  });

  test("extra arguments are refused", () => {
    const result = invokeCli("/tmp/unused", {
      argv: ["--request", "/tmp/unused", "--role", "controller"],
    });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      code: "ARGUMENTS_INVALID",
      ok: false,
      schema: ERROR_SCHEMA,
    });
    assert.equal(result.stdout, "");
  });

  test("wrong argument name is refused", () => {
    const result = invokeCli("/tmp/unused", {
      argv: ["--body", "/tmp/unused"],
    });
    assert.equal(JSON.parse(result.stderr).code, "ARGUMENTS_INVALID");
  });

  test("NODE_OPTIONS widening is refused", () => {
    expectCode("ENVIRONMENT_WIDENING_REFUSED", () =>
      validateSignerEnvironment({ NODE_OPTIONS: "--require=/tmp/hook.js" }),
    );
  });

  test("prefixed signer environment inputs are refused", () => {
    expectCode("ENVIRONMENT_WIDENING_REFUSED", () =>
      validateSignerEnvironment({
        PIKIIO_PHASE_ATTESTATION_PRIVATE_KEY: "/tmp/key",
      }),
    );
  });

  test("Darwin loader injection environment is refused", () => {
    expectCode("ENVIRONMENT_WIDENING_REFUSED", () =>
      validateSignerEnvironment({ DYLD_FAKE: "/tmp/library" }),
    );
  });

  test("environment must be a plain object", () => {
    expectCode("ENVIRONMENT_INVALID", () => validateSignerEnvironment(null));
  });

  test("unknown exceptions collapse to a fixed internal refusal", () => {
    assert.equal(safeErrorCode(new Error("private secret")), "INTERNAL_REFUSAL");
  });

  test("recognized signer codes are retained without messages", () => {
    assert.equal(
      safeErrorCode(new PhaseAttestationSignerError("FILE_UNAVAILABLE")),
      "FILE_UNAVAILABLE",
    );
  });

  test("CLI errors contain no requested path or key bytes", () => {
    const fixture = makeFixture();
    fs.chmodSync(fixture.privateKeyPath, 0o644);
    const result = invokeCli(fixture.requestPath);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(fixture.privateKeyPath), false);
    assert.equal(result.stderr.includes(fixture.keyBytes.toString()), false);
    assert.deepEqual(Object.keys(JSON.parse(result.stderr)).sort(), [
      "code",
      "ok",
      "schema",
    ]);
  });

  test("noncanonical request files fail before any signing", () => {
    const fixture = makeFixture();
    fs.writeFileSync(fixture.requestPath, `${stableJson(fixture.request)}\n`);
    const result = invokeCli(fixture.requestPath);
    assert.equal(JSON.parse(result.stderr).code, "REQUEST_JSON_NOT_CANONICAL");
  });
});
