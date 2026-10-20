"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { assert, id, redactValue } = require("./protocol.cjs");
class RunStore {
  constructor(root, { secrets = [] } = {}) {
    this.root = root;
    this.secrets = secrets;
    this.queue = Promise.resolve();
  }
  clean(value) {
    return redactValue(JSON.parse(JSON.stringify(value)), this.secrets);
  }
  file(runId) {
    assert(/^[a-f0-9-]{36}$/.test(runId), "شناسهٔ اجرا معتبر نیست.");
    return path.join(this.root, runId + ".json");
  }
  async save(state) {
    const target = this.file(state.id),
      data = this.clean(state);
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.root, { recursive: true });
        const tmp = target + "." + id() + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
        await fs.rename(tmp, target);
      });
    return this.queue;
  }
  async load(runId) {
    await this.queue;
    return JSON.parse(await fs.readFile(this.file(runId), "utf8"));
  }
  async list() {
    await this.queue;
    await fs.mkdir(this.root, { recursive: true });
    const result = [];
    for (const name of await fs.readdir(this.root)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const run = JSON.parse(
          await fs.readFile(path.join(this.root, name), "utf8"),
        );
        result.push({
          id: run.id,
          task: run.task,
          title: run.plan?.title || run.task,
          status: run.status,
          mode: run.mode,
          connection: run.connection || null,
          updatedAt: run.updatedAt,
          root: run.root,
        });
      } catch {}
    }
    return result
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 80);
  }
}
module.exports = { RunStore };
