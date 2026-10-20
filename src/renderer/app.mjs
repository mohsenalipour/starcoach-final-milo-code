import { icon, hydrateIcons } from "./icons.mjs";
import { ModelControls } from "./model-controls.mjs";
const $ = (id) => document.getElementById(id),
  api = window.milo;
const labels = {
  planning: "ساخت پلن",
  awaiting_plan: "منتظر تأیید پلن",
  running: "در حال اجرا",
  awaiting_approval: "نیاز به تأیید تو",
  verifying: "تست واقعی",
  correcting: "اصلاح خطا",
  reviewing: "بازبینی نهایی",
  completed: "تمام شد",
  stopped: "متوقف‌شده",
  needs_attention: "نیاز به بررسی",
};
const active = new Set([
  "planning",
  "awaiting_plan",
  "running",
  "awaiting_approval",
  "verifying",
  "correcting",
  "reviewing",
]);
let project = null,
  state = null,
  settings = null,
  skills = [],
  mode = "live",
  demoProject = false,
  view = "plan",
  page = "task",
  work = "files",
  historyItems = [],
  editorFile = null,
  editorDirty = false,
  preview = null,
  toastTimer,
  lastRun = null,
  lastCommand = null;
const fa = (n) => new Intl.NumberFormat("fa-IR").format(n);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function glyph(name) {
  const holder = document.createElement("span");
  holder.innerHTML = icon(name);
  return holder.firstElementChild;
}
function btn(label, cls, fn, ic) {
  const b = el("button", cls, label);
  b.type = "button";
  if (ic) b.prepend(glyph(ic));
  if (fn) b.addEventListener("click", () => guard(fn));
  return b;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6500);
}
async function call(name, ...args) {
  const reply = await api[name](...args);
  if (!reply?.ok) throw Error(reply?.error || "پاسخی از برنامه دریافت نشد.");
  return reply.value;
}
async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
    return null;
  }
}
const modelControls = new ModelControls({
  call,
  toast,
  onSettings: (value) => {
    settings = value;
    modelControls.update(value);
    render();
  },
  onSelection: () => render(),
});
function busy() {
  return state && !state.readOnly && active.has(state.status);
}
function commandText(c) {
  return [
    c.program,
    ...c.args.map((a) => (/\s|["']/.test(a) ? JSON.stringify(a) : a)),
  ].join(" ");
}
function setProject(p) {
  project = p;
  $("project-name").textContent = p?.name || "فضای کار تازه";
  $("project-path").textContent =
    p?.root || "ایده‌ات را بنویس؛ پروژه‌ات را می‌سازیم.";
  $("project-path").title = p?.root || "";
}
function closeEditor() {
  editorFile = null;
  editorDirty = false;
  $("editor").hidden = true;
  $("editor-empty").hidden = false;
  $("editor-path").textContent = "No file selected";
  $("save-file").disabled = true;
}
async function adopt(result) {
  if (!result) return;
  state = null;
  page = "task";
  closeWorkbench();
  mode = result.mode || "live";
  demoProject = mode === "offline-demo";
  setProject(result.project);
  modelControls.update(settings, result.selection || settings.defaultSelection);
  $("remember-model").checked = true;
  closeEditor();
  $("task").value = result.task || "";
  lastCommand = null;
  render();
  await Promise.all([refreshFiles(), refreshHistory()]);
  if (mode === "live") modelControls.autoFetch();
  if (result.task) toast("پروژهٔ نمونهٔ تازه آماده شد. «شروع کار» را بزن.");
}
async function demo() {
  await adopt(await call("createDemo"));
}
async function choose() {
  await adopt(await call("chooseProject"));
}
function render() {
  const isBusy = !!busy(),
    readonly = !!state?.readOnly,
    hasPlan = !!state?.plan;
  const inbox = page === "inbox";
  $("agent-panel").classList.toggle("is-empty", !state && !inbox);
  $("task-screen").hidden = inbox;
  $("inbox-screen").hidden = !inbox;
  $("inbox-empty").hidden = !!state?.approval && !readonly;
  $("task-form").hidden = inbox || isBusy || readonly;
  $("starter-ideas").hidden = inbox || !!state;
  for (const id of ["run-header", "run-pipeline", "run-tabs"])
    $(id).hidden = !state;
  $("request-summary").hidden = !state;
  $("request-summary").textContent = state?.task || "";
  $("history-context").hidden = !readonly;
  $("approval-count").hidden = !state?.approval || readonly;
  $("stop").hidden = !isBusy;
  $("export").hidden = !state;
  $("new-project").disabled = isBusy;
  syncNavigation();
  $("stop").disabled = !isBusy;
  $("export").disabled = !state;
  $("new-task").disabled = isBusy;
  $("choose-project").disabled = isBusy;
  $("demo").disabled = isBusy;
  $("open-settings").disabled = isBusy;
  $("submit-task").disabled = isBusy || readonly;
  $("task").disabled = isBusy || readonly;
  $("model-mode").hidden = !demoProject;
  $("model-mode").value = mode;
  $("model-mode").disabled = isBusy || readonly;
  const selected = modelControls.getSelection(),
    selectedProfile = modelControls.profile();
  modelControls.context({
    disabled: isBusy || readonly,
    offline: mode === "offline-demo",
  });
  $("model-label").replaceChildren(
    el("span", "dot" + (selectedProfile?.hasKey ? " connected" : "")),
    document.createTextNode(
      mode === "offline-demo"
        ? "Offline demo · real tools"
        : readonly && state.connection
          ? state.connection.providerName + " / " + state.connection.model
          : selectedProfile?.hasKey
            ? selectedProfile.name +
              " / " +
              (selected.model || "مدل را انتخاب کن")
            : "کلید " + (selectedProfile?.name || "پرووایدر") + " ثبت نشده",
    ),
  );
  $("composer-hint").textContent = readonly
    ? "گزارش ذخیره‌شده؛ برای ادامه درخواست تازه بساز"
    : isBusy
      ? "گام‌ها و تأییدها را در بالا دنبال کن"
      : project
        ? "روی همین پروژه ادامه بده · Ctrl + Enter برای شروع"
        : "ایده‌ات را بنویس؛ یک پروژهٔ تازه ساخته می‌شود.";
  $("mode-badge").textContent = state
    ? state.mode === "offline-demo"
      ? "دموی آفلاین · مدل اسکریپتی"
      : "مدل زنده · " +
        (state.connection
          ? state.connection.providerName + " / " + state.connection.model
          : "مدل در گزارش قدیمی ثبت نشده")
    : mode === "offline-demo"
      ? "دموی آفلاین · ابزار واقعی"
      : "آمادهٔ شروع";
  $("mode-badge").className =
    "badge " +
    ((state?.mode || mode) === "offline-demo" ? "demo-badge" : "live-badge");
  const chip = $("run-status");
  chip.replaceChildren(
    el("span", "dot" + (state?.status === "completed" ? " mint" : "")),
    el(
      "span",
      "",
      readonly ? "گزارش اجرا" : labels[state?.status] || "منتظر درخواست",
    ),
  );
  $("event-count").textContent = fa(state?.events.length || 0);
  $("step-count").textContent = fa(state?.plan?.steps.length || 0);
  $("change-count").textContent = fa(state?.changes.length || 0);
  $("footer-status").textContent = state
    ? `${fa(state.iterations)} گام · ${fa(state.corrections)} اصلاح`
    : "آمادهٔ کار";
  document.querySelectorAll("[data-phase]").forEach((node) => {
    const phase = node.dataset.phase;
    let current =
      state?.status === "completed"
        ? "done"
        : state?.status === "planning" || state?.status === "awaiting_plan"
          ? "plan"
          : state?.status === "verifying" || state?.status === "correcting"
            ? "test"
            : state?.status === "reviewing"
              ? "review"
              : state
                ? "tools"
                : "";
    const order = ["plan", "tools", "test", "review"],
      index = order.indexOf(current);
    node.className =
      current === "done" || order.indexOf(phase) < index
        ? "done"
        : phase === current
          ? "active"
          : "";
  });
  $("welcome").hidden = !!state;
  for (const key of ["plan", "activity", "review"])
    $(key + "-view").hidden = !state || key !== view;
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (state) {
    renderPlan();
    renderActivity();
    renderReview();
  } else {
    $("plan-view").replaceChildren();
    $("activity-view").replaceChildren();
    $("review-view").replaceChildren();
  }
  renderApproval();
  renderChanges();
  updateSave();
}
function renderPlan() {
  const target = $("plan-view"),
    s = state;
  if (
    s.status === "awaiting_plan" &&
    !s.readOnly &&
    target.querySelector("form")?.dataset.run === s.id
  )
    return;
  target.replaceChildren();
  if (s.readOnly) {
    target.append(
      el(
        "div",
        "readonly-note",
        s.interrupted
          ? "این اجرا هنگام خروج ناتمام بوده است. تاریخچه فقط برای بازبینی باز شده؛ هیچ فرمانی خودکار اجرا نمی‌شود."
          : "این گزارش ذخیره‌شده است. تغییرات و نتیجهٔ تست را می‌توانی بررسی و صادر کنی.",
      ),
    );
  }
  if (!s.plan) {
    const load = el("div", "loading-card");
    if (s.status === "planning") load.append(el("span", "spinner"));
    load.append(
      el(
        "p",
        "",
        s.error || "ساخت پلن با توجه به فایل‌ها، درخواست و مهارت‌های فعال…",
      ),
    );
    target.append(load);
    return;
  }
  const p = s.plan;
  target.append(
    el("h2", "plan-title", p.title),
    el("p", "plan-summary", p.summary),
  );
  if (s.status === "awaiting_plan" && !s.readOnly) {
    renderPlanForm(target, p);
    return;
  }
  p.steps.forEach((title, i) => {
    const done = s.status === "completed" || i < s.currentStep,
      step = el(
        "div",
        "step" + (done ? " done" : i === s.currentStep ? " active" : ""),
      ),
      index = el("span", "step-index", done ? "✓" : fa(i + 1)),
      body = el("div");
    body.append(
      el("p", "", title),
      el(
        "small",
        "",
        done
          ? "انجام‌شده"
          : i === s.currentStep
            ? "مرحلهٔ فعلی"
            : "در مسیر اجرا",
      ),
    );
    step.append(index, body);
    target.append(step);
  });
  target.append(
    acceptance(p.acceptance),
    el("h3", "", "فرمان تست تأییدشده"),
    el("div", "command-box", commandText(p.verification)),
  );
  if (s.error) target.append(el("p", "error-note", s.error));
}
function field(label, value, tag = "input") {
  const wrap = el("label", "", label),
    input = el(tag);
  input.value = value;
  wrap.append(input);
  return { wrap, input };
}
function acceptance(items) {
  const box = el("div", "acceptance");
  box.append(el("h3", "", "معیارهای قبولی"));
  for (const item of items) {
    const row = el("div", "criterion");
    row.append(glyph("check"), el("span", "", item));
    box.append(row);
  }
  return box;
}
function renderPlanForm(target, p) {
  const form = el("form", "plan-edit");
  form.dataset.run = state.id;
  const steps = field(
    "مراحل پلن — هر مرحله در یک خط",
    p.steps.join("\n"),
    "textarea",
  );
  steps.input.rows = 4;
  steps.input.maxLength = 2000;
  const criteria = field(
    "معیارهای قبولی — هر مورد در یک خط",
    p.acceptance.join("\n"),
    "textarea",
  );
  criteria.input.rows = 2;
  criteria.input.maxLength = 2000;
  const title = field("عنوان پلن", p.title);
  title.input.maxLength = 120;
  const summary = field("خلاصهٔ رویکرد", p.summary, "textarea");
  summary.input.rows = 2;
  summary.input.maxLength = 1400;
  const details = el("details");
  details.append(
    el("summary", "", "ویرایش عنوان و خلاصه"),
    title.wrap,
    summary.wrap,
  );
  const commandWrap = el("div", "command-inputs"),
    program = field("Program", p.verification.program),
    args = field("Arguments (JSON)", JSON.stringify(p.verification.args)),
    cwd = field("Working directory", p.verification.cwd),
    timeout = field("Timeout (ms)", p.verification.timeoutMs);
  timeout.input.type = "number";
  timeout.input.min = 1000;
  timeout.input.max = 180000;
  commandWrap.append(program.wrap, args.wrap, cwd.wrap, timeout.wrap);
  const buttons = el("div", "plan-buttons"),
    go = btn("تأیید پلن و شروع اجرا", "primary", null, "play");
  go.type = "submit";
  buttons.append(go);
  form.append(
    steps.wrap,
    criteria.wrap,
    details,
    el("h3", "", "تست پذیرش"),
    commandWrap,
    el(
      "p",
      "info-note",
      "این فرمان معیار قبولی این اجراست. پیش از اجرای فرمان هم تأیید جداگانه می‌گیری. مراحل و تست را همین‌جا می‌توانی ویرایش کنی.",
    ),
    buttons,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void guard(async () => {
      let argv;
      try {
        argv = JSON.parse(args.input.value);
      } catch {
        throw Error("آرگومان‌ها را به شکل آرایهٔ JSON وارد کن.");
      }
      go.disabled = true;
      try {
        await call("approvePlan", {
          title: title.input.value,
          summary: summary.input.value,
          steps: steps.input.value
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
          acceptance: criteria.input.value
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean),
          verification: {
            program: program.input.value.trim(),
            args: argv,
            cwd: cwd.input.value.trim() || ".",
            timeoutMs: Number(timeout.input.value),
          },
        });
      } finally {
        go.disabled = false;
      }
    });
  });
  target.append(form);
}
function renderActivity() {
  const target = $("activity-view"),
    nearBottom =
      target.parentElement.scrollTop + target.parentElement.clientHeight >=
      target.parentElement.scrollHeight - 70;
  target.replaceChildren();
  for (const event of [...state.events].reverse()) {
    const item = el("div", "activity-item");
    item.dataset.type = event.type;
    const graphic = el("div", "activity-icon");
    graphic.append(
      glyph(
        event.type === "approval"
          ? "shield"
          : event.type === "command"
            ? "terminal"
            : event.type === "review"
              ? "check"
              : event.type === "tool_start"
                ? "code"
                : "clock",
      ),
    );
    const body = el("div", "activity-body");
    body.append(
      el(
        "small",
        "",
        new Date(event.at).toLocaleTimeString("fa-IR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      ),
      el("p", "", event.message),
    );
    if (Object.keys(event.data || {}).length) {
      const details = el("details");
      details.append(
        el("summary", "", "جزئیات ابزار"),
        el("pre", "", JSON.stringify(event.data, null, 2)),
      );
      body.append(details);
    }
    item.append(graphic, body);
    target.append(item);
  }
}
function renderReview() {
  const target = $("review-view"),
    s = state;
  target.replaceChildren();
  const v = s.verification;
  if (!v) {
    const box = el("div", "result-card");
    box.append(
      el("h3", "", "هنوز تست نهایی موفقی ثبت نشده"),
      el(
        "p",
        "muted",
        "اتمام کار به اجرای واقعی تست، ثابت‌ماندن فایل‌ها و بازبینی نهایی وابسته است.",
      ),
    );
    target.append(box);
  } else {
    const box = el("div", "result-card " + (v.ok ? "success" : "failure")),
      heading = el(
        "h3",
        "",
        v.ok ? "تست روی آخرین فایل‌ها موفق بود" : "تست به اصلاح نیاز دارد",
      );
    heading.prepend(glyph(v.ok ? "check" : "warning"));
    box.append(heading);
    const stats = el("div", "evidence-grid");
    for (const [label, value] of [
      ["Exit code", v.exitCode ?? "—"],
      ["Duration", `${(v.durationMs / 1000).toFixed(2)}s`],
    ]) {
      const cell = el("div");
      cell.append(el("small", "", label), el("strong", "", value));
      stats.append(cell);
    }
    box.append(stats, el("div", "command-box", commandText(v.command)));
    if (v.stale)
      box.append(
        el("p", "", "فایل‌ها حین تست تغییر کرده‌اند؛ نتیجه معتبر نیست."),
      );
    target.append(box);
    const output = el("details");
    output.open = !v.ok;
    output.append(
      el("summary", "", "خروجی کامل تست"),
      el("pre", "", (v.stdout || "") + (v.stderr || "")),
    );
    target.append(output);
  }
  if (s.review) {
    const review = el("div", "result-card");
    review.append(el("h3", "", "بازبینی نهایی"), el("p", "", s.review.summary));
    for (const issue of s.review.issues) review.append(el("p", "muted", issue));
    target.append(review);
  }
  if (s.summary) {
    const result = el("div", "result-card");
    result.append(el("h3", "", "تحویل کار"), el("p", "", s.summary));
    target.append(result);
  }
  if (s.error) target.append(el("p", "error-note", s.error));
  if (s.plan) target.append(acceptance(s.plan.acceptance));
}
function renderApproval() {
  const box = $("approval"),
    approval = state?.readOnly ? null : state?.approval;
  box.hidden = !approval;
  if (!approval) {
    box.replaceChildren();
    return;
  }
  if (box.dataset.nonce === approval.nonce) return;
  box.dataset.nonce = approval.nonce;
  box.replaceChildren();
  const title = el(
    "h3",
    "",
    approval.verification ? "اجازهٔ اجرای تست پذیرش" : "اجازهٔ اجرای فرمان",
  );
  title.prepend(glyph("shield"));
  box.append(
    title,
    el("div", "command-box", commandText(approval.command)),
    el("p", "", `مسیر: ${approval.cwd}`),
  );
  const detail = el("details");
  detail.append(
    el("summary", "", "برنامه و آرگومان‌های دقیق اجرا"),
    el(
      "pre",
      "",
      JSON.stringify(
        { executable: approval.executable, args: approval.effectiveArgs },
        null,
        2,
      ),
    ),
  );
  box.append(
    detail,
    el(
      "p",
      "",
      "این فرمان با دسترسی حساب ویندوز تو اجرا می‌شود و ممکن است فایل یا شبکه را تغییر دهد. پیش از تأیید، برنامه و آرگومان‌ها را بررسی کن.",
    ),
  );
  const buttons = el("div", "approval-actions");
  for (const [label, approved, cls] of [
    ["تأیید و اجرا", true, "approve-command"],
    ["رد فرمان", false, "reject-command"],
  ])
    buttons.append(
      btn(
        label,
        cls,
        async () => {
          buttons
            .querySelectorAll("button")
            .forEach((b) => (b.disabled = true));
          await call("decide", {
            runId: state.id,
            nonce: approval.nonce,
            approved,
          });
        },
        approved ? "check" : "clear",
      ),
    );
  box.append(buttons);
  if (lastCommand !== approval.nonce) {
    lastCommand = approval.nonce;
    appendTerminal(
      `\n> ${commandText(approval.command)}\n[Waiting for your approval]\n`,
    );
  }
}
async function refreshFiles() {
  const list = $("file-list");
  list.replaceChildren();
  if (state?.readOnly) {
    list.append(
      el(
        "p",
        "empty-note",
        "فایل‌های این گزارش از بخش «تغییرات» قابل مشاهده‌اند.",
      ),
    );
    return;
  }
  if (!project) {
    list.append(el("p", "empty-note", "فایل‌های پروژه"));
    return;
  }
  const result = await call("listFiles");
  for (const item of result.files) {
    const depth = item.path.split("/").length - 1;
    const b = btn(
      item.name,
      "file-row " +
        (item.directory ? "directory" : "file") +
        (editorFile?.path === item.path ? " selected" : ""),
      item.directory ? null : () => openFile(item.path),
      item.directory ? "folder" : "file",
    );
    b.style.paddingLeft = `${7 + Math.min(depth, 4) * 9}px`;
    b.title = item.path;
    if (item.directory) b.disabled = true;
    list.append(b);
  }
  if (result.truncated)
    list.append(el("p", "empty-note", "نمایش تا سقف ۴۰۰ مورد."));
}
async function openFile(path) {
  if (editorDirty) {
    toast(
      "ابتدا تغییر دستی را ذخیره کن یا با خواندن مجدد همین فایل از تغییر صرف‌نظر کن.",
    );
    if (editorFile?.path !== path) return;
  }
  editorFile = await call("readFile", path);
  editorDirty = false;
  $("editor").value = editorFile.content;
  $("editor-path").textContent = path;
  $("editor-empty").hidden = true;
  $("editor").hidden = false;
  updateSave();
  await refreshFiles();
}
function updateSave() {
  const allowed =
    !state?.readOnly &&
    (!busy() || ["awaiting_plan", "awaiting_approval"].includes(state.status));
  $("save-file").disabled = !editorFile || !editorDirty || !allowed;
  $("editor").readOnly = !allowed;
  $("editor-info").textContent = editorDirty
    ? "ویرایش ذخیره نشده · ذخیره با Ctrl + S"
    : allowed
      ? "UTF-8 · ذخیره با کنترل نسخهٔ فایل · Ctrl + S"
      : "برای ویرایش، اجرا را متوقف کن یا تا مرحلهٔ تأیید صبر کن.";
}
async function saveFile() {
  if ($("save-file").disabled) return;
  const saved = await call("saveFile", {
    path: editorFile.path,
    content: $("editor").value,
    expectedHash: editorFile.hash,
  });
  editorFile = { ...editorFile, content: $("editor").value, hash: saved.hash };
  editorDirty = false;
  updateSave();
  toast("فایل ذخیره شد. تست بعدی روی نسخهٔ جدید اجرا می‌شود.");
}
function renderChanges() {
  const target = $("changes-work");
  target.replaceChildren();
  const changes = state?.changes || [];
  if (!changes.length) {
    target.append(
      el(
        "p",
        "empty-note",
        "تغییرات کد بعد از اولین ویرایش اینجا دیده می‌شوند.",
      ),
    );
    return;
  }
  for (const change of changes) {
    const card = el("div", "change-card");
    card.append(el("h3", "", change.path));
    const columns = el("div", "diff-columns");
    for (const [label, content] of [
      ["BEFORE", change.before ?? "New file"],
      ["AFTER", change.after],
    ]) {
      const pane = el("div");
      pane.append(el("small", "", label), el("pre", "", content));
      columns.append(pane);
    }
    card.append(columns);
    target.append(card);
  }
}
function renderSkills() {
  const target = $("skills-work");
  target.replaceChildren();
  $("skill-count").textContent = fa(skills.filter((s) => s.enabled).length);
  const head = el("div", "skills-intro");
  const add = btn("افزودن مهارت", "secondary", inspectSkill, "plus");
  add.disabled = !!busy();
  head.append(el("h3", "", "ابزارهای قابل گسترش"), add);
  target.append(
    head,
    el(
      "p",
      "info-note",
      "هر مهارت شامل دستورالعمل و ابزارهای تعریف‌شده در skill.json است. فرمان مهارت هم قبل از اجرا تأیید جداگانه می‌گیرد.",
    ),
  );
  for (const skill of skills) {
    const card = el("div", "skill-card"),
      top = el("div", "skill-top"),
      toggle = btn(
        skill.enabled ? "فعال" : "غیرفعال",
        "skill-toggle" + (skill.enabled ? " enabled" : ""),
        async () => {
          skills = await call("toggleSkill", {
            id: skill.id,
            enabled: !skill.enabled,
          });
          renderSkills();
        },
      );
    toggle.disabled = !!busy();
    top.append(el("h3", "", skill.name), toggle);
    const meta = el(
      "div",
      "skill-meta",
      `${skill.id} · v${skill.version} · ${skill.builtin ? "Built-in" : "Imported"}`,
    );
    card.append(top, el("p", "", skill.description), meta);
    for (const tool of skill.tools) {
      const pill = el("span", "tool-pill", tool.id);
      pill.title = commandText(tool.command);
      card.append(pill);
    }
    target.append(card);
  }
}
async function inspectSkill() {
  preview = await call("inspectSkill");
  if (!preview) return;
  const target = $("skill-preview");
  target.replaceChildren(
    el("h3", "", preview.name),
    el("p", "muted", preview.description),
    el(
      "p",
      "info-note",
      "با افزودن این مهارت، دستورالعمل آن به مدل داده می‌شود و برنامه‌های معرفی‌شده قابل درخواست می‌شوند. اجرای هر فرمان همچنان نیاز به تأیید تو دارد.",
    ),
  );
  for (const tool of preview.tools)
    target.append(el("div", "command-box", commandText(tool.command)));
  const details = el("details");
  details.append(
    el("summary", "", "متن دستورالعمل مهارت"),
    el("pre", "", preview.instructions),
  );
  target.append(details, el("p", "muted", "SHA-256: " + preview.digest));
  $("skill-dialog").showModal();
}
async function refreshHistory() {
  historyItems = await call("history");
  renderHistory();
}
function renderHistory() {
  const query = $("history-search").value.trim().toLocaleLowerCase();
  const rows = historyItems.filter((r) =>
    (r.title + " " + r.root + " " + (r.connection?.model || ""))
      .toLocaleLowerCase()
      .includes(query),
  );
  const target = $("history");
  target.replaceChildren();
  if (!rows.length)
    target.append(
      el(
        "p",
        "muted empty-note",
        query
          ? "کاری با این عبارت پیدا نشد."
          : "اولین کارت را از کادر روبه‌رو شروع کن.",
      ),
    );
  for (const run of rows) {
    const b = btn(
      "",
      "history-row" + (state?.id === run.id ? " selected" : ""),
      async () => {
        state = await call("loadRun", run.id);
        page = "task";
        mode = state.mode;
        closeWorkbench();
        closeEditor();
        $("project-name").textContent = run.root.split(/[\\/]/).at(-1);
        $("project-path").textContent = run.root;
        $("project-path").title = run.root;
        view = "review";
        render();
        setWork("changes", { reveal: false });
        await refreshFiles();
        rebuildTerminal();
        await refreshHistory();
      },
    );
    b.append(el("strong", "", run.title));
    if (run.connection)
      b.append(
        el(
          "span",
          "history-model",
          run.connection.providerName + " / " + run.connection.model,
        ),
      );
    const meta = el("small");
    meta.append(
      el("span", "", labels[run.status] || run.status),
      el(
        "span",
        "",
        new Date(run.updatedAt).toLocaleDateString("fa-IR", {
          month: "short",
          day: "numeric",
        }),
      ),
    );
    b.append(meta);
    target.append(b);
  }
}
function appendTerminal(text) {
  const t = $("terminal");
  t.textContent = (t.textContent + text).slice(-100000);
  t.scrollTop = t.scrollHeight;
}
function rebuildTerminal() {
  $("terminal").textContent = "";
  for (const event of state?.events || [])
    if (event.type === "command") {
      appendTerminal(
        `> ${commandText(event.data.command)}\n${event.data.stdout || ""}${event.data.stderr || ""}\n[exit ${event.data.exitCode}]\n\n`,
      );
    }
}
function syncNavigation() {
  $("nav-task").classList.toggle(
    "active",
    page === "task" && $("workbench").hidden,
  );
  $("inbox-button").classList.toggle("active", page === "inbox");
  document
    .querySelectorAll("[data-open-work]")
    .forEach((b) =>
      b.classList.toggle(
        "active",
        !$("workbench").hidden && b.dataset.openWork === work,
      ),
    );
}
function closeWorkbench() {
  $("workbench").hidden = true;
  document.body.classList.remove("drawer-open");
}
function setWork(key, { reveal = true } = {}) {
  work = key;
  if (reveal) {
    $("workbench").hidden = false;
    document.body.classList.add("drawer-open");
  }
  $("workbench-title").textContent = {
    files: "فایل‌های پروژه",
    changes: "تغییرات کد",
    skills: "مهارت‌های ایجنت",
    output: "خروجی فرمان‌ها",
  }[key];
  for (const name of ["files", "changes", "skills", "output"])
    $(name + "-work").hidden = name !== key;
  document
    .querySelectorAll("[data-work]")
    .forEach((b) => b.classList.toggle("active", b.dataset.work === key));
  if (key === "skills") renderSkills();
  syncNavigation();
}
$("nav-task").onclick = () => {
  page = "task";
  closeWorkbench();
  render();
};
$("inbox-button").onclick = () => {
  page = "inbox";
  closeWorkbench();
  render();
};
$("close-workbench").onclick = () => {
  closeWorkbench();
  syncNavigation();
};
$("show-output").onclick = () => setWork("output");
document.querySelectorAll("[data-open-work]").forEach((b) => {
  b.onclick = () => {
    page = "task";
    setWork(b.dataset.openWork);
    render();
  };
});
document.querySelectorAll("[data-prompt]").forEach((b) => {
  b.onclick = () => {
    $("task").value = b.dataset.prompt;
    $("task").focus();
  };
});
$("new-project").onclick = () => {
  if ($("new-project").disabled) return;
  $("project-dialog").showModal();
  $("project-title").select();
};
$("project-form").onsubmit = (event) => {
  event.preventDefault();
  void guard(async () => {
    await adopt(
      await call("createProject", { name: $("project-title").value }),
    );
    $("project-dialog").close();
    $("task").focus();
  });
};
$("continue-run").onclick = () =>
  guard(async () => {
    await adopt(await call("continueRun", state.id));
    $("task").focus();
    toast("همان پروژه آماده است؛ درخواست بعدی را بنویس.");
  });
$("choose-project").onclick = () => guard(choose);
$("welcome-project").onclick = () => guard(choose);
$("demo").onclick = () => guard(demo);
$("welcome-demo").onclick = () => guard(demo);
$("new-task").onclick = () =>
  guard(async () => {
    await call("newTask");
    state = null;
    page = "task";
    closeWorkbench();
    closeEditor();
    $("task").value = "";
    const boot = await call("boot");
    mode = boot.mode;
    demoProject = mode === "offline-demo";
    setProject(boot.project);
    modelControls.update(settings, boot.selection || settings.defaultSelection);
    $("remember-model").checked = true;
    render();
    await refreshFiles();
  });
$("refresh-history").onclick = () => guard(refreshHistory);
$("history-search").oninput = () => renderHistory();
$("refresh-files").onclick = () =>
  guard(async () => {
    if (editorFile) await openFile(editorFile.path);
    else await refreshFiles();
  });
$("save-file").onclick = () => guard(saveFile);
$("editor").addEventListener("input", () => {
  editorDirty = true;
  updateSave();
});
$("editor").addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const t = event.target,
      start = t.selectionStart,
      end = t.selectionEnd;
    t.setRangeText("  ", start, end, "end");
    editorDirty = true;
    updateSave();
  }
  if (event.ctrlKey && event.key === "s") {
    event.preventDefault();
    void guard(saveFile);
  }
});
document.querySelectorAll("[data-view]").forEach(
  (b) =>
    (b.onclick = () => {
      view = b.dataset.view;
      render();
    }),
);
document
  .querySelectorAll("[data-work]")
  .forEach((b) => (b.onclick = () => setWork(b.dataset.work)));
$("task-form").onsubmit = (event) => {
  event.preventDefault();
  void guard(async () => {
    if ($("submit-task").disabled) return;
    const task = $("task").value.trim();
    if (task.length < 8) throw Error("درخواست را کمی کامل‌تر بنویس.");
    $("submit-task").disabled = true;
    view = "plan";
    try {
      if (!project) {
        await adopt(await call("createProject", { name: "پروژه جدید" }));
        $("task").value = task;
      }
      if (state) {
        await call("newTask");
        state = null;
      }
      page = "task";
      await call("plan", {
        task,
        mode,
        selection: modelControls.getSelection(),
        remember: $("remember-model").checked,
      });
    } finally {
      render();
    }
  });
};
$("task").addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") {
    $("task-form").requestSubmit();
    e.preventDefault();
  }
});
$("model-mode").onchange = (event) => {
  mode = event.target.value;
  render();
  if (mode === "live") modelControls.autoFetch();
};
$("stop").onclick = () => guard(() => call("stop"));
$("export").onclick = () =>
  guard(async () => {
    const file = await call("exportRun", state.id);
    if (file) toast("گزارش اجرا ذخیره شد.");
  });
$("clear-terminal").onclick = () => {
  $("terminal").textContent = "";
};
$("open-settings").onclick = () => {
  modelControls.open();
};
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
$("confirm-skill").onclick = () =>
  guard(async () => {
    skills = await call("importSkill", { digest: preview.digest });
    $("skill-dialog").close();
    renderSkills();
    toast("مهارت اضافه شد.");
  });
api.onState((next) => {
  const was = state?.status;
  state = next;
  if (lastRun !== next.id) {
    lastRun = next.id;
    $("terminal").textContent = "";
    lastCommand = null;
  }
  if (
    was !== next.status &&
    ["completed", "needs_attention", "stopped"].includes(next.status)
  ) {
    void guard(refreshHistory);
    if (next.status === "completed") {
      view = "review";
      $("task").value = "";
      $("task").placeholder = "چه چیزی به این پروژه اضافه کنیم؟";
      toast("اجرا با تست موفق و بازبینی نهایی تمام شد.");
    }
  }
  render();
  if (
    next.events.at(-1)?.type === "tool_result" &&
    next.observations.at(-1)?.tool === "write_file"
  )
    void guard(refreshFiles);
});
api.onOutput((chunk) => appendTerminal(chunk.text));
async function boot() {
  hydrateIcons();
  const data = await call("boot");
  settings = data.settings;
  modelControls.update(settings, data.selection || settings.defaultSelection);
  mode = data.mode || "live";
  demoProject = mode === "offline-demo";
  skills = data.skills;
  state = data.state;
  setProject(data.project);
  renderSkills();
  render();
  await Promise.all([refreshHistory(), refreshFiles()]);
}
void guard(boot);
