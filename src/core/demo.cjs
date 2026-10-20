"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { id, assert } = require("./protocol.cjs");
const demoTask =
  "اشکال‌های جمع و محدودکردن عدد را در src/math.cjs پیدا و اصلاح کن. تست‌های موجود باید بدون تغییر پاس شوند. رفتار min و max و عدد منفی را هم بررسی کن.";
class DemoProvider {
  constructor() {
    this.phase = 0;
    this.model = "Offline scripted demo";
  }
  async plan() {
    return {
      title: "اصلاح کتابخانهٔ کوچک ریاضی",
      summary:
        "این دمو از مدل ازپیش‌نوشته‌شده و ابزارها و تست‌های واقعی استفاده می‌کند. دو اشکال را پیدا می‌کنیم و پس از شکست تست، اصلاح را ادامه می‌دهیم.",
      steps: [
        "خواندن کد، تست‌ها و مهارت تست Node",
        "اصلاح تابع جمع و اجرای تست‌ها",
        "تشخیص خطای باقی‌مانده و اصلاح clamp",
        "تست نهایی و بازبینی تغییرات",
      ],
      acceptance: [
        "تست‌های اصلی بدون دست‌کاری موفق شوند.",
        "جمع و clamp برای مقادیر مرزی درست کار کنند.",
      ],
      verification: {
        program: "node",
        args: ["--test", "tests/math.test.cjs"],
        cwd: ".",
        timeoutMs: 15000,
      },
    };
  }
  async next(context) {
    const obs = context.observations,
      read = () =>
        [...obs]
          .reverse()
          .find(
            (o) => o.tool === "read_file" && o.result.path === "src/math.cjs",
          )?.result;
    const tool = (step, name, args, message) => ({
      type: "tool",
      step,
      tool: name,
      args,
      message,
    });
    switch (this.phase++) {
      case 0:
        return tool(0, "list_files", {}, "ساختار پروژه را می‌خوانم.");
      case 1:
        return tool(
          0,
          "read_file",
          { path: "src/math.cjs" },
          "پیاده‌سازی توابع را بررسی می‌کنم.",
        );
      case 2:
        return tool(
          0,
          "read_file",
          { path: "tests/math.test.cjs" },
          "انتظار تست‌های واقعی را می‌خوانم.",
        );
      case 3:
        return tool(
          0,
          "run_skill",
          { skill: "node-testing", tool: "version" },
          "نسخهٔ Node همراه برنامه را با ابزار مهارت بررسی می‌کنم.",
        );
      case 4: {
        const f = read();
        return tool(
          1,
          "write_file",
          {
            path: f.path,
            expectedHash: f.hash,
            content: f.content.replace("return a - b;", "return a + b;"),
          },
          "اشکال جمع را اصلاح می‌کنم.",
        );
      }
      case 5:
        return tool(
          1,
          "verify",
          {},
          "تست‌ها را اجرا می‌کنم تا نتیجهٔ واقعی مشخص شود.",
        );
      case 6:
        return tool(
          2,
          "read_file",
          { path: "src/math.cjs" },
          "تست clamp شکست خورد؛ نسخهٔ فعلی را دوباره می‌خوانم.",
        );
      case 7: {
        const f = read();
        assert(
          context.verification?.ok === false,
          "دمو باید ابتدا شکست واقعی تست را ببیند.",
        );
        return tool(
          2,
          "write_file",
          {
            path: f.path,
            expectedHash: f.hash,
            content: f.content.replace(
              "Math.min(min, Math.max(max, value))",
              "Math.max(min, Math.min(max, value))",
            ),
          },
          "ترتیب min و max در clamp را با توجه به شکست تست درست می‌کنم.",
        );
      }
      case 8:
        return tool(
          3,
          "verify",
          {},
          "تست نهایی را روی هر دو اصلاح اجرا می‌کنم.",
        );
      default:
        return {
          type: "finish",
          summary:
            "هر دو اشکال اصلاح شد. تست‌های اصلی بدون تغییر موفق شدند و بازبینی نهایی انجام شد.",
        };
    }
  }
  async review(context) {
    const accepted =
      context.verification?.ok === true &&
      context.changes.some((c) => c.path === "src/math.cjs") &&
      !context.changes.some((c) => c.path.startsWith("tests/"));
    return {
      accepted,
      issues: accepted ? [] : ["تست یا تغییرات دمو مطابق انتظار نیست."],
      summary: "جمع، clamp و مقادیر مرزی بررسی شدند؛ فایل تست تغییر نکرده است.",
    };
  }
}
async function createDemo(templateRoot, destinationRoot) {
  await fs.mkdir(destinationRoot, { recursive: true });
  const target = path.join(
    destinationRoot,
    "math-workshop-" + id().slice(0, 8),
  );
  await fs.mkdir(target);
  // Explicit reads work inside Electron ASAR; fs.cp uses native paths on Windows.
  for (const relative of [
    "package.json",
    "README.md",
    "src/math.cjs",
    "tests/math.test.cjs",
  ]) {
    const content = await fs.readFile(
      path.join(templateRoot, ...relative.split("/")),
    );
    const file = path.join(target, ...relative.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { flag: "wx" });
  }
  return target;
}
module.exports = { DemoProvider, createDemo, demoTask };
