"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { Harness } = require("../src/core/harness.cjs"),
  { Workspace } = require("../src/core/workspace.cjs"),
  { SkillRegistry } = require("../src/core/skills.cjs"),
  { RunStore } = require("../src/core/store.cjs"),
  { Settings } = require("../src/core/settings.cjs");
test("run identity is frozen and recorded in history independently of later default changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milo-model-run-"));
  t.after(async () => {
    assert(
      path.dirname(root) === os.tmpdir() &&
        path.basename(root).startsWith("milo-model-run-"),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  const settings = new Settings(path.join(root, "settings"), {
    isEncryptionAvailable: () => false,
  });
  const selected = settings.config({
    providerId: "avalai",
    model: "chosen-for-this-run",
  });
  const store = new RunStore(path.join(root, "history"));
  const h = new Harness({
    workspace: await Workspace.open(root),
    store,
    skills: new SkillRegistry(),
    connection: {
      providerId: selected.providerId,
      providerName: selected.providerName,
      model: selected.model,
    },
    provider: {
      plan: async () => ({
        title: "Test selection",
        summary: "Frozen request model",
        steps: ["Read", "Verify"],
        acceptance: ["Keep selected model"],
        verification: { program: "node", args: ["--test"] },
      }),
    },
  });
  await h.makePlan("A request with an explicitly selected model");
  await settings.update({
    providerId: "metis",
    baseURL: settings.profile("metis").baseURL,
    model: "different-default",
    makeDefault: true,
  });
  assert.equal(h.snapshot().connection.model, "chosen-for-this-run");
  assert.equal((await store.load(h.state.id)).connection.providerId, "avalai");
  assert.equal((await store.list())[0].connection.model, "chosen-for-this-run");
  assert.equal(settings.config().providerId, "metis");
  await h.stop();
});
