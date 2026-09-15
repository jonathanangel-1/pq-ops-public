"use strict";
// The production flip ceremony orchestrator
// (YLYI/05_Agent_Runbooks/Production_Flip_Ceremony.md, step 6).
//
// Loop until one atomic pass completes:
//   1. Wait for the live gmail cursor head to carry a pending acceptance
//      epoch; drive acceptance UNFROZEN (claims machinery needs the shared
//      advisory lock free).
//   2. Require stillness (no runnable jobs) and a clean census (sweeps
//      classify fresh dead-letter crops; zero unclassified dead).
//   3. SIGSTOP the local crew, take the source-cut serialization lock
//      EXCLUSIVE (session) — ticks pause, cursor pinned.
//   4. In-freeze: re-verify head -> seal cut -> shadow build -> parity gate
//      against the legacy board captured at ceremony start -> candidate
//      build + one-time approval + CAS production publication.
//   5. Unlock, SIGCONT crew. Success ends the loop; any miss retries.
//
// The publication MUST happen in-freeze: commit_truth_publication_runtime
// refuses any cut that is no longer the live source vector (40001).
const fs = require("fs");
const path = require("path");
const { execSync } = require("node:child_process");
const { directClient, artifactDir, WORKSPACE } = require("./config");

const CREW_PATTERN = process.env.PQ_CEREMONY_CREW_PATTERN
  || "drain-pipeline.js|attmodel-once.js|reseal-loop.js|endgame.sh|open-loop.sh";
const SWEEPS_DIR = path.join(__dirname, "sweeps");
const ts = () => new Date().toISOString().slice(11, 19);

const HEAD_SQL = `
  select head->>'rootBatchId' rb,
    nullif(head->>'obligationId','') ob,
    coalesce((head->>'accepted')::boolean,false) accepted,
    head->>'acceptanceMode' acceptance_mode,
    coalesce((head->>'zeroChangeSuccessorCount')::integer,0) zero_change_count
  from (select public.read_truth_ceremony_gmail_head($1,$2) head) receipt`;

function run(cmd, timeoutMs) {
  return execSync(cmd, { encoding: "utf8", timeout: timeoutMs, cwd: path.join(__dirname, "..", "..") });
}

(async () => {
  const syncToken = process.env.PQ_SUPABASE_SYNC_TOKEN;
  if (!syncToken) throw new Error("PQ_SUPABASE_SYNC_TOKEN missing");
  console.log(`${ts()} capturing live legacy board for the parity gate`);
  console.log(run(`node ${path.join(__dirname, "capture-legacy-board.js")}`, 300000).trim());

  const c = await directClient();
  for (let i = 0; i < 5000; i += 1) {
    const { rows } = await c.query(HEAD_SQL, [WORKSPACE, syncToken]);
    const h = rows[0] || {};
    if (!h.ob) { console.log(`${ts()} [${i}] head ${String(h.rb).slice(0, 8)} claimless`); await new Promise((r) => setTimeout(r, 45000)); continue; }
    const carry = h.acceptance_mode === "zero_change_carry_forward"
      ? ` ZERO-CHANGE-CARRY(${h.zero_change_count})`
      : "";
    console.log(`${ts()} [${i}] head ${String(h.rb).slice(0, 8)} ${h.accepted ? "ACCEPTED" : "PENDING"}${carry}`);
    if (!h.accepted) {
      const acc = await c.query(
        "select public.run_truth_shadow_claim_acceptance_epoch($1,$2,$3) r", [WORKSPACE, h.ob, syncToken]);
      const st = acc.rows[0].r || {};
      if (st.status !== "succeeded") {
        console.log(`${ts()} accept wait: ${st.reasonCode || st.status}`);
        await new Promise((r) => setTimeout(r, 15000));
        continue;
      }
      console.log(`${ts()} ACCEPTED (accepted=${st.acceptedCount}) — freezing IMMEDIATELY`);
    } else {
      console.log(`${ts()} already accepted`);
    }
    const runnable = await c.query("select count(*)::int n from public.source_processing_jobs where workspace_key=$1 and source_system='gmail' and connection_key='primary' and state in ('queued','leased','retry_wait')", [WORKSPACE]);
    if (runnable.rows[0].n > 0) {
      console.log(`${ts()} ${runnable.rows[0].n} runnable in flight — waiting for stillness`);
      await new Promise((r) => setTimeout(r, 20000));
      continue;
    }
    console.log(`${ts()} stillness confirmed — sweeping fresh crops`);
    for (const f of fs.readdirSync(SWEEPS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
      try {
        const sql = fs.readFileSync(path.join(SWEEPS_DIR, f), "utf8");
        const sweep = await directClient();
        try { await sweep.query(sql); } finally { await sweep.end(); }
      } catch (e) { console.log(`${ts()} sweep ${f}: ${String(e.message).slice(0, 80)}`); }
    }
    const dead = await c.query("select count(*)::int n from public.source_processing_jobs where workspace_key=$1 and source_system='gmail' and connection_key='primary' and state='dead_letter'", [WORKSPACE]);
    if (dead.rows[0].n > 0) { console.log(`${ts()} ${dead.rows[0].n} dead unclassified after sweeps — waiting`); await new Promise((r) => setTimeout(r, 20000)); continue; }
    console.log(`${ts()} census clean — silencing crew + freezing`);
    execSync(`pkill -STOP -f '${CREW_PATTERN}' 2>/dev/null || true`);
    await c.query("select pg_advisory_lock(hashtextextended('truth-source-cut-serialization-v1:' || $1, 0))", [WORKSPACE]);
    try {
      const chk = await c.query(HEAD_SQL, [WORKSPACE, syncToken]);
      const h2 = chk.rows[0] || {};
      if (h2.ob !== h.ob || !h2.accepted) { console.log(`${ts()} lost head in the freeze gap; releasing`); continue; }
      console.log(`${ts()} cursor pinned; cutting (may take minutes)…`);
      const t0 = Date.now();
      const r = await c.query(
        "select public.seal_truth_shadow_root_source_cut($1,$2,'local-truth-gmail-slice:shadow-source-cut',$3) r",
        [WORKSPACE, h.ob, syncToken]);
      const receipt = r.rows[0].r;
      console.log(`${ts()} cut result in ${Math.round((Date.now() - t0) / 1000)}s:`, JSON.stringify(receipt).slice(0, 200));
      const cutId = (JSON.stringify(receipt).match(/cut:v1:[0-9a-f]{64}/) || [])[0];
      if (!cutId) continue;
      fs.writeFileSync(path.join(artifactDir(), "ceremony-cut-id"), cutId);
      console.log(`${ts()} ACCEPTANCE CUT SEALED: ${cutId} — shadow proof build IN-FREEZE`);
      try {
        const out = run(`node ${path.join(__dirname, "shadow-build.js")} '${cutId}'`, 40 * 60 * 1000);
        console.log(out.trim().split("\n").slice(-2).join(" | "));
        if (!/BUILD:.*succeeded/.test(out)) {
          console.log(`${ts()} acceptance-cut shadow proof did not succeed; will retry next cycle`);
          continue;
        }
        console.log(`${ts()} ACCEPTANCE PROOF SUCCEEDED — sealing required-source production cut`);
        const productionCutReceipt = (await c.query(
          "select public.seal_truth_production_cut_from_accepted_gmail_v1($1,$2,'ceremony:production-required-source-cut',$3) r",
          [WORKSPACE, cutId, syncToken],
        )).rows[0].r;
        const productionCutId = productionCutReceipt?.productionSourceCutId
          || productionCutReceipt?.sourceCutId;
        if (!/^cut:v1:[0-9a-f]{64}$/.test(productionCutId || "")
            || productionCutReceipt?.productionEligible !== true) {
          console.log(`${ts()} required-source production cut did not bridge; will retry next cycle`);
          continue;
        }
        fs.writeFileSync(path.join(artifactDir(), "ceremony-production-cut-id"), productionCutId);
        console.log(`${ts()} PRODUCTION CUT BRIDGED: ${productionCutId} — exact shadow build`);
        const productionOut = run(
          `node ${path.join(__dirname, "shadow-build.js")} '${productionCutId}' 'production-vector'`,
          40 * 60 * 1000,
        );
        console.log(productionOut.trim().split("\n").slice(-2).join(" | "));
        const packetHash = (productionOut.match(/"packetHash":"([0-9a-f]{64})"/) || [])[1];
        if (!/BUILD:.*succeeded/.test(productionOut) || !packetHash) {
          console.log(`${ts()} production-vector shadow build did not succeed; will retry next cycle`);
          continue;
        }
        console.log(`${ts()} PRODUCTION-VECTOR BUILD SUCCEEDED — parity gate IN-FREEZE`);
        let parityOut;
        try {
          parityOut = run(`node ${path.join(__dirname, "parity-gate.js")} '${packetHash}'`, 10 * 60 * 1000);
        } catch (e) {
          console.log(`${ts()} PARITY GATE FAILED — refusing to publish. ${String(e.stdout || e.message).slice(0, 300)}`);
          continue;
        }
        console.log(parityOut.trim());
        console.log(`${ts()} PARITY PASSED — publishing PRODUCTION in-freeze`);
        const pub = run(`node ${path.join(__dirname, "production-publish.js")} '${productionCutId}'`, 40 * 60 * 1000);
        console.log(pub.trim().split("\n").slice(-2).join(" | "));
        if (/PUBLISH:.*"channel":"production"/.test(pub)) {
          console.log(`${ts()} PRODUCTION PUBLICATION COMMITTED IN-FREEZE — ceremony core complete`);
          break;
        }
        console.log(`${ts()} production publication did not commit; will retry next cycle`);
      } catch (e) {
        console.log(`${ts()} in-freeze error: ${String(e.message).slice(0, 200)}`);
      }
    } finally {
      await c.query("select pg_advisory_unlock(hashtextextended('truth-source-cut-serialization-v1:' || $1, 0))", [WORKSPACE]).catch(() => {});
      execSync(`pkill -CONT -f '${CREW_PATTERN}' 2>/dev/null || true`);
      console.log(`${ts()} ticks unfrozen; crew resumed`);
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  await c.end();
})().catch((e) => { console.error("FREEZE-FLIP ERR:", String(e.message).slice(0, 300)); process.exit(1); });
