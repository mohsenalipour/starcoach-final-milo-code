"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Settings } = require("../src/core/settings.cjs");
const {
  normaliseModels,
  fetchModels,
  modelsEndpoint,
} = require("../src/core/catalog.cjs");
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from("encrypted:" + s),
  decryptString: (b) => b.toString().slice(10),
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milo-providers-"));
  t.after(async () => {
    assert(
      path.basename(root).startsWith("milo-providers-") &&
        path.dirname(root) === os.tmpdir(),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  return new Settings(root, safe);
}
function update(s, providerId, apiKey, model = "chat-one") {
  return s.update({
    providerId,
    baseURL: s.profile(providerId).baseURL,
    apiKey,
    model,
  });
}
const ok = (body) => ({ ok: true, json: async () => body });
test("v1 settings migrate without losing encrypted key, model or skills", async (t) => {
  const s = await fixture(t),
    key = "old-private-key-123456";
  await fs.mkdir(s.root, { recursive: true });
  await fs.writeFile(
    s.file,
    JSON.stringify({
      baseURL: "https://api.avalai.ir/v1",
      model: "my-old-model",
      encryptedKey: safe.encryptString(key).toString("base64"),
      skills: [{ id: "example" }],
    }),
  );
  const pub = await s.load();
  assert.equal(pub.defaultSelection.providerId, "avalai");
  assert.equal(s.config().apiKey, key);
  assert.equal(s.config().model, "my-old-model");
  assert.equal(pub.skills[0].id, "example");
  assert.equal(JSON.parse(await fs.readFile(s.file, "utf8")).schemaVersion, 2);
  assert(!JSON.stringify(pub).includes(key));
});
test("provider credentials stay separate, persist encrypted, and never fall back to another provider", async (t) => {
  const s = await fixture(t);
  await update(s, "avalai", "avalai-private-123456");
  await update(s, "metis", "metis-private-987654");
  assert.equal(
    s.config({ providerId: "metis", model: "m" }).apiKey,
    "metis-private-987654",
  );
  assert.equal(s.config({ providerId: "boxapi", model: "m" }).apiKey, "");
  const saved = await fs.readFile(s.file, "utf8");
  assert(!saved.includes("avalai-private"));
  assert(!saved.includes("metis-private"));
  assert(!JSON.stringify(s.public()).includes("encryptedKey"));
  const restored = new Settings(s.root, safe);
  await restored.load();
  assert.equal(
    restored.config({ providerId: "avalai", model: "m" }).apiKey,
    "avalai-private-123456",
  );
  assert.equal(restored.allSecrets().length, 2);
});
test("discovery sends only the selected provider key, caches identities and survives restart", async (t) => {
  const s = await fixture(t);
  await update(s, "avalai", "avalai-private-123456");
  await update(s, "boxapi", "box-private-987654");
  const result = await s.discover("boxapi", {
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://ai.boxapi.ir/ai/v1/models");
      assert.equal(options.headers.Authorization, "Bearer box-private-987654");
      assert.equal(options.redirect, "error");
      return ok({
        data: [
          {
            id: "gpt-test",
            name: "GPT Test",
            api_key: "server-metadata-must-not-be-copied",
          },
        ],
      });
    },
  });
  assert.equal(result.models[0].id, "gpt-test");
  assert(!JSON.stringify(result).includes("api_key"));
  assert.equal(s.profile("avalai").models.length, 0);
  const restored = new Settings(s.root, safe);
  await restored.load();
  assert.equal(restored.profile("boxapi").models[0].id, "gpt-test");
  assert(restored.profile("boxapi").modelsFetchedAt);
});
test("catalog accepts model arrays, removes duplicates and rejects invalid or empty shapes", () => {
  assert.deepEqual(
    normaliseModels({
      models: ["b", { id: "a" }, { id: "b" }, { id: "bad\nid" }, null],
    }).map((m) => m.id),
    ["a", "b"],
  );
  assert.equal(normaliseModels([{ model_id: "one" }])[0].id, "one");
  assert.throws(() => normaliseModels({ data: [] }), {
    code: "MODEL_CATALOG_EMPTY",
  });
  assert.throws(() => normaliseModels({ error: "x" }), {
    code: "MODEL_CATALOG_FORMAT",
  });
  assert.throws(() => modelsEndpoint("http://untrusted.example/v1"));
  assert.equal(
    modelsEndpoint("https://api.metisai.ir/openai/v1/"),
    "https://api.metisai.ir/openai/v1/models",
  );
});
test("catalog errors keep the last good list and do not return sensitive server bodies", async (t) => {
  const s = await fixture(t);
  await s.discover("avalai", {
    fetchImpl: async () => ok({ data: [{ id: "good" }] }),
  });
  const at = s.profile("avalai").modelsFetchedAt;
  await assert.rejects(
    s.discover("avalai", {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        body: { cancel: async () => {} },
        json: async () => ({ secret: "private" }),
      }),
    }),
    /401/,
  );
  assert.equal(s.profile("avalai").models[0].id, "good");
  assert.equal(s.profile("avalai").modelsFetchedAt, at);
  await assert.rejects(
    fetchModels(s.config(), {
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        body: { cancel: async () => {} },
      }),
    }),
    /404/,
  );
});
test("a catalog arriving after key or endpoint changes is rejected", async (t) => {
  const s = await fixture(t);
  await update(s, "avalai", "first-private-123456");
  let finish;
  const request = s.discover("avalai", {
    fetchImpl: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await update(s, "avalai", "second-private-123456");
  finish(ok({ data: [{ id: "stale" }] }));
  await assert.rejects(request, { code: "CATALOG_STALE" });
  assert.equal(s.profile("avalai").models.length, 0);
});
test("project choices are independent and an explicit per-chat choice overrides its default", async (t) => {
  const s = await fixture(t),
    a = path.join(s.root, "project-a"),
    b = path.join(s.root, "project-b");
  await s.saveProject(a, { providerId: "metis", model: "model-a" });
  await s.saveProject(b, { providerId: "boxapi", model: "model-b" });
  assert.equal(s.forProject(a).model, "model-a");
  assert.equal(s.forProject(b).model, "model-b");
  assert.equal(s.forProject(path.join(s.root, "new")).providerId, "avalai");
  const override = s.config({ providerId: "avalai", model: "this-chat-only" });
  assert.equal(override.model, "this-chat-only");
  assert.equal(s.forProject(a).model, "model-a");
  const restored = new Settings(s.root, safe);
  await restored.load();
  assert.equal(restored.forProject(a).providerId, "metis");
});
test("changing one profile's host clears only its own key and cached models", async (t) => {
  const s = await fixture(t);
  await update(s, "avalai", "avalai-private-123456");
  await update(s, "metis", "metis-private-987654");
  await s.discover("metis", { fetchImpl: async () => ok(["old-model"]) });
  await s.update({
    providerId: "metis",
    baseURL: "https://new.example/v1",
    model: "",
  });
  assert.equal(s.config({ providerId: "metis", model: "x" }).apiKey, "");
  assert.equal(s.profile("metis").models.length, 0);
  assert.equal(
    s.config({ providerId: "avalai", model: "x" }).apiKey,
    "avalai-private-123456",
  );
});
test("when encryption is unavailable, API keys are never written as plaintext", async (t) => {
  const s = await fixture(t);
  s.safe = { isEncryptionAvailable: () => false };
  await update(s, "boxapi", "in-memory-private-123456");
  assert.equal(
    s.public().providers.find((p) => p.id === "boxapi").keyStorage,
    "memory",
  );
  assert(!(await fs.readFile(s.file, "utf8")).includes("in-memory-private"));
});
