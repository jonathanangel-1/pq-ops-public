"use strict";

// Data-only PostgreSQL jsonb::text canonicalization for identities written by
// SQL migrations. Keeping this below reducers, delivery, witnesses, and the
// auditor prevents any truth-building module from depending on audit runtime.

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function postgresKeyCompare(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return leftBytes.length - rightBytes.length;
  return Buffer.compare(leftBytes, rightBytes);
}

function postgresJsonbText(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(postgresJsonbText).join(", ")}]`;
  if (!isPlainObject(value)) throw new TypeError("postgresJsonbText accepts JSON values only");
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort(postgresKeyCompare)
    .map((key) => `${JSON.stringify(key)}: ${postgresJsonbText(value[key])}`);
  return `{${entries.join(", ")}}`;
}

module.exports = Object.freeze({
  postgresJsonbText,
  _test: Object.freeze({ isPlainObject, postgresKeyCompare }),
});
