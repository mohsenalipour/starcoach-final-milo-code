"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Workspace } = require("../src/core/workspace.cjs");
const { SkillRegistry } = require("../src/core/skills.cjs");
const { RunStore } = require("../src/core/store.cjs");
const { Harness } = require("../src/core/harness.cjs");
const { DemoProvider, createDemo, demoTask } = require("../src/core/demo.cjs");
async function smoke() {
  const project = path.join(__dirname, ".."),
    data = path.join(project, ".test-output");
  const root = await createDemo(
    path.join(project, "examples/demo-node"),
    path.join(data, "workspaces"),
  );
  const skills = new SkillRegistry();
  await skills.loadBuiltins(path.join(project, "skills"));
  const store = new RunStore(path.join(data, "runs"));
  const harness = new Harness({
    workspace: await Workspace.open(root),
    skills,
    store,
    provider: new DemoProvider(),
    mode: "offline-demo",
  });
  const seen = new Set();
  harness.on("state", (state) => {
    if (state.approval && !seen.has(state.approval.nonce)) {
      seen.add(state.approval.nonce);
      console.log(
        "TEST DRIVER approves:",
        JSON.stringify(state.approval.command),
      );
      void harness.decide(state.id, state.approval.nonce, true, {
        actor: "test-driver",
      });
    }
  });
  await harness.makePlan(demoTask);
  assert.equal(harness.state.status, "awaiting_plan");
  await harness.approvePlan(harness.state.plan, { actor: "test-driver" });
  await harness.job;
  const report = harness.snapshot();
  assert.equal(report.status, "completed");
  assert(
    report.events.some((e) => e.type === "command" && e.data.exitCode !== 0),
  );
  assert.equal(report.verification.ok, true);
  assert.equal(report.changes.length, 1);
  assert.equal(report.changes[0].path, "src/math.cjs");
  assert.equal(seen.size, 3);
  const saved = await store.load(report.id);
  assert.equal(saved.status, "completed");
  await fs.writeFile(
    path.join(data, "demo-evidence.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        status: report.status,
        mode: report.mode,
        corrections: report.corrections,
        approvals: seen.size,
        tests: report.verification.exitCode,
        report: path.join(data, "demo-evidence.json"),
      },
      null,
      2,
    ),
  );
  return report;
}
if (require.main === module)
  smoke().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
module.exports = { smoke };
