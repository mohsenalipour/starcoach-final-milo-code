"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { assert, text, keys, id } = require("./protocol.cjs");
const { endpoint } = require("./provider.cjs");
class Settings {
  constructor(root, safeStorage) {
    this.root = root;
    this.safe = safeStorage;
    this.file = path.join(root, "settings.json");
    this.value = {
      baseURL: "https://api.avalai.ir/v1",
      model: "deepseek-v4.1-flash",
      encryptedKey: null,
      skills: [],
    };
    this.apiKey = "";
  }
  async load({ envFile } = {}) {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      this.value = { ...this.value, ...saved };
      if (saved.encryptedKey && this.safe.isEncryptionAvailable()) {
        try {
          this.apiKey = this.safe.decryptString(
            Buffer.from(saved.encryptedKey, "base64"),
          );
        } catch {
          this.value.encryptedKey = null;
        }
      }
    } catch (e) {
      if (e.code !== "ENOENT") this.value.encryptedKey = null;
    }
    if (!this.apiKey && envFile) {
      try {
        const vars = parseEnv(await fs.readFile(envFile, "utf8"));
        this.value.baseURL = vars.OPENAI_BASE_URL || this.value.baseURL;
        this.value.model = vars.OPENAI_MODEL || this.value.model;
        this.apiKey = vars.OPENAI_API_KEY || "";
        await this.persist();
      } catch {}
    }
    return this.public();
  }
  public() {
    return {
      baseURL: this.value.baseURL,
      model: this.value.model,
      hasKey: !!this.apiKey,
      keyStorage: this.apiKey
        ? this.value.encryptedKey
          ? "encrypted"
          : "memory"
        : "empty",
      skills: this.value.skills || [],
    };
  }
  config() {
    return {
      baseURL: this.value.baseURL,
      model: this.value.model,
      apiKey: this.apiKey,
    };
  }
  async update(input) {
    keys(input, ["baseURL", "model", "apiKey", "clearKey"]);
    text(input.baseURL, 300);
    endpoint(input.baseURL);
    text(input.model, 120);
    assert(input.model.trim(), "نام مدل خالی است.");
    if (input.apiKey !== undefined) text(input.apiKey, 1000);
    if (new URL(input.baseURL).origin !== new URL(this.value.baseURL).origin)
      this.apiKey = "";
    this.value.baseURL = input.baseURL.replace(/\/$/, "");
    this.value.model = input.model.trim();
    if (input.clearKey) this.apiKey = "";
    else if (input.apiKey) this.apiKey = input.apiKey.trim();
    await this.persist();
    return this.public();
  }
  async persist() {
    this.value.encryptedKey =
      this.apiKey && this.safe.isEncryptionAvailable()
        ? this.safe.encryptString(this.apiKey).toString("base64")
        : null;
    await fs.mkdir(this.root, { recursive: true });
    const tmp = this.file + "." + id() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.value, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }
  async saveSkills(items) {
    this.value.skills = items;
    await this.persist();
  }
}
function parseEnv(source) {
  const vars = {};
  for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)\s*=\s*(.*)$/);
    if (m) vars[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return vars;
}
module.exports = { Settings, parseEnv };
