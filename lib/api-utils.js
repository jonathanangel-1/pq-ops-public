"use strict";

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function isDryRunRequest(request, body = {}) {
  const url = new URL(request.url || "/", "http://localhost");
  return body.dryRun === true || url.searchParams.get("dryRun") === "1";
}

module.exports = {
  isDryRunRequest,
  readJsonBody,
};
