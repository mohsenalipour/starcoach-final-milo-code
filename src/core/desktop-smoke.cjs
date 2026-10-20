"use strict";
// Diagnostic CLI scenario, only on a fresh copy of the bundled fixture.
// This is never called by a renderer IPC method or a model tool.
const path = require("node:path");
const { assert } = require("./protocol.cjs");
const { Workspace } = require("./workspace.cjs");
const { Harness } = require("./harness.cjs");
const { createDemo, DemoProvider, demoTask } = require("./demo.cjs");
async function desktopDemo({ root, data, skills, store }) {
  const folder = await createDemo(
    path.join(root, "examples/demo-node"),
    path.join(data, "smoke-workspaces"),
  );
  const h = new Harness({
      workspace: await Workspace.open(folder),
      skills,
      store,
      provider: new DemoProvider(),
      mode: "offline-demo-smoke",
    }),
    seen = new Set();
  h.on("state", (s) => {
    if (!s.approval || seen.has(s.approval.nonce)) return;
    seen.add(s.approval.nonce);
    const c = s.approval.command,
      allow =
        s.approval.cwd === folder &&
        c.program === "node" &&
        c.cwd === "." &&
        ['["--version"]', '["--test","tests/math.test.cjs"]'].includes(
          JSON.stringify(c.args),
        );
    void h.decide(s.id, s.approval.nonce, allow, { actor: "test-driver" });
  });
  await h.makePlan(demoTask);
  assert(
    h.state.status === "awaiting_plan",
    "ساخت پلن دمو در تست دسکتاپ موفق نبود.",
  );
  await h.approvePlan(h.state.plan, { actor: "test-driver" });
  await h.job;
  assert(
    h.state.status === "completed" && h.state.verification?.ok,
    "تست چرخهٔ کامل دسکتاپ موفق نبود.",
  );
  assert(
    h.state.corrections === 1 && seen.size === 3,
    "شکست و اصلاح مورد انتظار در دمو رخ نداد.",
  );
  return {
    status: h.state.status,
    runId: h.state.id,
    approvals: seen.size,
    corrections: h.state.corrections,
    exitCode: h.state.verification.exitCode,
    runtime: process.versions.node,
  };
}
module.exports = { desktopDemo };
