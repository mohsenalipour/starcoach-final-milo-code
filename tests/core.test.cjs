"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Workspace } = require("../src/core/workspace.cjs");
const { CommandRunner } = require("../src/core/commands.cjs");
const { SkillRegistry } = require("../src/core/skills.cjs");
const { ApprovalGate, Harness } = require("../src/core/harness.cjs");
const { RunStore } = require("../src/core/store.cjs");
const { ModelProvider, endpoint } = require("../src/core/provider.cjs");
const { Settings } = require("../src/core/settings.cjs");
const { hash, id, redact } = require("../src/core/protocol.cjs");
const project = path.resolve(__dirname, "..");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milo-test-"));
  t.after(async () => {
    assert(
      path.basename(root).startsWith("milo-test-") &&
        path.dirname(root) === os.tmpdir(),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, workspace: await Workspace.open(root) };
}
test("workspace confines paths, private files, device names, symlinks and binary files", async (t) => {
  const { root, workspace: w } = await fixture(t);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 1]));
  for (const file of [
    "../outside",
    "C:\\outside",
    "a.txt:secret",
    ".env",
    ".git/config",
    "con.txt",
    "bad.",
    "bad /x",
  ])
    await assert.rejects(w.read(file));
  await assert.rejects(w.read("binary"));
  await fs.mkdir(path.join(root, "real"));
  try {
    await fs.symlink(
      path.join(root, "real"),
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(w.list("linked"), /لینک/);
  } catch (e) {
    if (e.code !== "EPERM") throw e;
  }
});
test("optimistic writes prevent lost updates and protect redacted files", async (t) => {
  const { root, workspace: w } = await fixture(t);
  await w.write("src/a.txt", "اول", null);
  const before = await w.read("src/a.txt");
  await fs.writeFile(path.join(root, "src/a.txt"), "external");
  await assert.rejects(w.write("src/a.txt", "lost", before.hash), {
    code: "FILE_CONFLICT",
  });
  const latest = await w.read("src/a.txt");
  await w.write("src/a.txt", "new", latest.hash);
  assert.equal(w.changeList()[0].before, null);
  await fs.writeFile(
    path.join(root, "secret.txt"),
    'api_key="' + "x".repeat(30) + '"',
  );
  const secret = await w.read("secret.txt", { agent: true });
  assert(secret.redacted);
  assert(!secret.content.includes("x".repeat(30)));
  await assert.rejects(w.write("secret.txt", "replacement", secret.hash));
});
test("fingerprint changes for external edits and search is bounded", async (t) => {
  const { root, workspace: w } = await fixture(t);
  await w.write("a.txt", "needle\n".repeat(50), null);
  const first = await w.fingerprint();
  assert.equal((await w.search("needle")).matches.length, 30);
  await fs.writeFile(path.join(root, "a.txt"), "external");
  assert.notEqual(await w.fingerprint(), first);
});
test("command runner executes real Node, clips output and reports failed tests", async (t) => {
  const { workspace: w } = await fixture(t),
    runner = new CommandRunner();
  let c = await runner.prepare(
    {
      program: "node",
      args: ["-e", 'console.log("x".repeat(70000));process.exit(3)'],
    },
    w,
  );
  const result = await runner.run(c);
  assert.equal(result.exitCode, 3);
  assert(!result.ok);
  assert(result.truncated);
  assert.equal(result.stdout.length, 64000);
  await assert.rejects(runner.prepare({ program: "powershell", args: [] }, w), {
    code: "PROGRAM_BLOCKED",
  });
});
test("command timeout and cancellation stop owned child", async (t) => {
  const { workspace: w } = await fixture(t),
    runner = new CommandRunner();
  const c = await runner.prepare(
    {
      program: "node",
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 1000,
    },
    w,
  );
  assert((await runner.run(c)).timedOut);
  const abort = new AbortController();
  const running = runner.run(
    { ...c, spec: { ...c.spec, timeoutMs: 15000 } },
    { signal: abort.signal },
  );
  setTimeout(() => abort.abort(), 100);
  assert((await running).aborted);
});
test("approvals are one-shot, run-scoped, cancellable and cannot become stale", async () => {
  const gate = new ApprovalGate(),
    controller = new AbortController();
  const pending = gate.request({ runId: "one" }, controller.signal);
  const { nonce } = gate.public();
  assert.throws(() => gate.decide("two", nonce, true));
  gate.decide("one", nonce, false);
  assert.equal(await pending, false);
  assert.throws(() => gate.decide("one", nonce, true));
  const second = gate.request({ runId: "one" }, controller.signal);
  controller.abort();
  await assert.rejects(second);
  assert.equal(gate.public(), null);
});
test("external skill hash changes revoke trust; manifests are declarative", async (t) => {
  const { root } = await fixture(t);
  const dir = path.join(root, "skill");
  await fs.cp(path.join(project, "skills/node-testing"), dir, {
    recursive: true,
  });
  const r = new SkillRegistry(),
    preview = await r.inspect(dir);
  assert(!preview.trusted);
  await r.import(dir, preview.digest);
  assert((await r.tool("node-testing", "test")).command.program === "node");
  await fs.appendFile(path.join(dir, "SKILL.md"), "changed");
  await assert.rejects(r.tool("node-testing", "test"), {
    code: "SKILL_CHANGED",
  });
});
test("provider repairs malformed JSON once and does not expose HTTP bodies", async () => {
  let calls = 0;
  const config = {
    baseURL: "https://example.com/v1",
    apiKey: "secret",
    model: "m",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: ++calls === 1 ? "invalid" : '{"ready":true}' },
          },
        ],
      }),
    }),
  };
  assert((await new ModelProvider(config).ping()).ready);
  assert.equal(calls, 2);
  const p = new ModelProvider({
    ...config,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      body: { cancel: async () => {} },
    }),
  });
  await assert.rejects(p.ping(), /401/);
  assert.throws(() => endpoint("http://example.com/v1"));
  assert.throws(() => endpoint("https://u:p@example.com"));
});
test("settings encrypt API keys, hide them from renderer and clear on host change", async (t) => {
  const { root } = await fixture(t);
  const safe = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from("encrypted:" + s),
      decryptString: (b) => b.toString().slice(10),
    },
    settings = new Settings(root, safe);
  await settings.update({
    baseURL: "https://example.com/v1",
    model: "m",
    apiKey: "sk-" + "a".repeat(25),
  });
  assert(settings.public().hasKey);
  assert(!JSON.stringify(settings.public()).includes("sk-"));
  assert(!(await fs.readFile(settings.file, "utf8")).includes("sk-"));
  await settings.update({ baseURL: "https://other.com/v1", model: "m" });
  assert(!settings.public().hasKey);
});
test("store redacts secrets and restart only reads history", async (t) => {
  const { root } = await fixture(t),
    store = new RunStore(root, { secrets: ["my-private-secret"] }),
    run = {
      id: id(),
      status: "awaiting_approval",
      updatedAt: new Date().toISOString(),
      task: "my-private-secret",
    };
  await store.save(run);
  assert.equal((await new RunStore(root).load(run.id)).task, "[REDACTED]");
  assert.equal((await store.list()).length, 1);
  assert.equal(redact("ghp_" + "a".repeat(30)), "[REDACTED]");
});
test("redaction preserves JSON and quoted source code structure", async (t) => {
  const { root } = await fixture(t),
    store = new RunStore(root);
  const clean = store.clean({
    content: 'const api_key = "' + "x".repeat(25) + '";\nconst valid = 1;',
    nested: ["password=" + "y".repeat(25)],
  });
  assert(clean.content.includes("[REDACTED]"));
  assert(clean.content.includes("const valid = 1;"));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(clean)));
});
test("finish is refused without real verify and iteration limit is enforced", async (t) => {
  const { root, workspace } = await fixture(t);
  await workspace.write("x.txt", "x", null);
  const skills = new SkillRegistry(),
    store = new RunStore(path.join(root, "history")),
    provider = {
      plan: async () => ({
        title: "test",
        summary: "test",
        steps: ["read", "test"],
        acceptance: ["real tests"],
        verification: { program: "node", args: ["--test"] },
      }),
      next: async () => ({ type: "finish", summary: "fake" }),
      review: async () => {
        throw Error("must not review");
      },
    };
  const h = new Harness({
    workspace,
    skills,
    store,
    provider,
    maxIterations: 2,
  });
  await h.makePlan("A sufficiently long task");
  await h.approvePlan(h.state.plan);
  await h.job;
  assert.equal(h.state.status, "needs_attention");
  assert.equal(h.state.iterations, 2);
  assert.equal(h.state.verification, null);
});
test("external edit after passing verification refuses completion", async (t) => {
  const { root, workspace } = await fixture(t);
  await workspace.write("x.txt", "x", null);
  let index = 0;
  const provider = {
    plan: async () => ({
      title: "test",
      summary: "test",
      steps: ["check", "verify"],
      acceptance: ["x remains x"],
      verification: {
        program: "node",
        args: [
          "-e",
          "require('node:assert/strict').equal(require('node:fs').readFileSync('x.txt','utf8'),'x')",
        ],
      },
    }),
    next: async () => {
      if (index++ === 0)
        return {
          type: "tool",
          step: 1,
          tool: "verify",
          args: {},
          message: "Real verification",
        };
      await fs.writeFile(path.join(root, "x.txt"), "external edit");
      return { type: "finish", summary: "cannot finish" };
    },
    review: async () => {
      throw Error("stale evidence must not reach review");
    },
  };
  const storage = await fixture(t);
  const h = new Harness({
    workspace,
    provider,
    skills: new SkillRegistry(),
    store: new RunStore(storage.root),
    maxIterations: 2,
  });
  h.on("state", (s) => {
    if (s.approval) void h.decide(s.id, s.approval.nonce, true);
  });
  await h.makePlan("A sufficiently long task");
  await h.approvePlan(h.state.plan);
  await h.job;
  assert.equal(h.state.status, "needs_attention");
  assert.equal(h.state.verification, null);
  assert(h.state.events.some((e) => e.type === "command" && e.data.ok));
});
test("denied command never executes", async (t) => {
  const { root, workspace } = await fixture(t);
  let index = 0;
  const provider = {
    plan: async () => ({
      title: "test",
      summary: "test",
      steps: ["read", "test"],
      acceptance: ["real result"],
      verification: { program: "node", args: ["--test"] },
    }),
    next: async () =>
      index++ === 0
        ? {
            type: "tool",
            step: 0,
            tool: "run_command",
            args: {
              program: "node",
              args: [
                "-e",
                "require('node:fs').writeFileSync('should-not-exist','bad')",
              ],
            },
            message: "request",
          }
        : { type: "finish", summary: "no evidence" },
    review: async () => {
      throw Error("not verified");
    },
  };
  const h = new Harness({
    workspace,
    provider,
    skills: new SkillRegistry(),
    store: new RunStore(path.join(root, "history")),
    maxIterations: 2,
  });
  h.on("state", (s) => {
    if (s.approval) void h.decide(s.id, s.approval.nonce, false);
  });
  await h.makePlan("A sufficiently long task");
  await h.approvePlan(h.state.plan);
  await h.job;
  await assert.rejects(fs.access(path.join(root, "should-not-exist")));
  assert(h.state.observations.some((o) => o.result.denied));
});
