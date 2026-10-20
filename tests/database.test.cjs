"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { AppDatabase, readOnly } = require("../src/core/database.cjs");
const { Settings } = require("../src/core/settings.cjs");
const { RunStore } = require("../src/core/store.cjs");
const { id } = require("../src/core/protocol.cjs");
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) =>
    Buffer.from("sealed:" + Buffer.from(s).toString("base64")),
  decryptString: (b) => Buffer.from(b.toString().slice(7), "base64").toString(),
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milo-db-"));
  const connections = [];
  const open = () => {
    const db = new AppDatabase(root);
    connections.push(db);
    return db;
  };
  t.after(async () => {
    for (const db of connections) db.close();
    assert(
      path.dirname(root) === os.tmpdir() &&
        path.basename(root).startsWith("milo-db-"),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, open, db: open() };
}
function run(root, extra = {}) {
  const at = new Date().toISOString();
  return {
    id: id(),
    root: path.join(root, "project"),
    task: "یک برنامه بساز",
    mode: "live",
    status: "completed",
    createdAt: at,
    updatedAt: at,
    summary: "برنامه آماده است",
    events: [],
    changes: [],
    ...extra,
  };
}
test("SQLite persists encrypted provider settings, permissions, drafts and runs across a real reopen", async (t) => {
  const f = await fixture(t),
    s = new Settings(f.root, safe, { database: f.db });
  const key = "private-provider-value-12345678";
  await s.update({
    providerId: "avalai",
    baseURL: s.profile("avalai").baseURL,
    model: "test-model",
    apiKey: key,
  });
  await s.setProjectApproval(path.join(f.root, "project"), true);
  const store = new RunStore("", { database: f.db, secrets: [key] }),
    r = run(f.root, { summary: key });
  await store.save(r);
  f.db.saveDraft(r.root, {
    text: "درخواست ارسال‌نشده",
    selection: { providerId: "avalai", model: "draft-model" },
    remember: false,
  });
  f.db.close();
  const reopened = f.open(),
    restored = new Settings(f.root, safe, { database: reopened });
  await restored.load();
  assert.equal(restored.config().apiKey, key);
  assert.equal(restored.projectApproval(r.root).autoApproveCommands, true);
  assert.equal(reopened.draft(r.root).text, "درخواست ارسال‌نشده");
  assert.equal(reopened.draft(r.root).selection.model, "draft-model");
  assert.equal(reopened.loadRun(r.id).summary, "[REDACTED]");
  assert(!JSON.stringify(restored.public()).includes(key));
  assert(!(await fs.readFile(reopened.file)).includes(Buffer.from(key)));
  assert.equal(reopened.listRuns().length, 1);
});
test("legacy JSON migration is atomic, idempotent, preserves originals and links follow-ups", async (t) => {
  const f = await fixture(t),
    a = run(f.root),
    b = run(f.root, {
      continuation: { runId: a.id },
      task: "قابلیت دوم را اضافه کن",
    });
  await fs.mkdir(path.join(f.root, "runs"));
  const settings = { schemaVersion: 2, providers: [], skills: [] };
  await fs.writeFile(
    path.join(f.root, "settings.json"),
    JSON.stringify(settings),
  );
  for (const r of [b, a])
    await fs.writeFile(
      path.join(f.root, "runs", r.id + ".json"),
      JSON.stringify(r),
    );
  await fs.writeFile(path.join(f.root, "runs", id() + ".json"), "{broken");
  await f.db.migrateLegacy();
  assert.equal(f.db.info().counts.runs, 2);
  assert.equal(f.db.info().counts.conversations, 1);
  assert.equal(f.db.info().migration.skipped.length, 1);
  assert.equal(f.db.loadRun(b.id).conversationId, a.id);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, "settings.json"), "utf8"))
      .schemaVersion,
    2,
  );
  await f.db.migrateLegacy();
  assert.equal(f.db.info().counts.runs, 2);
});
test("failed migration rolls back all imported rows and can retry without data loss", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "runs"));
  const r = run(f.root, { conversationId: "invalid" });
  const file = path.join(f.root, "runs", r.id + ".json");
  await fs.writeFile(file, JSON.stringify(r));
  await assert.rejects(f.db.migrateLegacy());
  assert.equal(f.db.info().counts.runs, 0);
  delete r.conversationId;
  await fs.writeFile(file, JSON.stringify(r));
  await f.db.migrateLegacy();
  assert.equal(f.db.info().counts.runs, 1);
});
test("conversation search includes all turns, treats SQL wildcards literally and supports pagination", async (t) => {
  const f = await fixture(t);
  const first = run(f.root, { task: "اولین درخواست" });
  f.db.saveRun(first);
  const second = run(f.root, {
    continuation: { runId: first.id },
    task: "افزودن خروجی",
    summary: "مقدار 100% و a_b",
  });
  f.db.saveRun(second);
  for (let i = 0; i < 82; i++)
    f.db.saveRun(run(f.root, { task: "request " + i }));
  assert.equal(f.db.conversations({ query: "اولین درخواست" }).items.length, 1);
  assert.equal(f.db.conversations({ query: "100%" }).items.length, 1);
  assert.equal(f.db.conversations({ query: "a_b" }).items.length, 1);
  assert.equal(f.db.conversations({ query: "' OR 1=1 --" }).items.length, 0);
  assert.equal(f.db.conversations({ limit: 40 }).hasMore, true);
  assert.equal(f.db.conversations({ offset: 80, limit: 40 }).items.length, 3);
  assert.equal(f.db.thread(second.id).length, 2);
  assert.equal(f.db.context(first.id).length, 1);
  assert.equal(f.db.context(second.id).length, 2);
  assert.equal(f.db.info().counts.messages, 168);
});
test("every event survives state-tail trimming and saved approvals never resume after restart", async (t) => {
  const f = await fixture(t),
    r = run(f.root, {
      status: "awaiting_approval",
      approval: { nonce: "stale" },
    });
  const event = {
    id: id(),
    at: r.updatedAt,
    type: "tool",
    message: "first",
    data: {},
  };
  f.db.saveRun({ ...r, events: [event] });
  f.db.saveRun({ ...r, events: [{ ...event, id: id(), message: "second" }] });
  assert.equal(f.db.loadRun(r.id).events.length, 2);
  assert.equal(f.db.recoverInterrupted(), 1);
  const saved = readOnly(f.db.loadRun(r.id));
  assert.equal(saved.status, "interrupted");
  assert.equal(saved.approval, null);
  assert(saved.readOnly && saved.interrupted);
  assert.equal(saved.events.length, 3);
  assert.equal(f.db.recoverInterrupted(), 0);
});
test("online SQLite backup includes WAL writes; restore is atomic and revokes project command grants", async (t) => {
  const f = await fixture(t),
    r = run(f.root);
  await f.db.migrateLegacy();
  f.db.saveRun(r);
  f.db.setSetting("application", {
    projectPermissions: { project: { autoApproveCommands: true } },
  });
  const backup = path.join(f.root, "snapshot.sqlite");
  await f.db.backup(backup);
  f.db.saveRun(run(f.root, { task: "later" }));
  assert.equal(f.db.info().counts.runs, 2);
  const result = await f.db.restore(backup);
  assert.equal(f.db.info().counts.runs, 1);
  assert.deepEqual(f.db.getSetting("application").projectPermissions, {});
  assert((await fs.stat(result.previousBackup)).size > 0);
  assert(f.db.integrity().ok);
  await assert.rejects(f.db.backup(f.db.file));
  await assert.rejects(f.db.backup(f.db.file + "-wal"));
});
test("invalid or future backups do not change active data", async (t) => {
  const f = await fixture(t),
    r = run(f.root);
  f.db.saveRun(r);
  const bad = path.join(f.root, "bad.sqlite");
  const other = new DatabaseSync(bad);
  other.exec("PRAGMA user_version=99");
  other.close();
  await assert.rejects(f.db.restore(bad));
  assert.equal(f.db.loadRun(r.id).task, r.task);
  assert.equal(f.db.info().counts.runs, 1);
});
test("unavailable Windows encryption preserves ciphertext and explicit key deletion clears it", async (t) => {
  const f = await fixture(t),
    s = new Settings(f.root, safe, { database: f.db });
  await s.update({
    providerId: "avalai",
    baseURL: s.profile("avalai").baseURL,
    model: "m",
    apiKey: "do-not-drop-this-secret",
  });
  const before = f.db.getSetting("application").providers[0].encryptedKey;
  const locked = new Settings(
    f.root,
    {
      ...safe,
      decryptString: () => {
        throw Error("locked");
      },
    },
    { database: f.db },
  );
  await locked.load();
  assert.equal(locked.public().providers[0].keyStorage, "unavailable");
  await locked.saveSkills([]);
  assert.equal(
    f.db.getSetting("application").providers[0].encryptedKey,
    before,
  );
  await locked.update({
    providerId: "avalai",
    baseURL: locked.profile("avalai").baseURL,
    model: "m",
    clearKey: true,
  });
  assert.equal(f.db.getSetting("application").providers[0].encryptedKey, null);
});
