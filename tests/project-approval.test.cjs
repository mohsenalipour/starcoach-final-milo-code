"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { Settings } = require("../src/core/settings.cjs");
const { Harness } = require("../src/core/harness.cjs");
const { Workspace } = require("../src/core/workspace.cjs");
const { RunStore } = require("../src/core/store.cjs");
const { SkillRegistry } = require("../src/core/skills.cjs");
const { AppRuntime } = require("../src/core/runtime.cjs");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milo-approval-"));
  const runtime = new AppRuntime();
  t.after(async () => {
    await runtime.close();
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith("milo-approval-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const a = path.join(root, "a"),
    b = path.join(root, "b");
  await fs.mkdir(a);
  await fs.mkdir(b);
  const settings = new Settings(path.join(root, "settings"), {
    isEncryptionAvailable: () => false,
  });
  return { root, a, b, settings, runtime };
}
const command = {
  program: "node",
  args: ["-e", "console.log('executed')"],
  timeoutMs: 5000,
};
async function harness(root, settings, runtime, work) {
  const h = new Harness({
    workspace: await Workspace.open(work),
    runtime,
    store: new RunStore(path.join(root, "runs")),
    skills: new SkillRegistry(),
    projectApproval: () => settings.projectApproval(work).autoApproveCommands,
    provider: {
      plan: async () => ({
        title: "Permissions",
        summary: "Project-specific command approvals",
        steps: ["Inspect", "Test"],
        acceptance: ["Run with explicit project permission"],
        verification: { program: "node", args: ["--test"] },
      }),
    },
  });
  await h.makePlan("Check project-scoped command permissions");
  return h;
}
function pending(h) {
  return new Promise((resolve) => {
    const listen = (state) => {
      if (state.approval) {
        h.off("state", listen);
        resolve(state.approval);
      }
    };
    h.on("state", listen);
  });
}
test("project permission survives restart, stays separate from model selection and defaults off in another project", async (t) => {
  const { root, a, b, settings } = await setup(t);
  assert.equal(settings.projectApproval(a).autoApproveCommands, false);
  await settings.saveProject(a, { providerId: "metis", model: "my-model" });
  await settings.setProjectApproval(a, true);
  const loaded = new Settings(path.join(root, "settings"), {
    isEncryptionAvailable: () => false,
  });
  await loaded.load();
  assert.equal(loaded.projectApproval(a).autoApproveCommands, true);
  assert.equal(loaded.projectApproval(b).autoApproveCommands, false);
  assert.equal(loaded.forProject(a).model, "my-model");
  assert.equal(loaded.public().projectPermissions, undefined);
  await loaded.setProjectApproval(a, false);
  await settings.load();
  assert.equal(settings.projectApproval(a).autoApproveCommands, false);
  await assert.rejects(settings.setProjectApproval(a, "true"));
});
test("an explicitly trusted project auto-approves each real command, while revoke restores the nonce gate", async (t) => {
  const { root, a, b, settings, runtime } = await setup(t);
  await settings.setProjectApproval(a, true);
  const h = await harness(root, settings, runtime, a);
  t.after(() => h.stop());
  for (let i = 0; i < 2; i++) {
    const result = await h.execute(command);
    assert.equal(result.stdout.trim(), "executed");
    assert.equal(result.ok, true);
    assert.equal(h.snapshot().approval, null);
  }
  assert.equal(
    h.state.events.filter(
      (e) => e.type === "approval" && e.data.actor === "project-policy",
    ).length,
    2,
  );
  const second = await harness(root, settings, runtime, b);
  t.after(() => second.stop());
  const waitingOther = pending(second),
    jobOther = second.execute(command);
  const otherApproval = await waitingOther;
  assert.equal(second.state.status, "awaiting_approval");
  await assert.rejects(second.decide(h.state.id, otherApproval.nonce, true), {
    code: "STALE_APPROVAL",
  });
  await second.decide(second.state.id, otherApproval.nonce, false);
  assert.equal((await jobOther).denied, true);
  await settings.setProjectApproval(a, false);
  const waiting = pending(h),
    job = h.execute(command),
    approval = await waiting;
  assert.equal(h.state.status, "awaiting_approval");
  await h.decide(h.state.id, approval.nonce, false);
  assert.equal((await job).denied, true);
  await assert.rejects(h.decide(h.state.id, approval.nonce, true), {
    code: "STALE_APPROVAL",
  });
});
test("launch_app uses the same gate, starts a persistent interactive app, and reports its real status", async (t) => {
  const { root, a, settings, runtime } = await setup(t);
  await fs.writeFile(
    path.join(a, "app.cjs"),
    "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => console.log('echo:'+d.trim())); process.stdin.on('end',()=>process.exit(0)); console.log('ready');",
  );
  const h = await harness(root, settings, runtime, a);
  t.after(() => h.stop());
  const waiting = pending(h),
    job = h.tool("launch_app", {
      command: { program: "node", args: ["app.cjs"] },
      title: "Interactive demo",
    });
  const approval = await waiting;
  assert.equal(approval.application, true);
  assert.equal(runtime.snapshot(a), null);
  await settings.setProjectApproval(a, true);
  await h.decide(h.state.id, approval.nonce, true);
  const started = await job;
  assert.equal(started.status, "running");
  assert.equal(started.inputOpen, true);
  assert.equal(h.state.launch.id, started.id);
  const status = await h.tool("app_status", {});
  assert.equal(status.id, started.id);
  await runtime.stop(a, started.id);
  assert.equal(runtime.snapshot(a).stopped, true);
});
