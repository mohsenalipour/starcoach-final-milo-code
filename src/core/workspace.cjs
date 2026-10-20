"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { assert, hash, id, HarnessError, redact } = require("./protocol.cjs");
const MAX_BYTES = 200000;
const excluded = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".milo",
  ".dev-data",
  ".test-output",
  ".npm-cache",
  ".uv-cache",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  "coverage",
]);
function segments(rel) {
  assert(
    typeof rel === "string" &&
      rel.length <= 500 &&
      !/[\0:]/.test(rel) &&
      !path.isAbsolute(rel),
    "مسیر باید نسبی و داخل پروژه باشد.",
  );
  const parts = rel
    .replaceAll("\\", "/")
    .split("/")
    .filter((p) => p && p !== ".");
  for (const p of parts)
    assert(
      p !== ".." &&
        p === p.trim() &&
        !p.endsWith(".") &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      "مسیر فایل معتبر نیست.",
    );
  return parts;
}
function hidden(parts) {
  return parts.some(
    (p) =>
      excluded.has(p.toLowerCase()) ||
      /^\.env(?:\.|$)/i.test(p) ||
      /^(?:id_rsa|id_ed25519|credentials|secrets)(?:\.|$)/i.test(p) ||
      /\.(?:pem|key|pfx|p12)$/i.test(p),
  );
}
class Workspace {
  constructor(root) {
    this.root = root;
    this.revision = 0;
    this.changes = new Map();
  }
  static async open(root) {
    const real = await fs.realpath(root);
    assert((await fs.stat(real)).isDirectory(), "پوشهٔ پروژه معتبر نیست.");
    const forbidden = [
      path.parse(real).root,
      os.homedir(),
      process.env.SystemRoot,
      process.env.ProgramFiles,
    ].filter(Boolean);
    assert(
      !forbidden.some(
        (p) => path.resolve(p).toLowerCase() === real.toLowerCase(),
      ),
      "یک پوشهٔ پروژه انتخاب کن، نه پوشهٔ سیستم یا حساب کاربری.",
    );
    return new Workspace(real);
  }
  async resolve(rel, { directory = false, missing = false } = {}) {
    const parts = segments(rel);
    assert(
      !hidden(parts),
      "این مسیر خصوصی، سیستمی یا خروجی تولیدشده است.",
      "PRIVATE_PATH",
    );
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        const stat = await fs.lstat(current);
        assert(
          !stat.isSymbolicLink(),
          "عبور از لینک نمادین یا junction مجاز نیست.",
          "SYMLINK",
        );
        if (i < parts.length - 1)
          assert(stat.isDirectory(), "یکی از بخش‌های مسیر پوشه نیست.");
      } catch (error) {
        if (error.code === "ENOENT" && missing) break;
        throw error;
      }
    }
    const target = path.resolve(this.root, ...parts),
      relative = path.relative(this.root, target);
    assert(
      !relative.startsWith("..") && !path.isAbsolute(relative),
      "مسیر از پروژه خارج می‌شود.",
    );
    if (directory)
      assert((await fs.stat(target)).isDirectory(), "مسیر پوشه نیست.");
    return target;
  }
  async list(rel = ".", limit = 400) {
    const start = await this.resolve(rel, { directory: true }),
      results = [],
      queue = [start];
    let depthOmitted = false;
    while (queue.length && results.length < limit) {
      const folder = queue.shift();
      const entries = (await fs.readdir(folder, { withFileTypes: true })).sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        const file = path.join(folder, entry.name),
          r = path.relative(this.root, file).replaceAll("\\", "/");
        if (
          hidden(r.split("/")) ||
          entry.name.startsWith(".milo-tmp-") ||
          entry.isSymbolicLink()
        )
          continue;
        results.push({
          path: r,
          name: entry.name,
          directory: entry.isDirectory(),
        });
        if (entry.isDirectory()) {
          if (r.split("/").length < 7) queue.push(file);
          else depthOmitted = true;
        }
        if (results.length >= limit) break;
      }
    }
    return {
      files: results,
      truncated: depthOmitted || queue.length > 0 || results.length >= limit,
    };
  }
  async read(rel, { agent = false } = {}) {
    const file = await this.resolve(rel);
    const stat = await fs.stat(file);
    assert(
      stat.isFile() && stat.size <= MAX_BYTES,
      "فقط فایل متنی تا ۲۰۰ کیلوبایت قابل خواندن است.",
    );
    const bytes = await fs.readFile(file);
    assert(!bytes.includes(0), "فایل باینری قابل ویرایش نیست.");
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new HarnessError("کدگذاری فایل باید UTF-8 باشد.");
    }
    const cleaned = redact(content);
    return {
      path: rel,
      content: agent ? cleaned : content,
      hash: hash(bytes),
      redacted: cleaned !== content,
      bytes: bytes.length,
    };
  }
  async search(query, limit = 30) {
    assert(
      typeof query === "string" && query.length >= 1 && query.length <= 120,
      "عبارت جستجو معتبر نیست.",
    );
    const list = await this.list(".", 250),
      hits = [];
    for (const entry of list.files) {
      if (entry.directory) continue;
      let data;
      try {
        data = await this.read(entry.path, { agent: true });
      } catch {
        continue;
      }
      const lines = data.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query.toLowerCase()))
          hits.push({
            path: entry.path,
            line: i + 1,
            text: lines[i].slice(0, 600),
          });
        if (hits.length >= limit) return { matches: hits, truncated: true };
      }
    }
    return { matches: hits, truncated: list.truncated };
  }
  async write(rel, content, expectedHash, { actor = "agent" } = {}) {
    assert(
      typeof content === "string" &&
        Buffer.byteLength(content, "utf8") <= MAX_BYTES &&
        !content.includes("\0"),
      "محتوای فایل بیش از حد بزرگ است یا معتبر نیست.",
    );
    let file = await this.resolve(rel, { missing: true }),
      before = null;
    try {
      before = await this.read(rel);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert(
      before ? expectedHash === before.hash : expectedHash === null,
      "فایل بعد از خواندن تغییر کرده است؛ دوباره بخوان.",
      "FILE_CONFLICT",
    );
    if (actor === "agent")
      assert(
        !before?.redacted,
        "فایل شامل دادهٔ محرمانه است؛ فقط ویرایش مستقیم کاربر مجاز است.",
      );
    await fs.mkdir(path.dirname(file), { recursive: true });
    file = await this.resolve(rel, { missing: true });
    const temporary = path.join(path.dirname(file), ".milo-tmp-" + id());
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    try {
      const current = before ? await this.read(rel) : null;
      assert(
        !before || current.hash === before.hash,
        "فایل هم‌زمان تغییر کرده؛ دوباره بخوان.",
        "FILE_CONFLICT",
      );
      if (!before) {
        try {
          await fs.lstat(file);
          throw new HarnessError(
            "فایل هم‌زمان ساخته شده است.",
            "FILE_CONFLICT",
          );
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    const prior = this.changes.get(rel);
    const afterHash = hash(Buffer.from(content, "utf8"));
    this.changes.set(rel, {
      path: rel,
      before: prior ? prior.before : (before?.content ?? null),
      after: content,
      afterHash,
      actor,
    });
    this.revision++;
    return {
      path: rel,
      hash: afterHash,
      bytes: Buffer.byteLength(content),
      revision: this.revision,
    };
  }
  changeList() {
    return [...this.changes.values()].map((c) => ({ ...c }));
  }
  async fingerprint() {
    const listing = await this.list(".", 5000);
    assert(
      !listing.truncated,
      "پروژه برای اعتبارسنجی کامل این نسخه بزرگ یا بیش از ۷ پوشه عمیق است؛ یک زیرپروژهٔ مشخص انتخاب کن.",
      "PROJECT_TOO_LARGE",
    );
    const items = listing.files.filter((x) => !x.directory),
      sums = [];
    let total = 0;
    for (const item of items) {
      const file = await this.resolve(item.path),
        stat = await fs.stat(file);
      assert(stat.isFile(), "فایل حین اعتبارسنجی تغییر کرد.");
      total += stat.size;
      assert(
        total <= 128 * 1024 * 1024,
        "فایل‌های پروژه برای اعتبارسنجی این نسخه بیش از ۱۲۸MB هستند؛ زیرپروژهٔ مشخص‌تری انتخاب کن.",
        "PROJECT_TOO_LARGE",
      );
      const bytes = await fs.readFile(file);
      sums.push([item.path, hash(bytes)]);
    }
    return hash(JSON.stringify(sums));
  }
  async summary() {
    const tree = await this.list(".", 240);
    return { root: this.root, name: path.basename(this.root), ...tree };
  }
}
module.exports = { Workspace, segments, hidden, MAX_BYTES };
