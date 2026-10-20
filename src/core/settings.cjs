"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { assert, text, keys, id, hash } = require("./protocol.cjs");
const { endpoint } = require("./provider.cjs");
const { presets, fetchModels, catalogToken } = require("./catalog.cjs");
class Settings {
  constructor(root, safeStorage) {
    this.root = root;
    this.safe = safeStorage;
    this.file = path.join(root, "settings.json");
    this.value = {
      schemaVersion: 2,
      defaultSelection: { providerId: "avalai", model: "deepseek-v4.1-flash" },
      providers: presets.map((p) => ({
        ...p,
        encryptedKey: null,
        models: [],
        modelsFetchedAt: null,
      })),
      projects: {},
      skills: [],
    };
    this.apiKeys = new Map();
    this.queue = Promise.resolve();
    this.requests = new Map();
  }
  profile(providerId = this.value.defaultSelection.providerId) {
    const p = this.value.providers.find((p) => p.id === providerId);
    assert(p, "پرووایدر انتخاب‌شده معتبر نیست.");
    return p;
  }
  get apiKey() {
    return this.apiKeys.get(this.value.defaultSelection.providerId) || "";
  }
  allSecrets() {
    return [...this.apiKeys.values()].filter(Boolean);
  }
  async load({ envFile } = {}) {
    let migrated = false;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (saved.schemaVersion === 2 && Array.isArray(saved.providers)) {
        for (const preset of this.value.providers) {
          const item = saved.providers.find((p) => p.id === preset.id);
          if (item) {
            endpoint(item.baseURL);
            Object.assign(preset, {
              baseURL: item.baseURL,
              model: typeof item.model === "string" ? item.model : "",
              encryptedKey: item.encryptedKey || null,
              models: Array.isArray(item.models)
                ? item.models.slice(0, 3000)
                : [],
              modelsFetchedAt: item.modelsFetchedAt || null,
            });
          }
        }
        if (saved.defaultSelection)
          this.value.defaultSelection = this.selection(saved.defaultSelection);
        if (
          saved.projects &&
          typeof saved.projects === "object" &&
          !Array.isArray(saved.projects)
        )
          this.value.projects = saved.projects;
      } else if (saved.baseURL) {
        endpoint(saved.baseURL);
        const match =
          this.value.providers.find(
            (p) =>
              p.baseURL.replace(/\/$/, "") === saved.baseURL.replace(/\/$/, ""),
          ) || this.profile("custom");
        Object.assign(match, {
          baseURL: saved.baseURL,
          model: saved.model || "",
          encryptedKey: saved.encryptedKey || null,
        });
        this.value.defaultSelection = {
          providerId: match.id,
          model: match.model,
        };
        migrated = true;
      }
      this.value.skills = Array.isArray(saved.skills) ? saved.skills : [];
      for (const p of this.value.providers)
        if (p.encryptedKey && this.safe.isEncryptionAvailable()) {
          try {
            this.apiKeys.set(
              p.id,
              this.safe.decryptString(Buffer.from(p.encryptedKey, "base64")),
            );
          } catch {
            p.encryptedKey = null;
          }
        }
    } catch {
      /* Missing or damaged settings leave usable defaults. */
    }
    if (envFile && !this.allSecrets().length) {
      try {
        const vars = parseEnv(await fs.readFile(envFile, "utf8"));
        if (vars.OPENAI_API_KEY) {
          const baseURL = vars.OPENAI_BASE_URL || presets[0].baseURL;
          endpoint(baseURL);
          const p =
            this.value.providers.find((p) => p.baseURL === baseURL) ||
            this.profile("custom");
          p.baseURL = baseURL;
          p.model = vars.OPENAI_MODEL || p.model;
          this.apiKeys.set(p.id, vars.OPENAI_API_KEY);
          this.value.defaultSelection = { providerId: p.id, model: p.model };
          migrated = true;
        }
      } catch {}
    }
    if (migrated) await this.persist();
    return this.public();
  }
  public() {
    const providers = this.value.providers.map(({ encryptedKey, ...p }) => ({
      ...p,
      hasKey: !!this.apiKeys.get(p.id),
      keyStorage: this.apiKeys.get(p.id)
        ? encryptedKey
          ? "encrypted"
          : "memory"
        : "empty",
    }));
    const current = providers.find(
      (p) => p.id === this.value.defaultSelection.providerId,
    );
    return {
      schemaVersion: 2,
      defaultSelection: { ...this.value.defaultSelection },
      providers,
      skills: this.value.skills,
      baseURL: current.baseURL,
      model: this.value.defaultSelection.model,
      hasKey: current.hasKey,
      keyStorage: current.keyStorage,
    };
  }
  selection(input = this.value.defaultSelection) {
    keys(input, ["providerId", "model"]);
    const p = this.profile(input.providerId);
    text(input.model, 180, "شناسهٔ مدل");
    assert(!/[\x00-\x1f\x7f]/.test(input.model), "شناسهٔ مدل معتبر نیست.");
    return { providerId: p.id, model: input.model.trim() };
  }
  config(input) {
    const selected = this.selection(input),
      p = this.profile(selected.providerId);
    return {
      baseURL: p.baseURL,
      model: selected.model,
      apiKey: this.apiKeys.get(p.id) || "",
      providerId: p.id,
      providerName: p.name,
    };
  }
  projectKey(root) {
    const canonical = path.resolve(root);
    return hash(
      process.platform === "win32" ? canonical.toLowerCase() : canonical,
    );
  }
  forProject(root) {
    try {
      return this.selection(
        this.value.projects[this.projectKey(root)] ||
          this.value.defaultSelection,
      );
    } catch {
      return { ...this.value.defaultSelection };
    }
  }
  async saveProject(root, input) {
    const selected = this.selection(input);
    assert(selected.model, "ابتدا مدل این پروژه را انتخاب کن.");
    this.value.projects[this.projectKey(root)] = selected;
    await this.persist();
    return selected;
  }
  async update(input) {
    keys(input, [
      "providerId",
      "baseURL",
      "model",
      "apiKey",
      "clearKey",
      "makeDefault",
    ]);
    const p = this.profile(input.providerId);
    text(input.baseURL, 300);
    endpoint(input.baseURL);
    text(input.model, 180);
    assert(!/[\x00-\x1f\x7f]/.test(input.model), "شناسهٔ مدل معتبر نیست.");
    if (input.apiKey !== undefined) text(input.apiKey, 1000);
    const baseURL = input.baseURL.trim().replace(/\/$/, ""),
      oldKey = this.apiKeys.get(p.id) || "";
    let newKey =
      new URL(baseURL).origin !== new URL(p.baseURL).origin ? "" : oldKey;
    if (input.clearKey) newKey = "";
    else if (input.apiKey?.trim()) newKey = input.apiKey.trim();
    if (p.baseURL !== baseURL || newKey !== oldKey) {
      p.models = [];
      p.modelsFetchedAt = null;
      this.requests.delete(p.id);
    }
    p.baseURL = baseURL;
    p.model = input.model.trim();
    this.apiKeys.set(p.id, newKey);
    if (
      input.makeDefault ||
      (!input.providerId && p.id === this.value.defaultSelection.providerId)
    )
      this.value.defaultSelection = { providerId: p.id, model: p.model };
    await this.persist();
    return this.public();
  }
  async discover(providerId, options = {}) {
    const p = this.profile(providerId),
      config = this.config({ providerId: p.id, model: p.model }),
      token = catalogToken(config);
    const pending = this.requests.get(p.id);
    if (pending?.token === token) return pending.promise;
    const promise = (async () => {
      const models = await fetchModels(config, options);
      assert(
        catalogToken(this.config({ providerId: p.id, model: p.model })) ===
          token,
        "تنظیمات سرویس هنگام دریافت مدل‌ها تغییر کرد؛ دوباره تلاش کن.",
        "CATALOG_STALE",
      );
      p.models = models;
      p.modelsFetchedAt = new Date().toISOString();
      await this.persist();
      return { providerId: p.id, models, fetchedAt: p.modelsFetchedAt };
    })();
    this.requests.set(p.id, { token, promise });
    try {
      return await promise;
    } finally {
      if (this.requests.get(p.id)?.promise === promise)
        this.requests.delete(p.id);
    }
  }
  async persist() {
    const value = structuredClone(this.value);
    for (const p of value.providers) {
      const key = this.apiKeys.get(p.id);
      p.encryptedKey =
        key && this.safe.isEncryptionAvailable()
          ? this.safe.encryptString(key).toString("base64")
          : null;
      this.profile(p.id).encryptedKey = p.encryptedKey;
    }
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(this.root, { recursive: true });
        const tmp = this.file + "." + id() + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
        await fs.rename(tmp, this.file);
      });
    return this.queue;
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
