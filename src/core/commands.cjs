"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { assert, command, redact, stripANSI } = require("./protocol.cjs");
const execute = promisify(execFile);
const builtinPrograms = new Set(["node", "npm", "python", "py", "git"]);
const envKeys = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
];
function childEnv() {
  const env = {};
  for (const key of envKeys) if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    NO_COLOR: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}
async function locate(name) {
  if (process.platform === "win32") {
    const where = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "where.exe",
    );
    try {
      const { stdout } = await execute(where, [name], {
        windowsHide: true,
        timeout: 5000,
      });
      return stdout
        .trim()
        .split(/\r?\n/)
        .find((p) => path.isAbsolute(p));
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}
class CommandRunner {
  constructor({ secrets = [] } = {}) {
    this.secrets = secrets;
    this.child = null;
  }
  async prepare(input, workspace, extraPrograms = []) {
    const spec = command(input);
    assert(
      builtinPrograms.has(spec.program) || extraPrograms.includes(spec.program),
      "این برنامه توسط هارنس یا مهارت فعال تعریف نشده است.",
      "PROGRAM_BLOCKED",
    );
    const cwd = await workspace.resolve(spec.cwd, { directory: true });
    let executable,
      args = [...spec.args];
    if (spec.program === "node") {
      executable = process.execPath;
    } else if (spec.program === "npm") {
      const npm = await locate(
        process.platform === "win32" ? "npm.cmd" : "npm",
      );
      assert(
        npm,
        "برای فرمان npm باید Node.js روی سیستم نصب باشد.",
        "PROGRAM_MISSING",
      );
      let cli = path.join(
        path.dirname(npm),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      try {
        await fs.access(cli);
      } catch {
        cli = path.resolve(path.dirname(await fs.realpath(npm)), "npm-cli.js");
        await fs.access(cli);
      }
      executable = process.execPath;
      args = [cli, ...args];
    } else if (spec.program === "python") {
      const local = path.join(
        workspace.root,
        ".venv",
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python",
      );
      try {
        const st = await fs.lstat(local);
        if (st.isFile() && !st.isSymbolicLink()) executable = local;
      } catch {}
      executable ||= await locate(
        process.platform === "win32" ? "python.exe" : "python3",
      );
    } else executable = await locate(spec.program);
    assert(
      executable && path.isAbsolute(executable),
      `برنامهٔ ${spec.program} روی سیستم پیدا نشد.`,
      "PROGRAM_MISSING",
    );
    assert(
      !/\.(?:cmd|bat|ps1)$/i.test(executable),
      "اجرای فایل پوسته مجاز نیست؛ مهارت باید یک executable واقعی معرفی کند.",
    );
    return { spec, executable, args, cwd };
  }
  async run(prepared, { signal, onOutput = () => {} } = {}) {
    assert(!this.child, "یک فرمان دیگر در حال اجراست.");
    assert(!signal?.aborted, "عملیات متوقف شده است.", "ABORTED");
    const started = Date.now(),
      limit = 64000;
    let stdout = "",
      stderr = "",
      truncated = false,
      timedOut = false,
      aborted = false;
    return new Promise((resolve, reject) => {
      const child = spawn(prepared.executable, prepared.args, {
        cwd: prepared.cwd,
        env: childEnv(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      const kill = () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          execFile(
            path.join(
              process.env.SystemRoot || "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 5000 },
            () => {
              try {
                child.kill("SIGKILL");
              } catch {}
            },
          );
          const fallback = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 1000);
          fallback.unref();
        } else child.kill("SIGKILL");
      };
      const cancel = () => {
        aborted = true;
        kill();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, prepared.spec.timeoutMs);
      const add = (stream, chunk) => {
        const clean = redact(stripANSI(chunk.toString("utf8")), this.secrets);
        if (stream === "stdout") {
          truncated ||= stdout.length + clean.length > limit;
          stdout = (stdout + clean).slice(0, limit);
        } else {
          truncated ||= stderr.length + clean.length > limit;
          stderr = (stderr + clean).slice(0, limit);
        }
        onOutput({ stream, text: clean.slice(0, 8000) });
      };
      child.stdout.on("data", (c) => add("stdout", c));
      child.stderr.on("data", (c) => add("stderr", c));
      signal?.addEventListener("abort", cancel, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.child = null;
      };
      child.once("error", (e) => {
        cleanup();
        reject(e);
      });
      child.once("close", (code, processSignal) => {
        cleanup();
        resolve({
          command: prepared.spec,
          exitCode: code,
          signal: processSignal,
          stdout,
          stderr,
          truncated,
          timedOut,
          aborted,
          durationMs: Date.now() - started,
          ok: code === 0 && !timedOut && !aborted,
        });
      });
    });
  }
}
module.exports = { CommandRunner, childEnv, builtinPrograms, locate };
