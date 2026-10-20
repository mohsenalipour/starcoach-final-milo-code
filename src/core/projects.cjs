"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { assert, text, id } = require("./protocol.cjs");

async function createProject(dataRoot, name = "پروژه جدید") {
  text(name, 80, "نام پروژه");
  const title = name.trim();
  assert(
    title && !/[<>:"/\\|?*\x00-\x1f]/.test(title),
    "یک نام ساده برای پروژه بنویس؛ نام نباید شامل نشانه‌های مسیر باشد.",
  );
  assert(!/[. ]$/.test(title), "نام پروژه نباید با نقطه یا فاصله تمام شود.");
  const parent = path.resolve(dataRoot, "projects");
  const folder = path.join(parent, title + "-" + id().slice(0, 8));
  assert(path.dirname(folder) === parent, "مسیر پروژه معتبر نیست.");
  await fs.mkdir(parent, { recursive: true });
  await fs.mkdir(folder);
  return folder;
}

function continuationFrom(run) {
  if (!run) return null;
  return {
    runId: run.id,
    task: String(run.task || "").slice(0, 6000),
    summary: String(run.summary || run.plan?.summary || "").slice(0, 2400),
    changedFiles: (run.changes || []).slice(0, 40).map((c) => c.path),
  };
}
module.exports = { createProject, continuationFrom };
