"use strict";
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  session,
  shell,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Workspace } = require("./core/workspace.cjs");
const { Harness } = require("./core/harness.cjs");
const { ModelProvider } = require("./core/provider.cjs");
const { DemoProvider, createDemo, demoTask } = require("./core/demo.cjs");
const { SkillRegistry } = require("./core/skills.cjs");
const { RunStore } = require("./core/store.cjs");
const { Settings } = require("./core/settings.cjs");
const { createProject, continuationFrom } = require("./core/projects.cjs");
const { AppRuntime, localURL, launchOptions } = require("./core/runtime.cjs");
const { assert, keys, text, redact } = require("./core/protocol.cjs");
app.setName("Milo Code");
if (process.env.MILO_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.MILO_DATA_DIR));
const root = path.resolve(__dirname, ".."),
  renderer = path.join(__dirname, "renderer", "index.html"),
  rendererURL = pathToFileURL(renderer).href;
let win,
  settings,
  skills,
  store,
  runtime,
  runtimeSmoke = null,
  harness = null,
  workspace = null,
  projectMode = "live",
  continuation = null;
let importing = null;
const available = () =>
  assert(
    !harness?.busy && !harness?.runner.child,
    "ابتدا اجرای فعلی را تمام یا متوقف کن و تا بسته‌شدن فرمان صبر کن.",
  );
const send = (name, data) => {
  if (win && !win.isDestroyed()) win.webContents.send("milo:" + name, data);
};
function connect(provider, mode, connection = null) {
  const current = new Harness({
    workspace,
    provider,
    mode,
    connection,
    continuation,
    runtime,
    projectApproval: () =>
      settings.projectApproval(current.workspace.root).autoApproveCommands,
    skills,
    store,
    secrets: settings.allSecrets(),
  });
  harness = current;
  current.on("state", (data) => {
    if (harness === current) send("state", data);
  });
  current.on("output", (data) => {
    if (harness === current) send("output", data);
  });
  return current;
}
async function projectSummary() {
  const result = await workspace.summary();
  if (
    path.dirname(workspace.root).toLowerCase() ===
    path.join(app.getPath("userData"), "projects").toLowerCase()
  )
    result.name = result.name.replace(/-[a-f0-9]{8}$/, "");
  return result;
}
async function select(rootPath, mode = "live") {
  available();
  workspace = await Workspace.open(rootPath);
  harness = null;
  projectMode = mode;
  continuation = null;
  return {
    project: await projectSummary(),
    mode,
    selection: settings.forProject(workspace.root),
    resources: await resources(workspace),
  };
}
async function viewedWorkspace(data = {}) {
  keys(data, ["runId"]);
  if (data.runId) return Workspace.open((await store.load(data.runId)).root);
  assert(workspace, "ابتدا پروژه را انتخاب کن.");
  return workspace;
}
async function resources(ws) {
  return {
    root: ws.root,
    approval: settings.projectApproval(ws.root),
    application: runtime.snapshot(ws.root),
    launches: await launchOptions(
      ws,
      harness?.workspace.root === ws.root ? harness.state?.launch : null,
    ),
  };
}
function ipc(name, handler) {
  ipcMain.handle("milo:" + name, async (event, ...args) => {
    assert(
      event.sender === win.webContents &&
        event.senderFrame?.url === rendererURL,
      "فرستندهٔ نامعتبر.",
    );
    try {
      return { ok: true, value: await handler(...args) };
    } catch (error) {
      return {
        ok: false,
        error: redact(error.message, settings?.allSecrets() || []),
      };
    }
  });
}
function register() {
  ipc("boot", async () => ({
    version: app.getVersion(),
    project: workspace ? await projectSummary() : null,
    state: harness?.snapshot() || null,
    settings: settings.public(),
    selection: workspace
      ? settings.forProject(workspace.root)
      : settings.value.defaultSelection,
    mode: projectMode,
    skills: skills.list(),
    dataPath: app.getPath("userData"),
    resources: workspace ? await resources(workspace) : null,
  }));
  ipc("resources", async (data) => resources(await viewedWorkspace(data)));
  ipc("openProjectFolder", async (data) => {
    const ws = await viewedWorkspace(data);
    const error = await shell.openPath(ws.root);
    assert(!error, error || "پوشه باز نشد.");
    return true;
  });
  ipc("revealFile", async (data) => {
    keys(data, ["runId", "path"]);
    const ws = await viewedWorkspace(data.runId ? { runId: data.runId } : {});
    shell.showItemInFolder(await ws.resolve(text(data.path, 500)));
    return true;
  });
  ipc("setProjectApproval", async (data) => {
    keys(data, ["root", "enabled", "runId", "nonce"]);
    assert(
      workspace && typeof data.enabled === "boolean",
      "پروژه یا مجوز معتبر نیست.",
    );
    assert(
      data.root === workspace.root,
      "پروژه تغییر کرده؛ مجوز را روی پروژهٔ فعلی انتخاب کن.",
    );
    const targetRoot = workspace.root,
      targetHarness = harness;
    const pending = targetHarness?.gate.public();
    if (data.enabled && pending)
      assert(
        pending.runId === data.runId && pending.nonce === data.nonce,
        "این تأیید منقضی شده؛ درخواست فعلی را بررسی کن.",
      );
    const permission = await settings.setProjectApproval(
      targetRoot,
      data.enabled,
    );
    if (targetHarness) {
      await targetHarness.event(
        "project_permission",
        data.enabled
          ? "کاربر اجرای خودکار فرمان‌ها را برای این پروژه فعال کرد."
          : "کاربر اجرای خودکار فرمان‌های پروژه را خاموش کرد.",
        { actor: "human", ...permission },
      );
      if (
        data.enabled &&
        pending &&
        targetHarness.gate.public()?.nonce === pending.nonce
      )
        await targetHarness.decide(pending.runId, pending.nonce, true);
    }
    return { ...permission, root: targetRoot };
  });
  ipc("startApp", async (data) => {
    available();
    keys(data, ["root", "optionId"]);
    assert(workspace, "پروژه انتخاب نشده است.");
    assert(
      data.root === workspace.root,
      "پروژه تغییر کرده؛ برنامه را از پروژهٔ فعلی اجرا کن.",
    );
    const targetWorkspace = workspace,
      targetHarness = harness;
    const option = (
      await launchOptions(targetWorkspace, targetHarness?.state?.launch)
    ).find((item) => item.id === data.optionId);
    assert(option, "گزینهٔ اجرا تغییر کرده؛ فهرست را به‌روزرسانی کن.");
    // The user clicks a labelled command in the output card; this is its one-shot approval.
    if (targetHarness)
      await targetHarness.event("approval", "کاربر دکمهٔ اجرای برنامه را زد.", {
        actor: "human",
        approved: true,
        command: option.command || null,
        path: option.path || null,
      });
    const result = option.path
      ? await runtime.preview(targetWorkspace, option.path, option.title)
      : await runtime.start(
          targetWorkspace,
          {
            command: option.command,
            title: option.title,
            ...(option.url ? { url: option.url } : {}),
          },
          { extraPrograms: skills.extraPrograms() },
        );
    if (targetHarness) {
      targetHarness.state.launch = result;
      await targetHarness.event(
        "application",
        "اجرای برنامه با درخواست مستقیم کاربر.",
        result,
      );
    }
    return result;
  });
  ipc("appInput", async (data) => {
    keys(data, ["id", "text", "eof"]);
    assert(workspace, "پروژه انتخاب نشده است.");
    return runtime.input(workspace.root, data.id, data.text, data.eof ?? false);
  });
  ipc("stopApp", async (data) => {
    keys(data, ["id"]);
    assert(workspace, "پروژه انتخاب نشده است.");
    return runtime.stop(workspace.root, data.id);
  });
  ipc("refreshApp", async () => {
    assert(workspace, "پروژه انتخاب نشده است.");
    return runtime.refresh(workspace.root);
  });
  ipc("openApp", async (data) => {
    keys(data, ["id", "runId"]);
    const ws = await viewedWorkspace(data.runId ? { runId: data.runId } : {});
    const app = await runtime.refresh(ws.root);
    assert(
      app?.id === data.id && app.url && app.status === "running",
      "لینک این اجرا هنوز آماده نیست یا برنامه بسته شده است.",
    );
    await shell.openExternal(localURL(app.url).href);
    return true;
  });
  ipc("chooseProject", async () => {
    available();
    const chosen = await dialog.showOpenDialog(win, {
      title: "انتخاب پوشهٔ پروژه",
      properties: ["openDirectory"],
    });
    if (chosen.canceled) return null;
    return select(chosen.filePaths[0]);
  });
  ipc("createDemo", async () => {
    available();
    const target = await createDemo(
      path.join(root, "examples/demo-node"),
      path.join(app.getPath("userData"), "workspaces"),
    );
    return { ...(await select(target, "offline-demo")), task: demoTask };
  });
  ipc("createProject", async (data) => {
    available();
    keys(data, ["name"]);
    return select(await createProject(app.getPath("userData"), data.name));
  });
  ipc("continueRun", async (runId) => {
    available();
    const saved = await store.load(runId);
    const selected = await select(saved.root);
    continuation = continuationFrom(saved);
    if (saved.connection) {
      try {
        selected.selection = settings.selection({
          providerId: saved.connection.providerId,
          model: saved.connection.model,
        });
      } catch {}
    }
    return selected;
  });
  ipc("listFiles", async () => {
    assert(workspace, "ابتدا پروژه را انتخاب کن.");
    return workspace.list();
  });
  ipc("readFile", async (file) => {
    assert(workspace, "پروژه انتخاب نشده است.");
    return workspace.read(text(file, 500));
  });
  ipc("saveFile", async (data) => {
    keys(data, ["path", "content", "expectedHash"]);
    assert(workspace, "پروژه انتخاب نشده است.");
    text(data.path, 500);
    if (harness)
      return harness.manualSave(data.path, data.content, data.expectedHash);
    return workspace.write(data.path, data.content, data.expectedHash, {
      actor: "human",
    });
  });
  ipc("plan", async (data) => {
    keys(data, ["task", "mode", "selection", "remember"]);
    assert(workspace, "ابتدا پوشهٔ پروژه یا دموی آماده را انتخاب کن.");
    available();
    assert(
      data.mode === "live" ||
        (data.mode === "offline-demo" && projectMode === "offline-demo"),
      "دموی آفلاین فقط روی پروژهٔ نمونهٔ تازه اجرا می‌شود.",
    );
    const config = settings.config(
      data.selection || settings.forProject(workspace.root),
    );
    const provider =
      data.mode === "offline-demo"
        ? new DemoProvider()
        : new ModelProvider(config);
    if (data.mode === "live")
      assert(
        config.apiKey && config.model,
        "ابتدا کلید همین پرووایدر و مدل را در تنظیمات انتخاب کن.",
      );
    if (data.mode === "live" && data.remember)
      await settings.saveProject(workspace.root, {
        providerId: config.providerId,
        model: config.model,
      });
    const connection =
      data.mode === "offline-demo"
        ? null
        : {
            providerId: config.providerId,
            providerName: config.providerName,
            model: config.model,
          };
    const h = connect(provider, data.mode, connection);
    void h.makePlan(data.task).catch((e) => h.fail(e));
    return { started: true };
  });
  ipc("approvePlan", async (data) => {
    assert(harness, "اجرایی وجود ندارد.");
    return harness.approvePlan(data);
  });
  ipc("decide", async (data) => {
    keys(data, ["runId", "nonce", "approved"]);
    assert(harness, "اجرایی وجود ندارد.");
    assert(typeof data.approved === "boolean", "تصمیم معتبر نیست.");
    return harness.decide(data.runId, data.nonce, data.approved);
  });
  ipc("stop", async () => {
    const result = await harness?.stop();
    const application = workspace && runtime.snapshot(workspace.root);
    if (application && ["running", "starting"].includes(application.status))
      await runtime.stop(workspace.root, application.id);
    return result;
  });
  ipc("newTask", async () => {
    available();
    if (harness?.state) continuation = continuationFrom(harness.state);
    harness = null;
    return true;
  });
  ipc("history", async () => store.list());
  ipc("loadRun", async (runId) => {
    available();
    const saved = await store.load(runId);
    return {
      ...saved,
      readOnly: true,
      approval: null,
      interrupted: [
        "planning",
        "running",
        "verifying",
        "awaiting_approval",
        "reviewing",
        "correcting",
        "awaiting_plan",
      ].includes(saved.status),
    };
  });
  ipc("exportRun", async (runId) => {
    const saved = await store.load(runId);
    const chosen = await dialog.showSaveDialog(win, {
      title: "ذخیرهٔ گزارش اجرا",
      defaultPath: `milo-run-${runId.slice(0, 8)}.json`,
      filters: [{ name: "JSON report", extensions: ["json"] }],
    });
    if (chosen.canceled) return null;
    await fs.writeFile(chosen.filePath, JSON.stringify(saved, null, 2), "utf8");
    return chosen.filePath;
  });
  ipc("settings", () => settings.public());
  ipc("saveSettings", async (data) => {
    available();
    const value = await settings.update(data);
    store.secrets = settings.allSecrets();
    runtime.secrets = settings.allSecrets();
    return value;
  });
  ipc("ping", async (selection) =>
    new ModelProvider(settings.config(selection)).ping(),
  );
  ipc("models", async (data) => {
    keys(data, ["providerId"]);
    const result = await settings.discover(data.providerId);
    return { ...result, settings: settings.public() };
  });
  ipc("skills", () => skills.list());
  ipc("toggleSkill", async (data) => {
    available();
    keys(data, ["id", "enabled"]);
    await skills.setEnabled(data.id, data.enabled);
    await saveSkillState();
    return skills.list();
  });
  ipc("inspectSkill", async () => {
    available();
    const chosen = await dialog.showOpenDialog(win, {
      title: "پوشهٔ مهارت دارای skill.json و SKILL.md",
      properties: ["openDirectory"],
    });
    if (chosen.canceled) return null;
    importing = await skills.inspect(chosen.filePaths[0]);
    return importing;
  });
  ipc("importSkill", async (data) => {
    available();
    keys(data, ["digest"]);
    assert(importing?.digest === data.digest, "پیش‌نمایش مهارت منقضی شده است.");
    await skills.import(importing.root, data.digest);
    importing = null;
    await saveSkillState();
    return skills.list();
  });
}
async function saveSkillState() {
  await settings.saveSkills(
    skills.list().map((s) => ({
      id: s.id,
      root: s.root,
      digest: s.digest,
      builtin: s.builtin,
      enabled: s.enabled,
    })),
  );
}
async function init() {
  const data = app.getPath("userData");
  settings = new Settings(data, safeStorage);
  await settings.load({
    envFile: app.isPackaged ? undefined : path.join(root, ".env"),
  });
  skills = new SkillRegistry();
  await skills.loadBuiltins(path.join(root, "skills"));
  for (const item of settings.value.skills || []) {
    try {
      if (!item.builtin) await skills.import(item.root, item.digest);
      await skills.setEnabled(item.id, item.enabled);
    } catch {}
  }
  store = new RunStore(path.join(data, "runs"), {
    secrets: settings.allSecrets(),
  });
  runtime = new AppRuntime({ secrets: settings.allSecrets() });
  runtime.on("change", (application) => send("application", application));
  runtime.on("output", (chunk) => send("appOutput", chunk));
  if (
    process.env.MILO_SMOKE === "1" &&
    process.env.MILO_SMOKE_RUNTIME === "1"
  ) {
    const scenario = await require("./core/desktop-smoke.cjs").desktopRuntime({
      data,
      runtime,
    });
    workspace = scenario.workspace;
    runtimeSmoke = scenario.checks;
  }
  session.defaultSession.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  register();
  win = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 1100,
    minHeight: 720,
    title: "Milo Code",
    backgroundColor: "#0b0b12",
    show: false,
    icon: path.join(root, "assets/milo.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererURL) event.preventDefault();
  });
  let closing = false,
    closePending = false;
  win.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    void (async () => {
      if (harness?.busy) {
        const result = await dialog.showMessageBox(win, {
          type: "question",
          message: "اجرا هنوز فعال است. متوقف شود و برنامه بسته شود؟",
          buttons: ["ادامهٔ کار", "توقف و بستن"],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) {
          closePending = false;
          return;
        }
        await harness.stop();
        await harness.job;
      }
      await runtime.close();
      closing = true;
      win.destroy();
    })().catch(() => {
      closePending = false;
    });
  });
  await win.loadFile(renderer);
  win.show();
  if (process.env.MILO_SMOKE === "1") {
    const status = await win.webContents.executeJavaScript(
      `window.milo.boot().then(packet => {
        const q = (s) => document.querySelector(s);
        const sidebar = q(".sidebar").getBoundingClientRect();
        const main = q(".main-shell").getBoundingClientRect();
        const heading = q(".welcome h2").getBoundingClientRect();
        const composer = q("#task-form").getBoundingClientRect();
        return {
          title: document.title, bridge: typeof window.milo?.boot,
          buttons: document.querySelectorAll("button").length,
          csp: !!q("meta[http-equiv]"),
          providerProfiles: packet.value.settings.providers.map(p => p.id),
          providerOptions: q("#run-provider").options.length,
          modelControl: !!q("#run-model"),
          sidebarOnRight: sidebar.left >= main.right,
          workspaceInitiallyHidden: q("#workbench").hidden,
          newProjectControl: !!q("#new-project"),
          taskEnabledWithoutProject: !packet.value.project && !q("#task").disabled && !q("#submit-task").disabled,
          welcomeHeadingClear: heading.height > 0 && heading.bottom <= composer.top,
          noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          deliveryControls: !!q("#delivery-folder") && !!q("#show-program"),
          projectApprovalControl: !!q("#project-approval"),
          runtimeBridge: typeof window.milo.appInput === "function" && typeof window.milo.openApp === "function",
          applicationPanelVisible: !q("#application-panel").hidden,
          applicationLink: q("#application-link").getAttribute("href")
        };
      })`,
    );
    assert(
      status.providerProfiles.length === 4 &&
        status.providerOptions === 4 &&
        status.modelControl,
      "کنترل‌های پرووایدر و مدل در رابط بارگذاری نشدند.",
    );
    assert(
      status.sidebarOnRight &&
        status.workspaceInitiallyHidden &&
        status.newProjectControl &&
        (runtimeSmoke || status.taskEnabledWithoutProject) &&
        (runtimeSmoke || status.welcomeHeadingClear) &&
        status.noHorizontalOverflow,
      "چیدمان صفحهٔ شروع یا کنترل‌های ساخت پروژه درست بارگذاری نشدند.",
    );
    assert(
      status.deliveryControls &&
        status.projectApprovalControl &&
        status.runtimeBridge,
      "کنترل‌های پروژه و اجرای برنامه بارگذاری نشدند.",
    );
    if (runtimeSmoke) {
      assert(
        status.applicationPanelVisible &&
          /^http:\/\/127\.0\.0\.1:\d+\//.test(status.applicationLink),
        "پنل برنامه یا لینک اجرای آن نمایش داده نشد.",
      );
      status.runtime = runtimeSmoke;
    }
    if (process.env.MILO_SMOKE_DEMO === "1")
      status.demo = await require("./core/desktop-smoke.cjs").desktopDemo({
        root,
        data,
        skills,
        store,
      });
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(
      path.join(data, "desktop-smoke.json"),
      JSON.stringify(
        { version: app.getVersion(), packaged: app.isPackaged, ...status },
        null,
        2,
      ),
    );
    if (process.env.MILO_SMOKE_KEEP_OPEN !== "1") app.quit();
  }
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(init)
    .catch(async (error) => {
      if (process.env.MILO_SMOKE === "1") {
        await fs.mkdir(app.getPath("userData"), { recursive: true });
        await fs.writeFile(
          path.join(app.getPath("userData"), "desktop-smoke-error.json"),
          JSON.stringify({ error: redact(error.message) }, null, 2),
        );
      } else dialog.showErrorBox("Milo Code", redact(error.message));
      app.exit(1);
    });
  app.on("window-all-closed", () => app.quit());
}
