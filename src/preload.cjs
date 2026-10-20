"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const call = (name, ...args) => ipcRenderer.invoke("milo:" + name, ...args);
contextBridge.exposeInMainWorld("milo", {
  boot: () => call("boot"),
  chooseProject: () => call("chooseProject"),
  createProject: (data) => call("createProject", data),
  continueRun: (id) => call("continueRun", id),
  resources: (data) => call("resources", data),
  setProjectApproval: (data) => call("setProjectApproval", data),
  openProjectFolder: (data) => call("openProjectFolder", data),
  revealFile: (data) => call("revealFile", data),
  startApp: (data) => call("startApp", data),
  stopApp: (data) => call("stopApp", data),
  appInput: (data) => call("appInput", data),
  refreshApp: () => call("refreshApp"),
  openApp: (data) => call("openApp", data),
  createDemo: () => call("createDemo"),
  listFiles: () => call("listFiles"),
  readFile: (path) => call("readFile", path),
  saveFile: (data) => call("saveFile", data),
  plan: (data) => call("plan", data),
  approvePlan: (data) => call("approvePlan", data),
  decide: (data) => call("decide", data),
  stop: () => call("stop"),
  newTask: (data) => call("newTask", data),
  history: () => call("history"),
  conversations: (data) => call("conversations", data),
  thread: (id) => call("thread", id),
  recentProjects: () => call("recentProjects"),
  openRecentProject: (root) => call("openRecentProject", root),
  saveDraft: (data) => call("saveDraft", data),
  databaseInfo: () => call("databaseInfo"),
  checkDatabase: () => call("checkDatabase"),
  openDataFolder: () => call("openDataFolder"),
  backupData: () => call("backupData"),
  restoreData: () => call("restoreData"),
  loadRun: (id) => call("loadRun", id),
  exportRun: (id) => call("exportRun", id),
  settings: () => call("settings"),
  saveSettings: (data) => call("saveSettings", data),
  ping: (selection) => call("ping", selection),
  models: (data) => call("models", data),
  skills: () => call("skills"),
  toggleSkill: (data) => call("toggleSkill", data),
  inspectSkill: () => call("inspectSkill"),
  importSkill: (data) => call("importSkill", data),
  onState: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on("milo:state", listener);
    return () => ipcRenderer.removeListener("milo:state", listener);
  },
  onOutput: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on("milo:output", listener);
    return () => ipcRenderer.removeListener("milo:output", listener);
  },
  onApplication: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on("milo:application", listener);
    return () => ipcRenderer.removeListener("milo:application", listener);
  },
  onAppOutput: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on("milo:appOutput", listener);
    return () => ipcRenderer.removeListener("milo:appOutput", listener);
  },
});
