#!/usr/bin/env node
"use strict";

// Untrusted candidate/product code executes only in this disposable process.
// The parent judge owns receipt parsing, evidence comparison, assertions, and
// every verdict. This child owns no authority beyond returning bounded data.

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const rawWrite = process.stdout.write.bind(process.stdout);
const safeStringify = JSON.stringify.bind(JSON);
const safeParse = JSON.parse.bind(JSON);
const REQUEST_PROTOCOL = "pikiio-truth-product-child-request-v1";
const RESPONSE_PROTOCOL = "pikiio-truth-product-child-response-v1";
const MAX_REQUEST_BYTES = 32 * 1024;

function exactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function readRequest() {
  const source = fs.readFileSync(0, "utf8");
  if (!source || Buffer.byteLength(source, "utf8") > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error("child request size is invalid"), {
      code: "TRUTH_PRODUCT_CHILD_REQUEST_INVALID",
    });
  }
  const request = safeParse(source);
  if (
    !exactKeys(request, ["operation", "protocol", "requestId", "target"]) ||
    request.protocol !== REQUEST_PROTOCOL ||
    !/^[0-9a-f]{64}$/.test(String(request.requestId || "")) ||
    !exactKeys(request.target, ["kind", "originalRelativePath", "sourcePath"]) ||
    !["module", "fixture"].includes(request.target.kind) ||
    typeof request.target.sourcePath !== "string" ||
    typeof request.target.originalRelativePath !== "string" ||
    !exactKeys(request.operation, ["input", "name"]) ||
    typeof request.operation.name !== "string"
  ) {
    throw Object.assign(new Error("child request shape is invalid"), {
      code: "TRUTH_PRODUCT_CHILD_REQUEST_INVALID",
    });
  }
  return request;
}

function emit(value) {
  rawWrite(`${safeStringify(value)}\n`);
}

function safeError(error) {
  return {
    name: String(error?.name || "Error").slice(0, 100),
    code: String(error?.code || "TRUTH_PRODUCT_OPERATION_FAILED").slice(0, 100),
    message: String(error?.message || error).slice(0, 500),
  };
}

function loadCandidate(target) {
  const filename = path.resolve(process.cwd(), target.originalRelativePath);
  const sourcePath = path.resolve(target.sourcePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  const candidateModule = new Module(`${filename}:pikiio-product-child`, module);
  candidateModule.filename = filename;
  candidateModule.paths = Module._nodeModulePaths(path.dirname(filename));
  candidateModule._compile(source, filename);
  return candidateModule.exports;
}

function runHostileFixture(name) {
  if (name === "monkeypatch") {
    const attempted = [];
    for (const operation of [
      () => {
        require("node:assert").equal = () => true;
        attempted.push("node:assert");
      },
      () => {
        fs.readFileSync = () => "{}";
        attempted.push("node:fs");
      },
      () => {
        require("node:crypto").createHash = () => ({
          update() { return this; },
          digest() { return "forged"; },
        });
        attempted.push("node:crypto");
      },
      () => {
        process.stdout.write = () => true;
        attempted.push("process.stdout");
      },
      () => {
        Module._load = () => ({ forged: true });
        attempted.push("Module._load");
      },
    ]) {
      try {
        operation();
      } catch {
        attempted.push("patch-refused");
      }
    }
    return { attempted };
  }
  if (name === "extra-output") {
    rawWrite("candidate-extra-output\n");
    return { hostile: name };
  }
  if (name === "malformed-output") {
    rawWrite("{malformed\n");
    return null;
  }
  if (name === "oversized-output") {
    rawWrite("x".repeat(256 * 1024));
    return { hostile: name };
  }
  if (name === "crash") process.exit(23);
  if (name === "signal") {
    process.kill(process.pid, "SIGTERM");
    return null;
  }
  if (name === "timeout") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    return null;
  }
  throw Object.assign(new Error(`unknown hostile fixture ${name}`), {
    code: "TRUTH_PRODUCT_CHILD_FIXTURE_UNKNOWN",
  });
}

async function executeOperation(api, operation) {
  const input = operation.input || {};
  switch (operation.name) {
    case "generic-run": {
      const calls = [];
      const result = await api.createGenericAcceptanceReadinessCoordinator({
        workspaceKey: "primary",
        syncToken: "sync-token-at-least-sixteen",
        callRpc: async (rpc, body) => {
          calls.push({ rpc, body });
          return rpc === api.FRONTIER_RPC
            ? input.frontierReceipt
            : input.acceptanceReceipt;
        },
      }).runOnce();
      return { calls, result };
    }
    case "normalize-frontier":
      return api._test.normalizeFrontier(input.receipt);
    case "validate-source-cut":
      return api._test.validateReceipt(input.receipt);
    case "validate-accepted-cut":
      return api._test.validateAcceptedGmailCut(input.receipt);
    case "validate-production-bridge":
      return api._test.validateProductionBridge(
        input.receipt,
        input.shadowSourceCutId,
      );
    case "production-source-cut-run": {
      const calls = [];
      const result = await api.createTruthProductionSourceCutCoordinator({
        workspaceKey: "primary",
        syncToken: "sync-token-at-least-sixteen",
        callRpc: async (rpc, body) => {
          calls.push({ rpc, body });
          if (rpc === api.RPC.readHead) return input.head;
          if (rpc === api.RPC.sealAcceptedGmail) return input.shadowCut;
          return input.bridge;
        },
      }).sealCurrent({ createdBy: "truth-product-child" });
      return { calls, result };
    }
    case "canonical-publish": {
      let writes = 0;
      try {
        const packet = await api.publishHostedCanonicalTruth(input.snapshot, {
          trigger: "truth-product-child",
          upsertAppSnapshot: async () => {
            writes += 1;
          },
        });
        return { outcome: "resolved", packet, writes };
      } catch (error) {
        return { outcome: "rejected", error: safeError(error), writes };
      }
    }
    case "canonical-prepare":
      return api.prepareCanonicalTruthPackets(input.snapshot, {
        trigger: "truth-product-child",
      });
    case "health-stale":
      return api._test.stale(
        input.timestamp,
        input.maxAgeMinutes,
        new Date(input.now),
      );
    case "health-active-rows":
      return api._test.activeTruthRows(input.snapshot);
    case "health-row-certification":
      return api._test.buildRowCertification(input.snapshot);
    case "health-tms-inventory": {
      const metadata = new Map(
        (input.metadataRows || []).map((row) => [row.snapshot_key, row]),
      );
      return api._test.tmsInventoryHealth(
        metadata,
        input.maxAgeMinutes,
        new Date(input.now),
        input.truthSnapshot,
      );
    }
    case "health-verified-freshness":
      return api._test.verifiedTruthFreshness(input);
    case "compact-semantics":
      return api.compactSemanticSnapshot(input.snapshot, input.identity || {});
    case "truth-soak-evaluate":
      return api.evaluateTruthSoakEvidence(input.evidence);
    default:
      throw Object.assign(new Error(`unsupported child operation ${operation.name}`), {
        code: "TRUTH_PRODUCT_CHILD_OPERATION_UNKNOWN",
      });
  }
}

async function main() {
  let request;
  try {
    request = readRequest();
  } catch (error) {
    emit({
      protocol: RESPONSE_PROTOCOL,
      requestId: "0".repeat(64),
      ok: false,
      error: safeError(error),
    });
    process.exitCode = 65;
    return;
  }

  if (request.target.kind === "fixture") {
    const result = runHostileFixture(request.operation.name);
    if (request.operation.name === "malformed-output") return;
    emit({
      protocol: RESPONSE_PROTOCOL,
      requestId: request.requestId,
      ok: true,
      result,
    });
    return;
  }

  try {
    const api = loadCandidate(request.target);
    const result = await executeOperation(api, request.operation);
    emit({
      protocol: RESPONSE_PROTOCOL,
      requestId: request.requestId,
      ok: true,
      result,
    });
  } catch (error) {
    emit({
      protocol: RESPONSE_PROTOCOL,
      requestId: request.requestId,
      ok: false,
      error: safeError(error),
    });
  }
}

main().catch((error) => {
  emit({
    protocol: RESPONSE_PROTOCOL,
    requestId: "0".repeat(64),
    ok: false,
    error: safeError(error),
  });
  process.exitCode = 70;
});
