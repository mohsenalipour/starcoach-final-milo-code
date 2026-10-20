const $ = (id) => document.getElementById(id);
function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
export class ModelControls {
  constructor({ call, onSettings, onSelection, toast }) {
    Object.assign(this, { call, onSettings, onSelection, toast });
    this.settings = null;
    this.selection = null;
    this.editing = null;
    this.drafts = new Map();
    this.pending = new Map();
    this.errors = new Map();
    this.attempted = new Set();
    $("run-provider").onchange = () => {
      const p = this.profile($("run-provider").value);
      this.selection = { providerId: p.id, model: p.model || "" };
      this.renderComposer();
      this.onSelection();
      this.autoFetch(p.id);
    };
    $("run-model").oninput = () => {
      this.selection.model = $("run-model").value.trim();
      this.onSelection();
    };
    $("run-refresh-models").onclick = () =>
      this.fetch(this.selection.providerId);
    $("refresh-models").onclick = () => this.save(true);
    $("model-search").oninput = () => this.renderCatalog();
    $("settings-form").onsubmit = (e) => {
      e.preventDefault();
      void this.save(true);
    };
    $("ping").onclick = () => this.ping();
    $("settings-dialog").addEventListener("close", () => {
      this.drafts.clear();
      $("settings-form").elements.apiKey.value = "";
    });
  }
  profile(id = this.selection?.providerId) {
    return this.settings?.providers.find((p) => p.id === id);
  }
  update(settings, selection) {
    this.settings = settings;
    if (selection) this.selection = { ...selection };
    if (!this.profile()) this.selection = { ...settings.defaultSelection };
    this.renderComposer();
  }
  getSelection() {
    return {
      providerId: this.selection.providerId,
      model: this.selection.model.trim(),
    };
  }
  renderComposer() {
    if (!this.settings) return;
    const provider = $("run-provider");
    provider.replaceChildren();
    for (const p of this.settings.providers) {
      const o = node("option", "", p.name + (p.hasKey ? "" : " · بدون کلید"));
      o.value = p.id;
      provider.append(o);
    }
    provider.value = this.selection.providerId;
    $("run-model").value = this.selection.model;
    const p = this.profile(),
      options = document.createDocumentFragment();
    for (const m of p.models) {
      const option = node("option");
      option.value = m.id;
      option.label = m.name !== m.id ? m.name : m.ownedBy;
      options.append(option);
    }
    $("run-model-list").replaceChildren(options);
    $("run-model-count").textContent = this.pending.has(p.id)
      ? "دریافت مدل‌ها…"
      : p.models.length
        ? p.models.length.toLocaleString("fa-IR") + " مدل"
        : "شناسهٔ مدل را وارد کن";
  }
  context({ disabled, offline }) {
    $("run-connection").hidden = offline;
    for (const id of ["run-provider", "run-model", "remember-model"])
      $(id).disabled = disabled;
    $("run-refresh-models").disabled =
      disabled || this.pending.has(this.selection?.providerId);
  }
  autoFetch(id = this.selection?.providerId) {
    const p = this.profile(id);
    if (!p?.hasKey || this.attempted.has(id)) return;
    const age = p.modelsFetchedAt
      ? Date.now() - new Date(p.modelsFetchedAt).getTime()
      : Infinity;
    if (p.models.length && age < 6 * 60 * 60 * 1000) return;
    this.attempted.add(id);
    void this.fetch(id);
  }
  open() {
    this.editing =
      this.selection?.providerId || this.settings.defaultSelection.providerId;
    this.drafts.clear();
    this.renderPanel();
    $("settings-dialog").showModal();
    this.autoFetch(this.editing);
  }
  draft() {
    const f = $("settings-form").elements;
    return {
      providerId: this.editing,
      baseURL: f.baseURL.value.trim(),
      model: f.model.value.trim(),
      apiKey: f.apiKey.value.trim(),
      clearKey: f.clearKey.checked,
      makeDefault: f.makeDefault.checked,
    };
  }
  renderPanel() {
    const p = this.profile(this.editing);
    if (!p) return;
    const f = $("settings-form").elements,
      draft = this.drafts.get(p.id);
    f.baseURL.value = draft?.baseURL ?? p.baseURL;
    f.model.value = draft?.model ?? p.model;
    f.apiKey.value = draft?.apiKey ?? "";
    f.clearKey.checked = draft?.clearKey ?? false;
    f.makeDefault.checked =
      draft?.makeDefault ?? this.settings.defaultSelection.providerId === p.id;
    const tabs = $("provider-tabs");
    tabs.replaceChildren();
    for (const item of this.settings.providers) {
      const button = node(
        "button",
        "provider-tab" + (item.id === p.id ? " active" : ""),
      );
      button.type = "button";
      button.append(
        node("span", "dot" + (item.hasKey ? " connected" : "")),
        node("strong", "", item.name),
      );
      button.onclick = () => {
        this.drafts.set(this.editing, this.draft());
        this.editing = item.id;
        $("model-search").value = "";
        $("settings-result").textContent = "";
        this.renderPanel();
        this.autoFetch(item.id);
      };
      tabs.append(button);
    }
    $("provider-note").textContent =
      p.id === "metis"
        ? "مسیر پیش‌فرض Metis مربوط به مدل‌های OpenAI است. برای مسیر سازگار دیگری، آدرس API را مطابق حساب و مستندات همان سرویس تغییر بده."
        : "کلید و مدل این پرووایدر جدا از سرویس‌های دیگر ذخیره می‌شوند.";
    $("key-status").textContent = p.hasKey
      ? p.keyStorage === "encrypted"
        ? "کلید این پرووایدر با رمزنگاری حساب ویندوز ذخیره شده است. برای حفظ آن، فیلد کلید را خالی بگذار."
        : "کلید این پرووایدر فقط تا بسته‌شدن برنامه در حافظه می‌ماند."
      : p.keyStorage === "unavailable"
        ? "کلید رمز‌شده موجود است، اما در حساب فعلی ویندوز باز نمی‌شود. برای استفاده، کلید را دوباره وارد کن."
        : "برای این پرووایدر هنوز کلیدی ذخیره نشده است.";
    this.renderCatalog();
  }
  renderCatalog() {
    const p = this.profile(this.editing);
    if (!p) return;
    const query = $("model-search").value.trim().toLowerCase(),
      list = $("catalog-list");
    list.replaceChildren();
    const matches = p.models.filter((m) =>
      (m.id + " " + m.name + " " + m.ownedBy).toLowerCase().includes(query),
    );
    $("catalog-status").textContent = this.pending.has(p.id)
      ? "در حال دریافت از API…"
      : this.errors.get(p.id) ||
        (p.modelsFetchedAt
          ? p.models.length.toLocaleString("fa-IR") +
            " مدل · " +
            new Date(p.modelsFetchedAt).toLocaleString("fa-IR")
          : "هنوز دریافت نشده");
    $("catalog-status").className = this.errors.has(p.id)
      ? "catalog-error"
      : "";
    $("refresh-models").disabled = this.pending.has(p.id);
    $("refresh-models").textContent = this.pending.has(p.id)
      ? "در حال دریافت…"
      : "ذخیره و دریافت مدل‌ها";
    for (const m of matches.slice(0, 180)) {
      const b = node("button", "catalog-model");
      b.type = "button";
      b.append(
        node("strong", "", m.id),
        node(
          "small",
          "",
          m.name !== m.id ? m.name : m.ownedBy || "Chat model route",
        ),
      );
      b.onclick = () => {
        $("settings-form").elements.model.value = m.id;
        this.selection = { providerId: p.id, model: m.id };
        this.renderComposer();
        this.onSelection();
        this.toast(
          "مدل این درخواست انتخاب شد. برای ثبت پیش‌فرض سرویس، تنظیمات را ذخیره کن.",
        );
      };
      list.append(b);
    }
    if (!matches.length)
      list.append(
        node(
          "p",
          "empty-note",
          p.models.length
            ? "مدلی با این عبارت پیدا نشد. شناسهٔ دقیق مدل را می‌توانی دستی وارد کنی."
            : "کلید این پرووایدر را ذخیره کن؛ مدل‌ها خودکار دریافت می‌شوند.",
        ),
      );
    if (matches.length > 180)
      list.append(
        node(
          "p",
          "empty-note",
          "برای دیدن مدل‌های دیگر، نام آن‌ها را جستجو کن.",
        ),
      );
  }
  async save(discover) {
    const input = this.draft(),
      buttons = $("settings-form").querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    $("settings-result").textContent = "ذخیرهٔ پرووایدر…";
    try {
      const settings = await this.call("saveSettings", input);
      this.drafts.delete(input.providerId);
      this.attempted.delete(input.providerId);
      this.errors.delete(input.providerId);
      this.selection = { providerId: input.providerId, model: input.model };
      this.onSettings(settings);
      this.renderPanel();
      this.onSelection();
      $("settings-result").textContent = "تنظیمات این پرووایدر ذخیره شد.";
      if (discover) await this.fetch(input.providerId);
    } catch (e) {
      $("settings-result").textContent = e.message;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }
  async fetch(providerId) {
    if (this.pending.has(providerId)) return this.pending.get(providerId);
    this.errors.delete(providerId);
    const request = (async () => {
      try {
        const data = await this.call("models", { providerId });
        this.onSettings(data.settings);
      } catch (e) {
        this.errors.set(providerId, e.message);
        if (this.selection.providerId === providerId) this.toast(e.message);
      } finally {
        this.pending.delete(providerId);
        this.renderComposer();
        if (this.editing === providerId) this.renderCatalog();
        this.onSelection();
      }
    })();
    this.pending.set(providerId, request);
    this.renderComposer();
    if (this.editing === providerId) this.renderCatalog();
    return request;
  }
  async ping() {
    const p = this.profile(this.editing),
      model = $("settings-form").elements.model.value.trim(),
      button = $("ping");
    button.disabled = true;
    $("settings-result").textContent = "آزمایش اتصال ذخیره‌شده…";
    try {
      const result = await this.call("ping", { providerId: p.id, model });
      $("settings-result").textContent = p.name + " پاسخ داد: " + result.model;
    } catch (e) {
      $("settings-result").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  }
}
