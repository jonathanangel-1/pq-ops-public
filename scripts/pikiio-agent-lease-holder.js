#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  GovernanceError,
  acquireWriterLease,
  pidAlive,
  readLease,
  releaseWriterLease,
  renewWriterLease,
  sha256,
  writeMorningTerminalReceipt,
} = require("../lib/pikiio-agent-governance");

const MAX_REQUEST_BYTES = 64 * 1024;
const MONITOR_INTERVAL_MS = 1000;

function valueArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function readBootstrap(bootstrapPath) {
  const stat = fs.statSync(bootstrapPath);
  if ((stat.mode & 0o077) !== 0) {
    throw new GovernanceError(
      "LEASE_BOOTSTRAP_PERMISSIONS_INVALID",
      "Lease bootstrap must be readable only by its owner",
    );
  }
  const payload = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
  fs.unlinkSync(bootstrapPath);
  if (
    payload.schema !== "pikiio-writer-bootstrap-v1" ||
    !/^[a-f0-9]{64}$/.test(String(payload.capability || "")) ||
    !payload.handlePath ||
    !payload.socketPath ||
    !payload.leasePath ||
    !payload.fencePath ||
    !payload.config
  ) {
    throw new GovernanceError(
      "LEASE_BOOTSTRAP_INVALID",
      "Lease bootstrap is incomplete",
    );
  }
  return payload;
}

function redactLease(lease) {
  if (!lease) return null;
  const copy = JSON.parse(JSON.stringify(lease));
  delete copy.capabilitySha256;
  return copy;
}

function writeHandle(payload, lease) {
  const handle = {
    schema: "pikiio-writer-handle-v1",
    runId: lease.runId,
    fence: lease.fence,
    capability: payload.capability,
    controlSocketPath: payload.socketPath,
    leasePath: payload.leasePath,
  };
  const temporary = `${payload.handlePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(handle)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, payload.handlePath);
}

async function main() {
  const bootstrapPath = valueArg("bootstrap");
  if (!bootstrapPath) {
    throw new GovernanceError(
      "LEASE_BOOTSTRAP_REQUIRED",
      "Lease holder requires a bootstrap path",
    );
  }
  const payload = readBootstrap(bootstrapPath);
  if (fs.existsSync(payload.socketPath)) fs.unlinkSync(payload.socketPath);

  const config = payload.config;
  let lease = acquireWriterLease({
    ...config,
    capability: payload.capability,
    leasePath: payload.leasePath,
    fencePath: payload.fencePath,
    ownerPid: process.pid,
  });
  let morningTerminalRecorded = false;
  let shuttingDown = false;

  function assertRequestOwner(request) {
    const current = readLease(payload.leasePath);
    if (
      !current ||
      request.runId !== lease.runId ||
      request.fence !== lease.fence ||
      sha256(String(request.capability || "")) !== current.capabilitySha256
    ) {
      throw new GovernanceError(
        "WRITER_CONTROL_NOT_OWNER",
        "Writer control request lacks the active capability",
      );
    }
    return current;
  }

  function recordMorningTerminal(terminal) {
    if (lease.lane !== "morning-refresh") {
      throw new GovernanceError(
        "MORNING_TERMINAL_WRONG_LEASE_CLASS",
        "Only the morning-refresh lease may record a morning terminal receipt",
      );
    }
    const receipt = writeMorningTerminalReceipt({
      ...terminal,
      runId: lease.runId,
      leaseFence: lease.fence,
      startedAt: lease.acquiredAt,
    }, {
      morningReceiptDir: config.morningReceiptDir,
    });
    morningTerminalRecorded = true;
    return receipt;
  }

  function releaseOwnedLease() {
    const result = releaseWriterLease(lease, {
      capability: payload.capability,
      leasePath: payload.leasePath,
    });
    return result;
  }

  function removePrivateArtifacts() {
    try {
      fs.unlinkSync(payload.handlePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      fs.unlinkSync(payload.socketPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  function emergencyMorningTerminal(reason) {
    if (lease.lane !== "morning-refresh" || morningTerminalRecorded) return;
    try {
      recordMorningTerminal({
        result: "failed",
        truthPublished: false,
        finishedAt: new Date().toISOString(),
        detail: reason,
      });
    } catch {
      // A missing receipt deliberately leaves morning priority fail-closed.
    }
  }

  function shutdown({ release = false, reason = "" } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (release) {
      emergencyMorningTerminal(reason || "lease holder terminated");
      try {
        releaseOwnedLease();
      } catch {
        // A lost lease is already fail-closed; do not delete another owner's lease.
      }
    }
    server.close(() => {
      try {
        removePrivateArtifacts();
      } finally {
        process.exit(0);
      }
    });
    setTimeout(() => {
      try {
        removePrivateArtifacts();
      } finally {
        process.exit(0);
      }
    }, 1000).unref();
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(5000);
    let source = "";
    socket.on("data", (chunk) => {
      source += chunk;
      if (Buffer.byteLength(source) > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = source.indexOf("\n");
      if (newline === -1) return;
      const line = source.slice(0, newline);
      source = "";
      let response;
      let releaseAfterResponse = false;
      try {
        const request = JSON.parse(line);
        if (request.schema !== "pikiio-writer-control-v1") {
          throw new GovernanceError(
            "WRITER_CONTROL_SCHEMA_INVALID",
            "Writer control schema is invalid",
          );
        }
        assertRequestOwner(request);
        if (request.operation === "assert") {
          response = { ok: true, lease: redactLease(readLease(payload.leasePath)) };
        } else if (request.operation === "renew") {
          lease = renewWriterLease(lease, {
            capability: payload.capability,
            leaseMs: Number(request.requestedLeaseMs),
            leasePath: payload.leasePath,
            morningReceiptDir: config.morningReceiptDir,
          });
          response = { ok: true, lease: redactLease(lease) };
        } else if (request.operation === "morning-terminal") {
          response = {
            ok: true,
            receipt: recordMorningTerminal(request.terminal || {}),
          };
        } else if (request.operation === "release") {
          if (lease.lane === "morning-refresh" && !morningTerminalRecorded) {
            throw new GovernanceError(
              "MORNING_TERMINAL_REQUIRED",
              "Morning lease cannot release before recording a terminal receipt",
            );
          }
          response = { ok: true, ...releaseOwnedLease() };
          releaseAfterResponse = true;
        } else {
          throw new GovernanceError(
            "WRITER_CONTROL_OPERATION_UNKNOWN",
            `Unknown writer control operation ${request.operation}`,
          );
        }
      } catch (error) {
        response = {
          ok: false,
          code: error.code || "WRITER_CONTROL_FAILED",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      socket.end(`${JSON.stringify(response)}\n`, () => {
        if (releaseAfterResponse) shutdown({ release: false });
      });
    });
    socket.on("timeout", () => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(payload.socketPath, () => {
      server.off("error", reject);
      fs.chmodSync(payload.socketPath, 0o600);
      resolve();
    });
  });

  writeHandle(payload, lease);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action: "acquired",
    handlePath: payload.handlePath,
    lease: redactLease(lease),
  })}\n`);

  const monitor = setInterval(() => {
    if (shuttingDown) return;
    let current;
    try {
      current = readLease(payload.leasePath);
    } catch {
      shutdown({ release: false });
      return;
    }
    if (!current || current.runId !== lease.runId || current.fence !== lease.fence) {
      shutdown({ release: false });
      return;
    }
    if (
      lease.lane === "morning-refresh" &&
      Number.isSafeInteger(config.supervisedPid) &&
      !pidAlive(config.supervisedPid)
    ) {
      shutdown({
        release: true,
        reason: "Morning runner exited before recording its terminal result",
      });
      return;
    }
    if (Date.now() >= Date.parse(current.expiresAt)) {
      shutdown({ release: true, reason: "Writer lease expired" });
    }
  }, MONITOR_INTERVAL_MS);
  monitor.unref();

  process.on("SIGTERM", () => {
    shutdown({ release: true, reason: "Lease holder received SIGTERM" });
  });
  process.on("SIGINT", () => {
    shutdown({ release: true, reason: "Lease holder received SIGINT" });
  });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: error.code || "WRITER_LEASE_HOLDER_FAILED",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exit(1);
});
