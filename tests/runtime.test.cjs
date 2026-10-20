"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  net = require("node:net"),
  http = require("node:http");
const {
  AppRuntime,
  localURL,
  launchOptions,
} = require("../src/core/runtime.cjs");
const { Workspace } = require("../src/core/workspace.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(30);
  }
  assert.fail("Timed out waiting for app state/output");
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milo-runtime-"));
  const runtime = new AppRuntime({ readinessMs: 3000 });
  t.after(async () => {
    await runtime.close();
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith("milo-runtime-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, runtime, workspace: await Workspace.open(root) };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
test("interactive app outlives short-command timeout, accepts Persian input and EOF, then can restart", async (t) => {
  const { root, runtime, workspace } = await setup(t);
  await fs.writeFile(
    path.join(root, "cli.cjs"),
    "const r=require('node:readline').createInterface({input:process.stdin}); console.log('نام؟'); r.on('line', x=>console.log('سلام '+x)); r.on('close',()=>console.log('done'));",
  );
  const spec = {
    command: { program: "node", args: ["cli.cjs"], timeoutMs: 1000 },
    title: "CLI",
  };
  const app = await runtime.start(workspace, spec);
  await delay(1100);
  assert.equal(runtime.snapshot(root).status, "running");
  runtime.input(root, app.id, "محسن");
  await until(() => runtime.snapshot(root).stdout.includes("سلام محسن"));
  assert.throws(() => runtime.input(root, "stale-id", "bad"));
  runtime.input(root, app.id, "", true);
  await until(() => runtime.snapshot(root).status === "exited");
  assert.equal(runtime.snapshot(root).exitCode, 0);
  assert(runtime.snapshot(root).stdout.includes("done"));
  assert.throws(() => runtime.input(root, app.id, "after EOF"));
  const next = await runtime.start(workspace, spec);
  assert.notEqual(next.id, app.id);
  await assert.rejects(runtime.stop(root, app.id));
  await runtime.stop(root, next.id);
  assert.equal(runtime.snapshot(root).status, "exited");
});
test("web launch publishes a reachable local URL, rejects occupied ports, survives task return and cleans up", async (t) => {
  const { root, runtime, workspace } = await setup(t),
    port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const app = await runtime.start(workspace, {
    title: "Web app",
    url,
    command: {
      program: "node",
      args: [
        "-e",
        `const s=require('node:http').createServer((q,r)=>r.end('usable app')).listen(${port},'127.0.0.1'); process.stdin.once('data',()=>s.close()); setInterval(()=>{},1000);`,
      ],
      timeoutMs: 1000,
    },
  });
  assert.equal(app.url, url);
  assert.equal(app.http.statusCode, 200);
  assert(app.http.bodyPreview.includes("usable app"));
  assert.equal(app.command.timeoutMs, undefined);
  assert.equal(app.lifetime, "until_stopped_or_window_closed");
  assert.equal(await (await fetch(app.url)).text(), "usable app");
  await delay(1100);
  assert.equal(runtime.snapshot(root).status, "running");
  await assert.rejects(runtime.start(workspace, { command: app.command }), {
    code: "APP_RUNNING",
  });
  const other = path.join(root, "other");
  await fs.mkdir(other);
  await assert.rejects(
    runtime.start(await Workspace.open(other), { command: app.command, url }),
    { code: "PORT_IN_USE" },
  );
  runtime.input(root, app.id, "close-port");
  await delay(100);
  const unavailable = await runtime.refresh(root);
  assert.equal(unavailable.status, "running");
  assert.equal(unavailable.url, null);
  assert.equal(unavailable.http, null);
  await runtime.stop(root, app.id);
  assert.equal(runtime.snapshot(root).url, null);
  await assert.rejects(fetch(url));
});
test("static HTML preview serves assets and denies private files, traversal, and external links", async (t) => {
  const { root, runtime, workspace } = await setup(t);
  await fs.writeFile(
    path.join(root, "index.html"),
    '<!doctype html><link rel="stylesheet" href="style.css"><h1>ساخته شد</h1>',
  );
  await fs.writeFile(path.join(root, "style.css"), "h1{color:purple}");
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_VALUE=not-public");
  const app = await runtime.preview(workspace, "index.html");
  const base = new URL(app.url).origin;
  assert((await (await fetch(app.url)).text()).includes("ساخته شد"));
  assert.equal(
    await (await fetch(base + "/style.css")).text(),
    "h1{color:purple}",
  );
  assert.equal((await fetch(base + "/.env")).status, 404);
  assert.equal((await fetch(base + "/missing")).status, 404);
  const raw = (requestPath) =>
    new Promise((resolve, reject) => {
      http
        .get(base, { path: requestPath }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on("error", reject);
    });
  assert.equal(await raw("/%2e%2e/elsewhere.txt"), 404);
  assert.equal(await raw("/%5c..%5cprivate.txt"), 404);
  await assert.rejects(runtime.preview(workspace, "../outside.html"));
  for (const url of [
    "https://example.com",
    "file:///C:/secret",
    "http://user:pass@127.0.0.1:8000",
    "http://127.0.0.1",
    "http://example.com:8000",
  ])
    assert.throws(() => localURL(url));
  await runtime.close();
  await assert.rejects(fetch(app.url));
});
test("launch discovery supplies concrete CLI, npm and HTML entries without executing project scripts", async (t) => {
  const { root, workspace } = await setup(t);
  for (const file of ["cli.cjs", "index.html", "entry.mjs"])
    await fs.writeFile(path.join(root, file), "// not executed");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { start: "node entry.mjs", dev: "node entry.mjs" },
      main: "entry.mjs",
    }),
  );
  const options = await launchOptions(workspace);
  assert(options.some((o) => o.id === "npm-start"));
  assert(options.some((o) => o.path === "index.html"));
  assert(options.some((o) => o.command?.args[0] === "cli.cjs"));
  assert(options.some((o) => o.command?.args[0] === "entry.mjs"));
  assert.equal(
    options.find((o) => o.id === "npm-start").command.program,
    "npm",
  );
});
test("a failed server never supplies a browser link and exposes actual stderr/exit code", async (t) => {
  const { root, runtime, workspace } = await setup(t),
    port = await freePort();
  const app = await runtime.start(workspace, {
    command: {
      program: "node",
      args: ["-e", "console.error('startup failed');process.exit(7)"],
    },
    url: `http://127.0.0.1:${port}`,
  });
  assert.equal(app.status, "exited");
  assert.equal(app.exitCode, 7);
  assert.equal(app.url, null);
  assert(app.stderr.includes("startup failed"));
  assert.equal(runtime.snapshot(root).inputOpen, false);
});
