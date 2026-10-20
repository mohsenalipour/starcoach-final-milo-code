"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");
const { assert, hash, id, redactValue } = require("./protocol.cjs");

const VERSION = 1;
const running = new Set([
  "planning",
  "awaiting_plan",
  "running",
  "awaiting_approval",
  "verifying",
  "correcting",
  "reviewing",
]);
const tables = {
  metadata: ["key", "value"],
  settings: ["key", "value", "updated_at"],
  projects: ["id", "root", "name", "mode", "created_at", "updated_at"],
  conversations: ["id", "project_id", "title", "created_at", "updated_at"],
  runs: [
    "id",
    "project_id",
    "conversation_id",
    "task",
    "title",
    "status",
    "mode",
    "connection",
    "created_at",
    "updated_at",
    "state",
  ],
  messages: [
    "id",
    "conversation_id",
    "run_id",
    "role",
    "content",
    "created_at",
  ],
  run_events: ["id", "run_id", "at", "type", "message", "data"],
  drafts: ["context", "value", "updated_at"],
};
const now = () => new Date().toISOString();
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
function projectId(root) {
  const resolved = path.resolve(root);
  return hash(process.platform === "win32" ? resolved.toLowerCase() : resolved);
}
function readOnly(run) {
  return {
    ...run,
    readOnly: true,
    approval: null,
    interrupted: run.status === "interrupted" || running.has(run.status),
  };
}
class AppDatabase {
  constructor(root) {
    fs.mkdirSync(root, { recursive: true });
    this.root = path.resolve(root);
    this.file = path.join(this.root, "milo.sqlite");
    this.db = new DatabaseSync(this.file, {
      enableForeignKeyConstraints: true,
    });
    try {
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      assert(
        version <= VERSION,
        "این دیتابیس متعلق به نسخهٔ جدیدتر Milo است؛ برنامه را به‌روز کن.",
      );
      if (!version)
        this.transaction(() => {
          this.db.exec(`
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE projects (
            id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE conversations (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
            title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE runs (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            task TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL,
            connection TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL
          );
          CREATE INDEX runs_conversation ON runs(conversation_id, created_at);
          CREATE INDEX runs_updated ON runs(updated_at DESC);
          CREATE INDEX conversations_updated ON conversations(updated_at DESC);
          CREATE TABLE messages (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(run_id, role)
          );
          CREATE INDEX messages_conversation ON messages(conversation_id, created_at);
          CREATE TABLE run_events (
            id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            at TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL
          );
          CREATE INDEX events_run ON run_events(run_id, at);
          CREATE TABLE drafts (context TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
          PRAGMA user_version=1;
        `);
          this.db
            .prepare("INSERT INTO metadata VALUES (?,?)")
            .run("format", "milo-code");
        });
      assert(
        this.db.prepare("SELECT value FROM metadata WHERE key='format'").get()
          ?.value === "milo-code",
        "قالب دیتابیس Milo معتبر نیست.",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  getSetting(key, fallback = null) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key, value) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      )
      .run(key, JSON.stringify(value), now());
  }
  rememberProject(root, name = path.basename(root), mode = "live") {
    const pid = projectId(root),
      at = now();
    this.db
      .prepare(
        "INSERT INTO projects VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, mode=excluded.mode, updated_at=excluded.updated_at",
      )
      .run(pid, path.resolve(root), name, mode, at, at);
    return pid;
  }
  projects() {
    return this.db
      .prepare(
        "SELECT root,name,mode,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC",
      )
      .all()
      .map((p) => ({ ...p }));
  }
  saveRun(source, secrets = []) {
    const run = redactValue(JSON.parse(JSON.stringify(source)), secrets);
    assert(uuid(run.id), "شناسهٔ اجرا معتبر نیست.");
    assert(
      typeof run.root === "string" && path.isAbsolute(run.root),
      "مسیر اجرای ذخیره‌شده معتبر نیست.",
    );
    return this.transaction(() => {
      const at = run.updatedAt || now(),
        created = run.createdAt || at;
      const pid = this.rememberProject(
        run.root,
        path.basename(run.root).replace(/-[a-f0-9]{8}$/, ""),
        run.mode || "live",
      );
      const existing = this.db
        .prepare("SELECT conversation_id FROM runs WHERE id=?")
        .get(run.id);
      const parent = run.continuation?.runId
        ? this.db
            .prepare(
              "SELECT conversation_id FROM runs WHERE id=? AND project_id=?",
            )
            .get(run.continuation.runId, pid)
        : null;
      let cid =
        existing?.conversation_id ||
        parent?.conversation_id ||
        run.conversationId ||
        run.id;
      assert(uuid(cid), "شناسهٔ گفتگو معتبر نیست.");
      const conversation = this.db
        .prepare("SELECT project_id FROM conversations WHERE id=?")
        .get(cid);
      assert(
        !conversation || conversation.project_id === pid,
        "گفتگو متعلق به پروژهٔ دیگری است.",
      );
      const title = run.plan?.title || run.task || "گفتگوی تازه";
      this.db
        .prepare(
          "INSERT INTO conversations VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=MAX(conversations.updated_at,excluded.updated_at)",
        )
        .run(cid, pid, title.slice(0, 160), created, at);
      if (cid === run.id)
        this.db
          .prepare("UPDATE conversations SET title=? WHERE id=?")
          .run(title.slice(0, 160), cid);
      run.conversationId = cid;
      this.db
        .prepare(
          `INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET task=excluded.task,title=excluded.title,status=excluded.status,
        connection=excluded.connection,updated_at=excluded.updated_at,state=excluded.state`,
        )
        .run(
          run.id,
          pid,
          cid,
          run.task || "",
          title,
          run.status || "needs_attention",
          run.mode || "live",
          run.connection ? JSON.stringify(run.connection) : null,
          created,
          at,
          JSON.stringify(run),
        );
      const putMessage = this.db.prepare(
        "INSERT INTO messages VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content",
      );
      putMessage.run(
        run.id + ":user",
        cid,
        run.id,
        "user",
        run.task || "",
        created,
      );
      putMessage.run(
        run.id + ":assistant",
        cid,
        run.id,
        "assistant",
        run.summary || run.plan?.summary || run.events?.at(-1)?.message || "",
        at,
      );
      const putEvent = this.db.prepare(
        "INSERT OR IGNORE INTO run_events VALUES (?,?,?,?,?,?)",
      );
      for (const event of run.events || [])
        putEvent.run(
          event.id || id(),
          run.id,
          event.at || at,
          event.type || "event",
          event.message || "",
          JSON.stringify(event.data || {}),
        );
      return run;
    });
  }
  loadRun(runId) {
    assert(uuid(runId), "شناسهٔ اجرا معتبر نیست.");
    const row = this.db.prepare("SELECT state FROM runs WHERE id=?").get(runId);
    assert(row, "گفتگوی انتخاب‌شده پیدا نشد.");
    const run = JSON.parse(row.state);
    run.events = this.db
      .prepare(
        "SELECT id,at,type,message,data FROM run_events WHERE run_id=? ORDER BY at,rowid",
      )
      .all(runId)
      .map(({ data, ...event }) => ({ ...event, data: JSON.parse(data) }));
    return run;
  }
  listRuns() {
    return this.db
      .prepare(
        "SELECT r.id,r.conversation_id AS conversationId,r.task,r.title,r.status,r.mode,r.connection,r.updated_at AS updatedAt,p.root FROM runs r JOIN projects p ON p.id=r.project_id ORDER BY updatedAt DESC",
      )
      .all()
      .map((r) => ({
        ...r,
        connection: r.connection ? JSON.parse(r.connection) : null,
      }));
  }
  conversations({ query = "", offset = 0, limit = 40 } = {}) {
    assert(
      typeof query === "string" && query.length <= 200,
      "جستجو بیش از حد طولانی است.",
    );
    assert(
      Number.isInteger(offset) &&
        offset >= 0 &&
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 100,
      "صفحهٔ تاریخچه معتبر نیست.",
    );
    const match = "%" + query.trim().replace(/[\\%_]/g, "\\$&") + "%";
    const rows = this.db
      .prepare(
        String.raw`SELECT c.id AS conversationId,c.title,c.updated_at AS updatedAt,p.root,p.name,
        r.id,r.status,r.mode,r.connection,
        (SELECT COUNT(*) FROM runs WHERE conversation_id=c.id) AS turnCount
      FROM conversations c JOIN projects p ON p.id=c.project_id
      JOIN runs r ON r.id=(SELECT id FROM runs WHERE conversation_id=c.id ORDER BY created_at DESC,rowid DESC LIMIT 1)
      WHERE ?='' OR c.title LIKE ? ESCAPE '\' OR p.root LIKE ? ESCAPE '\'
        OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ? ESCAPE '\')
        OR EXISTS(SELECT 1 FROM runs s WHERE s.conversation_id=c.id AND s.connection LIKE ? ESCAPE '\')
      ORDER BY c.updated_at DESC,c.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(query.trim(), match, match, match, match, limit + 1, offset);
    return {
      items: rows
        .slice(0, limit)
        .map((r) => ({
          ...r,
          connection: r.connection ? JSON.parse(r.connection) : null,
        })),
      hasMore: rows.length > limit,
    };
  }
  thread(runId) {
    const run = this.loadRun(runId);
    return this.db
      .prepare(
        `SELECT r.id,r.task,r.title,r.status,r.created_at AS createdAt,
      (SELECT content FROM messages WHERE run_id=r.id AND role='assistant') AS answer
      FROM runs r WHERE r.conversation_id=? ORDER BY r.created_at,r.rowid`,
      )
      .all(run.conversationId)
      .map((r) => ({ ...r }));
  }
  context(runId) {
    const rows = this.thread(runId),
      index = rows.findIndex((r) => r.id === runId);
    return rows.slice(Math.max(0, index - 5), index + 1).map((r) => ({
      task: r.task.slice(0, 1800),
      summary: (r.answer || "").slice(0, 1400),
    }));
  }
  draft(root) {
    const row = this.db
      .prepare("SELECT value FROM drafts WHERE context=?")
      .get(root ? projectId(root) : "home");
    return row
      ? JSON.parse(row.value)
      : { text: "", selection: null, remember: true };
  }
  saveDraft(root, value, secrets = []) {
    const clean = redactValue(structuredClone(value), secrets);
    this.db
      .prepare(
        "INSERT INTO drafts VALUES (?,?,?) ON CONFLICT(context) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
      .run(root ? projectId(root) : "home", JSON.stringify(clean), now());
  }
  recoverInterrupted() {
    const rows = this.db.prepare("SELECT state FROM runs").all();
    let count = 0;
    for (const row of rows) {
      const run = JSON.parse(row.state);
      if (!running.has(run.status)) continue;
      run.interruptedFrom = run.status;
      run.status = "interrupted";
      run.approval = null;
      const at = now();
      run.events = [
        ...(run.events || []),
        {
          id: id(),
          at,
          type: "recovery",
          message:
            "اجرا با بسته‌شدن برنامه قطع شده بود؛ هیچ فرمانی خودکار تکرار نشد.",
          data: {},
        },
      ];
      this.saveRun(run);
      count++;
    }
    return count;
  }
  async migrateLegacy() {
    if (
      this.db
        .prepare("SELECT value FROM metadata WHERE key='legacy-import'")
        .get()
    )
      return;
    const report = { at: now(), settings: false, runs: 0, skipped: [] };
    async function json(file) {
      try {
        return JSON.parse(await fsp.readFile(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") {
          if (!(error instanceof SyntaxError)) throw error;
          report.skipped.push(path.basename(file));
        }
        return null;
      }
    }
    const saved = await json(path.join(this.root, "settings.json"));
    const legacyRuns = [];
    let names = [];
    try {
      names = await fsp.readdir(path.join(this.root, "runs"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of names.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const run = await json(path.join(this.root, "runs", name));
      if (!run) continue;
      if (
        uuid(run.id) &&
        typeof run.root === "string" &&
        path.isAbsolute(run.root) &&
        typeof run.task === "string"
      )
        legacyRuns.push(run);
      else report.skipped.push(name);
    }
    // Import parents first so existing follow-ups retain their conversation.
    const imported = new Set(),
      visiting = new Set(),
      byId = new Map(legacyRuns.map((r) => [r.id, r]));
    const ordered = [];
    const visit = (run) => {
      if (imported.has(run.id) || visiting.has(run.id)) return;
      visiting.add(run.id);
      const parent = byId.get(run.continuation?.runId);
      if (parent) visit(parent);
      visiting.delete(run.id);
      imported.add(run.id);
      ordered.push(run);
    };
    legacyRuns
      .sort((a, b) =>
        String(a.createdAt || a.updatedAt).localeCompare(
          String(b.createdAt || b.updatedAt),
        ),
      )
      .forEach(visit);
    this.transaction(() => {
      if (
        saved &&
        typeof saved === "object" &&
        !Array.isArray(saved) &&
        !this.getSetting("application")
      ) {
        this.setSetting("application", saved);
        report.settings = true;
      }
      for (const run of ordered) {
        if (!this.db.prepare("SELECT 1 FROM runs WHERE id=?").get(run.id)) {
          this.saveRun(run);
          report.runs++;
        }
      }
      this.db
        .prepare("INSERT INTO metadata VALUES (?,?)")
        .run("legacy-import", JSON.stringify(report));
    });
  }
  info() {
    const counts = {};
    for (const name of [
      "projects",
      "conversations",
      "runs",
      "messages",
      "drafts",
    ])
      counts[name] = this.db
        .prepare("SELECT COUNT(*) AS n FROM " + name)
        .get().n;
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        bytes += fs.statSync(this.file + suffix).size;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    const legacy = this.db
      .prepare("SELECT value FROM metadata WHERE key='legacy-import'")
      .get();
    return {
      engine: "SQLite",
      schemaVersion: VERSION,
      file: this.file,
      bytes,
      counts,
      migration: legacy ? JSON.parse(legacy.value) : null,
    };
  }
  integrity() {
    const result = this.db
      .prepare("PRAGMA quick_check")
      .all()
      .map((r) => Object.values(r)[0]);
    const foreignKeys = this.db
      .prepare("PRAGMA foreign_key_check")
      .all().length;
    return {
      ok: result.length === 1 && result[0] === "ok" && foreignKeys === 0,
      checkedAt: now(),
      foreignKeyErrors: foreignKeys,
    };
  }
  async backup(target) {
    assert(
      path.resolve(target).toLowerCase() !== this.file.toLowerCase(),
      "فایل پشتیبان باید با دیتابیس اصلی متفاوت باشد.",
    );
    assert(
      !path
        .resolve(target)
        .toLowerCase()
        .startsWith(this.file.toLowerCase() + "-"),
      "مسیر پشتیبان معتبر نیست.",
    );
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await backup(this.db, target);
    return target;
  }
  async restore(source) {
    assert(
      path.resolve(source).toLowerCase() !== this.file.toLowerCase(),
      "دیتابیس فعال را به‌عنوان پشتیبان انتخاب نکن.",
    );
    const external = new DatabaseSync(source, {
      readOnly: true,
      enableForeignKeyConstraints: true,
    });
    let snapshot;
    try {
      external.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      assert(
        external.prepare("PRAGMA user_version").get().user_version === VERSION,
        "نسخهٔ فایل پشتیبان پشتیبانی نمی‌شود.",
      );
      assert(
        external.prepare("SELECT value FROM metadata WHERE key='format'").get()
          ?.value === "milo-code",
        "این فایل پشتیبان Milo نیست.",
      );
      assert(
        Object.values(external.prepare("PRAGMA quick_check").get())[0] === "ok",
        "فایل پشتیبان آسیب دیده است.",
      );
      assert(
        external.prepare("PRAGMA foreign_key_check").all().length === 0,
        "ارتباط داده‌های پشتیبان معتبر نیست.",
      );
      snapshot = {};
      for (const [table, columns] of Object.entries(tables)) {
        assert(
          external
            .prepare("SELECT type FROM sqlite_schema WHERE name=?")
            .get(table)?.type === "table",
          "ساختار پشتیبان معتبر نیست.",
        );
        snapshot[table] = external
          .prepare("SELECT " + columns.join(",") + " FROM " + table)
          .all();
      }
      for (const row of snapshot.settings) JSON.parse(row.value);
      for (const row of snapshot.runs) {
        const state = JSON.parse(row.state);
        assert(
          state.id === row.id && uuid(state.id) && path.isAbsolute(state.root),
          "گزارش پشتیبان معتبر نیست.",
        );
      }
      for (const row of snapshot.drafts) JSON.parse(row.value);
    } finally {
      external.close();
    }
    const previous = path.join(
      this.root,
      "backups",
      "before-restore-" + now().replace(/[:.]/g, "-") + ".sqlite",
    );
    await this.backup(previous);
    this.transaction(() => {
      for (const table of Object.keys(tables).reverse())
        this.db.exec("DELETE FROM " + table);
      for (const [table, columns] of Object.entries(tables)) {
        const statement = this.db.prepare(
          "INSERT INTO " +
            table +
            " (" +
            columns.join(",") +
            ") VALUES (" +
            columns.map(() => "?").join(",") +
            ")",
        );
        for (const row of snapshot[table])
          statement.run(...columns.map((col) => row[col]));
      }
      const settings = this.getSetting("application");
      if (settings) {
        settings.projectPermissions = {};
        this.setSetting("application", settings);
      }
      // Never reimport old JSON after restoring or resurrect old command approvals.
      this.db
        .prepare("INSERT OR IGNORE INTO metadata VALUES (?,?)")
        .run(
          "legacy-import",
          JSON.stringify({ at: now(), restored: true, skipped: [] }),
        );
    });
    this.recoverInterrupted();
    return { previousBackup: previous };
  }
  close() {
    if (this.db.isOpen) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.close();
    }
  }
}
module.exports = { AppDatabase, projectId, readOnly };
