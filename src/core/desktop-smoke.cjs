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
async function desktopRuntime({ data, runtime }) {
  const fs = require("node:fs/promises"),
    net = require("node:net");
  const { createProject } = require("./projects.cjs");
  const folder = await createProject(data, "برنامهٔ آزمایشی اجرا");
  await fs.writeFile(
    path.join(folder, "index.html"),
    '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>Milo runtime check</title><h1>برنامه آمادهٔ استفاده است</h1><button onclick="this.textContent=\'کار می‌کند\'">آزمایش</button></html>',
  );
  await fs.writeFile(
    path.join(folder, "server.cjs"),
    "const fs=require('node:fs'); require('node:http').createServer((q,r)=>{r.setHeader('Content-Type','text/html;charset=utf-8');r.end(fs.readFileSync('index.html'))}).listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('Milo: web server ready'));",
  );
  await fs.writeFile(
    path.join(folder, "cli.cjs"),
    "process.stdin.setEncoding('utf8'); console.log('نام را بنویس'); process.stdin.on('data',x=>console.log('سلام '+x.trim())); process.stdin.on('end',()=>process.exit(0));",
  );
  const ws = await Workspace.open(folder);
  const cli = await runtime.start(ws, {
    command: { program: "node", args: ["cli.cjs"], timeoutMs: 1000 },
    title: "CLI smoke",
  });
  runtime.input(folder, cli.id, "محسن");
  let deadline = Date.now() + 4000;
  while (
    !runtime.snapshot(folder).stdout.includes("سلام محسن") &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 40));
  assert(
    runtime.snapshot(folder).stdout.includes("سلام محسن"),
    "ورودی فارسی برنامهٔ بسته‌بندی‌شده موفق نبود.",
  );
  runtime.input(folder, cli.id, "", true);
  deadline = Date.now() + 4000;
  while (runtime.snapshot(folder).status !== "exited" && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 40));
  assert(runtime.snapshot(folder).exitCode === 0, "پایان ورودی CLI موفق نبود.");
  const portServer = net.createServer();
  await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
  const port = portServer.address().port;
  await new Promise((r) => portServer.close(r));
  const web = await runtime.start(ws, {
    command: { program: "node", args: ["server.cjs", String(port)] },
    title: "برنامهٔ وب آمادهٔ استفاده",
    url: `http://127.0.0.1:${port}/`,
  });
  assert(
    web.url && web.http?.statusCode === 200,
    "سرور وب برنامهٔ بسته‌بندی‌شده آماده نشد.",
  );
  return {
    workspace: ws,
    checks: {
      interactivePersianInput: true,
      eofExitCode: 0,
      webHTTPStatus: 200,
      browserURL: web.url,
      lifetime: web.lifetime,
      bundledNode: process.versions.node,
    },
  };
}
module.exports = { desktopDemo, desktopRuntime };
