"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_TIMEOUT_MS = 60000;

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatAwb(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/\d{3}-\d{8}/);
  if (match) return match[0];
  const digits = normalizeAwb(raw);
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return raw;
}

function deliveryOrderActionError(actionId, action) {
  if (!actionId) return "Action id is required";
  if (!action || typeof action !== "object") return "Delivery order action is required";
  if (action.id && action.id !== actionId) return "Action id mismatch";
  const intent = deliveryOrderAttachmentIntent(action);
  if (action.type !== "delivery-order" && !intent) {
    return "Only delivery-order actions or actions with delivery-order intent can generate delivery order PDFs";
  }
  if (!normalizeAwb(intent?.awb || action.awb)) return "AWB is required";
  return "";
}

function scriptPath() {
  return path.join(ROOT_DIR, "scripts", "generate-delivery-order.js");
}

function expectedOutputPath(awb) {
  const safeAwb = formatAwb(awb).replace(/[^A-Za-z0-9-]+/g, "-") || "shipment";
  const outputDir = process.env.VERCEL ? os.tmpdir() : path.join(ROOT_DIR, "output", "pdf");
  return path.join(outputDir, `delivery-order-${safeAwb}.pdf`);
}

function publicFilePath(filePath) {
  const relative = path.relative(ROOT_DIR, filePath);
  return relative && !relative.startsWith("..") ? `/${relative.split(path.sep).join("/")}` : "";
}

function parseGeneratorOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Delivery order generator returned non-JSON output");
  }
}

function deliveryOrderAttachmentIntent(action) {
  const intents = [
    ...(Array.isArray(action?.attachmentIntents) ? action.attachmentIntents : []),
    action?.attachmentIntent,
    action?.documentIntent,
  ].filter(Boolean);
  return intents.find((intent) => String(intent.kind || intent.type || "").toLowerCase() === "delivery-order") || null;
}

function deliveryOrderFields(action) {
  const intent = deliveryOrderAttachmentIntent(action) || {};
  const candidates = [
    intent.fields,
    intent.deliveryOrderFields,
    action?.documentIntent?.fields,
    action?.attachmentIntent?.fields,
    action?.deliveryOrderFields,
  ];
  return candidates.find((fields) => fields && typeof fields === "object" && !Array.isArray(fields)) || null;
}

function runGenerator(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath(), ...args], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Delivery order generation timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || "Delivery order generation failed"));
        return;
      }
      try {
        resolve(parseGeneratorOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function renderPdfPreviewPngBase64(filePath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const prefix = path.join(os.tmpdir(), `delivery-order-preview-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const env = { ...process.env };
    for (const candidate of ["/opt/homebrew/etc/fonts/fonts.conf", "/usr/local/etc/fonts/fonts.conf"]) {
      if (!env.FONTCONFIG_FILE && fs.existsSync(candidate)) {
        env.FONTCONFIG_FILE = candidate;
        break;
      }
    }
    const child = spawn("pdftoppm", ["-png", "-singlefile", filePath, prefix], {
      cwd: ROOT_DIR,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve("");
    }, timeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const pngPath = `${prefix}.png`;
      try {
        if (code === 0 && fs.existsSync(pngPath)) {
          const base64 = fs.readFileSync(pngPath).toString("base64");
          fs.unlinkSync(pngPath);
          resolve(base64);
          return;
        }
      } catch {
        // Preview rendering is optional; the PDF remains the source artifact.
      }
      resolve("");
    });
  });
}

async function generateDeliveryOrderPdf(awbValue, carrierName = "", options = {}) {
  const awb = formatAwb(awbValue);
  const output = options.output || expectedOutputPath(awb);
  if (!normalizeAwb(awb)) throw new Error("AWB is required");
  if (!fs.existsSync(scriptPath())) throw new Error("Delivery order generator is missing");
  const args = [awb, "--output", output];
  if (String(carrierName || "").trim()) args.push("--carrier-name", String(carrierName || "").trim());
  if (options.fields && typeof options.fields === "object") args.push("--fields-json", JSON.stringify(options.fields));
  const result = await runGenerator(args, options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const generatedOutput = result.output || output;
  const pdfBuffer = fs.existsSync(generatedOutput) ? fs.readFileSync(generatedOutput) : Buffer.alloc(0);
  const previewPngBase64 = await renderPdfPreviewPngBase64(generatedOutput, options.previewTimeoutMs || 15000);
  return {
    result,
    awb: result.awb || awb,
    output: generatedOutput,
    publicPath: publicFilePath(generatedOutput),
    fileName: path.basename(generatedOutput),
    pdfBuffer,
    pdfBase64: pdfBuffer.toString("base64"),
    previewPngBase64,
    carrierName: String(carrierName || "").trim(),
  };
}

async function materializeDraftAttachmentsForAction(action, options = {}) {
  const intent = deliveryOrderAttachmentIntent(action);
  if (!intent) return { attachments: [], generated: [] };
  const awb = formatAwb(intent.awb || action?.awb || "");
  const carrierName = String(intent.carrierName || action?.documentIntent?.carrierName || action?.carrierName || "").trim();
  const fields = deliveryOrderFields(action);
  if (options.dryRun) {
    return {
      attachments: [],
      generated: [],
      attachmentIntents: [{ kind: "delivery-order", awb, carrierName }],
      wouldGenerate: Boolean(normalizeAwb(awb)),
    };
  }
  const generated = await generateDeliveryOrderPdf(awb, carrierName, { ...options, fields: options.fields || fields });
  const attachment = {
    path: generated.output,
    fileName: generated.fileName,
    filename: generated.fileName,
    contentType: "application/pdf",
    mimeType: "application/pdf",
    kind: "delivery-order",
    awb: generated.awb,
    carrierName,
    size: generated.pdfBuffer.length,
    contentBase64: generated.pdfBase64,
  };
  return {
    attachments: [attachment],
    generated: [{
      kind: "delivery-order",
      awb: generated.awb,
      carrierName,
      output: generated.output,
      publicPath: generated.publicPath,
      fileName: generated.fileName,
      size: generated.pdfBuffer.length,
      populatedFields: generated.result.populatedFields || [],
      foundSources: generated.result.foundSources || [],
      previewPngBase64: generated.previewPngBase64,
    }],
  };
}

async function generateDeliveryOrderForAction(actionId, action, options = {}) {
  const error = deliveryOrderActionError(actionId, action);
  if (error) return { statusCode: error === "Delivery order action is required" ? 404 : 409, body: { error } };

  const intent = deliveryOrderAttachmentIntent(action);
  const awb = formatAwb(intent?.awb || action.awb);
  const carrierName = String(
    intent?.carrierName ||
      action.documentIntent?.carrierName ||
      action.attachmentIntent?.carrierName ||
      action.carrierName ||
      "",
  ).trim();
  const fields = deliveryOrderFields(action);
  const output = expectedOutputPath(awb);
  if (options.dryRun) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        dryRun: true,
        generated: false,
        wouldGenerate: true,
        actionId,
        awb,
        output,
        publicPath: publicFilePath(output),
        note: "Validated delivery order PDF generation. No Gmail draft or email is created.",
      },
    };
  }

  if (!fs.existsSync(scriptPath())) {
    return { statusCode: 500, body: { error: "Delivery order generator is missing" } };
  }

  try {
    const generated = await generateDeliveryOrderPdf(awb, carrierName, { output, fields: options.fields || fields });
    return {
      statusCode: 201,
      body: {
        ok: true,
        generated: true,
        actionId,
        awb: generated.awb,
        output: generated.output,
        publicPath: generated.publicPath,
        fileName: generated.fileName,
        pdfBase64: generated.pdfBase64,
        previewPngBase64: generated.previewPngBase64,
        createdAt: new Date().toISOString(),
        populatedFields: generated.result.populatedFields || [],
        foundSources: generated.result.foundSources || [],
        note: "Delivery order PDF generated. No Gmail draft or email was created.",
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        awb,
      },
    };
  }
}

module.exports = {
  deliveryOrderActionError,
  expectedOutputPath,
  formatAwb,
  generateDeliveryOrderForAction,
  materializeDraftAttachmentsForAction,
};
