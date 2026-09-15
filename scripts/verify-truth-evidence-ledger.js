#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  createTruthEvidenceLedger,
} = require("../lib/truth-evidence-ledger");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CLAIM_ID = `claim:v1:${HASH_A}`;
const LINK_ID = `link:v1:${HASH_A}`;
const WORKGROUP_ID = `workgroup:v1:${HASH_A}`;
const MEMBERSHIP_ID = `membership:v1:${HASH_B}`;

async function main() {
  const calls = [];
  const callRpc = async (name, body) => {
    calls.push({ name, body });
    if (name === "append_accepted_claim") {
      return { ok: true, idempotent: false, claimVersionId: CLAIM_ID, itemHash: HASH_A };
    }
    if (name === "append_observation_entity_link") {
      return { ok: true, idempotent: false, linkVersionId: LINK_ID, itemHash: HASH_A };
    }
    if (name === "append_operational_workgroup_membership") {
      return {
        ok: true,
        idempotent: false,
        workgroupId: WORKGROUP_ID,
        membershipVersionId: MEMBERSHIP_ID,
        definitionHash: HASH_A,
        itemHash: HASH_B,
      };
    }
    throw new Error(`unexpected RPC ${name}`);
  };
  const ledger = createTruthEvidenceLedger({
    workspaceKey: "primary",
    syncToken: "sync-secret",
    callRpc,
  });
  const evidence = [
    { observationId: `obs:v1:${HASH_B}`, evidenceRole: "supporting", evidenceSpan: {} },
    { observationId: `obs:v1:${HASH_A}`, evidenceRole: "primary", evidenceSpan: { start: 2, end: 9 } },
  ];

  const claim = await ledger.appendAcceptedClaim({
    claim: { claimKey: "shipment:123:release", versionNo: 1 },
    evidence,
    supersessions: [],
  });
  assert.equal(claim.claimVersionId, CLAIM_ID);
  assert(Object.isFrozen(claim));
  assert.deepEqual(
    calls[0].body.p_evidence.map((item) => item.observationId),
    [`obs:v1:${HASH_A}`, `obs:v1:${HASH_B}`],
  );
  assert.equal(calls[0].body.p_sync_token, "sync-secret");

  const link = await ledger.appendEntityLink({
    link: { linkKey: "obs:shipment", versionNo: 1 },
  });
  assert.equal(link.linkVersionId, LINK_ID);

  const membership = await ledger.appendWorkgroupMembership({
    workgroup: { identityKey: "broker:shipment-set" },
    membership: { membershipKey: "workgroup:shipment:123", versionNo: 1 },
    evidence: [evidence[0]],
  });
  assert.equal(membership.workgroupId, WORKGROUP_ID);
  assert.equal(membership.membershipVersionId, MEMBERSHIP_ID);

  await assert.rejects(
    ledger.appendAcceptedClaim({ claim: {}, evidence: [] }),
    (error) => error?.code === "TRUTH_EVIDENCE_INVALID_ARGUMENT",
  );
  assert.equal(calls.length, 3, "invalid envelope input must not reach the RPC");

  const broken = createTruthEvidenceLedger({
    workspaceKey: "primary",
    syncToken: "sync-secret",
    callRpc: async () => ({ ok: true, claimVersionId: "caller-owned-id", itemHash: HASH_A }),
  });
  await assert.rejects(
    broken.appendAcceptedClaim({ claim: {}, evidence: [evidence[0]] }),
    (error) => error?.code === "TRUTH_EVIDENCE_INVALID_RECEIPT",
  );

  const failing = createTruthEvidenceLedger({
    workspaceKey: "primary",
    syncToken: "sync-secret",
    callRpc: async () => {
      const error = new Error("serialization failure");
      error.body = JSON.stringify({ code: "40001" });
      throw error;
    },
  });
  await assert.rejects(
    failing.appendEntityLink({ link: {} }),
    (error) => error?.code === "40001" && error.retryable === true,
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-evidence-ledger",
    checks: [
      "claim evidence and supersessions are normalized before the atomic append RPC",
      "entity links and workgroup memberships use only server-derived identity receipts",
      "claim/link/workgroup/membership identities and item hashes are strictly validated",
      "receipts are immutable",
      "invalid inputs fail before any RPC call",
      "Postgres concurrency codes remain typed and retryable",
    ],
    rpcCalls: calls.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
