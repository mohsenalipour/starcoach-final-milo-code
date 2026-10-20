"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { assert, command, keys, text, hash } = require("./protocol.cjs");
async function loadSkill(folder, { builtin = false, trustedHash = null } = {}) {
  const root = await fs.realpath(folder);
  const read = async (name) => {
    const file = path.join(root, name),
      st = await fs.lstat(file);
    assert(
      st.isFile() && !st.isSymbolicLink() && st.size <= 32000,
      "فایل مهارت معتبر نیست.",
    );
    return fs.readFile(file, "utf8");
  };
  const manifestRaw = await read("skill.json"),
    instructions = await read("SKILL.md");
  const manifest = JSON.parse(manifestRaw);
  keys(manifest, ["id", "name", "description", "version", "tools"]);
  assert(
    /^[a-z][a-z0-9-]{2,50}$/.test(manifest.id),
    "شناسهٔ مهارت معتبر نیست.",
  );
  text(manifest.name, 100);
  text(manifest.description, 500);
  text(manifest.version, 30);
  assert(
    Array.isArray(manifest.tools) && manifest.tools.length <= 8,
    "حداکثر ۸ ابزار برای هر مهارت پذیرفته می‌شود.",
  );
  const seen = new Set();
  const tools = manifest.tools.map((tool) => {
    keys(tool, ["id", "description", "command"]);
    assert(
      /^[a-z][a-z0-9_]{1,40}$/.test(tool.id) && !seen.has(tool.id),
      "شناسهٔ ابزار تکراری یا نامعتبر است.",
    );
    seen.add(tool.id);
    text(tool.description, 300);
    return { ...tool, command: command(tool.command) };
  });
  const digest = hash(manifestRaw + "\n" + instructions);
  return {
    ...manifest,
    tools,
    instructions,
    root,
    digest,
    builtin,
    trusted: builtin || digest === trustedHash,
    enabled: builtin || digest === trustedHash,
  };
}
class SkillRegistry {
  constructor() {
    this.items = new Map();
  }
  async loadBuiltins(root) {
    for (const dir of await fs.readdir(root, { withFileTypes: true }))
      if (dir.isDirectory()) {
        const skill = await loadSkill(path.join(root, dir.name), {
          builtin: true,
        });
        this.items.set(skill.id, skill);
      }
  }
  async inspect(folder) {
    return loadSkill(folder);
  }
  async import(folder, digest) {
    const skill = await loadSkill(folder, { trustedHash: digest });
    assert(
      skill.trusted,
      "مهارت از زمان بازبینی تغییر کرده؛ دوباره بررسی کن.",
      "SKILL_CHANGED",
    );
    assert(
      !this.items.get(skill.id)?.builtin,
      "شناسهٔ مهارت داخلی قابل جایگزینی نیست.",
    );
    this.items.set(skill.id, skill);
    return skill;
  }
  async setEnabled(id, enabled) {
    const skill = this.items.get(id);
    assert(skill, "مهارت پیدا نشد.");
    const fresh = await loadSkill(skill.root, {
      builtin: skill.builtin,
      trustedHash: skill.digest,
    });
    assert(
      fresh.trusted,
      "محتوای مهارت تغییر کرده؛ باید دوباره تأیید شود.",
      "SKILL_CHANGED",
    );
    fresh.enabled = !!enabled;
    this.items.set(id, fresh);
  }
  list() {
    return [...this.items.values()].map(({ instructions, ...item }) => item);
  }
  async context() {
    const out = [];
    for (const item of this.items.values()) {
      if (!item.enabled) continue;
      const fresh = await loadSkill(item.root, {
        builtin: item.builtin,
        trustedHash: item.digest,
      });
      assert(
        fresh.trusted,
        "مهارت تغییر کرده و نیاز به بازبینی دارد.",
        "SKILL_CHANGED",
      );
      out.push({
        id: fresh.id,
        name: fresh.name,
        instructions: fresh.instructions,
        tools: fresh.tools,
      });
    }
    return out;
  }
  async tool(skillId, toolId) {
    const skill = this.items.get(skillId);
    assert(skill?.enabled && skill.trusted, "این مهارت فعال و تأییدشده نیست.");
    const fresh = await loadSkill(skill.root, {
      builtin: skill.builtin,
      trustedHash: skill.digest,
    });
    assert(fresh.trusted, "مهارت تغییر کرده است.", "SKILL_CHANGED");
    const tool = fresh.tools.find((t) => t.id === toolId);
    assert(tool, "ابزار مهارت پیدا نشد.");
    return tool;
  }
  extraPrograms() {
    return [
      ...new Set(
        [...this.items.values()]
          .filter((s) => s.enabled && s.trusted)
          .flatMap((s) => s.tools.map((t) => t.command.program)),
      ),
    ];
  }
}
module.exports = { loadSkill, SkillRegistry };
