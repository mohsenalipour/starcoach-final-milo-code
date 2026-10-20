"use strict";
// Explicit test driver: only this disposable fixture's Node tests are approved.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { Workspace } = require("../src/core/workspace.cjs"),
  { SkillRegistry } = require("../src/core/skills.cjs"),
  { RunStore } = require("../src/core/store.cjs"),
  { Harness } = require("../src/core/harness.cjs"),
  { ModelProvider } = require("../src/core/provider.cjs"),
  { Settings } = require("../src/core/settings.cjs"),
  { createDemo, demoTask } = require("../src/core/demo.cjs");
async function main() {
  const root = path.resolve(__dirname, "..");
  const settings = new Settings(path.join(root, ".test-output/live-settings"), {
    isEncryptionAvailable: () => false,
  });
  await settings.load({ envFile: path.join(root, ".env") });
  const config = settings.config();
  const catalog = await settings.discover(config.providerId);
  console.log("Discovered models:", catalog.models.length);
  const provider = new ModelProvider(config);
  const ping = await provider.ping();
  console.log("Connected:", ping.model);
  const data = path.join(root, ".test-output"),
    folder = await createDemo(
      path.join(root, "examples/demo-node"),
      path.join(data, "live-workspaces"),
    ),
    skills = new SkillRegistry();
  await skills.loadBuiltins(path.join(root, "skills"));
  const store = new RunStore(path.join(data, "live-runs"), {
      secrets: [config.apiKey],
    }),
    h = new Harness({
      workspace: await Workspace.open(folder),
      skills,
      store,
      provider,
      secrets: [config.apiKey],
      maxIterations: 22,
      mode: "live",
      connection: {
        providerId: config.providerId,
        providerName: config.providerName,
        model: config.model,
      },
    }),
    seen = new Set();
  h.on("state", (s) => {
    const e = s.events.at(-1);
    if (e?.type === "tool_start" || e?.type === "status")
      console.log(s.status, e.message);
    if (s.approval && !seen.has(s.approval.nonce)) {
      seen.add(s.approval.nonce);
      const c = s.approval.command,
        allowed =
          c.program === "node" &&
          JSON.stringify(c.args) ===
            JSON.stringify(["--test", "tests/math.test.cjs"]) &&
          c.cwd === ".";
      console.log(
        "TEST DRIVER command decision:",
        allowed,
        c.program,
        JSON.stringify(c.args),
      );
      void h.decide(s.id, s.approval.nonce, allowed, { actor: "test-driver" });
    }
  });
  await h.makePlan(demoTask);
  assert.equal(h.state.status, "awaiting_plan");
  const p = {
    ...h.state.plan,
    verification: {
      program: "node",
      args: ["--test", "tests/math.test.cjs"],
      cwd: ".",
      timeoutMs: 15000,
    },
  };
  await h.approvePlan(p, { actor: "test-driver" });
  await h.job;
  const report = h.snapshot();
  await fs.writeFile(
    path.join(data, "live-evidence.json"),
    JSON.stringify(report, null, 2),
  );
  assert.equal(report.status, "completed");
  assert.equal(report.verification.ok, true);
  assert.equal(report.connection.model, config.model);
  assert.equal(
    (await store.load(report.id)).connection.providerId,
    config.providerId,
  );
  assert(!report.changes.some((c) => c.path.startsWith("tests/")));
  console.log(
    JSON.stringify(
      {
        model: config.model,
        status: report.status,
        iterations: report.iterations,
        corrections: report.corrections,
        exitCode: report.verification.exitCode,
        changes: report.changes.map((c) => c.path),
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
