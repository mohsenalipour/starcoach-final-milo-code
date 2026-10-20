"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
async function main() {
  const root = path.resolve(__dirname, "..");
  const data = path.join(
    root,
    ".test-output",
    "persistence-" + crypto.randomUUID().slice(0, 8),
  );
  await fs.mkdir(data, { recursive: true });
  const binary = process.argv[2]
    ? path.resolve(process.argv[2])
    : require("electron");
  const results = [];
  for (const phase of ["seed", "restore", "draft"]) {
    const env = {
      ...process.env,
      MILO_DATA_DIR: data,
      MILO_SMOKE: "1",
      MILO_SMOKE_STORAGE: "1",
      MILO_STORAGE_PHASE: phase,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.MILO_SMOKE_KEEP_OPEN;
    const child = spawn(binary, process.argv[2] ? [] : [root], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => {
      output = (output + b).slice(-10000);
    });
    child.stderr.on("data", (b) => {
      output = (output + b).slice(-10000);
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Desktop persistence smoke timed out: " + phase));
      }, 45000);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (code !== 0) {
      let error = "";
      try {
        error = await fs.readFile(
          path.join(data, "desktop-smoke-error.json"),
          "utf8",
        );
      } catch {}
      throw Error(
        "Persistence smoke failed: " +
          phase +
          " " +
          code +
          "\n" +
          error +
          "\n" +
          output,
      );
    }
    const result = JSON.parse(
      await fs.readFile(
        path.join(data, "persistence-" + phase + ".json"),
        "utf8",
      ),
    );
    assert(
      result.restoredProject &&
        result.restoredConversation &&
        result.databaseIntegrity,
    );
    results.push(result);
  }
  const summary = {
    version: require("../package.json").version,
    actualProcessRestarts: 2,
    packaged: !!process.argv[2],
    phases: results,
  };
  await fs.writeFile(
    path.join(data, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  await fs.writeFile(
    path.join(root, ".test-output", "persistence-latest.json"),
    JSON.stringify({ evidencePath: data, ...summary }, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
