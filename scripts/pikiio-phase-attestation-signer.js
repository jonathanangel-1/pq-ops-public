#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  sha256,
  signAttestationBody,
  stableJson,
  validateAttestationBody,
  validateIssuerRegistry,
} = require("../lib/pikiio-phase-attestation");

const REQUEST_SCHEMA = "pikiio-phase-attestation-sign-request-v1";
const ERROR_SCHEMA = "pikiio-phase-attestation-signer-error-v1";
const MAX_PATH_BYTES = 4096;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_REGISTRY_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const REQUEST_KEYS = Object.freeze([
  "schema",
  "role",
  "issuerId",
  "issuerRegistryPath",
  "issuerRegistrySha256",
  "attestationBodyPath",
  "attestationBodySha256",
  "privateKeyPath",
]);
const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "OPENSSL_CONF",
  "SSLKEYLOGFILE",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;

class PhaseAttestationSignerError extends Error {
  constructor(code) {
    super(code);
    this.name = "PhaseAttestationSignerError";
    this.code = code;
  }
}

function fail(code) {
  throw new PhaseAttestationSignerError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validateAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    fail("INVALID_PATH");
  }
  return value;
}

function statFingerprint(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}

function requireRegularStat(stat, maximumBytes) {
  if (!stat.isFile() || stat.isSymbolicLink()) fail("FILE_NOT_REGULAR");
  if (stat.size <= 0n) fail("FILE_EMPTY");
  if (stat.size > BigInt(maximumBytes)) fail("FILE_TOO_LARGE");
}

function requirePrivateKeyStat(stat, { platform, effectiveUid }) {
  if (platform !== "darwin" && platform !== "linux") {
    fail("UNSUPPORTED_PRIVATE_KEY_PLATFORM");
  }
  if (!Number.isSafeInteger(effectiveUid) || effectiveUid < 0) {
    fail("PRIVATE_KEY_OWNER_UNAVAILABLE");
  }
  if (stat.uid !== BigInt(effectiveUid)) fail("PRIVATE_KEY_OWNER_MISMATCH");
  if (stat.nlink !== 1n) fail("PRIVATE_KEY_LINK_COUNT");
  const permissions = Number(stat.mode & 0o7777n);
  if (permissions !== 0o400 && permissions !== 0o600) {
    fail("PRIVATE_KEY_PERMISSIONS");
  }
}

function readBoundedRegularFile(
  filePath,
  {
    maximumBytes,
    privateKey = false,
    platform = process.platform,
    effectiveUid =
      typeof process.geteuid === "function" ? process.geteuid() : null,
    fileSystem = fs,
  },
) {
  validateAbsolutePath(filePath);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail("INVALID_SIZE_LIMIT");
  }
  const noFollow = fileSystem.constants?.O_NOFOLLOW;
  const readOnly = fileSystem.constants?.O_RDONLY;
  if (!Number.isInteger(noFollow) || !Number.isInteger(readOnly)) {
    fail("NOFOLLOW_UNAVAILABLE");
  }

  let pathBefore;
  try {
    pathBefore = fileSystem.lstatSync(filePath, { bigint: true });
  } catch {
    fail("FILE_UNAVAILABLE");
  }
  requireRegularStat(pathBefore, maximumBytes);
  if (privateKey) {
    requirePrivateKeyStat(pathBefore, { platform, effectiveUid });
  }

  const closeOnExec = fileSystem.constants?.O_CLOEXEC || 0;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(filePath, readOnly | noFollow | closeOnExec);
  } catch {
    fail("FILE_OPEN_REFUSED");
  }

  try {
    const descriptorBefore = fileSystem.fstatSync(descriptor, { bigint: true });
    requireRegularStat(descriptorBefore, maximumBytes);
    if (privateKey) {
      requirePrivateKeyStat(descriptorBefore, { platform, effectiveUid });
    }
    if (statFingerprint(pathBefore) !== statFingerprint(descriptorBefore)) {
      fail("FILE_CHANGED_DURING_OPEN");
    }

    const bytes = Buffer.alloc(Number(descriptorBefore.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fileSystem.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0) fail("FILE_SHORT_READ");
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    if (
      fileSystem.readSync(
        descriptor,
        overflow,
        0,
        1,
        bytes.length,
      ) !== 0
    ) {
      fail("FILE_GREW_DURING_READ");
    }

    const descriptorAfter = fileSystem.fstatSync(descriptor, { bigint: true });
    if (
      statFingerprint(descriptorBefore) !== statFingerprint(descriptorAfter)
    ) {
      fail("FILE_CHANGED_DURING_READ");
    }

    let pathAfter;
    try {
      pathAfter = fileSystem.lstatSync(filePath, { bigint: true });
    } catch {
      fail("FILE_CHANGED_AFTER_READ");
    }
    if (statFingerprint(descriptorAfter) !== statFingerprint(pathAfter)) {
      fail("FILE_CHANGED_AFTER_READ");
    }
    return bytes;
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function parseCanonicalJson(bytes, expectedLabel) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    fail(`${expectedLabel}_UTF8_INVALID`);
  }
  if (text.charCodeAt(0) === 0xfeff) fail(`${expectedLabel}_BOM_FORBIDDEN`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${expectedLabel}_JSON_INVALID`);
  }
  const canonical = stableJson(value);
  if (canonical !== text) fail(`${expectedLabel}_JSON_NOT_CANONICAL`);
  return value;
}

function validateSignRequest(request) {
  if (!exactKeys(request, REQUEST_KEYS)) fail("REQUEST_FIELDS_INVALID");
  if (request.schema !== REQUEST_SCHEMA) fail("REQUEST_SCHEMA_INVALID");
  if (request.role !== "controller") fail("LOCAL_COLLECTOR_FORBIDDEN");
  if (
    typeof request.issuerId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.issuerId)
  ) {
    fail("REQUEST_ISSUER_INVALID");
  }
  validateAbsolutePath(request.issuerRegistryPath);
  validateAbsolutePath(request.attestationBodyPath);
  validateAbsolutePath(request.privateKeyPath);
  if (
    request.issuerRegistryPath === request.attestationBodyPath ||
    request.issuerRegistryPath === request.privateKeyPath ||
    request.attestationBodyPath === request.privateKeyPath
  ) {
    fail("REQUEST_PATH_COLLISION");
  }
  if (
    typeof request.issuerRegistrySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.issuerRegistrySha256) ||
    typeof request.attestationBodySha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.attestationBodySha256)
  ) {
    fail("REQUEST_HASH_INVALID");
  }
  return request;
}

function importPrivateEd25519Key(bytes) {
  const text = bytes.toString("ascii");
  if (
    !bytes.equals(Buffer.from(text, "ascii")) ||
    !text.startsWith("-----BEGIN PRIVATE KEY-----\n") ||
    !text.endsWith("\n-----END PRIVATE KEY-----\n") ||
    text.includes("ENCRYPTED")
  ) {
    fail("PRIVATE_KEY_FORMAT_INVALID");
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: bytes, format: "pem" });
  } catch {
    fail("PRIVATE_KEY_IMPORT_FAILED");
  }
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  ) {
    fail("PRIVATE_KEY_ALGORITHM_INVALID");
  }
  return privateKey;
}

function signControllerRequest(request) {
  validateSignRequest(request);
  const registryBytes = readBoundedRegularFile(request.issuerRegistryPath, {
    maximumBytes: MAX_REGISTRY_BYTES,
  });
  if (sha256(registryBytes) !== request.issuerRegistrySha256) {
    fail("REGISTRY_FILE_HASH_MISMATCH");
  }
  const registry = parseCanonicalJson(registryBytes, "REGISTRY");
  try {
    validateIssuerRegistry(registry);
  } catch {
    fail("REGISTRY_CONTRACT_INVALID");
  }

  const bodyBytes = readBoundedRegularFile(request.attestationBodyPath, {
    maximumBytes: MAX_BODY_BYTES,
  });
  if (sha256(bodyBytes) !== request.attestationBodySha256) {
    fail("BODY_FILE_HASH_MISMATCH");
  }
  const body = parseCanonicalJson(bodyBytes, "BODY");
  try {
    validateAttestationBody(body);
  } catch {
    fail("BODY_CONTRACT_INVALID");
  }
  if (body.issuerRegistrySha256 !== request.issuerRegistrySha256) {
    fail("BODY_REGISTRY_BINDING_MISMATCH");
  }

  const issuer = registry.issuers.controller;
  if (issuer.issuerId !== request.issuerId) fail("REQUEST_ISSUER_MISMATCH");
  const privateKeyBytes = readBoundedRegularFile(request.privateKeyPath, {
    maximumBytes: MAX_PRIVATE_KEY_BYTES,
    privateKey: true,
  });
  let signature;
  try {
    const privateKey = importPrivateEd25519Key(privateKeyBytes);
    try {
      signature = signAttestationBody({
        body,
        registry,
        role: "controller",
        issuerId: issuer.issuerId,
        privateKey,
      });
    } catch {
      fail("SIGNING_AUTHORITY_REFUSED");
    }
  } finally {
    privateKeyBytes.fill(0);
  }

  const publicDer = Buffer.from(issuer.publicKeySpkiBase64, "base64");
  const publicKey = crypto.createPublicKey({
    key: publicDer,
    format: "der",
    type: "spki",
  });
  const signatureBytes = Buffer.from(signature.signatureBase64, "base64");
  if (
    signatureBytes.length !== 64 ||
    !crypto.verify(null, bodyBytes, publicKey, signatureBytes)
  ) {
    fail("SIGNATURE_SELF_VERIFICATION_FAILED");
  }
  return signature;
}

function validateSignerEnvironment(environment) {
  if (!isPlainObject(environment)) fail("ENVIRONMENT_INVALID");
  for (const key of Object.keys(environment)) {
    if (
      FORBIDDEN_ENVIRONMENT_KEYS.has(key) ||
      key.startsWith("PIKIIO_PHASE_ATTESTATION_") ||
      key.startsWith("DYLD_")
    ) {
      fail("ENVIRONMENT_WIDENING_REFUSED");
    }
  }
}

function safeErrorCode(error) {
  if (
    error instanceof PhaseAttestationSignerError &&
    SAFE_ERROR_CODE.test(error.code)
  ) {
    return error.code;
  }
  return "INTERNAL_REFUSAL";
}

function runSignerCli({
  argv,
  environment,
  writeStdout,
  writeStderr,
}) {
  try {
    validateSignerEnvironment(environment);
    if (
      !Array.isArray(argv) ||
      argv.length !== 2 ||
      argv[0] !== "--request"
    ) {
      fail("ARGUMENTS_INVALID");
    }
    const requestPath = validateAbsolutePath(argv[1]);
    const requestBytes = readBoundedRegularFile(requestPath, {
      maximumBytes: MAX_REQUEST_BYTES,
    });
    const request = parseCanonicalJson(requestBytes, "REQUEST");
    const signature = signControllerRequest(request);
    writeStdout(`${stableJson(signature)}\n`);
    return 0;
  } catch (error) {
    const response = {
      schema: ERROR_SCHEMA,
      ok: false,
      code: safeErrorCode(error),
    };
    writeStderr(`${stableJson(response)}\n`);
    return 1;
  }
}

if (require.main === module) {
  const exitCode = runSignerCli({
    argv: process.argv.slice(2),
    environment: { ...process.env },
    writeStdout: process.stdout.write.bind(process.stdout),
    writeStderr: process.stderr.write.bind(process.stderr),
  });
  process.exitCode = exitCode;
}

module.exports = {
  ERROR_SCHEMA,
  MAX_BODY_BYTES,
  MAX_PRIVATE_KEY_BYTES,
  MAX_REGISTRY_BYTES,
  MAX_REQUEST_BYTES,
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
};
