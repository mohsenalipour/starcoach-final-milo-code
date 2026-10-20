"use strict";
const path = require("node:path");
const { assert } = require("./protocol.cjs");
function registerStorage({
  ipc,
  database,
  getWindow,
  available,
  setBusy,
  quiesce,
  reload,
  dataPath,
  dialog,
  shell,
}) {
  ipc("databaseInfo", () => database.info());
  ipc("checkDatabase", () => database.integrity());
  ipc("openDataFolder", async () => {
    const error = await shell.openPath(dataPath);
    assert(!error, error || "پوشهٔ داده‌ها باز نشد.");
    return true;
  });
  ipc("backupData", async () => {
    available();
    const chosen = await dialog.showSaveDialog(getWindow(), {
      title: "پشتیبان داده‌های Milo",
      defaultPath:
        "Milo-backup-" + new Date().toISOString().slice(0, 10) + ".sqlite",
      filters: [{ name: "Milo SQLite backup", extensions: ["sqlite"] }],
    });
    if (chosen.canceled) return null;
    assert(path.isAbsolute(chosen.filePath), "مسیر پشتیبان معتبر نیست.");
    return database.backup(chosen.filePath);
  });
  ipc("restoreData", async () => {
    available();
    setBusy(true);
    try {
      const chosen = await dialog.showOpenDialog(getWindow(), {
        title: "انتخاب پشتیبان Milo",
        properties: ["openFile"],
        filters: [{ name: "Milo SQLite backup", extensions: ["sqlite"] }],
      });
      if (chosen.canceled) return null;
      const source = chosen.filePaths[0];
      const answer = await dialog.showMessageBox(getWindow(), {
        type: "question",
        title: "بازیابی داده‌های Milo",
        message: "تنظیمات و گفتگوها از این پشتیبان جایگزین شوند؟",
        detail:
          source +
          "\nپیش از جایگزینی، پشتیبان خودکار از اطلاعات فعلی ساخته می‌شود. فایل‌های پروژه‌ها تغییر نمی‌کنند. مجوز اجرای خودکار فرمان‌ها پس از بازیابی خاموش می‌شود.",
        buttons: ["انصراف", "بازیابی پشتیبان"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) return null;
      await quiesce();
      const result = await database.restore(source);
      await reload();
      return result;
    } finally {
      setBusy(false);
    }
  });
}
module.exports = { registerStorage };
