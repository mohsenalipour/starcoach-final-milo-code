const $ = (id) => document.getElementById(id);
const fa = (n) => new Intl.NumberFormat("fa-IR").format(n);
export class DataControls {
  constructor({ call, guard, toast, onProject, flushDraft }) {
    Object.assign(this, { call, guard, toast, onProject, flushDraft });
    $("open-data").onclick = () => guard(() => this.open());
    $("open-data-folder").onclick = () => guard(() => call("openDataFolder"));
    $("check-database").onclick = () =>
      guard(async () => {
        const result = await call("checkDatabase");
        $("data-result").textContent = result.ok
          ? "یکپارچگی دیتابیس تأیید شد."
          : "بررسی دیتابیس خطا پیدا کرد؛ یک پشتیبان نگه دار.";
      });
    $("backup-data").onclick = () =>
      guard(() =>
        this.action(async () => {
          await flushDraft();
          const result = await call("backupData");
          if (result)
            $("data-result").textContent = "پشتیبان ذخیره شد: " + result;
        }),
      );
    $("restore-data").onclick = () =>
      guard(() =>
        this.action(async () => {
          await flushDraft();
          const result = await call("restoreData");
          if (result) {
            toast("پشتیبان بازیابی شد.");
            window.location.reload();
          }
        }),
      );
  }
  async action(fn) {
    const buttons = $("data-dialog").querySelectorAll("button");
    for (const b of buttons) b.disabled = true;
    try {
      await fn();
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  }
  async open() {
    $("data-result").textContent = "";
    const [info, projects] = await Promise.all([
      this.call("databaseInfo"),
      this.call("recentProjects"),
    ]);
    $("database-path").textContent = info.file;
    $("database-summary").textContent =
      "SQLite · نسخهٔ ساختار " +
      fa(info.schemaVersion) +
      " · " +
      fa(Math.round(info.bytes / 1024)) +
      " کیلوبایت";
    const counts = $("database-counts");
    counts.replaceChildren();
    for (const [key, label] of [
      ["projects", "پروژه"],
      ["conversations", "گفتگو"],
      ["runs", "درخواست"],
      ["messages", "پیام"],
      ["drafts", "پیش‌نویس"],
    ]) {
      const item = document.createElement("div"),
        number = document.createElement("strong"),
        text = document.createElement("span");
      number.textContent = fa(info.counts[key]);
      text.textContent = label;
      item.append(number, text);
      counts.append(item);
    }
    const migration = info.migration;
    $("migration-note").textContent = migration?.skipped?.length
      ? "انتقال قبلی انجام شده؛ " +
        fa(migration.skipped.length) +
        " فایل نامعتبر کنار گذاشته شد. فایل‌های JSON اصلی حذف نشده‌اند."
      : migration?.runs || migration?.settings
        ? "تنظیمات و تاریخچهٔ نسخهٔ قبلی منتقل شدند؛ فایل‌های JSON اصلی هم حفظ شده‌اند."
        : "اطلاعات روی همین دستگاه ذخیره می‌شوند و به دیتابیس آنلاین نیاز ندارند.";
    const list = $("recent-projects");
    list.replaceChildren();
    if (!projects.length) list.textContent = "هنوز پروژه‌ای ذخیره نشده است.";
    for (const project of projects) {
      const button = document.createElement("button"),
        title = document.createElement("strong"),
        root = document.createElement("small");
      button.type = "button";
      button.className = "recent-project";
      title.textContent = project.name;
      root.textContent = project.root;
      root.dir = "ltr";
      button.append(title, root);
      button.onclick = () =>
        this.guard(async () => {
          await this.flushDraft();
          const result = await this.call("openRecentProject", project.root);
          await this.onProject(result);
          $("data-dialog").close();
        });
      list.append(button);
    }
    $("data-dialog").showModal();
  }
}
