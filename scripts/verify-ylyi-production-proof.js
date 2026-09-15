#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeAwb } = require("../lib/awb");

const ROOT_DIR = path.resolve(__dirname, "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts", "ylyi-production-proof");

function parseArgs(argv) {
  return {
    strict: argv.includes("--strict"),
    write: !argv.includes("--no-write"),
  };
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
}

function readJson(relativePath, fallback = {}) {
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return fallback;
  }
}

function includesAll(text, terms) {
  const lower = String(text || "").toLowerCase();
  return terms.filter((term) => !lower.includes(String(term).toLowerCase()));
}

function proofText(proof = {}) {
  return JSON.stringify({
    status: proof.status,
    summary: proof.summary,
    nextAction: proof.nextAction,
    proof: proof.proof,
    emailValidation: proof.emailValidation,
    historicalEvents: proof.historicalEvents,
    historicalProof: proof.historicalProof,
    sources: proof.sources,
    timeline: proof.timeline,
  });
}

function historicalReplayProofRows(data = {}) {
  return (data.shipments || [])
    .filter((row) =>
      (row.historicalEvents || row.sourceEvents || []).length ||
      (row.historicalProof || row.sourceProof || []).length
    )
    .map((row) => {
      const awb = row.awb || "";
      const historicalEvents = row.historicalEvents || row.sourceEvents || [];
      const historicalProof = row.historicalProof || row.sourceProof || [];
      const latestEventAt = [
        ...historicalEvents.map((event) => event.at),
        ...historicalProof.map((proof) => proof.at),
        ...(row.decisiveEvidence || []).map((proof) => proof.at),
      ].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || "";
      return {
        awb,
        normalizedAwb: normalizeAwb(awb),
        status: "manual-historical-replay",
        summary: row.manualTruth || row.purpose || "Manual historical Gmail replay proof.",
        nextAction: "Use historical replay proof for completed-shipment source validation.",
        latestEventAt,
        historicalEvents,
        historicalProof,
        proof: historicalProof,
        emailValidation: {
          status: "manual-historical-replay",
          summary: row.manualTruth || "Manual historical Gmail replay proof.",
          latestEventAt,
          events: historicalEvents,
          proof: historicalProof,
        },
      };
    });
}

function combinedGmailProofData(gmailProof = {}, historicalReplay = {}) {
  return {
    ...gmailProof,
    proofs: [
      ...historicalReplayProofRows(historicalReplay),
      ...(gmailProof.proofs || []),
    ],
  };
}

function proofByAwb(proofs = []) {
  const map = new Map();
  for (const proof of proofs) {
    const key = normalizeAwb(proof.awb);
    if (key && !map.has(key)) map.set(key, proof);
  }
  return map;
}

function shipmentsByAwb(shipments = []) {
  const map = new Map();
  for (const shipment of shipments) {
    const key = normalizeAwb(shipment.awb || shipment.normalizedAwb);
    if (key) map.set(key, shipment);
  }
  return map;
}

function actionText(action = {}) {
  return [
    action.id,
    action.type,
    action.subject,
    action.problem,
    action.reason,
    action.body,
    action.nextAction,
  ].filter(Boolean).join(" ");
}

function actionMatchesAwb(action = {}, awb) {
  const key = normalizeAwb(awb);
  if (!key) return false;
  return [
    action.awb,
    action.normalizedAwb,
    action.shipmentAwb,
    action.shipmentId,
    action.id,
    action.subject,
    action.reason,
    action.body,
    action.nextAction,
  ].some((value) => normalizeAwb(value).includes(key));
}

function validateAgentInstructions() {
  const ag = readText("AGENTS.md");
  const required = [
    "YLYI/05_Agent_Runbooks/Startup_Manifest.md",
    "Gmail OAuth backend ingestion",
    "schema contracts",
    "action registry",
    "Mac mini automation runbook",
    "YLYI/05_Agent_Runbooks/Parallel_Agent_Contract.md",
    "YLYI/05_Agent_Runbooks/Lane_Ownership_Matrix.md",
    "YLYI/05_Agent_Runbooks/Proof_Matrix.md",
    "no-overlap",
    "npm run verify:ylyi",
  ];
  const missing = includesAll(ag, required);
  assert.deepEqual(missing, [], `AGENTS.md missing required YLYI references: ${missing.join(", ")}`);
}

function validateVaultContract() {
  const files = [
    "YLYI/YLYI.md",
    "YLYI/00_Product_Contract/Product_Contract.md",
    "YLYI/00_Product_Contract/Productionization_Plan.md",
    "YLYI/00_Product_Contract/Action_Registry.md",
    "YLYI/00_Product_Contract/Cost_And_AI_Usage_Model.md",
    "YLYI/01_Truth_Lab/Companion_RAG_Contract.md",
    "YLYI/01_Truth_Lab/Schema_Contracts.md",
    "YLYI/04_UI_Companion_Guidelines/Desktop_And_Phone_UI.md",
    "YLYI/04_UI_Companion_Guidelines/UI_Information_Architecture.md",
    "YLYI/03_Source_Systems/Gmail_OAuth_Backend_Ingestion.md",
    "YLYI/03_Source_Systems/Automation_Topology.md",
    "YLYI/03_Source_Systems/Mac_Mini_Automation_Runbook.md",
    "YLYI/05_Agent_Runbooks/Startup_Manifest.md",
    "YLYI/05_Agent_Runbooks/Parallel_Agent_Contract.md",
    "YLYI/05_Agent_Runbooks/Lane_Ownership_Matrix.md",
    "YLYI/05_Agent_Runbooks/Proof_Matrix.md",
  ];
  for (const file of files) assert.ok(fs.existsSync(path.join(ROOT_DIR, file)), `${file} must exist`);

  const combined = files.map(readText).join("\n");
  const missing = includesAll(combined, [
    "Email threads",
    "Tracking is a baseline",
    "Mac mini",
    "not been implemented yet",
    "Desktop is the main operator work surface",
    "companion should let an operator ask questions instead of searching Gmail",
    "Gmail OAuth backend ingestion is critical product infrastructure",
    "Cost must be optimized",
    "Cleanup Last",
    "canonical startup",
    "Parallel Agent Contract",
    "Lane Ownership Matrix",
    "No-Overlap",
    "Proof Matrix",
    "Schema Contracts",
    "Action Registry",
    "Mac mini automation runbook",
    "coordinating brain",
    "source fact",
    "truth packet",
    "evidence packet",
    "action proposal",
  ]);
  assert.deepEqual(missing, [], `YLYI production contract missing terms: ${missing.join(", ")}`);
}

function validateCompletedCases(fixtures, gmailProof) {
  const completed = fixtures.completedCases || [];
  assert.equal(completed.length, 20, "YLYI production proof must include exactly 20 completed shipment cases");
  assert.equal(new Set(completed.map((row) => row.caseId)).size, 20, "Completed case IDs must be unique");
  assert.equal(new Set(completed.map((row) => normalizeAwb(row.awb))).size, 20, "Completed case AWBs must be unique");

  const proofMap = proofByAwb(gmailProof.proofs || []);
  return completed.map((row) => {
    const proof = proofMap.get(normalizeAwb(row.awb));
    assert.ok(proof, `${row.caseId} ${row.awb}: missing from gmail-proof-snapshot.json`);
    const text = proofText(proof);
    const missingTerms = includesAll(text, row.expectedSourceTerms || []);
    assert.deepEqual(missingTerms, [], `${row.caseId} ${row.awb}: proof missing expected terms ${missingTerms.join(", ")}`);
    return {
      caseId: row.caseId,
      awb: row.awb,
      latestEventAt: proof.latestEventAt || "",
      status: proof.status || "",
      expectedSourceTerms: row.expectedSourceTerms || [],
    };
  });
}

function validateIncidentCases(fixtures, snapshots) {
  const incidentCases = fixtures.incidentCases || [];
  assert.equal(incidentCases.length, 1, "YLYI proof starts with one active incident case");

  const activeMap = shipmentsByAwb(snapshots.active.shipments || []);
  const groupText = JSON.stringify(snapshots.groups);
  const actions = snapshots.actions.actions || [];

  return incidentCases.map((incident) => {
    const incidentText = readText(incident.incidentFile);
    const missingTerms = includesAll(incidentText, incident.expectedIncidentTerms || []);
    assert.deepEqual(missingTerms, [], `${incident.caseId}: incident file missing terms ${missingTerms.join(", ")}`);

    const activeAwbs = [];
    const absentActiveAwbs = [];
    for (const awb of incident.awbs || []) {
      if (activeMap.has(normalizeAwb(awb))) {
        activeAwbs.push(awb);
        assert.ok(groupText.includes(awb), `${incident.caseId}: ${awb} must be present in shipment-groups.json while active`);
      } else {
        absentActiveAwbs.push(awb);
      }
    }

    const incidentActionTexts = actions
      .filter((action) => (incident.awbs || []).some((awb) => actionMatchesAwb(action, awb)))
      .map(actionText);
    const wrongActionHits = (incident.expectedWrongCurrentActions || []).filter((term) =>
      incidentActionTexts.some((text) => text.toLowerCase().includes(term.toLowerCase())),
    );

    return {
      caseId: incident.caseId,
      awbs: incident.awbs,
      activeAwbs,
      absentActiveAwbs,
      currentWrongActionSignalsFound: wrongActionHits,
      expectedFutureTruth: incident.expectedFutureTruth,
      unresolved: wrongActionHits.length > 0,
    };
  });
}

function validateQuestions(fixtures) {
  const questions = fixtures.canonicalOperatorQuestions || [];
  assert.ok(questions.length >= 10, "YLYI proof must include at least 10 canonical operator questions");
  const missing = includesAll(questions.join("\n"), [
    "released",
    "delivery order",
    "station paid",
    "broker",
    "pick it up",
    "out for delivery",
    "POD",
    "station phone",
    "broker say",
    "stopping",
  ]);
  assert.deepEqual(missing, [], `Canonical operator question set missing terms: ${missing.join(", ")}`);
  return questions;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = readJson("YLYI/07_Backtest_Cases/operator-question-backtests.json");
  const gmailProof = combinedGmailProofData(
    readJson("gmail-proof-snapshot.json", { proofs: [] }),
    readJson("data/manual-gmail-truth/historical-replay-awbs.json", { shipments: [] }),
  );
  const snapshots = {
    active: readJson("shipment-truth-packets.json", { shipments: [] }),
    groups: readJson("shipment-groups.json", { groups: [] }),
    actions: readJson("action-queue.json", { actions: [] }),
  };

  validateAgentInstructions();
  validateVaultContract();
  const questions = validateQuestions(fixtures);
  const completedCases = validateCompletedCases(fixtures, gmailProof);
  const incidentCases = validateIncidentCases(fixtures, snapshots);

  const unresolvedIncidentCount = incidentCases.filter((row) => row.unresolved).length;
  const strictReady = unresolvedIncidentCount === 0;
  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    strict: options.strict,
    agentInstructions: true,
    vaultContract: true,
    operatorQuestions: questions.length,
    completedCases: completedCases.length,
    incidentCases: incidentCases.length,
    unresolvedIncidentCount,
    strictReady,
    completedCaseAwbs: completedCases.map((row) => row.awb),
    incidents: incidentCases,
    nextProductionProof: "Build companion evidence-packet/RAG runner that answers the canonical operator questions from source evidence for each case.",
  };

  if (options.strict && !strictReady) {
    result.ok = false;
    if (options.write) {
      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(ARTIFACT_DIR, "latest.json"), `${JSON.stringify(result, null, 2)}\n`);
    }
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  if (options.write) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, "latest.json"), `${JSON.stringify(result, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    ok: result.ok,
    agentInstructions: result.agentInstructions,
    vaultContract: result.vaultContract,
    operatorQuestions: result.operatorQuestions,
    completedCases: result.completedCases,
    incidentCases: result.incidentCases,
    unresolvedIncidentCount: result.unresolvedIncidentCount,
    strictReady: result.strictReady,
  }));
}

main();
