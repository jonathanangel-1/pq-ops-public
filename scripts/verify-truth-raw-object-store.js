#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  DEFAULT_CACHE_CONTROL,
  TruthRawObjectStoreError,
  createTruthRawObjectStore,
  deriveRawObjectKey,
  normalizeStorageError,
} = require("../lib/truth-raw-object-store");

const checks = [];

async function check(name, fn) {
  await fn();
  checks.push(name);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeSupabaseStorage {
  constructor(options = {}) {
    this.bucketName = options.bucketName || "private-truth-evidence";
    this.public = Boolean(options.public);
    this.useInfo = options.useInfo !== false;
    this.camelCaseInfoMetadata = Boolean(options.camelCaseInfoMetadata);
    this.pathMismatch = Boolean(options.pathMismatch);
    this.throwUpload = options.throwUpload || null;
    this.calls = [];
    this.objects = new Map();
    this.nextId = 1;
  }

  async getBucket(bucket) {
    this.calls.push({ operation: "getBucket", bucket });
    return { data: { id: bucket, name: bucket, public: this.public }, error: null };
  }

  from(bucket) {
    assert.equal(bucket, this.bucketName);
    const api = {
      upload: async (key, bytes, options) => {
        this.calls.push({
          operation: "upload",
          key,
          bytes: Buffer.from(bytes),
          options: jsonClone(options),
        });
        if (this.throwUpload) throw this.throwUpload;
        if (this.objects.has(key)) {
          return {
            data: null,
            error: {
              statusCode: "409",
              code: "Duplicate",
              message: "Object already exists; bearer token and payload must never escape",
            },
          };
        }
        const id = `object-${this.nextId++}`;
        this.objects.set(key, {
          id,
          version: "v1",
          etag: sha256(bytes).slice(0, 32),
          bytes: Buffer.from(bytes),
          contentType: options.contentType,
          metadata: jsonClone(options.metadata),
        });
        return {
          data: {
            id,
            path: this.pathMismatch ? `${key}-wrong` : key,
            fullPath: `${bucket}/${this.pathMismatch ? `${key}-wrong` : key}`,
            user_metadata: jsonClone(options.metadata),
          },
          error: null,
        };
      },
      download: async (key) => {
        this.calls.push({ operation: "download", key });
        const object = this.objects.get(key);
        if (!object) return { data: null, error: { statusCode: 404, message: "missing" } };
        return { data: new Uint8Array(object.bytes), error: null };
      },
      list: async (folder, options) => {
        this.calls.push({ operation: "list", folder, options: jsonClone(options) });
        const prefix = folder ? `${folder}/` : "";
        const rows = [...this.objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, object]) => ({
            id: object.id,
            name: key.slice(prefix.length),
            version: object.version,
            metadata: {
              size: object.bytes.length,
              eTag: `"${object.etag}"`,
              user_metadata: jsonClone(object.metadata),
            },
          }));
        return { data: rows, error: null };
      },
    };
    if (this.useInfo) {
      api.info = async (key) => {
        this.calls.push({ operation: "info", key });
        const object = this.objects.get(key);
        if (!object) return { data: null, error: { status: 404, message: "missing" } };
        const infoMetadata = this.camelCaseInfoMetadata
          ? Object.fromEntries(Object.entries(object.metadata).map(([metadataKey, value]) => [
            metadataKey.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()),
            value,
          ]))
          : null;
        return {
          data: {
            id: object.id,
            name: key.split("/").at(-1),
            version: object.version,
            eTag: `"${object.etag}"`,
            size: object.bytes.length,
            contentType: object.contentType,
            ...(this.camelCaseInfoMetadata
              ? { metadata: jsonClone(infoMetadata) }
              : { userMetadata: jsonClone(object.metadata) }),
          },
          error: null,
        };
      };
    }
    return api;
  }
}

function coordinate(overrides = {}) {
  return {
    workspaceKey: "primary",
    sourceSystem: "gmail",
    connectionKey: "ops@example.com",
    sourceObjectType: "gmail_attachment",
    sourceObjectId: "message/123:attachment/456",
    sourceRevision: "history:90071992547409939999",
    ...overrides,
  };
}

function putInput(bytes, overrides = {}) {
  return {
    ...coordinate(),
    bytes,
    contentType: "application/pdf",
    attachmentMetadata: {
      attachmentId: "attachment/456",
      messageId: "message/123",
      filename: "arrival notice 123.pdf",
      mimeType: "application/pdf",
      size: bytes.length,
      partId: "1.2",
    },
    ...overrides,
  };
}

async function rejectsCode(promise, code) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TruthRawObjectStoreError, `expected typed error ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

async function main() {
  await check("deterministic URL-safe key commits the full coordinate and content SHA-256", async () => {
    const contentHash = "a".repeat(64);
    const input = { ...coordinate(), contentHash };
    const first = deriveRawObjectKey(input);
    const second = deriveRawObjectKey({ ...input });
    assert.equal(first, second);
    assert.equal(first.endsWith(`/${contentHash}`), true);
    assert.equal(first.startsWith("truth-raw/v1/"), true);
    assert.equal(first.includes("ops@example.com"), false);
    assert.equal(first.includes("message/123"), false);
    assert.notEqual(first, deriveRawObjectKey({ ...input, sourceRevision: "history:next" }));
    assert.notEqual(first, deriveRawObjectKey({ ...input, contentHash: "b".repeat(64) }));
  });

  await check("private upload is immutable, byte-verified, metadata-verified, and attachment-aware", async () => {
    const fake = new FakeSupabaseStorage();
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const source = Buffer.from("%PDF-1.7\narrival notice evidence\n", "utf8");
    const original = Buffer.from(source);
    const pending = store.putRawObject(putInput(source));
    source.fill(0);
    const receipt = await pending;

    assert.equal(receipt.ok, true);
    assert.equal(receipt.idempotent, false);
    assert.equal(receipt.rawObject.bucket, fake.bucketName);
    assert.equal(receipt.rawObject.hash, sha256(original));
    assert.equal(receipt.rawObject.bytes, original.length);
    assert.equal(receipt.rawObject.contentType, "application/pdf");
    assert.equal(receipt.rawObject.version, "v1");
    assert.match(receipt.rawObject.etag, /^[0-9a-f]{32}$/);
    assert.equal(receipt.attachmentMetadata.filename, "arrival notice 123.pdf");
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.rawObject), true);
    assert.equal(Object.isFrozen(receipt.attachmentMetadata), true);

    const upload = fake.calls.find((call) => call.operation === "upload");
    assert.equal(upload.options.upsert, false);
    assert.equal(upload.options.cacheControl, DEFAULT_CACHE_CONTROL);
    assert.equal(upload.options.contentType, "application/pdf");
    assert.equal(upload.options.metadata.truth_content_sha256, sha256(original));
    assert.equal(upload.options.metadata.truth_content_bytes, String(original.length));
    assert.equal(
      JSON.parse(upload.options.metadata.truth_attachment_json).filename,
      "arrival notice 123.pdf",
    );
    assert.deepEqual(upload.bytes, original, "the store must clone caller-owned bytes before awaiting storage");
    assert.equal(fake.calls.filter((call) => call.operation === "getBucket").length, 1);
    assert.equal(fake.calls.some((call) => call.operation === "info"), true);
    assert.equal(fake.calls.some((call) => call.operation === "download"), true);
  });

  await check("same-content Uint8Array replay is idempotent only after existing bytes and metadata verify", async () => {
    const fake = new FakeSupabaseStorage();
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const bytes = Buffer.from("immutable RFC822 message", "utf8");
    const input = putInput(bytes, {
      sourceObjectType: "gmail_message",
      sourceObjectId: "message-777",
      contentType: "message/rfc822",
      attachmentMetadata: null,
    });
    const first = await store.putRawObject(input);
    const replay = await store.putRawObject({ ...input, bytes: new Uint8Array(bytes) });
    assert.equal(first.idempotent, false);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.rawObject.key, first.rawObject.key);
    assert.equal(replay.rawObject.hash, first.rawObject.hash);
    assert.equal(fake.objects.size, 1);
    assert.equal(fake.calls.filter((call) => call.operation === "upload").length, 2);
    assert.equal(fake.calls.filter((call) => call.operation === "getBucket").length, 1);
    assert.equal(fake.calls.filter((call) => call.operation === "download").length, 2);
  });

  await check("verified reads return only bytes matching the immutable key metadata and caller expectation", async () => {
    const fake = new FakeSupabaseStorage();
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const bytes = Buffer.from("raw RFC822 bytes for parsing", "utf8");
    const written = await store.putRawObject(putInput(bytes, {
      sourceObjectType: "gmail_message",
      sourceObjectId: "message-read-1",
      contentType: "message/rfc822",
      attachmentMetadata: null,
    }));
    const read = await store.getRawObject({
      key: written.rawObject.key,
      expectedSha256: written.rawObject.hash,
      expectedBytes: written.rawObject.bytes,
    });
    assert.deepEqual(read.bytes, bytes);
    assert.deepEqual(read.rawObject, written.rawObject);
    await rejectsCode(store.getRawObject({
      key: written.rawObject.key,
      expectedSha256: "0".repeat(64),
      expectedBytes: written.rawObject.bytes,
    }), "TRUTH_RAW_OBJECT_METADATA_MISMATCH");
    await assert.rejects(
      store.getRawObject({
        key: "outside-prefix/object",
        expectedSha256: written.rawObject.hash,
        expectedBytes: written.rawObject.bytes,
      }),
      (error) => error?.code === "TRUTH_RAW_OBJECT_INVALID_ARGUMENT",
    );
  });

  await check("Supabase info camel-cased metadata preserves full immutable verification", async () => {
    const fake = new FakeSupabaseStorage({ camelCaseInfoMetadata: true });
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const bytes = Buffer.from("hosted Storage metadata response shape", "utf8");
    const input = putInput(bytes, {
      sourceObjectType: "gmail_message_raw",
      sourceObjectId: "message-hosted-shape",
      contentType: "message/rfc822",
      attachmentMetadata: null,
    });
    const written = await store.putRawObject(input);
    const replay = await store.putRawObject(input);
    const read = await store.getRawObject({
      key: written.rawObject.key,
      expectedSha256: written.rawObject.hash,
      expectedBytes: written.rawObject.bytes,
    });
    assert.equal(replay.idempotent, true);
    assert.deepEqual(read.bytes, bytes);

    const object = fake.objects.get(written.rawObject.key);
    object.metadata.truthSchemaVersion = "conflicting-version";
    fake.camelCaseInfoMetadata = false;
    await rejectsCode(store.putRawObject(input), "TRUTH_RAW_OBJECT_METADATA_COLLISION");
  });

  await check("an occupied deterministic key with different stored bytes is a content collision", async () => {
    const fake = new FakeSupabaseStorage();
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const secretContent = Buffer.from("Bearer secret-token raw-source-content", "utf8");
    const input = putInput(secretContent);
    const first = await store.putRawObject(input);
    const object = fake.objects.get(first.rawObject.key);
    object.bytes = Buffer.from("different stored bytes", "utf8");
    const error = await rejectsCode(
      store.putRawObject(input),
      "TRUTH_RAW_OBJECT_CONTENT_COLLISION",
    );
    assert.equal(error.integrityFailure, true);
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes("secret-token"), false);
    assert.equal(error.message.includes("raw-source-content"), false);
  });

  await check("different content receives a different content-addressed key, while an expected hash mismatch fails closed", async () => {
    const fake = new FakeSupabaseStorage();
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const firstBytes = Buffer.from("first immutable representation", "utf8");
    const secondBytes = Buffer.from("different immutable representation", "utf8");
    const first = await store.putRawObject(putInput(firstBytes));
    const second = await store.putRawObject(putInput(secondBytes, {
      attachmentMetadata: { filename: "arrival notice 123.pdf", mimeType: "application/pdf", size: secondBytes.length },
    }));
    assert.notEqual(first.rawObject.key, second.rawObject.key);
    assert.notEqual(first.rawObject.hash, second.rawObject.hash);
    assert.equal(fake.objects.size, 2);

    const uploadCount = fake.calls.filter((call) => call.operation === "upload").length;
    const error = await rejectsCode(
      store.putRawObject(putInput(secondBytes, { expectedSha256: sha256(firstBytes) })),
      "TRUTH_RAW_OBJECT_EXPECTED_HASH_MISMATCH",
    );
    assert.equal(error.integrityFailure, true);
    assert.equal(fake.calls.filter((call) => call.operation === "upload").length, uploadCount);
  });

  await check("same bytes with different stored attachment metadata is not accepted as an idempotent replay", async () => {
    const fake = new FakeSupabaseStorage();
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const bytes = Buffer.from("attachment bytes", "utf8");
    const first = await store.putRawObject(putInput(bytes));
    fake.objects.get(first.rawObject.key).metadata.truth_attachment_json = "{}";
    const error = await rejectsCode(
      store.putRawObject(putInput(bytes)),
      "TRUTH_RAW_OBJECT_METADATA_COLLISION",
    );
    assert.equal(error.integrityFailure, true);
  });

  await check("public buckets are rejected before any raw byte upload", async () => {
    const fake = new FakeSupabaseStorage({ public: true });
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const error = await rejectsCode(
      store.putRawObject(putInput(Buffer.from("private evidence", "utf8"))),
      "TRUTH_RAW_OBJECT_BUCKET_NOT_PRIVATE",
    );
    assert.equal(error.operation, "bucket.get");
    assert.equal(fake.calls.some((call) => call.operation === "upload"), false);
  });

  await check("list fallback verifies metadata when the bucket client has no info method", async () => {
    const fake = new FakeSupabaseStorage({ useInfo: false });
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const receipt = await store.putRawObject(putInput(Buffer.from("list fallback", "utf8")));
    assert.equal(receipt.ok, true);
    assert.equal(fake.calls.some((call) => call.operation === "list"), true);
    assert.equal(fake.calls.some((call) => call.operation === "download"), true);
  });

  await check("typed storage failures are retryable when appropriate and redact provider messages", async () => {
    const providerError = new Error("fetch failed Bearer super-secret-token payload=raw-content");
    providerError.status = 503;
    const fake = new FakeSupabaseStorage({ throwUpload: providerError });
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const error = await rejectsCode(
      store.putRawObject(putInput(Buffer.from("raw-content", "utf8"))),
      "TRUTH_RAW_STORAGE_OUTCOME_UNKNOWN",
    );
    assert.equal(error.retryable, true);
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.status, 503);
    assert.equal(error.message.includes("super-secret-token"), false);
    assert.equal(error.message.includes("raw-content"), false);

    const normalized = normalizeStorageError({ statusCode: 403, message: "Bearer do-not-leak" }, "upload");
    assert.equal(normalized.code, "TRUTH_RAW_OBJECT_STORAGE_AUTH_FAILED");
    assert.equal(normalized.message.includes("do-not-leak"), false);
  });

  await check("a mismatched upload receipt path fails integrity verification", async () => {
    const fake = new FakeSupabaseStorage({ pathMismatch: true });
    const store = createTruthRawObjectStore({ storage: fake, bucket: fake.bucketName });
    const error = await rejectsCode(
      store.putRawObject(putInput(Buffer.from("path-bound evidence", "utf8"))),
      "TRUTH_RAW_OBJECT_UPLOAD_PATH_MISMATCH",
    );
    assert.equal(error.integrityFailure, true);
  });

  process.stdout.write(`${JSON.stringify({ ok: true, checks, liveCalls: 0 }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
