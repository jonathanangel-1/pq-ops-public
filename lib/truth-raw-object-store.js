"use strict";

const crypto = require("node:crypto");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  isAbortError,
  throwIfAborted,
} = require("./runtime-deadline");

const DEFAULT_KEY_PREFIX = "truth-raw/v1";
// Supabase Storage's FileOptions.cacheControl is the max-age value, without
// the `max-age=` directive used on the eventual response header.
const DEFAULT_CACHE_CONTROL = "31536000";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const MAX_ATTACHMENT_METADATA_BYTES = 16 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
const TRUTH_METADATA_KEYS = Object.freeze([
  "truth_schema_version",
  "truth_coordinate_sha256",
  "truth_content_sha256",
  "truth_content_bytes",
  "truth_content_type",
  "truth_attachment_sha256",
  "truth_attachment_json",
]);
const METADATA_ALIAS_CONFLICT = "__truth_metadata_alias_conflict__";

class TruthRawObjectStoreError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "TruthRawObjectStoreError";
    this.code = fields.code || "TRUTH_RAW_OBJECT_STORE_ERROR";
    this.operation = fields.operation || "";
    this.status = fields.status === undefined || fields.status === null || fields.status === ""
      ? null
      : Number.isFinite(Number(fields.status)) ? Number(fields.status) : null;
    this.retryable = Boolean(fields.retryable);
    this.integrityFailure = Boolean(fields.integrityFailure);
    this.deadlineExceeded = Boolean(fields.deadlineExceeded);
    this.outcomeUnknown = Boolean(fields.outcomeUnknown);
    this.field = fields.field || "";
    if (fields.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthRawObjectStoreError(`Invalid raw-object store argument ${field}: ${reason}`, {
    code: "TRUTH_RAW_OBJECT_INVALID_ARGUMENT",
    operation: "validate",
    field,
  });
}

function integrityError(code, operation, message) {
  return new TruthRawObjectStoreError(message, {
    code,
    operation,
    integrityFailure: true,
    retryable: false,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, field = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidArgument(field, "must not contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      result[key] = canonicalize(value[key], `${field}.${key}`);
    }
    return result;
  }
  throw invalidArgument(field, "must contain only JSON-compatible values");
}

function stableJson(value, field) {
  return JSON.stringify(canonicalize(value, field));
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashJson(value, field = "value") {
  return crypto.createHash("sha256").update(stableJson(value, field), "utf8").digest("hex");
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!allowEmpty && value.length === 0) throw invalidArgument(field, "must not be empty");
  if (value.trim() !== value) throw invalidArgument(field, "must not have surrounding whitespace");
  if (Buffer.byteLength(value, "utf8") > 4096) throw invalidArgument(field, "is too long");
  return value;
}

function requireHash(value, field) {
  const hash = requireString(value, field);
  if (!HASH_RE.test(hash)) throw invalidArgument(field, "must be a lowercase SHA-256 hex digest");
  return hash;
}

function pathSegment(value) {
  if (value === "") return "_";
  return Buffer.from(value, "utf8").toString("base64url");
}

function normalizePrefix(value) {
  const prefix = requireString(value, "keyPrefix").replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw invalidArgument("keyPrefix", "must contain safe non-empty path segments");
  }
  if (!/^[A-Za-z0-9._~/-]+$/.test(prefix)) {
    throw invalidArgument("keyPrefix", "must contain only URL-safe path characters");
  }
  return prefix;
}

function normalizeCoordinate(input) {
  if (!isPlainObject(input)) throw invalidArgument("coordinate", "must be an object");
  return {
    workspaceKey: requireString(input.workspaceKey, "workspaceKey"),
    sourceSystem: requireString(input.sourceSystem, "sourceSystem"),
    connectionKey: requireString(input.connectionKey, "connectionKey"),
    sourceObjectType: requireString(input.sourceObjectType, "sourceObjectType"),
    sourceObjectId: requireString(input.sourceObjectId, "sourceObjectId"),
    sourceRevision: requireString(input.sourceRevision ?? "", "sourceRevision", { allowEmpty: true }),
  };
}

function deriveRawObjectKey(input, options = {}) {
  if (!isPlainObject(input)) throw invalidArgument("keyInput", "must be an object");
  const coordinate = normalizeCoordinate(input);
  const contentHash = requireHash(input.contentHash, "contentHash");
  const keyPrefix = normalizePrefix(options.keyPrefix || DEFAULT_KEY_PREFIX);
  const key = [
    keyPrefix,
    pathSegment(coordinate.workspaceKey),
    pathSegment(coordinate.sourceSystem),
    pathSegment(coordinate.connectionKey),
    pathSegment(coordinate.sourceObjectType),
    pathSegment(coordinate.sourceObjectId),
    pathSegment(coordinate.sourceRevision),
    contentHash,
  ].join("/");
  if (Buffer.byteLength(key, "utf8") > 2048) {
    throw invalidArgument("keyInput", "produces an object key longer than 2048 encoded bytes");
  }
  return key;
}

function cloneBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw invalidArgument("bytes", "must be a Buffer or Uint8Array");
}

function normalizeAttachmentMetadata(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw invalidArgument("attachmentMetadata", "must be an object or null");
  const normalized = canonicalize(value, "attachmentMetadata");
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_ATTACHMENT_METADATA_BYTES) {
    throw invalidArgument("attachmentMetadata", `must not exceed ${MAX_ATTACHMENT_METADATA_BYTES} encoded bytes`);
  }
  return normalized;
}

function normalizeContentType(value, attachmentMetadata) {
  const candidate = value || attachmentMetadata?.contentType || attachmentMetadata?.mimeType || DEFAULT_CONTENT_TYPE;
  const contentType = requireString(candidate, "contentType");
  if (contentType.length > 255 || /[\r\n\0]/.test(contentType)) {
    throw invalidArgument("contentType", "must be a valid single-line media type");
  }
  return contentType;
}

function immutable(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) immutable(item);
  return value;
}

function statusFrom(error) {
  const candidates = [error?.status, error?.statusCode, error?.status_code];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function errorFingerprint(error) {
  return `${error?.code || ""} ${error?.name || ""} ${error?.message || ""}`.toLowerCase();
}

function isAlreadyExistsError(error) {
  const status = statusFrom(error);
  const fingerprint = errorFingerprint(error);
  return status === 409 || /duplicate|already.?exists|resource.?exists|conflict/.test(fingerprint);
}

function normalizeStorageError(error, operation) {
  if (error instanceof TruthRawObjectStoreError) return error;
  if (isAbortError(error)) {
    const deadline = asDeadlineError(error, {
      stage: `truth raw Storage ${operation}`,
      outcomeUnknown: error?.outcomeUnknown === true,
    });
    return new TruthRawObjectStoreError(deadline.message, {
      code: deadline.code,
      operation,
      retryable: true,
      deadlineExceeded: true,
      outcomeUnknown: deadline.outcomeUnknown,
      cause: deadline,
    });
  }
  const status = statusFrom(error);
  const fingerprint = errorFingerprint(error);
  if (isAlreadyExistsError(error)) {
    return new TruthRawObjectStoreError("The immutable raw object already exists", {
      code: "TRUTH_RAW_OBJECT_ALREADY_EXISTS",
      operation,
      status: status ?? 409,
    });
  }
  if (status === 401 || status === 403) {
    return new TruthRawObjectStoreError("Raw-object storage authorization failed", {
      code: "TRUTH_RAW_OBJECT_STORAGE_AUTH_FAILED",
      operation,
      status,
    });
  }
  if (status === 404) {
    return new TruthRawObjectStoreError("The raw object was not found during verification", {
      code: "TRUTH_RAW_OBJECT_NOT_FOUND",
      operation,
      status,
    });
  }
  const timeout = error?.name === "AbortError" || /timeout|timed out|etimedout/.test(fingerprint);
  const network = /econnreset|eai_again|enotfound|network|fetch failed/.test(fingerprint);
  const retryable = timeout || network || status === 408 || status === 429 || Number(status) >= 500;
  return new TruthRawObjectStoreError(
    retryable ? "Raw-object storage is temporarily unavailable" : "Raw-object storage operation failed",
    {
      code: retryable ? "TRUTH_RAW_OBJECT_STORAGE_UNAVAILABLE" : "TRUTH_RAW_OBJECT_STORAGE_FAILED",
      operation,
      status,
      retryable,
    },
  );
}

function outcomeUnknownStorageError(error, operation, deadlineAtMs = null) {
  const unknown = asOutcomeUnknownError(error, {
    stage: `truth raw Storage ${operation}`,
    deadlineAtMs,
    code: "TRUTH_RAW_STORAGE_OUTCOME_UNKNOWN",
  });
  return new TruthRawObjectStoreError(unknown.message, {
    code: unknown.code,
    operation,
    status: statusFrom(error),
    retryable: true,
    deadlineExceeded: unknown.deadlineExceeded === true,
    outcomeUnknown: true,
    cause: unknown,
  });
}

function unwrapSupabaseResult(result, operation) {
  if (!result || typeof result !== "object") {
    throw new TruthRawObjectStoreError("Raw-object storage returned an invalid receipt", {
      code: "TRUTH_RAW_OBJECT_INVALID_STORAGE_RECEIPT",
      operation,
    });
  }
  if (result.error) throw normalizeStorageError(result.error, operation);
  if (!("data" in result)) {
    throw new TruthRawObjectStoreError("Raw-object storage returned an invalid receipt", {
      code: "TRUTH_RAW_OBJECT_INVALID_STORAGE_RECEIPT",
      operation,
    });
  }
  return result.data;
}

async function callStorage(operation, fn, options = {}) {
  const signal = options.signal || null;
  const outcomeUnknown = options.outcomeUnknown === true;
  const deadlineAtMs = options.deadlineAtMs ?? null;
  try {
    throwIfAborted(signal, {
      stage: `truth raw Storage ${operation}`,
      deadlineAtMs,
      outcomeUnknown,
    });
    return unwrapSupabaseResult(await fn(), operation);
  } catch (error) {
    if (isAbortError(error, signal)) {
      const deadline = asDeadlineError(error, {
        signal,
        stage: `truth raw Storage ${operation}`,
        deadlineAtMs,
        outcomeUnknown,
      });
      throw new TruthRawObjectStoreError(deadline.message, {
        code: deadline.code,
        operation,
        retryable: true,
        deadlineExceeded: true,
        outcomeUnknown: deadline.outcomeUnknown,
        cause: deadline,
      });
    }
    const errorStatus = statusFrom(error);
    if (outcomeUnknown && (errorStatus === null || errorStatus === 408 || errorStatus >= 500)) {
      throw outcomeUnknownStorageError(error, operation, deadlineAtMs);
    }
    throw normalizeStorageError(error, operation);
  }
}

function expectedObjectMetadata({ coordinateHash, contentHash, bytes, contentType, attachmentMetadata }) {
  const attachmentJson = attachmentMetadata ? stableJson(attachmentMetadata, "attachmentMetadata") : "null";
  return Object.freeze({
    truth_schema_version: "truth-raw-object-v1",
    truth_coordinate_sha256: coordinateHash,
    truth_content_sha256: contentHash,
    truth_content_bytes: String(bytes),
    truth_content_type: contentType,
    truth_attachment_sha256: hashJson(attachmentMetadata, "attachmentMetadata"),
    truth_attachment_json: attachmentJson,
  });
}

function metadataCandidates(info) {
  if (!info || typeof info !== "object") return [];
  return [
    info.user_metadata,
    info.userMetadata,
    info.metadata?.user_metadata,
    info.metadata?.userMetadata,
    info.metadata?.metadata,
    info.metadata,
    info,
  ].filter(isPlainObject);
}

function storageCamelKey(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function canonicalTruthMetadata(candidate) {
  const schemaAliases = ["truth_schema_version", "truthSchemaVersion"];
  if (!schemaAliases.some((key) => Object.prototype.hasOwnProperty.call(candidate, key))) {
    return null;
  }
  const result = {};
  for (const canonicalKey of TRUTH_METADATA_KEYS) {
    const aliases = [canonicalKey, storageCamelKey(canonicalKey)];
    const values = aliases
      .filter((key) => Object.prototype.hasOwnProperty.call(candidate, key))
      .map((key) => candidate[key]);
    if (values.length === 0) continue;
    result[canonicalKey] = values.length > 1 && String(values[0]) !== String(values[1])
      ? METADATA_ALIAS_CONFLICT
      : values[0];
  }
  return result;
}

function extractTruthMetadata(info) {
  for (const candidate of metadataCandidates(info)) {
    const canonical = canonicalTruthMetadata(candidate);
    if (canonical) return canonical;
  }
  return null;
}

function verifyMetadata(actual, expected, operation, collision) {
  if (!actual) {
    throw integrityError(
      collision ? "TRUTH_RAW_OBJECT_METADATA_COLLISION" : "TRUTH_RAW_OBJECT_METADATA_MISSING",
      operation,
      "Stored raw-object truth metadata is missing",
    );
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (String(actual[key] ?? "") !== expectedValue) {
      throw integrityError(
        collision ? "TRUTH_RAW_OBJECT_METADATA_COLLISION" : "TRUTH_RAW_OBJECT_METADATA_MISMATCH",
        operation,
        "Stored raw-object truth metadata does not match the immutable write",
      );
    }
  }
}

function verifyUploadReceipt(uploadData, bucket, key, expectedMetadata) {
  if (!uploadData || typeof uploadData !== "object") {
    throw new TruthRawObjectStoreError("Raw-object upload returned an invalid receipt", {
      code: "TRUTH_RAW_OBJECT_INVALID_UPLOAD_RECEIPT",
      operation: "upload",
    });
  }
  if (uploadData.path !== key) {
    throw integrityError(
      "TRUTH_RAW_OBJECT_UPLOAD_PATH_MISMATCH",
      "upload",
      "Raw-object upload returned a different object path",
    );
  }
  if (uploadData.fullPath !== undefined && uploadData.fullPath !== null) {
    const normalizedFullPath = String(uploadData.fullPath).replace(/^\/+/, "");
    if (normalizedFullPath !== `${bucket}/${key}`) {
      throw integrityError(
        "TRUTH_RAW_OBJECT_UPLOAD_PATH_MISMATCH",
        "upload",
        "Raw-object upload returned a different full object path",
      );
    }
  }
  const returnedMetadata = extractTruthMetadata(uploadData);
  if (returnedMetadata) verifyMetadata(returnedMetadata, expectedMetadata, "upload", false);
}

async function dataToBuffer(data) {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (data && typeof data.arrayBuffer === "function") {
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(new Uint8Array(arrayBuffer));
  }
  throw new TruthRawObjectStoreError("Raw-object download returned unsupported binary data", {
    code: "TRUTH_RAW_OBJECT_INVALID_DOWNLOAD_RECEIPT",
    operation: "download",
  });
}

function objectIdentity(info) {
  const metadata = isPlainObject(info?.metadata) ? info.metadata : {};
  return {
    version: String(info?.version || info?.version_id || info?.versionId || metadata.version || ""),
    etag: String(info?.etag || info?.eTag || metadata.etag || metadata.eTag || "").replace(/^"|"$/g, ""),
  };
}

function systemSize(info) {
  const candidates = [info?.size, info?.metadata?.size, info?.metadata?.contentLength];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function createTruthRawObjectStore(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const storage = options.storage || options.supabase?.storage;
  if (!storage || typeof storage !== "object" || typeof storage.from !== "function") {
    throw invalidArgument("storage", "must expose the Supabase Storage from(bucket) API");
  }
  const bucket = requireString(options.bucket, "bucket");
  const keyPrefix = normalizePrefix(options.keyPrefix || DEFAULT_KEY_PREFIX);
  const cacheControl = requireString(options.cacheControl || DEFAULT_CACHE_CONTROL, "cacheControl");
  const requirePrivateBucket = options.requirePrivateBucket !== false;
  const signal = options.signal || null;
  const deadlineAtMs = options.deadlineAtMs ?? null;
  if (requirePrivateBucket && typeof storage.getBucket !== "function") {
    throw invalidArgument("storage.getBucket", "is required to prove the evidence bucket is private");
  }
  const bucketClient = storage.from(bucket);
  if (!bucketClient || typeof bucketClient.upload !== "function" || typeof bucketClient.download !== "function") {
    throw invalidArgument("storage.from(bucket)", "must expose upload and download methods");
  }
  if (typeof bucketClient.info !== "function" && typeof bucketClient.list !== "function") {
    throw invalidArgument("storage.from(bucket)", "must expose info(path) or list(folder) for metadata verification");
  }

  let privateBucketPromise = null;
  async function assertPrivateBucket() {
    if (!requirePrivateBucket) return;
    if (!privateBucketPromise) {
      privateBucketPromise = callStorage("bucket.get", () => storage.getBucket(bucket), { signal, deadlineAtMs })
        .then((data) => {
          if (!data || data.public !== false) {
            throw new TruthRawObjectStoreError("Raw evidence requires a private storage bucket", {
              code: "TRUTH_RAW_OBJECT_BUCKET_NOT_PRIVATE",
              operation: "bucket.get",
            });
          }
          return true;
        })
        .catch((error) => {
          privateBucketPromise = null;
          throw error;
        });
    }
    await privateBucketPromise;
  }

  async function inspectObject(key, outcomeUnknown = false) {
    if (typeof bucketClient.info === "function") {
      return callStorage("object.info", () => bucketClient.info(key), {
        signal,
        deadlineAtMs,
        outcomeUnknown,
      });
    }
    const slash = key.lastIndexOf("/");
    const folder = slash >= 0 ? key.slice(0, slash) : "";
    const filename = slash >= 0 ? key.slice(slash + 1) : key;
    const rows = await callStorage("object.list", () => bucketClient.list(folder, {
      search: filename,
      limit: 100,
      sortBy: { column: "name", order: "asc" },
    }), { signal, deadlineAtMs, outcomeUnknown });
    if (!Array.isArray(rows)) {
      throw new TruthRawObjectStoreError("Raw-object listing returned an invalid receipt", {
        code: "TRUTH_RAW_OBJECT_INVALID_STORAGE_RECEIPT",
        operation: "object.list",
      });
    }
    const exact = rows.find((row) => row && row.name === filename);
    if (!exact) {
      throw new TruthRawObjectStoreError("The raw object was not found during verification", {
        code: "TRUTH_RAW_OBJECT_NOT_FOUND",
        operation: "object.list",
        status: 404,
      });
    }
    return exact;
  }

  async function verifyStoredObject({ key, contentHash, contentBytes, expectedMetadata, collision }) {
    throwIfAborted(signal, {
      stage: "truth raw Storage post-upload verification",
      deadlineAtMs,
      outcomeUnknown: true,
    });
    const info = await inspectObject(key, true);
    verifyMetadata(extractTruthMetadata(info), expectedMetadata, "object.info", collision);
    const reportedSize = systemSize(info);
    if (reportedSize !== null && reportedSize !== contentBytes) {
      throw integrityError(
        collision ? "TRUTH_RAW_OBJECT_CONTENT_COLLISION" : "TRUTH_RAW_OBJECT_SIZE_MISMATCH",
        "object.info",
        "Stored raw-object size does not match the immutable write",
      );
    }
    const downloaded = await callStorage("object.download", () => bucketClient.download(key), {
      signal,
      deadlineAtMs,
      outcomeUnknown: true,
    });
    const storedBytes = await dataToBuffer(downloaded);
    throwIfAborted(signal, {
      stage: "truth raw Storage post-upload verification",
      deadlineAtMs,
      outcomeUnknown: true,
    });
    const storedHash = hashBytes(storedBytes);
    if (storedBytes.length !== contentBytes || storedHash !== contentHash) {
      throw integrityError(
        collision ? "TRUTH_RAW_OBJECT_CONTENT_COLLISION" : "TRUTH_RAW_OBJECT_HASH_MISMATCH",
        "object.download",
        "Stored raw-object bytes do not match the immutable write",
      );
    }
    return objectIdentity(info);
  }

  async function putRawObject(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("input", "must be an object");
    const coordinate = normalizeCoordinate(input);
    const content = cloneBytes(input.bytes);
    const contentHash = hashBytes(content);
    if (input.expectedSha256 !== undefined && requireHash(input.expectedSha256, "expectedSha256") !== contentHash) {
      throw integrityError(
        "TRUTH_RAW_OBJECT_EXPECTED_HASH_MISMATCH",
        "validate",
        "Raw-object bytes do not match the expected content hash",
      );
    }
    const attachmentMetadata = normalizeAttachmentMetadata(input.attachmentMetadata);
    const contentType = normalizeContentType(input.contentType, attachmentMetadata);
    const coordinateHash = hashJson(coordinate, "coordinate");
    const key = deriveRawObjectKey({ ...coordinate, contentHash }, { keyPrefix });
    const objectMetadata = expectedObjectMetadata({
      coordinateHash,
      contentHash,
      bytes: content.length,
      contentType,
      attachmentMetadata,
    });

    throwIfAborted(signal, {
      stage: "truth raw Storage upload",
      deadlineAtMs,
      outcomeUnknown: false,
    });
    await assertPrivateBucket();
    let idempotent = false;
    let uploadData = null;
    try {
      uploadData = await callStorage("upload", () => bucketClient.upload(key, content, {
        contentType,
        cacheControl,
        upsert: false,
        metadata: objectMetadata,
      }), { signal, deadlineAtMs, outcomeUnknown: true });
      verifyUploadReceipt(uploadData, bucket, key, objectMetadata);
    } catch (error) {
      let normalized = normalizeStorageError(error, "upload");
      if (normalized.status === null
          && normalized.code === "TRUTH_RAW_OBJECT_INVALID_STORAGE_RECEIPT") {
        normalized = outcomeUnknownStorageError(normalized, "upload", deadlineAtMs);
      }
      if (normalized.code !== "TRUTH_RAW_OBJECT_ALREADY_EXISTS") throw normalized;
      idempotent = true;
    }

    const identity = await verifyStoredObject({
      key,
      contentHash,
      contentBytes: content.length,
      expectedMetadata: objectMetadata,
      collision: idempotent,
    });
    return immutable({
      ok: true,
      idempotent,
      coordinateHash,
      metadataHash: hashJson(objectMetadata, "objectMetadata"),
      attachmentMetadata,
      rawObject: {
        bucket,
        key,
        version: identity.version,
        etag: identity.etag,
        hash: contentHash,
        bytes: content.length,
        contentType,
      },
    });
  }

  async function getRawObject(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("input", "must be an object");
    const key = requireString(input.key, "key");
    if (!key.startsWith(`${keyPrefix}/`) || key.includes("/../") || key.includes("/./")) {
      throw invalidArgument("key", "must be inside the configured immutable evidence prefix");
    }
    const expectedSha256 = requireHash(input.expectedSha256, "expectedSha256");
    const expectedBytes = Number(input.expectedBytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
      throw invalidArgument("expectedBytes", "must be a non-negative safe integer");
    }
    throwIfAborted(signal, { stage: "truth raw Storage read", deadlineAtMs, outcomeUnknown: false });
    await assertPrivateBucket();
    const info = await inspectObject(key);
    const metadata = extractTruthMetadata(info);
    if (!metadata
      || String(metadata.truth_schema_version || "") !== "truth-raw-object-v1"
      || String(metadata.truth_content_sha256 || "") !== expectedSha256
      || String(metadata.truth_content_bytes || "") !== String(expectedBytes)) {
      throw integrityError(
        "TRUTH_RAW_OBJECT_METADATA_MISMATCH",
        "object.info",
        "Stored raw-object truth metadata does not match the requested immutable object",
      );
    }
    const reportedSize = systemSize(info);
    if (reportedSize !== null && reportedSize !== expectedBytes) {
      throw integrityError(
        "TRUTH_RAW_OBJECT_SIZE_MISMATCH",
        "object.info",
        "Stored raw-object size does not match the requested immutable object",
      );
    }
    const downloaded = await callStorage("object.download", () => bucketClient.download(key), {
      signal,
      deadlineAtMs,
    });
    const bytes = await dataToBuffer(downloaded);
    throwIfAborted(signal, { stage: "truth raw Storage read", deadlineAtMs, outcomeUnknown: false });
    if (bytes.length !== expectedBytes || hashBytes(bytes) !== expectedSha256) {
      throw integrityError(
        "TRUTH_RAW_OBJECT_HASH_MISMATCH",
        "object.download",
        "Stored raw-object bytes do not match the requested immutable object",
      );
    }
    const identity = objectIdentity(info);
    return {
      ok: true,
      bytes,
      rawObject: {
        bucket,
        key,
        version: identity.version,
        etag: identity.etag,
        hash: expectedSha256,
        bytes: expectedBytes,
        contentType: String(metadata.truth_content_type || DEFAULT_CONTENT_TYPE),
      },
    };
  }

  return Object.freeze({
    bucket,
    keyPrefix,
    getRawObject,
    putRawObject,
  });
}

module.exports = {
  DEFAULT_CACHE_CONTROL,
  DEFAULT_CONTENT_TYPE,
  DEFAULT_KEY_PREFIX,
  MAX_ATTACHMENT_METADATA_BYTES,
  TruthRawObjectStoreError,
  createTruthRawObjectStore,
  deriveRawObjectKey,
  normalizeStorageError,
  _test: {
    canonicalize,
    canonicalTruthMetadata,
    dataToBuffer,
    expectedObjectMetadata,
    extractTruthMetadata,
    hashBytes,
    hashJson,
    isAlreadyExistsError,
    normalizeAttachmentMetadata,
    stableJson,
  },
};
