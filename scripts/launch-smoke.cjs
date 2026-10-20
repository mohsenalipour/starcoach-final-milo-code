"use strict";
// Real-model run-only follow-up on a disposable local app. No renderer or UI automation.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  net = require("node:net");
const assert = require("node:assert/strict");
const { Settings } = require("../src/core/settings.cjs"),
  { Workspace } = require("../src/core/workspace.cjs");
const { ModelProvider } = require("../src/core/provider.cjs"),
  { SkillRegistry } = require("../src/core/skills.cjs");
const { Harness } = require("../src/core/harness.cjs"),
  { RunStore } = require("../src/core/store.cjs");
const { AppRuntime } = require("../src/core/runtime.cjs");
const { createProject } = require("../src/core/projects.cjs");
async function main() {
  const root = path.resolve(__dirname, ".."),
    data = path.join(root, ".test-output", "launch");
  const settings = new Settings(path.join(data, "settings"), {
    isEncryptionAvailable: () => false,
  });
  await settings.load({ envFile: path.join(root, ".env") });
  const config = settings.config();
  const folder = await createProject(data, "runnable-web-app");
  const source = {
    "index.html":
      '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>برنامهٔ قابل استفاده</title><h1>تبدیل دما</h1><input id="c" type="number" value="25"><button onclick="document.querySelector(\'#f\').textContent=Number(document.querySelector(\'#c\').value)*9/5+32">تبدیل</button><output id="f">77</output></html>',
    "server.cjs":
      "const http=require('node:http'),fs=require('node:fs'); const port=Number(process.argv[2]||3000); http.createServer((q,r)=>{r.setHeader('Content-Type','text/html; charset=utf-8');r.end(fs.readFileSync('index.html'));}).listen(port,'127.0.0.1',()=>console.log('Ready http://127.0.0.1:'+port));",
    "app.test.cjs":
      "const t=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs');t('interactive conversion UI exists',()=>{const h=fs.readFileSync('index.html','utf8');a.match(h,/id=\"c\"/);a.match(h,/id=\"f\"/);a.match(h,/9\\/5\\+32/)});",
    "README.md":
      "Run node server.cjs PORT. Open http://127.0.0.1:PORT. Tests: node --test app.test.cjs. The app already exists; do not rewrite files to run it.",
  };
  for (const [file, content] of Object.entries(source))
    await fs.writeFile(path.join(folder, file), content);
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const workspace = await Workspace.open(folder),
    before = await workspace.fingerprint();
  const runtime = new AppRuntime({ secrets: [config.apiKey] });
  const h = new Harness({
    workspace,
    runtime,
    provider: new ModelProvider(config),
    skills: new SkillRegistry(),
    store: new RunStore(path.join(data, "runs"), { secrets: [config.apiKey] }),
    secrets: [config.apiKey],
    connection: {
      providerId: config.providerId,
      providerName: config.providerName,
      model: config.model,
    },
    continuation: {
      runId: "fixture-creation",
      task: "ساخت ابزار وب تبدیل دما",
      summary: "برنامه در index.html و server.cjs آماده است.",
      changedFiles: Object.keys(source),
    },
  });
  const seen = new Set();
  h.on("state", (s) => {
    const event = s.events.at(-1);
    if (["tool_start", "status"].includes(event?.type))
      console.log(s.status, event.message);
    if (!s.approval || seen.has(s.approval.nonce)) return;
    seen.add(s.approval.nonce);
    const c = s.approval.command;
    const allowed =
      s.approval.cwd === folder &&
      c.program === "node" &&
      [
        JSON.stringify(["--test", "app.test.cjs"]),
        JSON.stringify(["server.cjs", String(port)]),
      ].includes(JSON.stringify(c.args));
    void h.decide(s.id, s.approval.nonce, allowed, { actor: "test-driver" });
  });
  try {
    await h.makePlan(
      `خب همین برنامه‌ای که ساختی را واقعاً اجرا کن تا در مرورگر با آن کار کنم. فایل‌ها موجودند؛ فقط اجرا کن و تست موجود را بگیر. سرور را با node server.cjs ${port} روی http://127.0.0.1:${port} باز نگه دار. تست موجود node --test app.test.cjs است. اجرای چند نمونه یا تست به‌تنهایی کافی نیست؛ لینک وب قابل استفاده لازم دارم.`,
    );
    assert.equal(h.state.status, "awaiting_plan");
    await h.approvePlan(
      {
        ...h.state.plan,
        verification: {
          program: "node",
          args: ["--test", "app.test.cjs"],
          cwd: ".",
          timeoutMs: 20000,
        },
      },
      { actor: "test-driver" },
    );
    await h.job;
    const report = h.snapshot();
    await fs.writeFile(
      path.join(data, "evidence.json"),
      JSON.stringify(report, null, 2),
    );
    assert.equal(report.status, "completed");
    assert(
      report.events.some(
        (e) => e.type === "tool_start" && e.data.tool === "launch_app",
      ),
    );
    const app = runtime.snapshot(folder);
    assert.equal(app.status, "running");
    assert.equal(app.url, `http://127.0.0.1:${port}/`);
    assert((await (await fetch(app.url)).text()).includes("تبدیل دما"));
    assert.equal(await workspace.fingerprint(), before);
    const summary = {
      version: require("../package.json").version,
      provider: config.providerName,
      model: config.model,
      status: report.status,
      iterations: report.iterations,
      corrections: report.corrections,
      fileChanges: report.changes.length,
      launchedTool: "launch_app",
      browserReachable: true,
      survivedTaskCompletion: true,
      exitCode: report.verification.exitCode,
      approvals: seen.size,
    };
    await fs.writeFile(
      path.join(data, "summary.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await h.stop();
    await runtime.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
