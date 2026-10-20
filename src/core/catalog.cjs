"use strict";
const { assert, hash } = require("./protocol.cjs");
const { endpoint } = require("./provider.cjs");
const presets = Object.freeze([
  {
    id: "avalai",
    name: "AvalAI",
    baseURL: "https://api.avalai.ir/v1",
    model: "deepseek-v4.1-flash",
    docsURL: "https://docs.avalai.org/en/api-reference/models",
  },
  {
    id: "metis",
    name: "Metis",
    baseURL: "https://api.metisai.ir/openai/v1",
    model: "",
    docsURL: "https://docs.metisai.ir/api/wrapper/openai/",
  },
  {
    id: "boxapi",
    name: "BoxAPI",
    baseURL: "https://ai.boxapi.ir/ai/v1",
    model: "",
    docsURL: "https://boxapi.ir/docs/ai/",
  },
  {
    id: "custom",
    name: "سرویس دیگر",
    baseURL: "https://api.openai.com/v1",
    model: "",
    docsURL: "",
  },
]);
function modelsEndpoint(baseURL) {
  return endpoint(baseURL).replace(/\/chat\/completions$/, "/models");
}
function catalogToken(config) {
  return hash(config.baseURL + "\n" + (config.apiKey || ""));
}
function normaliseModels(body) {
  const items = Array.isArray(body) ? body : (body?.data ?? body?.models);
  assert(
    Array.isArray(items),
    "پرووایدر فهرست مدل استانداردی برنگرداند؛ شناسهٔ مدل را می‌توانی دستی وارد کنی.",
    "MODEL_CATALOG_FORMAT",
  );
  const found = new Map();
  for (const item of items.slice(0, 10000)) {
    const id =
      typeof item === "string"
        ? item
        : (item?.id ?? item?.model_id ?? item?.model);
    if (
      typeof id !== "string" ||
      !id.trim() ||
      id.length > 180 ||
      /[\x00-\x1f\x7f]/.test(id)
    )
      continue;
    const label =
      typeof item === "object" ? (item.name ?? item.display_name ?? id) : id;
    const ownedBy =
      typeof item?.owned_by === "string" ? item.owned_by.slice(0, 100) : "";
    found.set(id, {
      id,
      name: typeof label === "string" ? label.slice(0, 180) : id,
      ownedBy,
    });
    if (found.size >= 3000) break;
  }
  assert(
    found.size,
    "فهرست مدل‌های این پرووایدر خالی است؛ دسترسی حساب یا آدرس API را بررسی کن.",
    "MODEL_CATALOG_EMPTY",
  );
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
async function readJSON(response, limit = 2000000) {
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      assert(length <= limit, "فهرست مدل‌های سرویس بیش از حد بزرگ است.");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("پاسخ فهرست مدل‌ها JSON معتبر نیست. آدرس API را بررسی کن.");
  }
}
async function fetchModels(
  config,
  { fetchImpl = fetch, timeoutMs = 20000, signal } = {},
) {
  const timeout = AbortSignal.timeout(timeoutMs),
    combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(modelsEndpoint(config.baseURL), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {}),
      },
      redirect: "error",
      signal: combined,
    });
  } catch {
    throw new Error(
      timeout.aborted
        ? "دریافت مدل‌ها طول کشید؛ دوباره تلاش کن. فهرست قبلی حفظ شده است."
        : "دریافت مدل‌ها از این پرووایدر ممکن نشد. اتصال و آدرس API را بررسی کن.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = [401, 403].includes(response.status)
      ? "کلید همین پرووایدر و دسترسی حساب را بررسی کن."
      : [404, 405].includes(response.status)
        ? "این مسیر /models را ارائه نمی‌کند؛ آدرس سازگار را بررسی کن یا شناسهٔ مدل را دستی وارد کن."
        : "کمی بعد دوباره تلاش کن.";
    throw new Error(
      "دریافت مدل‌ها با HTTP " + response.status + " ناموفق بود. " + hint,
    );
  }
  return normaliseModels(await readJSON(response));
}
module.exports = {
  presets,
  modelsEndpoint,
  normaliseModels,
  fetchModels,
  catalogToken,
};
