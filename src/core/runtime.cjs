"use strict";
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { CommandRunner, childEnv, terminateChild } = require("./commands.cjs");
const { assert, text, keys, id, redact, stripANSI } = require("./protocol.cjs");

function localURL(value) {
  text(value, 1000, "آدرس برنامه");
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.port,
    "پیش‌نمایش باید آدرس HTTP محلی با شمارهٔ پورت باشد.",
  );
  return url;
}
function listening(url) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port),
    });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(350, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
async function probeHTTP(url, secrets = []) {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(1500),
    });
    const reader = response.body?.getReader();
    let sample = "";
    if (reader) {
      const chunk = await reader.read();
      sample = new TextDecoder().decode(
        chunk.value?.slice(0, 8192) || new Uint8Array(),
      );
      await reader.cancel();
    }
    return {
      statusCode: response.status,
      contentType: response.headers.get("content-type"),
      bodyPreview: redact(sample.slice(0, 2000), secrets),
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const active = (entry) =>
  entry && ["starting", "running"].includes(entry.status);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

class AppRuntime extends EventEmitter {
  constructor({ secrets = [], readinessMs = 8000 } = {}) {
    super();
    this.secrets = secrets;
    this.readinessMs = readinessMs;
    this.apps = new Map();
    this.starts = new Set();
  }
  snapshot(root) {
    const app = this.apps.get(root);
    if (!app) return null;
    const { child, server, done, sockets, ...value } = app;
    return structuredClone(value);
  }
  changed(app) {
    this.emit("change", this.snapshot(app.root));
  }
  async start(workspace, input, { extraPrograms = [], prepared = null } = {}) {
    keys(input, ["command", "title", "url"]);
    const title = text(input.title || "اجرای برنامه", 160);
    const expected = input.url ? localURL(input.url) : null;
    assert(
      !this.starts.has(workspace.root) &&
        !active(this.apps.get(workspace.root)),
      "برنامهٔ این پروژه باز است؛ ابتدا آن را متوقف کن.",
      "APP_RUNNING",
    );
    this.starts.add(workspace.root);
    try {
      const ready =
        prepared ||
        (await new CommandRunner().prepareApp(
          input.command,
          workspace,
          extraPrograms,
        ));
      if (expected)
        assert(
          !(await listening(expected)),
          "این پورت از قبل استفاده می‌شود؛ پورت دیگری انتخاب کن.",
          "PORT_IN_USE",
        );
      const app = {
        id: id(),
        root: workspace.root,
        title,
        kind: "process",
        command: ready.spec,
        status: "starting",
        startedAt: new Date().toISOString(),
        endedAt: null,
        url: null,
        expectedURL: expected?.href || null,
        stdout: "",
        stderr: "",
        exitCode: null,
        stopped: false,
        inputOpen: true,
        lifetime: "until_stopped_or_window_closed",
      };
      const child = spawn(ready.executable, ready.args, {
        cwd: ready.cwd,
        env: childEnv(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      app.child = child;
      this.apps.set(app.root, app);
      let spawned = false;
      app.done = new Promise((resolve) => {
        child.once("error", (error) => {
          app.status = "failed";
          app.error = redact(error.message, this.secrets);
          app.inputOpen = false;
          this.changed(app);
        });
        child.once("close", (code) => {
          app.status = app.error ? "failed" : "exited";
          app.exitCode = code;
          app.url = null;
          app.inputOpen = false;
          app.endedAt = new Date().toISOString();
          this.changed(app);
          resolve();
        });
      });
      child.once("spawn", () => {
        spawned = true;
        app.pid = child.pid;
        app.status = expected ? "starting" : "running";
        this.changed(app);
      });
      child.stdin.on("error", () => {
        app.inputOpen = false;
        this.changed(app);
      });
      for (const stream of ["stdout", "stderr"]) {
        child[stream].setEncoding("utf8");
        child[stream].on("data", (chunk) => {
          const clean = redact(stripANSI(chunk), this.secrets);
          app[stream] = (app[stream] + clean).slice(-64000);
          this.emit("output", {
            root: app.root,
            id: app.id,
            stream,
            text: clean.slice(-8000),
          });
        });
      }
      this.changed(app);
      const deadline = Date.now() + (expected ? this.readinessMs : 350);
      while (Date.now() < deadline && active(app)) {
        if (spawned && expected && (await listening(expected))) {
          // A process that immediately fails (e.g. EADDRINUSE) must never publish a link.
          app.http = await probeHTTP(expected, this.secrets);
          if (
            active(app) &&
            app.http?.statusCode >= 200 &&
            app.http.statusCode < 400
          ) {
            app.url = expected.href;
            app.status = "running";
            this.changed(app);
            break;
          }
        }
        await pause(80);
      }
      if (expected && active(app) && !app.url) {
        app.notice =
          "برنامه شروع شده، اما پورت وب هنوز آماده نشده است. از «بررسی لینک» استفاده کن.";
        this.changed(app);
      }
      return this.snapshot(app.root);
    } finally {
      this.starts.delete(workspace.root);
    }
  }
  async refresh(root) {
    const app = this.apps.get(root);
    if (
      active(app) &&
      app.expectedURL &&
      (await listening(localURL(app.expectedURL)))
    ) {
      app.http = await probeHTTP(app.expectedURL, this.secrets);
      if (
        active(app) &&
        app.http?.statusCode >= 200 &&
        app.http.statusCode < 400
      ) {
        app.url = app.expectedURL;
        app.status = "running";
        delete app.notice;
      } else app.url = null;
      this.changed(app);
    } else if (active(app) && app.expectedURL) {
      app.url = null;
      app.http = null;
      app.notice = "پورت وب اکنون در دسترس نیست؛ خروجی برنامه را بررسی کن.";
      this.changed(app);
    }
    return this.snapshot(root);
  }
  async preview(workspace, relative, title = "پیش‌نمایش برنامه") {
    text(relative, 500);
    text(title, 160);
    const entry = await workspace.resolve(relative);
    assert(
      /\.html?$/i.test(entry) && (await fs.stat(entry)).isFile(),
      "یک فایل HTML داخل پروژه انتخاب کن.",
    );
    assert(
      !this.starts.has(workspace.root) &&
        !active(this.apps.get(workspace.root)),
      "برنامهٔ این پروژه باز است؛ ابتدا آن را متوقف کن.",
      "APP_RUNNING",
    );
    this.starts.add(workspace.root);
    try {
      const app = {
        id: id(),
        root: workspace.root,
        title,
        kind: "preview",
        path: relative,
        status: "starting",
        startedAt: new Date().toISOString(),
        url: null,
        stdout: "",
        stderr: "",
        inputOpen: false,
        lifetime: "until_stopped_or_window_closed",
      };
      const server = http.createServer(async (req, res) => {
        try {
          assert(["GET", "HEAD"].includes(req.method), "Unsupported method");
          // Decode the raw path before resolution; URL normalization must not conceal ../.
          const requested = decodeURIComponent(req.url.split("?")[0]);
          assert(
            requested.startsWith("/") && !requested.includes("\\"),
            "Invalid URL",
          );
          const rel = requested === "/" ? relative : requested.slice(1);
          const target = await workspace.resolve(rel);
          const stat = await fs.stat(target);
          assert(
            stat.isFile() && stat.size <= 10 * 1024 * 1024,
            "File unavailable",
          );
          assert(
            mime[path.extname(target).toLowerCase()],
            "File type unavailable",
          );
          const body = await fs.readFile(target);
          res.writeHead(200, {
            "Content-Type": mime[path.extname(target).toLowerCase()],
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Length": body.length,
          });
          res.end(req.method === "HEAD" ? undefined : body);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
      });
      app.server = server;
      app.sockets = new Set();
      server.on("connection", (socket) => {
        app.sockets.add(socket);
        socket.on("close", () => app.sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      app.url = `http://127.0.0.1:${server.address().port}/${relative.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`;
      app.status = "running";
      this.apps.set(app.root, app);
      this.changed(app);
      return this.snapshot(app.root);
    } finally {
      this.starts.delete(workspace.root);
    }
  }
  input(root, appId, value, eof = false) {
    const app = this.apps.get(root);
    assert(
      app?.id === appId && active(app) && app.child && app.inputOpen,
      "ورودی این اجرا بسته شده است.",
    );
    text(value, 4000, "ورودی برنامه");
    assert(typeof eof === "boolean", "ورودی معتبر نیست.");
    if (value) app.child.stdin.write(value + "\n", "utf8");
    if (eof) {
      app.child.stdin.end();
      app.inputOpen = false;
      this.changed(app);
    }
    return true;
  }
  async stop(root, appId) {
    const app = this.apps.get(root);
    assert(app && app.id === appId, "این اجرا دیگر فعال نیست.");
    if (!active(app)) return this.snapshot(root);
    app.stopped = true;
    if (app.server) {
      app.server.closeAllConnections();
      for (const socket of app.sockets) socket.destroy();
      await new Promise((resolve) => app.server.close(resolve));
      app.status = "exited";
      app.url = null;
      app.endedAt = new Date().toISOString();
      this.changed(app);
    } else {
      await terminateChild(app.child);
      await app.done;
    }
    return this.snapshot(root);
  }
  async close() {
    await Promise.all(
      [...this.apps.values()]
        .filter(active)
        .map((app) => this.stop(app.root, app.id)),
    );
  }
}

async function launchOptions(workspace, previous = null) {
  const options = [];
  if (previous?.command)
    options.push({
      id: "last",
      title: previous.title || "برنامهٔ ساخته‌شده",
      command: previous.command,
      ...(previous.expectedURL ? { url: previous.expectedURL } : {}),
    });
  let pkg;
  try {
    pkg = JSON.parse((await workspace.read("package.json")).content);
  } catch {}
  for (const name of ["start", "dev"])
    if (typeof pkg?.scripts?.[name] === "string")
      options.push({
        id: "npm-" + name,
        title: `اجرای ${name}`,
        command: {
          program: "npm",
          args: ["run", name],
          cwd: ".",
          timeoutMs: 60000,
        },
      });
  const files = (await workspace.list(".", 250)).files
    .filter((f) => !f.directory)
    .map((f) => f.path);
  const entries = [
    "index.html",
    "public/index.html",
    "src/index.html",
    "cli.cjs",
    "cli.js",
    "src/cli.cjs",
    "src/cli.js",
    "app.cjs",
    "app.js",
    "main.cjs",
    "main.js",
    "server.cjs",
    "server.js",
    "index.cjs",
    "index.js",
    "app.py",
    "main.py",
  ];
  if (
    typeof pkg?.main === "string" &&
    files.includes(pkg.main) &&
    /\.(?:c?js|mjs)$/.test(pkg.main) &&
    !entries.includes(pkg.main)
  )
    entries.push(pkg.main);
  for (const file of entries.filter((file) => files.includes(file))) {
    if (/\.html$/.test(file))
      options.push({ id: "file-" + file, path: file, title: "نمایش " + file });
    else
      options.push({
        id: "file-" + file,
        title: "اجرای " + file,
        command: {
          program: file.endsWith(".py") ? "python" : "node",
          args: [file],
          cwd: ".",
          timeoutMs: 60000,
        },
      });
  }
  return options.slice(0, 12);
}
module.exports = { AppRuntime, localURL, launchOptions };
