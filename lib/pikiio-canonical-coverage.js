"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { pathToFileURL } = require("node:url");

const REPORT_SCHEMA = "pikiio-canonical-coverage-report-v2";
const RAW_EVIDENCE_MANIFEST_SCHEMA =
  "pikiio-canonical-coverage-raw-evidence-manifest-v1";
const SEMANTIC_MANIFEST_SCHEMA =
  "pikiio-canonical-coverage-semantic-input-manifest-v1";
const REDUCER_NAME = "pikiio-canonical-raw-v8-coverage";
const REDUCER_VERSION = "1.1.0";
const ALGORITHM =
  "utf16-merged-function-lines-zero-overlay-block-supersession-v3";

const BOUNDS = Object.freeze({
  maxRawFiles: 128,
  maxRawFileBytes: 2 * 1024 * 1024,
  maxRawTotalBytes: 32 * 1024 * 1024,
  maxScriptsPerRawFile: 10_000,
  maxFunctionsPerScript: 20_000,
  maxRangesPerFunction: 20_000,
  maxRangesPerRawFile: 25_000,
  maxFunctionsPerTarget: 20_000,
  maxMergedRangesPerFunction: 20_000,
  maxScriptObservationsPerTarget: 4_096,
  maxFunctionObservationsPerTarget: 25_000,
  maxRangeObservationsPerTarget: 50_000,
  maxTargets: 64,
  maxSourceBytes: 8 * 1024 * 1024,
  maxUrlCodeUnits: 16_384,
  maxFunctionNameCodeUnits: 4_096,
  maxJsonDepth: 64,
  maxJsonTokens: 200_000,
});

const PERCENTAGE_POLICY = Object.freeze({
  authority: "integer-covered-and-total",
  displayDecimalPlaces: 2,
  rounding: "integer-half-up",
  zeroDenominatorDisplay: "100.00",
});

const RAW_FILE_PATTERN = /^coverage-\d+-\d{13}-\d+\.json$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IGNORE_DIRECTIVE_PATTERN =
  /(?:\/\*|\/\/)\s*(?:node:coverage|c8|istanbul|v8)\s+(?:ignore\b|enable\b|disable\b)/iu;
const SOURCE_MAP_PATTERN =
  /(?:\/\/[@#]|\/\*#)\s*sourceMappingURL\s*=/iu;
const LOGICAL_TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

class CanonicalCoverageError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CanonicalCoverageError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new CanonicalCoverageError(code, message, details);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isWellFormedString(value) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ownStringKeys(value) {
  return Reflect.ownKeys(value).filter((key) => typeof key === "string");
}

function assertRecord(value, code, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
  ) {
    fail(code, `${label} must be an exact plain record`);
  }
}

function assertExactKeys(value, expected, code, label) {
  assertRecord(value, code, label);
  const actual = ownStringKeys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, `${label} has unsupported or missing fields`, {
      actual,
      expected: wanted,
    });
  }
}

function assertSafeInteger(value, code, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(code, `${label} must be a safe integer >= ${minimum}`);
  }
}

function safeAdd(left, right, code, label) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    fail(code, `${label} exceeds the safe integer range`);
  }
  return sum;
}

function safeMultiply(left, right, code, label) {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    fail(code, `${label} exceeds the safe integer range`);
  }
  return product;
}

function assertUnionCountBound(observed, maximum, code, label) {
  assertSafeInteger(observed, code, label);
  assertSafeInteger(maximum, code, `${label} maximum`, 1);
  if (observed > maximum) {
    fail(code, `${label} exceeds its cross-file union or observation bound`, {
      maximum,
      observed,
    });
  }
}

function boundedUnionAdd(current, increment, maximum, code, label) {
  const observed = safeAdd(current, increment, code, label);
  assertUnionCountBound(observed, maximum, code, label);
  return observed;
}

function fileSnapshot(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    rdev: stat.rdev.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameSnapshot(left, right) {
  return stableJson(fileSnapshot(left)) === stableJson(fileSnapshot(right));
}

function assertCurrentOwner(stat, code, label) {
  if (typeof process.getuid !== "function") {
    fail("OWNER_IDENTITY_UNAVAILABLE", "current process owner is unavailable");
  }
  if (stat.uid !== BigInt(process.getuid())) {
    fail(code, `${label} is not owned by the current process owner`);
  }
}

function assertCanonicalAbsolutePath(input, code, label) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    !isWellFormedString(input) ||
    !path.isAbsolute(input) ||
    path.normalize(input) !== input
  ) {
    fail(code, `${label} must be an absolute normalized path`);
  }
  let canonical;
  try {
    canonical = fs.realpathSync.native(input);
  } catch (error) {
    fail(code, `${label} cannot be resolved`, { cause: error.code || "UNKNOWN" });
  }
  if (canonical !== input) {
    fail(code, `${label} must use its exact canonical filesystem spelling`, {
      supplied: input,
      canonical,
    });
  }
  return canonical;
}

function assertRawDirectory(rawDirectory) {
  const canonical = assertCanonicalAbsolutePath(
    rawDirectory,
    "RAW_DIRECTORY_NON_CANONICAL",
    "rawDirectory",
  );
  const stat = fs.lstatSync(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("RAW_DIRECTORY_INVALID", "rawDirectory must be a real directory");
  }
  assertCurrentOwner(stat, "RAW_DIRECTORY_OWNER_MISMATCH", "rawDirectory");
  if ((stat.mode & 0o077n) !== 0n) {
    fail(
      "RAW_DIRECTORY_NOT_OWNER_ONLY",
      "rawDirectory must grant no group or other permissions",
    );
  }
  return { canonical, stat };
}

function assertStableRegularFile(stat, options) {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(options.typeCode, `${options.label} must be a regular non-symlink file`);
  }
  assertCurrentOwner(stat, options.ownerCode, options.label);
  if (stat.nlink !== 1n) {
    fail(options.linkCode, `${options.label} must have exactly one hard link`);
  }
  if (!options.ownerOnly && (stat.mode & 0o022n) !== 0n) {
    fail(
      options.permissionsCode,
      `${options.label} must not be group/world writable`,
    );
  }
  if (options.ownerOnly && (stat.mode & 0o077n) !== 0n) {
    fail(
      options.permissionsCode,
      `${options.label} must grant no group or other permissions`,
    );
  }
  if (stat.size > BigInt(options.maxBytes)) {
    fail(options.sizeCode, `${options.label} exceeds its byte bound`, {
      maximum: options.maxBytes,
      observed: stat.size.toString(),
    });
  }
}

function secureReadFile(filePath, options) {
  const canonical = assertCanonicalAbsolutePath(
    filePath,
    options.pathCode,
    options.label,
  );
  const pathBefore = fs.lstatSync(canonical, { bigint: true });
  assertStableRegularFile(pathBefore, options);

  let descriptor;
  try {
    descriptor = fs.openSync(
      canonical,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    fail(options.pathCode, `${options.label} cannot be opened safely`, {
      cause: error.code || "UNKNOWN",
    });
  }

  try {
    const fdBefore = fs.fstatSync(descriptor, { bigint: true });
    assertStableRegularFile(fdBefore, options);
    if (!sameSnapshot(pathBefore, fdBefore)) {
      fail(options.mutationCode, `${options.label} changed before reading`);
    }

    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > options.maxBytes) {
      fail(options.sizeCode, `${options.label} exceeds its byte bound`);
    }

    const fdAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(canonical, { bigint: true });
    assertStableRegularFile(fdAfter, options);
    assertStableRegularFile(pathAfter, options);
    if (
      !sameSnapshot(fdBefore, fdAfter) ||
      !sameSnapshot(fdAfter, pathAfter)
    ) {
      fail(options.mutationCode, `${options.label} changed while being read`);
    }
    return { canonical, bytes };
  } finally {
    fs.closeSync(descriptor);
  }
}

function decodeUtf8(bytes, code, label) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    fail(code, `${label} must not contain a UTF-8 byte-order mark`);
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    fail(code, `${label} is not valid UTF-8`);
  }
}

function sourceReadOptions(label) {
  return {
    label,
    maxBytes: BOUNDS.maxSourceBytes,
    ownerOnly: false,
    pathCode: "SOURCE_PATH_NON_CANONICAL",
    typeCode: "SOURCE_FILE_INVALID",
    ownerCode: "SOURCE_OWNER_MISMATCH",
    linkCode: "SOURCE_LINK_COUNT_INVALID",
    permissionsCode: "SOURCE_PERMISSIONS_INVALID",
    sizeCode: "SOURCE_SIZE_BOUND_EXCEEDED",
    mutationCode: "SOURCE_MUTATED_DURING_READ",
  };
}

function reportSourceReadOptions(label) {
  return {
    label,
    maxBytes: BOUNDS.maxSourceBytes,
    ownerOnly: false,
    pathCode: "REPORT_SOURCE_PATH_INVALID",
    typeCode: "REPORT_SOURCE_FILE_INVALID",
    ownerCode: "REPORT_SOURCE_OWNER_MISMATCH",
    linkCode: "REPORT_SOURCE_LINK_COUNT_INVALID",
    permissionsCode: "REPORT_SOURCE_PERMISSIONS_INVALID",
    sizeCode: "REPORT_SOURCE_SIZE_BOUND_EXCEEDED",
    mutationCode: "REPORT_SOURCE_MUTATED_DURING_READ",
  };
}

function rawReadOptions(label) {
  return {
    label,
    maxBytes: BOUNDS.maxRawFileBytes,
    ownerOnly: true,
    pathCode: "RAW_FILE_NON_CANONICAL",
    typeCode: "RAW_ENTRY_NOT_REGULAR",
    ownerCode: "RAW_FILE_OWNER_MISMATCH",
    linkCode: "RAW_FILE_LINK_COUNT_INVALID",
    permissionsCode: "RAW_FILE_NOT_OWNER_ONLY",
    sizeCode: "RAW_FILE_SIZE_BOUND_EXCEEDED",
    mutationCode: "RAW_FILE_MUTATED_DURING_READ",
  };
}

function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    fail("TARGETS_INVALID", "targets must be a non-empty array");
  }
  if (targets.length > BOUNDS.maxTargets) {
    fail("TARGET_COUNT_BOUND_EXCEEDED", "target count exceeds the bound");
  }

  const seenIds = new Set();
  const seenPaths = new Set();
  const validated = targets.map((target, index) => {
    const label = `targets[${index}]`;
    assertExactKeys(
      target,
      ["id", "sourcePath"],
      "TARGET_SCHEMA_INVALID",
      label,
    );
    if (
      typeof target.id !== "string" ||
      !isWellFormedString(target.id) ||
      !LOGICAL_TARGET_ID_PATTERN.test(target.id) ||
      target.id === "." ||
      target.id === ".."
    ) {
      fail("TARGET_ID_INVALID", `${label}.id is invalid`);
    }

    const source = secureReadFile(
      target.sourcePath,
      sourceReadOptions(`${label}.sourcePath`),
    );
    const exactUrl = pathToFileURL(source.canonical).href;
    if (seenIds.has(target.id)) {
      fail("TARGET_ID_DUPLICATE", `duplicate target ID: ${target.id}`);
    }
    if (seenPaths.has(source.canonical)) {
      fail(
        "TARGET_SOURCE_DUPLICATE",
        `duplicate target sourcePath: ${source.canonical}`,
      );
    }
    seenIds.add(target.id);
    seenPaths.add(source.canonical);

    const sourceText = decodeUtf8(
      source.bytes,
      "SOURCE_UTF8_INVALID",
      `${label}.sourcePath`,
    );
    if (IGNORE_DIRECTIVE_PATTERN.test(sourceText)) {
      fail(
        "SOURCE_IGNORE_DIRECTIVE_UNSUPPORTED",
        `${label}.sourcePath contains a coverage ignore/status directive`,
      );
    }
    if (SOURCE_MAP_PATTERN.test(sourceText)) {
      fail(
        "SOURCE_MAP_UNSUPPORTED",
        `${label}.sourcePath contains a source-map directive`,
      );
    }

    return {
      id: target.id,
      url: exactUrl,
      sourcePath: source.canonical,
      sourceBytes: source.bytes,
      sourceText,
      sourceSha256: sha256(source.bytes),
      functionGroups: new Map(),
      scriptObservationCount: 0,
      functionObservationCount: 0,
      rangeObservationCount: 0,
      blockScriptObservationCount: 0,
    };
  });

  validated.sort((left, right) => compareText(left.id, right.id));
  return validated;
}

function validateRange(range, label) {
  assertExactKeys(
    range,
    ["count", "endOffset", "startOffset"],
    "RAW_RANGE_SCHEMA_INVALID",
    label,
  );
  assertSafeInteger(
    range.startOffset,
    "RAW_RANGE_OFFSET_INVALID",
    `${label}.startOffset`,
  );
  assertSafeInteger(
    range.endOffset,
    "RAW_RANGE_OFFSET_INVALID",
    `${label}.endOffset`,
    1,
  );
  assertSafeInteger(range.count, "RAW_RANGE_COUNT_INVALID", `${label}.count`);
  if (range.startOffset >= range.endOffset) {
    fail("RAW_RANGE_OFFSET_INVALID", `${label} must have positive width`);
  }
}

function validateFunction(fn, label) {
  assertExactKeys(
    fn,
    ["functionName", "isBlockCoverage", "ranges"],
    "RAW_FUNCTION_SCHEMA_INVALID",
    label,
  );
  if (
    typeof fn.functionName !== "string" ||
    !isWellFormedString(fn.functionName) ||
    fn.functionName.length > BOUNDS.maxFunctionNameCodeUnits
  ) {
    fail("RAW_FUNCTION_NAME_INVALID", `${label}.functionName is invalid`);
  }
  if (typeof fn.isBlockCoverage !== "boolean") {
    fail(
      "RAW_BLOCK_COVERAGE_INVALID",
      `${label}.isBlockCoverage must be boolean`,
    );
  }
  if (
    !Array.isArray(fn.ranges) ||
    fn.ranges.length === 0 ||
    fn.ranges.length > BOUNDS.maxRangesPerFunction
  ) {
    fail("RAW_RANGE_COUNT_INVALID", `${label}.ranges violates its bound`);
  }
  if (!fn.isBlockCoverage && fn.ranges.length !== 1) {
    fail(
      "RAW_NON_BLOCK_RANGES_INVALID",
      `${label} non-block coverage must contain exactly one root range`,
    );
  }

  const exactRanges = new Set();
  fn.ranges.forEach((range, rangeIndex) => {
    validateRange(range, `${label}.ranges[${rangeIndex}]`);
    const key = `${range.startOffset}:${range.endOffset}`;
    if (exactRanges.has(key)) {
      fail(
        "RAW_RANGE_DUPLICATE",
        `${label} contains duplicate exact ranges`,
      );
    }
    exactRanges.add(key);
  });

  const root = fn.ranges[0];
  for (const range of fn.ranges) {
    if (
      root.startOffset > range.startOffset ||
      root.endOffset < range.endOffset
    ) {
      fail(
        "RAW_FUNCTION_ROOT_INVALID",
        `${label}.ranges[0] must contain every function range`,
      );
    }
  }
  const ordered = fn.ranges
    .map((range) => ({ ...range }))
    .sort(compareRanges);
  const stack = [];
  for (const range of ordered) {
    while (
      stack.length > 0 &&
      range.startOffset >= stack[stack.length - 1].endOffset
    ) {
      stack.pop();
    }
    if (
      stack.length > 0 &&
      range.endOffset > stack[stack.length - 1].endOffset
    ) {
      fail(
        "RAW_RANGE_TREE_INVALID",
        `${label}.ranges must be nested or disjoint within one observation`,
      );
    }
    stack.push(range);
  }
}

function validateScript(script, label) {
  assertExactKeys(
    script,
    ["functions", "scriptId", "url"],
    "RAW_SCRIPT_SCHEMA_INVALID",
    label,
  );
  if (
    typeof script.scriptId !== "string" ||
    script.scriptId.length === 0 ||
    script.scriptId.length > 32 ||
    !isWellFormedString(script.scriptId) ||
    !/^\d+$/u.test(script.scriptId)
  ) {
    fail("RAW_SCRIPT_ID_INVALID", `${label}.scriptId is invalid`);
  }
  if (
    typeof script.url !== "string" ||
    !isWellFormedString(script.url) ||
    script.url.length > BOUNDS.maxUrlCodeUnits
  ) {
    fail("RAW_SCRIPT_URL_INVALID", `${label}.url is invalid`);
  }
  if (
    !Array.isArray(script.functions) ||
    script.functions.length > BOUNDS.maxFunctionsPerScript
  ) {
    fail("RAW_FUNCTION_COUNT_INVALID", `${label}.functions violates its bound`);
  }
}

function assertStrictJson(text, label) {
  let offset = 0;
  let tokenCount = 0;

  function syntax(message) {
    fail("RAW_JSON_INVALID", `${label} ${message}`, { offset });
  }

  function token() {
    tokenCount = safeAdd(
      tokenCount,
      1,
      "RAW_JSON_TOKEN_BOUND_EXCEEDED",
      `${label} JSON token count`,
    );
    if (tokenCount > BOUNDS.maxJsonTokens) {
      fail(
        "RAW_JSON_TOKEN_BOUND_EXCEEDED",
        `${label} exceeds the JSON token bound`,
      );
    }
  }

  function skipWhitespace() {
    while (
      text[offset] === " " ||
      text[offset] === "\t" ||
      text[offset] === "\n" ||
      text[offset] === "\r"
    ) {
      offset++;
    }
  }

  function parseString() {
    if (text[offset] !== '"') syntax("contains an invalid string");
    const start = offset++;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset++;
        const literal = text.slice(start, offset);
        try {
          return JSON.parse(literal);
        } catch {
          syntax("contains an invalid string escape");
        }
      }
      if (code < 0x20) syntax("contains an unescaped control character");
      if (code === 0x5c) {
        offset++;
        if (offset >= text.length) syntax("contains a truncated escape");
        const escape = text[offset];
        if (escape === "u") {
          const hex = text.slice(offset + 1, offset + 5);
          if (hex.length !== 4 || !/^[a-fA-F0-9]{4}$/u.test(hex)) {
            syntax("contains an invalid Unicode escape");
          }
          offset += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) {
          syntax("contains an invalid string escape");
        }
      }
      offset++;
    }
    syntax("contains an unterminated string");
  }

  function parseNumber() {
    const start = offset;
    if (text[offset] === "-") offset++;
    if (text[offset] === "0") {
      offset++;
      if (text[offset] >= "0" && text[offset] <= "9") {
        syntax("contains a number with a leading zero");
      }
    } else {
      if (!(text[offset] >= "1" && text[offset] <= "9")) {
        syntax("contains an invalid number");
      }
      while (text[offset] >= "0" && text[offset] <= "9") offset++;
    }
    if (text[offset] === ".") {
      offset++;
      if (!(text[offset] >= "0" && text[offset] <= "9")) {
        syntax("contains an invalid fraction");
      }
      while (text[offset] >= "0" && text[offset] <= "9") offset++;
    }
    if (text[offset] === "e" || text[offset] === "E") {
      offset++;
      if (text[offset] === "+" || text[offset] === "-") offset++;
      if (!(text[offset] >= "0" && text[offset] <= "9")) {
        syntax("contains an invalid exponent");
      }
      while (text[offset] >= "0" && text[offset] <= "9") offset++;
    }
    const value = Number(text.slice(start, offset));
    if (!Number.isFinite(value)) syntax("contains a non-finite number");
  }

  function parseValue(depth) {
    if (depth > BOUNDS.maxJsonDepth) {
      fail(
        "RAW_JSON_DEPTH_BOUND_EXCEEDED",
        `${label} exceeds the JSON depth bound`,
      );
    }
    token();
    skipWhitespace();
    const current = text[offset];
    if (current === "{") {
      parseObject(depth + 1);
      return;
    }
    if (current === "[") {
      parseArray(depth + 1);
      return;
    }
    if (current === '"') {
      parseString();
      return;
    }
    if (current === "-" || (current >= "0" && current <= "9")) {
      parseNumber();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    syntax("contains an invalid value");
  }

  function parseObject(depth) {
    offset++;
    skipWhitespace();
    const keys = new Set();
    if (text[offset] === "}") {
      offset++;
      return;
    }
    while (offset < text.length) {
      token();
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) {
        fail("RAW_JSON_DUPLICATE_KEY", `${label} contains duplicate key`, {
          key,
        });
      }
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        fail(
          "RAW_JSON_PROTOTYPE_KEY",
          `${label} contains a prototype-polluting key`,
          { key },
        );
      }
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ":") syntax("contains an object key without ':'");
      offset++;
      parseValue(depth);
      skipWhitespace();
      if (text[offset] === "}") {
        offset++;
        return;
      }
      if (text[offset] !== ",") syntax("contains an invalid object separator");
      offset++;
      skipWhitespace();
      if (text[offset] === "}") syntax("contains a trailing object comma");
    }
    syntax("contains an unterminated object");
  }

  function parseArray(depth) {
    offset++;
    skipWhitespace();
    if (text[offset] === "]") {
      offset++;
      return;
    }
    while (offset < text.length) {
      if (text[offset] === ",") syntax("contains a sparse array");
      parseValue(depth);
      skipWhitespace();
      if (text[offset] === "]") {
        offset++;
        return;
      }
      if (text[offset] !== ",") syntax("contains an invalid array separator");
      offset++;
      skipWhitespace();
      if (text[offset] === "]") syntax("contains a trailing array comma");
    }
    syntax("contains an unterminated array");
  }

  skipWhitespace();
  parseValue(0);
  skipWhitespace();
  if (offset !== text.length) syntax("contains trailing data");
}

function parseRawCoverage(bytes, label) {
  const text = decodeUtf8(bytes, "RAW_UTF8_INVALID", label);
  assertStrictJson(text, label);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("RAW_JSON_INVALID", `${label} is not valid JSON`);
  }
  if (JSON.stringify(raw) !== text) {
    fail(
      "RAW_JSON_NON_CANONICAL",
      `${label} must use canonical JSON.stringify serialization`,
    );
  }
  if (
    raw &&
    typeof raw === "object" &&
    Object.prototype.hasOwnProperty.call(raw, "source-map-cache")
  ) {
    fail(
      "SOURCE_MAP_UNSUPPORTED",
      `${label} contains unsupported source-map coverage`,
    );
  }
  assertExactKeys(
    raw,
    ["result", "timestamp"],
    "RAW_ROOT_SCHEMA_INVALID",
    label,
  );
  if (!Array.isArray(raw.result)) {
    fail("RAW_RESULT_INVALID", `${label}.result must be an array`);
  }
  if (
    typeof raw.timestamp !== "number" ||
    !Number.isFinite(raw.timestamp) ||
    raw.timestamp < 0
  ) {
    fail("RAW_TIMESTAMP_INVALID", `${label}.timestamp must be finite and >= 0`);
  }
  if (raw.result.length > BOUNDS.maxScriptsPerRawFile) {
    fail("RAW_SCRIPT_COUNT_BOUND_EXCEEDED", `${label} has too many scripts`);
  }

  let rangeCount = 0;
  raw.result.forEach((script, scriptIndex) => {
    const scriptLabel = `${label}.result[${scriptIndex}]`;
    validateScript(script, scriptLabel);
    const functionIdentities = new Set();
    script.functions.forEach((fn, functionIndex) => {
      validateFunction(fn, `${scriptLabel}.functions[${functionIndex}]`);
      const identity = functionKey(fn);
      if (functionIdentities.has(identity)) {
        fail(
          "RAW_FUNCTION_DUPLICATE",
          `${scriptLabel} contains a duplicate function identity`,
        );
      }
      functionIdentities.add(identity);
      rangeCount = safeAdd(
        rangeCount,
        fn.ranges.length,
        "RAW_RANGE_COUNT_BOUND_EXCEEDED",
        `${label} range count`,
      );
      if (rangeCount > BOUNDS.maxRangesPerRawFile) {
        fail(
          "RAW_RANGE_COUNT_BOUND_EXCEEDED",
          `${label} has too many ranges`,
        );
      }
    });
  });
  return raw;
}

function functionKey(fn) {
  const root = fn.ranges[0];
  return stableJson([
    fn.functionName,
    root.startOffset,
    root.endOffset,
  ]);
}

function observeTargetScript(target, script, label) {
  const sourceLength = target.sourceText.length;
  const globalCandidates = script.functions.filter((fn) => {
    const root = fn.ranges[0];
    return (
      fn.functionName === "" &&
      root.startOffset === 0 &&
      root.endOffset === sourceLength
    );
  });
  if (
    globalCandidates.length !== 1 ||
    script.functions[0] !== globalCandidates[0]
  ) {
    fail(
      "SCRIPT_GLOBAL_FUNCTION_INVALID",
      `${label} must have exactly one index-0 global function spanning the source`,
    );
  }

  let scriptRangeCount = 0;
  const pendingGroups = [];
  const pendingFunctionKeys = new Set();
  for (const [index, fn] of script.functions.entries()) {
    for (const range of fn.ranges) {
      if (range.endOffset > sourceLength) {
        fail(
          "RAW_RANGE_SOURCE_MISMATCH",
          `${label}.functions[${index}] exceeds source UTF-16 length`,
        );
      }
    }
    scriptRangeCount = safeAdd(
      scriptRangeCount,
      fn.ranges.length,
      "TARGET_RANGE_OBSERVATION_BOUND_EXCEEDED",
      "target range observations in one script",
    );
    const key = functionKey(fn);
    const group = target.functionGroups.get(key);
    if (!group) pendingFunctionKeys.add(key);
    const existingIdentities = group
      ? fn.isBlockCoverage
        ? group.blockRangeIdentities
        : group.nonBlockRangeIdentities
      : null;
    let newIdentityCount = 0;
    const identities = fn.ranges.map((range) => {
      const identity = `${range.startOffset}:${range.endOffset}`;
      if (!existingIdentities || !existingIdentities.has(identity)) {
        newIdentityCount = safeAdd(
          newIdentityCount,
          1,
          "TARGET_MERGED_RANGE_IDENTITY_BOUND_EXCEEDED",
          "new merged range identities",
        );
      }
      return identity;
    });
    const prospectiveIdentityCount = safeAdd(
      existingIdentities ? existingIdentities.size : 0,
      newIdentityCount,
      "TARGET_MERGED_RANGE_IDENTITY_BOUND_EXCEEDED",
      "merged range identity count",
    );
    assertUnionCountBound(
      prospectiveIdentityCount,
      BOUNDS.maxMergedRangesPerFunction,
      "TARGET_MERGED_RANGE_IDENTITY_BOUND_EXCEEDED",
      "merged range identity count",
    );
    pendingGroups.push({ fn, index, key, group, identities });
  }

  const prospectiveFunctionIdentityCount = safeAdd(
    target.functionGroups.size,
    pendingFunctionKeys.size,
    "TARGET_FUNCTION_IDENTITY_BOUND_EXCEEDED",
    "target function identity count",
  );
  assertUnionCountBound(
    prospectiveFunctionIdentityCount,
    BOUNDS.maxFunctionsPerTarget,
    "TARGET_FUNCTION_IDENTITY_BOUND_EXCEEDED",
    "target function identity count",
  );
  const nextScriptObservationCount = boundedUnionAdd(
    target.scriptObservationCount,
    1,
    BOUNDS.maxScriptObservationsPerTarget,
    "TARGET_SCRIPT_OBSERVATION_BOUND_EXCEEDED",
    "target script observation count",
  );
  const nextFunctionObservationCount = boundedUnionAdd(
    target.functionObservationCount,
    script.functions.length,
    BOUNDS.maxFunctionObservationsPerTarget,
    "TARGET_FUNCTION_OBSERVATION_BOUND_EXCEEDED",
    "target function observation count",
  );
  const nextRangeObservationCount = boundedUnionAdd(
    target.rangeObservationCount,
    scriptRangeCount,
    BOUNDS.maxRangeObservationsPerTarget,
    "TARGET_RANGE_OBSERVATION_BOUND_EXCEEDED",
    "target range observation count",
  );
  const nextBlockScriptObservationCount = script.functions.some(
    (fn) => fn.isBlockCoverage,
  )
    ? boundedUnionAdd(
        target.blockScriptObservationCount,
        1,
        BOUNDS.maxScriptObservationsPerTarget,
        "TARGET_SCRIPT_OBSERVATION_BOUND_EXCEEDED",
        "block script observation count",
      )
    : target.blockScriptObservationCount;

  target.scriptObservationCount = nextScriptObservationCount;
  target.functionObservationCount = nextFunctionObservationCount;
  target.rangeObservationCount = nextRangeObservationCount;
  target.blockScriptObservationCount = nextBlockScriptObservationCount;
  for (const pending of pendingGroups) {
    const { fn, index, key, identities } = pending;
    let group = pending.group;
    if (!group) {
      const root = fn.ranges[0];
      group = {
        functionName: fn.functionName,
        root: {
          startOffset: root.startOffset,
          endOffset: root.endOffset,
        },
        isScriptGlobal: index === 0,
        blockObservations: [],
        nonBlockObservations: [],
        blockRangeIdentities: new Set(),
        nonBlockRangeIdentities: new Set(),
      };
      target.functionGroups.set(key, group);
    }
    const rangeIdentities = fn.isBlockCoverage
      ? group.blockRangeIdentities
      : group.nonBlockRangeIdentities;
    for (const identity of identities) rangeIdentities.add(identity);
    const ranges = fn.ranges.map((range) => ({ ...range }));
    if (fn.isBlockCoverage) group.blockObservations.push(ranges);
    else group.nonBlockObservations.push(ranges);
  }
}

function strictContains(outer, inner) {
  return (
    outer.startOffset <= inner.startOffset &&
    outer.endOffset >= inner.endOffset &&
    (outer.startOffset < inner.startOffset ||
      outer.endOffset > inner.endOffset)
  );
}

function compareRanges(left, right) {
  return (
    left.startOffset - right.startOffset ||
    right.endOffset - left.endOffset ||
    right.count - left.count
  );
}

function mergeFunctionGroup(group) {
  const isBlockCoverage = group.blockObservations.length > 0;
  const observations = isBlockCoverage
    ? group.blockObservations
    : group.nonBlockObservations;
  const identities = new Map();
  for (const ranges of observations) {
    for (const range of ranges) {
      identities.set(`${range.startOffset}:${range.endOffset}`, {
        startOffset: range.startOffset,
        endOffset: range.endOffset,
      });
    }
  }

  const mergedRanges = [...identities.values()].map((identity) => {
    let count = 0;
    for (const observation of observations) {
      count = safeAdd(
        count,
        effectiveCountForInterval(observation, identity),
        "MERGED_COUNT_OVERFLOW",
        "effective merged range count",
      );
    }
    return { ...identity, count };
  });
  const rootKey = `${group.root.startOffset}:${group.root.endOffset}`;
  const root = mergedRanges.find(
    (range) => `${range.startOffset}:${range.endOffset}` === rootKey,
  );
  const rest = mergedRanges
    .filter((range) => range !== root)
    .sort(compareRanges);
  let uncoveredIntervals = zeroIntervals(observations[0]);
  for (const observation of observations.slice(1)) {
    uncoveredIntervals = intersectIntervals(
      uncoveredIntervals,
      zeroIntervals(observation),
    );
  }
  return {
    functionName: group.functionName,
    isBlockCoverage,
    isScriptGlobal: group.isScriptGlobal,
    root: { ...group.root },
    ranges: [root, ...rest],
    uncoveredIntervals,
  };
}

function effectiveCountForInterval(ranges, interval) {
  let selected;
  let selectedWidth = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    if (
      range.startOffset <= interval.startOffset &&
      range.endOffset >= interval.endOffset
    ) {
      const width = range.endOffset - range.startOffset;
      if (width < selectedWidth) {
        selected = range;
        selectedWidth = width;
      }
    }
  }
  if (!selected) {
    fail(
      "EFFECTIVE_RANGE_MISSING",
      "function observation does not contain an effective parent range",
    );
  }
  return selected.count;
}

function zeroIntervals(ranges) {
  const boundaries = [
    ...new Set(
      ranges.flatMap((range) => [range.startOffset, range.endOffset]),
    ),
  ].sort((left, right) => left - right);
  const intervals = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const interval = {
      startOffset: boundaries[index],
      endOffset: boundaries[index + 1],
    };
    if (
      interval.startOffset < interval.endOffset &&
      effectiveCountForInterval(ranges, interval) === 0
    ) {
      const previous = intervals[intervals.length - 1];
      if (previous && previous.endOffset === interval.startOffset) {
        previous.endOffset = interval.endOffset;
      } else {
        intervals.push(interval);
      }
    }
  }
  return intervals;
}

function intersectIntervals(left, right) {
  const intersections = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const startOffset = Math.max(
      left[leftIndex].startOffset,
      right[rightIndex].startOffset,
    );
    const endOffset = Math.min(
      left[leftIndex].endOffset,
      right[rightIndex].endOffset,
    );
    if (startOffset < endOffset) {
      const previous = intersections[intersections.length - 1];
      if (previous && previous.endOffset === startOffset) {
        previous.endOffset = endOffset;
      } else {
        intersections.push({ startOffset, endOffset });
      }
    }
    if (left[leftIndex].endOffset <= right[rightIndex].endOffset) leftIndex++;
    else rightIndex++;
  }
  return intersections;
}

function compareFunctions(left, right) {
  if (left.isScriptGlobal !== right.isScriptGlobal) {
    return left.isScriptGlobal ? -1 : 1;
  }
  return (
    left.root.startOffset - right.root.startOffset ||
    right.root.endOffset - left.root.endOffset ||
    compareText(left.functionName, right.functionName)
  );
}

function splitSourceLines(sourceText) {
  let offset = 0;
  const sources = sourceText.split(/(?<=\r?\n)/u);
  return sources.map((source, index) => {
    const newline = source.match(/\r?\n$/u)?.[0] || "";
    const startOffset = offset;
    offset += source.length;
    const endOffset = offset - newline.length;
    return {
      line: index + 1,
      startOffset,
      endOffset,
      count: startOffset === endOffset ? 1 : 0,
    };
  });
}

function rangeMapsWholeLine(range, line) {
  return (
    range.endOffset > line.startOffset &&
    range.startOffset <= line.startOffset &&
    range.endOffset >= line.endOffset
  );
}

function calculateMergedFunctionLines(sourceText, functions) {
  const lines = splitSourceLines(sourceText);
  for (const line of lines) line.count = 0;
  for (const fn of functions) {
    for (const range of fn.ranges) {
      for (const line of lines) {
        if (rangeMapsWholeLine(range, line)) {
          line.count = range.count;
        }
      }
    }
    for (const interval of fn.uncoveredIntervals) {
      for (const line of lines) {
        if (rangeMapsWholeLine(interval, line)) {
          line.count = 0;
        }
      }
    }
  }
  return lines;
}

function percentageMetric(covered, total) {
  assertSafeInteger(covered, "METRIC_INVALID", "covered");
  assertSafeInteger(total, "METRIC_INVALID", "total");
  if (covered > total) {
    fail("METRIC_INVALID", "covered cannot exceed total");
  }
  if (total === 0) {
    return {
      covered,
      total,
      percentageDisplay: PERCENTAGE_POLICY.zeroDenominatorDisplay,
    };
  }
  const numerator = BigInt(covered) * 10_000n;
  const denominator = BigInt(total);
  const roundedHundredths = (numerator + denominator / 2n) / denominator;
  const whole = roundedHundredths / 100n;
  const fraction = (roundedHundredths % 100n).toString().padStart(2, "0");
  return {
    covered,
    total,
    percentageDisplay: `${whole}.${fraction}`,
  };
}

function calculateTarget(target) {
  const functions = [...target.functionGroups.values()]
    .map(mergeFunctionGroup)
    .sort(compareFunctions);
  if (
    functions.length === 0 ||
    !functions[0].isScriptGlobal ||
    functions.filter((fn) => fn.isScriptGlobal).length !== 1
  ) {
    fail(
      "SCRIPT_GLOBAL_FUNCTION_INVALID",
      `target ${target.url} lacks one canonical global function`,
    );
  }
  if (target.blockScriptObservationCount === 0) {
    fail(
      "TARGET_PRECISE_COVERAGE_REQUIRED",
      `target ${target.id} has no block-precise coverage observation`,
    );
  }

  const lines = calculateMergedFunctionLines(target.sourceText, functions);

  const blockRanges = functions.flatMap((fn) =>
    fn.isBlockCoverage ? fn.ranges : [],
  );
  const measuredFunctions = functions.filter((fn) => !fn.isScriptGlobal);
  const uncoveredRanges = functions.flatMap((fn) =>
    fn.uncoveredIntervals.map((range) => ({
      functionName: fn.functionName,
      rootStartOffset: fn.root.startOffset,
      rootEndOffset: fn.root.endOffset,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    })),
  );

  return {
    id: target.id,
    url: target.url,
    sourcePath: target.sourcePath,
    sourceSha256: target.sourceSha256,
    sourceByteLength: target.sourceBytes.length,
    sourceUtf16Length: target.sourceText.length,
    sourceLineCount: lines.length,
    scriptObservationCount: target.scriptObservationCount,
    functions,
    uncoveredRanges,
    uncoveredLineNumbers: lines
      .filter((line) => line.count === 0)
      .map((line) => line.line),
    metrics: {
      lines: percentageMetric(
        lines.filter((line) => line.count > 0).length,
        lines.length,
      ),
      branches: percentageMetric(
        blockRanges.filter((range) => range.count > 0).length,
        blockRanges.length,
      ),
      functions: percentageMetric(
        measuredFunctions.filter((fn) => fn.ranges[0].count > 0).length,
        measuredFunctions.length,
      ),
    },
  };
}

function aggregateMetrics(targets) {
  const result = {};
  for (const kind of ["lines", "branches", "functions"]) {
    let covered = 0;
    let total = 0;
    for (const target of targets) {
      covered = safeAdd(
        covered,
        target.metrics[kind].covered,
        "METRIC_OVERFLOW",
        `${kind} covered`,
      );
      total = safeAdd(
        total,
        target.metrics[kind].total,
        "METRIC_OVERFLOW",
        `${kind} total`,
      );
    }
    result[kind] = percentageMetric(covered, total);
  }
  return result;
}

function enumerateRawFiles(rawDirectory) {
  const directory = assertRawDirectory(rawDirectory);
  let descriptor;
  try {
    descriptor = fs.openSync(
      directory.canonical,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    fail("RAW_DIRECTORY_NON_CANONICAL", "rawDirectory cannot be opened safely", {
      cause: error.code || "UNKNOWN",
    });
  }
  const descriptorBefore = fs.fstatSync(descriptor, { bigint: true });
  try {
    if (!sameSnapshot(directory.stat, descriptorBefore)) {
      fail(
        "RAW_DIRECTORY_MUTATED_DURING_READ",
        "rawDirectory changed before enumeration",
      );
    }
    const entries = fs.readdirSync(directory.canonical, {
      withFileTypes: true,
    });
    if (entries.length === 0) {
      fail("RAW_DIRECTORY_EMPTY", "rawDirectory contains no coverage files");
    }
    if (entries.length > BOUNDS.maxRawFiles) {
      fail("RAW_FILE_COUNT_BOUND_EXCEEDED", "raw file count exceeds the bound");
    }

    const names = entries.map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !RAW_FILE_PATTERN.test(entry.name) ||
        entry.name.includes("/") ||
        entry.name.includes("\\") ||
        entry.name === "." ||
        entry.name === ".."
      ) {
        fail(
          "RAW_ENTRY_NOT_REGULAR",
          "rawDirectory contains a non-canonical coverage entry",
          { entry: entry.name },
        );
      }
      return entry.name;
    });
    names.sort(compareText);

    const files = [];
    let totalBytes = 0;
    for (const name of names) {
      const file = secureReadFile(
        path.join(directory.canonical, name),
        rawReadOptions(`raw coverage file ${name}`),
      );
      totalBytes = safeAdd(
        totalBytes,
        file.bytes.length,
        "RAW_TOTAL_SIZE_BOUND_EXCEEDED",
        "raw total bytes",
      );
      if (totalBytes > BOUNDS.maxRawTotalBytes) {
        fail(
          "RAW_TOTAL_SIZE_BOUND_EXCEEDED",
          "raw coverage total exceeds its byte bound",
        );
      }
      files.push(file);
    }

    const descriptorAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(directory.canonical, { bigint: true });
    if (
      !sameSnapshot(descriptorBefore, descriptorAfter) ||
      !sameSnapshot(descriptorAfter, after)
    ) {
      fail(
        "RAW_DIRECTORY_MUTATED_DURING_READ",
        "rawDirectory changed while inputs were read",
      );
    }
    return files;
  } finally {
    fs.closeSync(descriptor);
  }
}

function canonicalSemanticScripts(payload, targetByUrl) {
  return payload.result
    .filter((script) => targetByUrl.has(script.url))
    .map((script) => {
      const functions = script.functions
        .map((fn) => {
          const root = { ...fn.ranges[0] };
          const ranges = [
            root,
            ...fn.ranges
              .slice(1)
              .map((range) => ({ ...range }))
              .sort(compareRanges),
          ];
          return {
            functionName: fn.functionName,
            isBlockCoverage: fn.isBlockCoverage,
            ranges,
          };
        })
        .sort((left, right) => {
          const leftRoot = left.ranges[0];
          const rightRoot = right.ranges[0];
          return (
            leftRoot.startOffset - rightRoot.startOffset ||
            rightRoot.endOffset - leftRoot.endOffset ||
            compareText(left.functionName, right.functionName) ||
            Number(right.isBlockCoverage) - Number(left.isBlockCoverage) ||
            compareText(stableJson(left), stableJson(right))
          );
        });
      return {
        targetId: targetByUrl.get(script.url).id,
        functions,
      };
    })
    .sort(
      (left, right) =>
        compareText(left.targetId, right.targetId) ||
        compareText(stableJson(left), stableJson(right)),
    );
}

function buildSemanticManifest(payloads, targetByUrl) {
  const byHash = new Map();
  for (const payload of payloads) {
    const normalizedScripts = canonicalSemanticScripts(payload, targetByUrl);
    if (normalizedScripts.length === 0) continue;
    const canonicalPayload = stableJson({ result: normalizedScripts });
    const normalizedPayloadSha256 = sha256(canonicalPayload);
    const existing = byHash.get(normalizedPayloadSha256);
    if (existing) {
      existing.multiplicity = safeAdd(
        existing.multiplicity,
        1,
        "MANIFEST_MULTIPLICITY_OVERFLOW",
        "manifest multiplicity",
      );
    } else {
      byHash.set(normalizedPayloadSha256, {
        normalizedPayloadSha256,
        normalizedPayloadBytes: Buffer.byteLength(canonicalPayload),
        multiplicity: 1,
      });
    }
  }
  const entries = [...byHash.values()].sort((left, right) =>
    compareText(left.normalizedPayloadSha256, right.normalizedPayloadSha256),
  );
  const manifest = {
    schema: SEMANTIC_MANIFEST_SCHEMA,
    targetPayloadCount: entries.reduce(
      (total, entry) =>
        safeAdd(
          total,
          entry.multiplicity,
          "MANIFEST_MULTIPLICITY_OVERFLOW",
          "semantic manifest payload count",
        ),
      0,
    ),
    uniquePayloadCount: entries.length,
    entries,
  };
  return {
    ...manifest,
    semanticManifestSha256: sha256(stableJson(manifest)),
  };
}

function buildRawEvidenceManifest(rawFiles) {
  const byHash = new Map();
  for (const file of rawFiles) {
    const rawSha256 = sha256(file.bytes);
    const existing = byHash.get(rawSha256);
    if (existing) {
      existing.multiplicity = safeAdd(
        existing.multiplicity,
        1,
        "MANIFEST_MULTIPLICITY_OVERFLOW",
        "raw evidence multiplicity",
      );
    } else {
      byHash.set(rawSha256, {
        rawSha256,
        rawByteLength: file.bytes.length,
        multiplicity: 1,
      });
    }
  }
  const entries = [...byHash.values()].sort((left, right) =>
    compareText(left.rawSha256, right.rawSha256),
  );
  const manifest = {
    schema: RAW_EVIDENCE_MANIFEST_SCHEMA,
    fileCount: rawFiles.length,
    uniqueRawFileCount: entries.length,
    entries,
  };
  return {
    ...manifest,
    rawEvidenceManifestSha256: sha256(stableJson(manifest)),
  };
}

function semanticCoverageProjection(report) {
  return {
    schema: report.schema,
    reducer: report.reducer,
    bounds: report.bounds,
    percentagePolicy: report.percentagePolicy,
    semanticInputManifest: report.semanticInputManifest,
    targets: report.targets.map((target) => {
      const { sourcePath, url, ...semanticTarget } = target;
      return semanticTarget;
    }),
    totals: report.totals,
  };
}

function reduceCanonicalCoverageUnsafe(input) {
  assertExactKeys(
    input,
    ["rawDirectory", "targets"],
    "REDUCER_INPUT_SCHEMA_INVALID",
    "reducer input",
  );
  const { rawDirectory, targets } = input;
  const validatedTargets = validateTargets(targets);
  const targetByUrl = new Map(
    validatedTargets.map((target) => [target.url, target]),
  );
  const rawFiles = enumerateRawFiles(rawDirectory);
  const payloads = [];
  let scriptObservationCount = 0;
  let targetScriptObservationCount = 0;

  for (const [fileIndex, file] of rawFiles.entries()) {
    const raw = parseRawCoverage(
      file.bytes,
      `raw coverage input[${fileIndex}]`,
    );
    payloads.push(raw);
    for (const [scriptIndex, script] of raw.result.entries()) {
      scriptObservationCount = safeAdd(
        scriptObservationCount,
        1,
        "SCRIPT_OBSERVATION_COUNT_OVERFLOW",
        "script observation count",
      );
      const target = targetByUrl.get(script.url);
      if (!target) continue;
      targetScriptObservationCount = safeAdd(
        targetScriptObservationCount,
        1,
        "SCRIPT_OBSERVATION_COUNT_OVERFLOW",
        "target script observation count",
      );
      observeTargetScript(
        target,
        script,
        `raw coverage input[${fileIndex}].result[${scriptIndex}]`,
      );
    }
  }

  for (const target of validatedTargets) {
    if (target.scriptObservationCount === 0) {
      fail(
        "TARGET_NOT_OBSERVED",
        `target was not observed in raw coverage: ${target.url}`,
      );
    }
  }

  const canonicalTargets = validatedTargets.map(calculateTarget);
  const report = {
    schema: REPORT_SCHEMA,
    reducer: {
      name: REDUCER_NAME,
      version: REDUCER_VERSION,
      algorithm: ALGORITHM,
    },
    bounds: { ...BOUNDS },
    percentagePolicy: { ...PERCENTAGE_POLICY },
    rawEvidenceManifest: buildRawEvidenceManifest(rawFiles),
    semanticInputManifest: buildSemanticManifest(payloads, targetByUrl),
    rawInventory: {
      fileCount: rawFiles.length,
      scriptObservationCount,
      targetScriptObservationCount,
      nonTargetScriptObservationCount:
        scriptObservationCount - targetScriptObservationCount,
    },
    targets: canonicalTargets,
    totals: aggregateMetrics(canonicalTargets),
  };
  const withSemanticHash = {
    ...report,
    semanticCoverageSha256: sha256(
      stableJson(semanticCoverageProjection(report)),
    ),
  };
  const finalReport = {
    ...withSemanticHash,
    evidenceReportSha256: sha256(stableJson(withSemanticHash)),
  };
  validateCanonicalCoverageReportUnsafe(finalReport);
  return finalReport;
}

function asTypedFailure(operation, callback) {
  try {
    return callback();
  } catch (error) {
    if (error instanceof CanonicalCoverageError) throw error;
    throw new CanonicalCoverageError(
      `${operation}_REFUSED`,
      `${operation.toLowerCase().replaceAll("_", " ")} refused an invalid or unstable input`,
      { cause: error && error.code ? error.code : error?.name || "UNKNOWN" },
    );
  }
}

function reduceCanonicalCoverage(input = {}) {
  return asTypedFailure("CANONICAL_COVERAGE_REDUCTION", () =>
    reduceCanonicalCoverageUnsafe(input),
  );
}

function validateMetric(metric, label) {
  assertExactKeys(
    metric,
    ["covered", "percentageDisplay", "total"],
    "REPORT_METRIC_SCHEMA_INVALID",
    label,
  );
  const expected = percentageMetric(metric.covered, metric.total);
  if (stableJson(metric) !== stableJson(expected)) {
    fail("REPORT_METRIC_INCONSISTENT", `${label} is inconsistent`);
  }
}

function validateRawEvidenceManifest(manifest) {
  assertExactKeys(
    manifest,
    [
      "entries",
      "fileCount",
      "rawEvidenceManifestSha256",
      "schema",
      "uniqueRawFileCount",
    ],
    "REPORT_MANIFEST_SCHEMA_INVALID",
    "report.rawEvidenceManifest",
  );
  if (
    manifest.schema !== RAW_EVIDENCE_MANIFEST_SCHEMA ||
    !Array.isArray(manifest.entries)
  ) {
    fail("REPORT_MANIFEST_SCHEMA_INVALID", "raw evidence manifest is invalid");
  }
  assertSafeInteger(
    manifest.fileCount,
    "REPORT_MANIFEST_SCHEMA_INVALID",
    "raw manifest fileCount",
    1,
  );
  assertSafeInteger(
    manifest.uniqueRawFileCount,
    "REPORT_MANIFEST_SCHEMA_INVALID",
    "raw manifest uniqueRawFileCount",
    1,
  );
  if (manifest.fileCount > BOUNDS.maxRawFiles) {
    fail("REPORT_MANIFEST_BOUNDS_INVALID", "raw manifest file count is unbounded");
  }
  let multiplicity = 0;
  let totalBytes = 0;
  let previousHash = "";
  manifest.entries.forEach((entry, index) => {
    assertExactKeys(
      entry,
      ["multiplicity", "rawByteLength", "rawSha256"],
      "REPORT_MANIFEST_SCHEMA_INVALID",
      `rawEvidenceManifest.entries[${index}]`,
    );
    if (
      typeof entry.rawSha256 !== "string" ||
      !SHA256_PATTERN.test(entry.rawSha256) ||
      entry.rawSha256 <= previousHash
    ) {
      fail(
        "REPORT_MANIFEST_SCHEMA_INVALID",
        "raw evidence hashes must be unique and ordered",
      );
    }
    previousHash = entry.rawSha256;
    assertSafeInteger(
      entry.rawByteLength,
      "REPORT_MANIFEST_SCHEMA_INVALID",
      "rawByteLength",
      1,
    );
    assertSafeInteger(
      entry.multiplicity,
      "REPORT_MANIFEST_SCHEMA_INVALID",
      "raw multiplicity",
      1,
    );
    if (entry.rawByteLength > BOUNDS.maxRawFileBytes) {
      fail("REPORT_MANIFEST_BOUNDS_INVALID", "raw evidence file is unbounded");
    }
    multiplicity = safeAdd(
      multiplicity,
      entry.multiplicity,
      "REPORT_MANIFEST_SCHEMA_INVALID",
      "raw evidence multiplicity",
    );
    totalBytes = safeAdd(
      totalBytes,
      safeMultiply(
        entry.rawByteLength,
        entry.multiplicity,
        "REPORT_MANIFEST_SCHEMA_INVALID",
        "raw evidence bytes",
      ),
      "REPORT_MANIFEST_SCHEMA_INVALID",
      "raw evidence total bytes",
    );
  });
  if (
    multiplicity !== manifest.fileCount ||
    manifest.entries.length !== manifest.uniqueRawFileCount ||
    totalBytes > BOUNDS.maxRawTotalBytes
  ) {
    fail("REPORT_MANIFEST_INCONSISTENT", "raw evidence manifest is inconsistent");
  }
  const withoutHash = { ...manifest };
  delete withoutHash.rawEvidenceManifestSha256;
  if (
    manifest.rawEvidenceManifestSha256 !== sha256(stableJson(withoutHash))
  ) {
    fail("REPORT_MANIFEST_HASH_INVALID", "raw evidence manifest hash is invalid");
  }
}

function validateSemanticManifest(manifest) {
  assertExactKeys(
    manifest,
    [
      "entries",
      "schema",
      "semanticManifestSha256",
      "targetPayloadCount",
      "uniquePayloadCount",
    ],
    "REPORT_MANIFEST_SCHEMA_INVALID",
    "report.semanticInputManifest",
  );
  if (
    manifest.schema !== SEMANTIC_MANIFEST_SCHEMA ||
    !Array.isArray(manifest.entries)
  ) {
    fail("REPORT_MANIFEST_SCHEMA_INVALID", "semantic manifest is invalid");
  }
  assertSafeInteger(
    manifest.targetPayloadCount,
    "REPORT_MANIFEST_SCHEMA_INVALID",
    "semantic targetPayloadCount",
    1,
  );
  assertSafeInteger(
    manifest.uniquePayloadCount,
    "REPORT_MANIFEST_SCHEMA_INVALID",
    "semantic uniquePayloadCount",
    1,
  );
  let multiplicity = 0;
  let previousHash = "";
  manifest.entries.forEach((entry, index) => {
    assertExactKeys(
      entry,
      [
        "multiplicity",
        "normalizedPayloadBytes",
        "normalizedPayloadSha256",
      ],
      "REPORT_MANIFEST_SCHEMA_INVALID",
      `semanticInputManifest.entries[${index}]`,
    );
    if (
      typeof entry.normalizedPayloadSha256 !== "string" ||
      !SHA256_PATTERN.test(entry.normalizedPayloadSha256) ||
      entry.normalizedPayloadSha256 <= previousHash
    ) {
      fail(
        "REPORT_MANIFEST_SCHEMA_INVALID",
        "semantic manifest hashes must be unique and ordered",
      );
    }
    previousHash = entry.normalizedPayloadSha256;
    assertSafeInteger(
      entry.normalizedPayloadBytes,
      "REPORT_MANIFEST_SCHEMA_INVALID",
      "normalizedPayloadBytes",
      1,
    );
    assertSafeInteger(
      entry.multiplicity,
      "REPORT_MANIFEST_SCHEMA_INVALID",
      "semantic multiplicity",
      1,
    );
    multiplicity = safeAdd(
      multiplicity,
      entry.multiplicity,
      "REPORT_MANIFEST_SCHEMA_INVALID",
      "semantic manifest multiplicity",
    );
  });
  if (
    multiplicity !== manifest.targetPayloadCount ||
    manifest.entries.length !== manifest.uniquePayloadCount
  ) {
    fail("REPORT_MANIFEST_INCONSISTENT", "semantic manifest is inconsistent");
  }
  const withoutHash = { ...manifest };
  delete withoutHash.semanticManifestSha256;
  if (manifest.semanticManifestSha256 !== sha256(stableJson(withoutHash))) {
    fail("REPORT_MANIFEST_HASH_INVALID", "semantic manifest hash is invalid");
  }
}

function validateReportSourceBinding(target, label) {
  const source = secureReadFile(
    target.sourcePath,
    reportSourceReadOptions(`${label}.sourcePath`),
  );
  const sourceText = decodeUtf8(
    source.bytes,
    "REPORT_SOURCE_UTF8_INVALID",
    `${label}.sourcePath`,
  );
  if (IGNORE_DIRECTIVE_PATTERN.test(sourceText)) {
    fail(
      "REPORT_SOURCE_IGNORE_DIRECTIVE_UNSUPPORTED",
      `${label}.sourcePath contains a coverage ignore/status directive`,
    );
  }
  if (SOURCE_MAP_PATTERN.test(sourceText)) {
    fail(
      "REPORT_SOURCE_MAP_UNSUPPORTED",
      `${label}.sourcePath contains a source-map directive`,
    );
  }
  const expected = {
    sourcePath: source.canonical,
    url: pathToFileURL(source.canonical).href,
    sourceSha256: sha256(source.bytes),
    sourceByteLength: source.bytes.length,
    sourceUtf16Length: sourceText.length,
    sourceLineCount: splitSourceLines(sourceText).length,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (target[field] !== value) {
      fail(
        "REPORT_SOURCE_BINDING_INVALID",
        `${label}.${field} does not match the stable source bytes`,
        { expected: value, observed: target[field] },
      );
    }
  }
  return sourceText;
}

function validateCanonicalCoverageReportUnsafe(report) {
  assertExactKeys(
    report,
    [
      "bounds",
      "evidenceReportSha256",
      "percentagePolicy",
      "rawEvidenceManifest",
      "rawInventory",
      "reducer",
      "schema",
      "semanticCoverageSha256",
      "semanticInputManifest",
      "targets",
      "totals",
    ],
    "REPORT_SCHEMA_INVALID",
    "report",
  );
  if (report.schema !== REPORT_SCHEMA) {
    fail("REPORT_VERSION_UNSUPPORTED", "report schema is unsupported");
  }
  if (
    stableJson(report.reducer) !==
      stableJson({
        name: REDUCER_NAME,
        version: REDUCER_VERSION,
        algorithm: ALGORITHM,
      }) ||
    stableJson(report.bounds) !== stableJson(BOUNDS) ||
    stableJson(report.percentagePolicy) !== stableJson(PERCENTAGE_POLICY)
  ) {
    fail(
      "REPORT_ALGORITHM_INCONSISTENT",
      "report reducer, bounds, or percentage policy is inconsistent",
    );
  }
  validateRawEvidenceManifest(report.rawEvidenceManifest);
  validateSemanticManifest(report.semanticInputManifest);

  if (
    !Array.isArray(report.targets) ||
    report.targets.length === 0 ||
    report.targets.length > BOUNDS.maxTargets
  ) {
    fail("REPORT_TARGETS_INVALID", "report targets violate their bound");
  }
  let previousId = "";
  let targetObservationTotal = 0;
  const seenSourcePaths = new Set();
  for (const [targetIndex, target] of report.targets.entries()) {
    const targetLabel = `report.targets[${targetIndex}]`;
    assertExactKeys(
      target,
      [
        "functions",
        "id",
        "metrics",
        "scriptObservationCount",
        "sourceByteLength",
        "sourceLineCount",
        "sourcePath",
        "sourceSha256",
        "sourceUtf16Length",
        "uncoveredLineNumbers",
        "uncoveredRanges",
        "url",
      ],
      "REPORT_TARGET_SCHEMA_INVALID",
      targetLabel,
    );
    if (
      typeof target.id !== "string" ||
      !LOGICAL_TARGET_ID_PATTERN.test(target.id) ||
      target.id <= previousId ||
      typeof target.sourcePath !== "string" ||
      typeof target.url !== "string" ||
      typeof target.sourceSha256 !== "string" ||
      !SHA256_PATTERN.test(target.sourceSha256)
    ) {
      fail(
        "REPORT_TARGET_SCHEMA_INVALID",
        "report targets must be logically ordered and source-bound",
      );
    }
    previousId = target.id;
    for (const field of [
      "sourceByteLength",
      "sourceUtf16Length",
      "sourceLineCount",
      "scriptObservationCount",
    ]) {
      assertSafeInteger(
        target[field],
        "REPORT_TARGET_SCHEMA_INVALID",
        `target.${field}`,
        1,
      );
    }
    if (target.sourceByteLength > BOUNDS.maxSourceBytes) {
      fail("REPORT_TARGET_BOUNDS_INVALID", "target source exceeds its bound");
    }
    const sourceText = validateReportSourceBinding(target, targetLabel);
    if (seenSourcePaths.has(target.sourcePath)) {
      fail(
        "REPORT_TARGET_SCHEMA_INVALID",
        "report target source paths must be unique",
      );
    }
    seenSourcePaths.add(target.sourcePath);
    targetObservationTotal = safeAdd(
      targetObservationTotal,
      target.scriptObservationCount,
      "REPORT_INVENTORY_INCONSISTENT",
      "target script observations",
    );
    assertUnionCountBound(
      target.scriptObservationCount,
      BOUNDS.maxScriptObservationsPerTarget,
      "REPORT_TARGET_OBSERVATION_BOUND_EXCEEDED",
      "report target script observation count",
    );
    if (
      !Array.isArray(target.functions) ||
      target.functions.length === 0 ||
      !target.functions[0].isScriptGlobal ||
      target.functions.filter((fn) => fn.isScriptGlobal).length !== 1 ||
      !target.functions.some((fn) => fn.isBlockCoverage)
    ) {
      fail("REPORT_FUNCTION_SCHEMA_INVALID", "target functions are invalid");
    }
    assertUnionCountBound(
      target.functions.length,
      BOUNDS.maxFunctionsPerTarget,
      "REPORT_TARGET_FUNCTION_BOUND_EXCEEDED",
      "report target function identity count",
    );
    let priorFunction = null;
    for (const [functionIndex, fn] of target.functions.entries()) {
      assertExactKeys(
        fn,
        [
          "functionName",
          "isBlockCoverage",
          "isScriptGlobal",
          "ranges",
          "root",
          "uncoveredIntervals",
        ],
        "REPORT_FUNCTION_SCHEMA_INVALID",
        `target.functions[${functionIndex}]`,
      );
      if (
        typeof fn.functionName !== "string" ||
        !isWellFormedString(fn.functionName) ||
        typeof fn.isBlockCoverage !== "boolean" ||
        typeof fn.isScriptGlobal !== "boolean" ||
        !Array.isArray(fn.ranges) ||
        fn.ranges.length === 0 ||
        (!fn.isBlockCoverage && fn.ranges.length !== 1) ||
        !Array.isArray(fn.uncoveredIntervals)
      ) {
        fail("REPORT_FUNCTION_SCHEMA_INVALID", "function fields are invalid");
      }
      assertUnionCountBound(
        fn.ranges.length,
        BOUNDS.maxMergedRangesPerFunction,
        "REPORT_FUNCTION_RANGE_BOUND_EXCEEDED",
        "report merged function range identity count",
      );
      assertExactKeys(
        fn.root,
        ["endOffset", "startOffset"],
        "REPORT_FUNCTION_SCHEMA_INVALID",
        "function.root",
      );
      if (
        fn.ranges[0].startOffset !== fn.root.startOffset ||
        fn.ranges[0].endOffset !== fn.root.endOffset ||
        fn.root.startOffset < 0 ||
        fn.root.endOffset > target.sourceUtf16Length ||
        (fn.isScriptGlobal &&
          (fn.root.startOffset !== 0 ||
            fn.root.endOffset !== target.sourceUtf16Length))
      ) {
        fail("REPORT_FUNCTION_ROOT_INVALID", "function root is invalid");
      }
      if (priorFunction && compareFunctions(priorFunction, fn) >= 0) {
        fail(
          "REPORT_FUNCTION_ORDER_INVALID",
          "functions are not canonically ordered",
        );
      }
      priorFunction = fn;
      let priorRange = null;
      fn.ranges.forEach((range, rangeIndex) => {
        validateRange(range, `report range[${rangeIndex}]`);
        if (
          range.startOffset < fn.root.startOffset ||
          range.endOffset > fn.root.endOffset
        ) {
          fail("REPORT_RANGE_SOURCE_INVALID", "range exceeds its function root");
        }
        if (
          rangeIndex > 0 &&
          priorRange &&
          compareRanges(priorRange, range) >= 0
        ) {
          fail("REPORT_RANGE_ORDER_INVALID", "ranges are not canonically ordered");
        }
        priorRange = range;
      });
      let previousInterval;
      fn.uncoveredIntervals.forEach((interval, intervalIndex) => {
        assertExactKeys(
          interval,
          ["endOffset", "startOffset"],
          "REPORT_UNCOVERED_RANGES_INCONSISTENT",
          `uncoveredIntervals[${intervalIndex}]`,
        );
        assertSafeInteger(
          interval.startOffset,
          "REPORT_UNCOVERED_RANGES_INCONSISTENT",
          "uncovered interval start",
        );
        assertSafeInteger(
          interval.endOffset,
          "REPORT_UNCOVERED_RANGES_INCONSISTENT",
          "uncovered interval end",
          1,
        );
        if (
          interval.startOffset >= interval.endOffset ||
          interval.startOffset < fn.root.startOffset ||
          interval.endOffset > fn.root.endOffset ||
          (previousInterval &&
            previousInterval.endOffset >= interval.startOffset)
        ) {
          fail(
            "REPORT_UNCOVERED_RANGES_INCONSISTENT",
            "uncovered intervals are not canonical disjoint intersections",
          );
        }
        previousInterval = interval;
      });
    }

    assertExactKeys(
      target.metrics,
      ["branches", "functions", "lines"],
      "REPORT_METRIC_SCHEMA_INVALID",
      "target.metrics",
    );
    for (const kind of ["lines", "branches", "functions"]) {
      validateMetric(target.metrics[kind], `target.metrics.${kind}`);
    }
    const branchRanges = target.functions.flatMap((fn) =>
      fn.isBlockCoverage ? fn.ranges : [],
    );
    const measuredFunctions = target.functions.filter(
      (fn) => !fn.isScriptGlobal,
    );
    const expectedLines = calculateMergedFunctionLines(
      sourceText,
      target.functions,
    );
    const expectedUncoveredLineNumbers = expectedLines
      .filter((line) => line.count === 0)
      .map((line) => line.line);
    if (
      target.metrics.lines.total !== target.sourceLineCount ||
      target.metrics.lines.covered !==
        expectedLines.filter((line) => line.count > 0).length ||
      target.metrics.branches.total !== branchRanges.length ||
      target.metrics.branches.covered !==
        branchRanges.filter((range) => range.count > 0).length ||
      target.metrics.functions.total !== measuredFunctions.length ||
      target.metrics.functions.covered !==
        measuredFunctions.filter((fn) => fn.ranges[0].count > 0).length
    ) {
      fail("REPORT_METRIC_INCONSISTENT", "target metrics are inconsistent");
    }
    const expectedUncoveredRanges = target.functions.flatMap((fn) =>
      fn.uncoveredIntervals.map((interval) => ({
        functionName: fn.functionName,
        rootStartOffset: fn.root.startOffset,
        rootEndOffset: fn.root.endOffset,
        startOffset: interval.startOffset,
        endOffset: interval.endOffset,
      })),
    );
    if (
      !Array.isArray(target.uncoveredRanges) ||
      stableJson(target.uncoveredRanges) !== stableJson(expectedUncoveredRanges)
    ) {
      fail(
        "REPORT_UNCOVERED_RANGES_INCONSISTENT",
        "target uncovered ranges are inconsistent",
      );
    }
    if (!Array.isArray(target.uncoveredLineNumbers)) {
      fail(
        "REPORT_UNCOVERED_LINES_INVALID",
        "target uncovered line numbers must be an array",
      );
    }
    let previousLine = 0;
    for (const line of target.uncoveredLineNumbers) {
      assertSafeInteger(
        line,
        "REPORT_UNCOVERED_LINES_INVALID",
        "uncovered line number",
        1,
      );
      if (line <= previousLine || line > target.sourceLineCount) {
        fail(
          "REPORT_UNCOVERED_LINES_INVALID",
          "uncovered line numbers must be unique and ordered",
        );
      }
      previousLine = line;
    }
    if (
      stableJson(target.uncoveredLineNumbers) !==
      stableJson(expectedUncoveredLineNumbers)
    ) {
      fail(
        "REPORT_UNCOVERED_LINES_INCONSISTENT",
        "target uncovered line identities do not match merged function coverage",
      );
    }
    if (
      safeAdd(
        target.metrics.lines.covered,
        target.uncoveredLineNumbers.length,
        "REPORT_METRIC_INCONSISTENT",
        "line reconciliation",
      ) !== target.metrics.lines.total
    ) {
      fail(
        "REPORT_METRIC_INCONSISTENT",
        "line counts do not reconcile with uncovered line identities",
      );
    }
  }

  assertExactKeys(
    report.rawInventory,
    [
      "fileCount",
      "nonTargetScriptObservationCount",
      "scriptObservationCount",
      "targetScriptObservationCount",
    ],
    "REPORT_INVENTORY_SCHEMA_INVALID",
    "report.rawInventory",
  );
  for (const field of [
    "fileCount",
    "nonTargetScriptObservationCount",
    "scriptObservationCount",
    "targetScriptObservationCount",
  ]) {
    assertSafeInteger(
      report.rawInventory[field],
      "REPORT_INVENTORY_SCHEMA_INVALID",
      `rawInventory.${field}`,
    );
  }
  if (
    report.rawInventory.fileCount !== report.rawEvidenceManifest.fileCount ||
    targetObservationTotal !== report.rawInventory.targetScriptObservationCount ||
    safeAdd(
      report.rawInventory.targetScriptObservationCount,
      report.rawInventory.nonTargetScriptObservationCount,
      "REPORT_INVENTORY_INCONSISTENT",
      "raw inventory observation count",
    ) !== report.rawInventory.scriptObservationCount
  ) {
    fail("REPORT_INVENTORY_INCONSISTENT", "raw inventory is inconsistent");
  }

  assertExactKeys(
    report.totals,
    ["branches", "functions", "lines"],
    "REPORT_METRIC_SCHEMA_INVALID",
    "report.totals",
  );
  const expectedTotals = aggregateMetrics(report.targets);
  if (stableJson(report.totals) !== stableJson(expectedTotals)) {
    fail("REPORT_METRIC_INCONSISTENT", "aggregate metrics are inconsistent");
  }
  if (
    typeof report.semanticCoverageSha256 !== "string" ||
    !SHA256_PATTERN.test(report.semanticCoverageSha256) ||
    report.semanticCoverageSha256 !==
      sha256(stableJson(semanticCoverageProjection(report)))
  ) {
    fail("REPORT_SEMANTIC_HASH_INVALID", "semantic coverage hash is invalid");
  }
  if (
    typeof report.evidenceReportSha256 !== "string" ||
    !SHA256_PATTERN.test(report.evidenceReportSha256)
  ) {
    fail("REPORT_EVIDENCE_HASH_INVALID", "evidence report hash is malformed");
  }
  const withoutEvidenceHash = { ...report };
  delete withoutEvidenceHash.evidenceReportSha256;
  if (
    report.evidenceReportSha256 !==
    sha256(stableJson(withoutEvidenceHash))
  ) {
    fail("REPORT_EVIDENCE_HASH_INVALID", "evidence report hash is invalid");
  }
  return report;
}

function validateCanonicalCoverageReport(report) {
  return asTypedFailure("CANONICAL_COVERAGE_REPORT_VALIDATION", () =>
    validateCanonicalCoverageReportUnsafe(report),
  );
}

function verifyCanonicalCoverageEvidence(input = {}) {
  return asTypedFailure("CANONICAL_COVERAGE_EVIDENCE_VERIFICATION", () => {
    assertExactKeys(
      input,
      ["rawDirectory", "report", "targets"],
      "EVIDENCE_INPUT_SCHEMA_INVALID",
      "evidence input",
    );
    validateCanonicalCoverageReportUnsafe(input.report);
    const reproduced = reduceCanonicalCoverageUnsafe({
      rawDirectory: input.rawDirectory,
      targets: input.targets,
    });
    if (stableJson(reproduced) !== stableJson(input.report)) {
      fail(
        "EVIDENCE_REPRODUCTION_MISMATCH",
        "raw/source evidence does not reproduce the canonical report",
        {
          expectedEvidenceReportSha256: input.report.evidenceReportSha256,
          observedEvidenceReportSha256: reproduced.evidenceReportSha256,
        },
      );
    }
    return input.report;
  });
}

module.exports = {
  ALGORITHM,
  BOUNDS,
  CanonicalCoverageError,
  PERCENTAGE_POLICY,
  RAW_EVIDENCE_MANIFEST_SCHEMA,
  REDUCER_NAME,
  REDUCER_VERSION,
  REPORT_SCHEMA,
  SEMANTIC_MANIFEST_SCHEMA,
  reduceCanonicalCoverage,
  validateCanonicalCoverageReport,
  verifyCanonicalCoverageEvidence,
};
