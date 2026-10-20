"use strict";
// Real model, initially empty folder; only the disposable project's Node test command is approved.
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { Workspace } = require("../src/core/workspace.cjs");
const { createProject } = require("../src/core/projects.cjs");
const { Settings } = require("../src/core/settings.cjs");
const { ModelProvider } = require("../src/core/provider.cjs");
const { SkillRegistry } = require("../src/core/skills.cjs");
const { RunStore } = require("../src/core/store.cjs");
const { Harness } = require("../src/core/harness.cjs");

async function main() {
  const root = path.resolve(__dirname, "..");
  const data = path.join(root, ".test-output", "creation");
  const settings = new Settings(path.join(data, "settings"), {
    isEncryptionAvailable: () => false,
  });
  await settings.load({ envFile: path.join(root, ".env") });
  const config = settings.config();
  const folder = await createProject(data, "temperature-cli");
  const initialFiles = await fs.readdir(folder);
  assert.equal(initialFiles.length, 0);
  const skills = new SkillRegistry();
  await skills.loadBuiltins(path.join(root, "skills"));
  const store = new RunStore(path.join(data, "runs"), {
    secrets: [config.apiKey],
  });
  const h = new Harness({
    workspace: await Workspace.open(folder),
    provider: new ModelProvider(config),
    skills,
    store,
    secrets: [config.apiKey],
    connection: {
      providerId: config.providerId,
      providerName: config.providerName,
      model: config.model,
    },
    maxIterations: 28,
  });
  const seen = new Set();
  h.on("state", (s) => {
    const event = s.events.at(-1);
    if (event?.type === "tool_start" || event?.type === "status")
      console.log(s.status, event.message);
    if (!s.approval || seen.has(s.approval.nonce)) return;
    seen.add(s.approval.nonce);
    const c = s.approval.command;
    const allowed =
      s.approval.cwd === folder &&
      c.program === "node" &&
      c.cwd === "." &&
      JSON.stringify(c.args) === '["--test"]';
    console.log("TEST DRIVER:", allowed, c.program, JSON.stringify(c.args));
    void h.decide(s.id, s.approval.nonce, allowed, { actor: "test-driver" });
  });
  await h.makePlan(
    "از این پوشهٔ کاملاً خالی یک ابزار خط فرمان تبدیل دما با Node.js بساز. بدون پکیج خارجی. فایل temperature.cjs تابع convert(value, from, to) را برای واحدهای C، F و K صادر کند، ورودی نامعتبر و دمای زیر صفر مطلق را رد کند. فایل cli.cjs با node cli.cjs 25 C F مقدار عددی تبدیل‌شده را چاپ کند؛ در خطا exit غیرصفر بدهد. تست‌های واقعی با node --test و README فارسی برای اجرا بساز. خودت تمام فایل‌ها را بنویس و تست کن.",
  );
  assert.equal(h.state.status, "awaiting_plan");
  const plan = {
    ...h.state.plan,
    verification: {
      program: "node",
      args: ["--test"],
      cwd: ".",
      timeoutMs: 20000,
    },
  };
  await h.approvePlan(plan, { actor: "test-driver" });
  await h.job;
  const report = h.snapshot();
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(
    path.join(data, "evidence.json"),
    JSON.stringify(report, null, 2),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.verification?.ok, true);
  const { convert } = require(path.join(folder, "temperature.cjs"));
  assert.equal(convert(25, "C", "F"), 77);
  assert(Math.abs(convert(32, "F", "C")) < 1e-8);
  assert(Math.abs(convert(0, "C", "K") - 273.15) < 1e-8);
  assert.throws(() => convert(-274, "C", "F"));
  assert.throws(() => convert(10, "bad", "C"));
  const cli = execFileSync(
    process.execPath,
    [path.join(folder, "cli.cjs"), "25", "C", "F"],
    { cwd: folder, encoding: "utf8" },
  );
  assert.equal(Number(cli.trim()), 77);
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [path.join(folder, "cli.cjs"), "bad", "C", "F"],
      { cwd: folder, stdio: "pipe" },
    ),
  );
  const summary = {
    provider: config.providerName,
    model: config.model,
    initialFileCount: initialFiles.length,
    status: report.status,
    iterations: report.iterations,
    corrections: report.corrections,
    exitCode: report.verification.exitCode,
    independentChecks: 7,
    filesCreated: report.changes.map((c) => c.path),
  };
  await fs.writeFile(
    path.join(data, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
