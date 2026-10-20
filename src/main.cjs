"use strict";
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  session,
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
  harness = null,
  workspace = null,
  projectMode = "live";
let importing = null;
const available = () =>
  assert(
    !harness?.busy && !harness?.runner.child,
    "ابتدا اجرای فعلی را تمام یا متوقف کن و تا بسته‌شدن فرمان صبر کن.",
  );
const send = (name, data) => {
  if (win && !win.isDestroyed()) win.webContents.send("milo:" + name, data);
};
function connect(provider, mode) {
  const current = new Harness({
    workspace,
    provider,
    mode,
    skills,
    store,
    secrets: [settings.apiKey],
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
async function select(rootPath, mode = "live") {
  available();
  workspace = await Workspace.open(rootPath);
  harness = null;
  projectMode = mode;
  return { project: await workspace.summary(), mode };
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
      return { ok: false, error: redact(error.message, [settings?.apiKey]) };
    }
  });
}
function register() {
  ipc("boot", async () => ({
    version: app.getVersion(),
    project: workspace ? await workspace.summary() : null,
    state: harness?.snapshot() || null,
    settings: settings.public(),
    skills: skills.list(),
    dataPath: app.getPath("userData"),
  }));
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
    keys(data, ["task", "mode"]);
    assert(workspace, "ابتدا پوشهٔ پروژه یا دموی آماده را انتخاب کن.");
    available();
    assert(
      data.mode === "live" ||
        (data.mode === "offline-demo" && projectMode === "offline-demo"),
      "دموی آفلاین فقط روی پروژهٔ نمونهٔ تازه اجرا می‌شود.",
    );
    const provider =
      data.mode === "offline-demo"
        ? new DemoProvider()
        : new ModelProvider(settings.config());
    if (data.mode === "live")
      assert(settings.apiKey, "ابتدا کلید سرویس مدل را در تنظیمات وارد کن.");
    const h = connect(provider, data.mode);
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
  ipc("stop", async () => harness?.stop());
  ipc("newTask", async () => {
    available();
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
    store.secrets = [settings.apiKey];
    return value;
  });
  ipc("ping", async () => new ModelProvider(settings.config()).ping());
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
    skills
      .list()
      .map((s) => ({
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
  store = new RunStore(path.join(data, "runs"), { secrets: [settings.apiKey] });
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
    backgroundColor: "#0e1018",
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
  win.on("close", (event) => {
    if (harness?.busy) {
      event.preventDefault();
      void dialog
        .showMessageBox(win, {
          type: "question",
          message: "اجرا هنوز فعال است. متوقف شود و برنامه بسته شود؟",
          buttons: ["ادامهٔ کار", "توقف و بستن"],
          defaultId: 0,
          cancelId: 0,
        })
        .then(async (result) => {
          if (result.response === 1) {
            await harness.stop();
            await harness.job;
            win.destroy();
          }
        });
    }
  });
  await win.loadFile(renderer);
  win.show();
  if (process.env.MILO_SMOKE === "1") {
    const status = await win.webContents.executeJavaScript(
      '({title:document.title,bridge:typeof window.milo?.boot,buttons:document.querySelectorAll("button").length,csp:!!document.querySelector("meta[http-equiv]")})',
    );
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
    app.quit();
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
