"use strict";
const crypto = require("node:crypto");

class HarnessError extends Error {
  constructor(message, code = "HARNESS_ERROR") {
    super(message);
    this.name = "HarnessError";
    this.code = code;
  }
}
const assert = (condition, message, code = "INVALID_INPUT") => {
  if (!condition) throw new HarnessError(message, code);
};
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const id = () => crypto.randomUUID();
function object(value, label = "داده") {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} باید یک شیء باشد.`,
  );
  return value;
}
function text(value, max = 1000, label = "متن") {
  assert(
    typeof value === "string" && value.length <= max && !value.includes("\0"),
    `${label} معتبر نیست یا بیش از حد طولانی است.`,
  );
  return value;
}
function keys(value, allowed) {
  object(value);
  assert(
    Object.keys(value).every((key) => allowed.includes(key)),
    "فیلد ناشناخته در درخواست.",
  );
  return value;
}
function command(value) {
  keys(value, ["program", "args", "cwd", "timeoutMs"]);
  const program = text(value.program, 90, "برنامه");
  assert(
    /^[a-zA-Z0-9_.-]+$/.test(program) && !program.startsWith("."),
    "نام برنامه باید ساده باشد؛ پوسته و مسیر دلخواه پذیرفته نمی‌شوند.",
  );
  assert(
    Array.isArray(value.args) && value.args.length <= 80,
    "آرگومان‌ها باید آرایه باشند.",
  );
  const args = value.args.map((a) => text(a, 3000, "آرگومان"));
  const cwd = text(value.cwd ?? ".", 300, "مسیر فرمان");
  const timeoutMs = value.timeoutMs ?? 60000;
  assert(
    Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 180000,
    "مهلت فرمان بین ۱ تا ۱۸۰ ثانیه است.",
  );
  return { program, args, cwd, timeoutMs };
}
function plan(value) {
  keys(value, ["title", "summary", "steps", "acceptance", "verification"]);
  const title = text(value.title, 120),
    summary = text(value.summary, 1400);
  assert(
    Array.isArray(value.steps) &&
      value.steps.length >= 2 &&
      value.steps.length <= 8,
    "پلن باید ۲ تا ۸ مرحله داشته باشد.",
  );
  assert(
    Array.isArray(value.acceptance) &&
      value.acceptance.length >= 1 &&
      value.acceptance.length <= 6,
    "معیار قبولی لازم است.",
  );
  return {
    title,
    summary,
    steps: value.steps.map((s) => text(s, 240)),
    acceptance: value.acceptance.map((s) => text(s, 300)),
    verification: command(value.verification),
  };
}
const toolNames = [
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "run_command",
  "run_skill",
  "launch_app",
  "preview_file",
  "app_status",
  "verify",
];
function action(value, steps) {
  object(value);
  if (value.type === "finish") {
    keys(value, ["type", "summary"]);
    return { type: "finish", summary: text(value.summary, 2400) };
  }
  keys(value, ["type", "step", "tool", "args", "message"]);
  assert(
    value.type === "tool" && toolNames.includes(value.tool),
    "نوع عملیات یا ابزار معتبر نیست.",
  );
  assert(
    Number.isInteger(value.step) && value.step >= 0 && value.step < steps,
    "مرحلهٔ عملیات معتبر نیست.",
  );
  object(value.args, "آرگومان ابزار");
  assert(
    JSON.stringify(value.args).length <= 220000,
    "آرگومان ابزار بیش از حد بزرگ است.",
  );
  return {
    type: "tool",
    step: value.step,
    tool: value.tool,
    args: value.args,
    message: text(value.message ?? "", 500),
  };
}
function parseJSON(content) {
  text(content, 240000, "پاسخ مدل");
  const clean = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    throw new HarnessError("مدل JSON معتبر برنگرداند.", "MODEL_FORMAT");
  }
}
function redact(value, secrets = []) {
  let result = String(value);
  for (const secret of secrets)
    if (secret && secret.length >= 8)
      result = result.split(secret).join("[REDACTED]");
  return result
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{20,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)([^\s"',;]{12,})/gi,
      "$1[REDACTED]",
    );
}
function stripANSI(value) {
  return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
function redactValue(value, secrets = []) {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactValue(v, secrets)]),
    );
  return value;
}
module.exports = {
  HarnessError,
  assert,
  hash,
  id,
  object,
  text,
  keys,
  command,
  plan,
  action,
  parseJSON,
  redact,
  redactValue,
  stripANSI,
  toolNames,
};
