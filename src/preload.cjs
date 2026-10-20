"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const call = (name, ...args) => ipcRenderer.invoke("milo:" + name, ...args);
contextBridge.exposeInMainWorld("milo", {
  boot: () => call("boot"),
  chooseProject: () => call("chooseProject"),
  createDemo: () => call("createDemo"),
  listFiles: () => call("listFiles"),
  readFile: (path) => call("readFile", path),
  saveFile: (data) => call("saveFile", data),
  plan: (data) => call("plan", data),
  approvePlan: (data) => call("approvePlan", data),
  decide: (data) => call("decide", data),
  stop: () => call("stop"),
  newTask: () => call("newTask"),
  history: () => call("history"),
  loadRun: (id) => call("loadRun", id),
  exportRun: (id) => call("exportRun", id),
  settings: () => call("settings"),
  saveSettings: (data) => call("saveSettings", data),
  ping: () => call("ping"),
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
});
