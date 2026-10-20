"use strict";
const { EventEmitter } = require("node:events");
const {
  assert,
  id,
  keys,
  text,
  plan: validatePlan,
  action: validateAction,
  redact,
} = require("./protocol.cjs");
const { CommandRunner } = require("./commands.cjs");
const busyStates = new Set([
  "planning",
  "awaiting_plan",
  "running",
  "awaiting_approval",
  "verifying",
  "correcting",
  "reviewing",
]);
class ApprovalGate {
  constructor() {
    this.pending = null;
  }
  request(payload, signal) {
    assert(!this.pending, "یک تأیید دیگر در انتظار است.");
    assert(!signal?.aborted, "متوقف شده است.", "ABORTED");
    return new Promise((resolve, reject) => {
      const nonce = id(),
        abort = () => {
          if (this.pending?.nonce === nonce) {
            this.pending = null;
            reject(new Error("عملیات متوقف شد."));
          }
        };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending = {
        ...payload,
        nonce,
        settle: (approved) => {
          signal?.removeEventListener("abort", abort);
          this.pending = null;
          resolve(approved);
        },
      };
    });
  }
  decide(runId, nonce, approved) {
    assert(
      this.pending &&
        this.pending.runId === runId &&
        this.pending.nonce === nonce,
      "این تأیید منقضی شده یا مربوط به اجرای دیگری است.",
      "STALE_APPROVAL",
    );
    this.pending.settle(!!approved);
  }
  public() {
    if (!this.pending) return null;
    const { settle, ...value } = this.pending;
    return value;
  }
}
class Harness extends EventEmitter {
  constructor({
    workspace,
    provider,
    skills,
    store,
    mode = "live",
    connection = null,
    continuation = null,
    runtime = null,
    projectApproval = () => false,
    maxIterations = 28,
    maxCorrections = 6,
    secrets = [],
  }) {
    super();
    Object.assign(this, {
      workspace,
      provider,
      skills,
      store,
      mode,
      connection,
      continuation,
      runtime,
      projectApproval,
      maxIterations,
      maxCorrections,
      secrets,
    });
    this.runner = new CommandRunner({ secrets });
    this.gate = new ApprovalGate();
    this.state = null;
    this.controller = null;
    this.job = null;
  }
  get busy() {
    return busyStates.has(this.state?.status);
  }
  snapshot() {
    return this.state
      ? this.store.clean({ ...this.state, approval: this.gate.public() })
      : null;
  }
  async event(type, message, data = {}) {
    if (!this.state) return;
    this.state.updatedAt = new Date().toISOString();
    this.state.events.push({
      id: id(),
      at: this.state.updatedAt,
      type,
      message: redacted(message, this.secrets),
      data: this.store.clean(data),
    });
    if (this.state.events.length > 160)
      this.state.events.splice(0, this.state.events.length - 160);
    await this.store.save(this.snapshot());
    this.emit("state", this.snapshot());
  }
  async status(status, message) {
    this.state.status = status;
    await this.event("status", message, { status });
  }
  async makePlan(task) {
    assert(!this.busy, "اجرای فعلی را تمام یا متوقف کن.");
    text(task, 6000, "درخواست");
    assert(task.trim().length >= 8, "درخواست را کمی کامل‌تر بنویس.");
    this.controller = new AbortController();
    this.state = {
      id: id(),
      mode: this.mode,
      connection: this.connection,
      continuation: this.continuation,
      root: this.workspace.root,
      task: task.trim(),
      status: "planning",
      plan: null,
      events: [],
      observations: [],
      changes: [],
      backups: [],
      verification: null,
      review: null,
      iterations: 0,
      corrections: 0,
      currentStep: -1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.workspace.changes.clear();
    await this.event("task", "درخواست ثبت شد؛ در حال بررسی پروژه و ساخت پلن.");
    try {
      const listing = await this.workspace.summary(),
        manifests = [];
      for (const name of ["package.json", "pyproject.toml", "README.md"]) {
        try {
          const f = await this.workspace.read(name, { agent: true });
          manifests.push({ path: name, content: f.content.slice(0, 5000) });
        } catch {}
      }
      const proposal = await this.provider.plan(
        {
          task: this.state.task,
          continuation: this.continuation,
          project: { name: listing.name, files: listing.files },
          manifests,
          skills: await this.skills.context(),
        },
        { signal: this.controller.signal },
      );
      if (this.controller.signal.aborted) return;
      this.state.plan = validatePlan(proposal);
      await this.status(
        "awaiting_plan",
        "پلن آماده است. مراحل و فرمان تست را مرور و در صورت نیاز ویرایش کن.",
      );
    } catch (error) {
      await this.fail(error);
    }
    return this.snapshot();
  }
  async approvePlan(input, { actor = "human" } = {}) {
    assert(
      this.state?.status === "awaiting_plan",
      "پلنی در انتظار تأیید نیست.",
    );
    this.state.plan = validatePlan(input);
    this.state.planApprovedAt = new Date().toISOString();
    await this.event(
      "plan_approved",
      actor === "test-driver"
        ? "درایور تست، پلن پروژهٔ نمونه را پذیرفت."
        : "پلن و معیار تست توسط کاربر تأیید شد.",
      { actor, verification: this.state.plan.verification },
    );
    this.job = this.loop().catch((error) => this.fail(error));
    return this.snapshot();
  }
  async observe(tool, result) {
    this.state.observations.push({ tool, result: this.store.clean(result) });
    if (this.state.observations.length > 14) this.state.observations.shift();
    await this.event("tool_result", tool, { tool, result });
  }
  async context() {
    return this.store.clean({
      task: this.state.task,
      continuation: this.state.continuation,
      plan: this.state.plan,
      skills: await this.skills.context(),
      files: (await this.workspace.list(".", 200)).files,
      changes: this.workspace.changeList().map((c) => ({
        path: c.path,
        before: c.before?.slice(0, 14000) ?? null,
        after: c.after.slice(0, 18000),
      })),
      observations: this.state.observations,
      verification: this.state.verification,
      iteration: this.state.iterations,
      corrections: this.state.corrections,
      application: this.runtime?.snapshot(this.workspace.root) || null,
    });
  }
  async loop() {
    await this.status("running", "اجرای پلن با ابزارهای پروژه شروع شد.");
    while (
      !this.controller.signal.aborted &&
      this.state.iterations < this.maxIterations
    ) {
      this.state.iterations++;
      const next = validateAction(
        await this.provider.next(await this.context(), {
          signal: this.controller.signal,
        }),
        this.state.plan.steps.length,
      );
      if (this.controller.signal.aborted) break;
      if (next.type === "finish") {
        if (
          !this.state.verification?.ok ||
          this.state.verification.fingerprint !==
            (await this.workspace.fingerprint())
        ) {
          this.state.verification = null;
          await this.observe("finish", {
            error:
              "ابتدا verify را روی آخرین وضعیت فایل‌ها اجرا کن؛ بدون تست موفق امکان اتمام نیست.",
          });
          continue;
        }
        await this.status(
          "reviewing",
          "تست موفق بود؛ بازبینی نهایی تغییرات و معیارهای قبولی.",
        );
        const review = await this.provider.review(await this.context(), {
          signal: this.controller.signal,
        });
        this.state.review = review;
        await this.event("review", review.summary, {
          accepted: review.accepted,
          issues: review.issues,
        });
        if (
          review.accepted &&
          this.state.verification.fingerprint ===
            (await this.workspace.fingerprint())
        ) {
          this.state.summary = next.summary;
          this.state.currentStep = this.state.plan.steps.length;
          await this.status(
            "completed",
            "کار با تست موفق و بازبینی نهایی تمام شد.",
          );
          return;
        }
        this.state.corrections++;
        await this.observe("review", {
          error: "بازبینی پذیرفته نشد یا فایل‌ها پس از تست تغییر کرده‌اند.",
          issues: review.issues,
        });
      } else {
        this.state.currentStep = next.step;
        await this.event("tool_start", next.message || next.tool, {
          tool: next.tool,
          step: next.step,
          args:
            next.tool === "write_file" ? { path: next.args.path } : next.args,
        });
        let result;
        try {
          result = await this.tool(next.tool, next.args);
        } catch (error) {
          if (this.controller.signal.aborted) break;
          result = { error: error.message, code: error.code || "TOOL_ERROR" };
        }
        if (this.controller.signal.aborted) break;
        if (result.error || (next.tool === "verify" && !result.ok)) {
          this.state.corrections++;
          await this.status(
            "correcting",
            "ابزار یا تست خطا داد؛ نتیجه برای اصلاح به مدل برمی‌گردد.",
          );
        }
        await this.observe(next.tool, result);
      }
      if (this.state.corrections >= this.maxCorrections) {
        await this.status(
          "needs_attention",
          "سقف چرخه‌های اصلاح رسید. خروجی و خطاها برای ادامهٔ دستی ذخیره شد.",
        );
        return;
      }
      await this.status(
        "running",
        "در حال انتخاب گام بعدی بر اساس نتیجهٔ واقعی ابزارها.",
      );
    }
    if (this.controller.signal.aborted) {
      if (this.state.status !== "stopped")
        await this.status("stopped", "اجرا با درخواست کاربر متوقف شد.");
    } else
      await this.status(
        "needs_attention",
        "سقف تعداد عملیات رسید؛ اجرا برای بررسی کاربر متوقف شد.",
      );
  }
  async tool(name, args) {
    if (name === "list_files") {
      keys(args, ["path"]);
      return this.workspace.list(args.path || ".");
    }
    if (name === "read_file") {
      keys(args, ["path"]);
      return this.workspace.read(text(args.path, 500), { agent: true });
    }
    if (name === "search_files") {
      keys(args, ["query"]);
      return this.workspace.search(args.query);
    }
    if (name === "write_file") {
      keys(args, ["path", "content", "expectedHash"]);
      text(args.path, 500);
      assert(
        args.expectedHash === null || /^[a-f0-9]{64}$/.test(args.expectedHash),
        "هش فایل معتبر نیست.",
      );
      let before = null;
      try {
        before = await this.workspace.read(args.path, { agent: true });
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      assert(
        !before?.redacted,
        "این فایل حاوی دادهٔ محرمانه است و قابل بازنویسی با مدل نیست.",
      );
      if (!this.state.backups.some((b) => b.path === args.path)) {
        this.state.backups.push({
          path: args.path,
          before: before?.content ?? null,
          hash: before?.hash ?? null,
        });
        await this.store.save(this.snapshot());
      }
      const result = await this.workspace.write(
        args.path,
        args.content,
        args.expectedHash,
      );
      this.state.verification = null;
      this.state.review = null;
      this.state.changes = this.workspace.changeList();
      return result;
    }
    if (name === "verify") {
      keys(args, []);
      return this.execute(this.state.plan.verification, { verification: true });
    }
    if (name === "run_command") return this.execute(args);
    if (name === "launch_app") {
      keys(args, ["command", "title", "url"]);
      assert(this.runtime, "اجرای تعاملی در این محیط در دسترس نیست.");
      const prepared = await this.runner.prepareApp(
        args.command,
        this.workspace,
        this.skills.extraPrograms(),
      );
      if (!(await this.authorize(prepared, { application: true })))
        return { error: "کاربر اجرای برنامه را نپذیرفت.", denied: true };
      assert(!this.controller.signal.aborted, "عملیات متوقف شد.", "ABORTED");
      await this.status(
        "running",
        "در حال باز کردن برنامه؛ اجرای آن مستقل از تست ادامه پیدا می‌کند.",
      );
      const result = await this.runtime.start(this.workspace, args, {
        prepared,
      });
      this.state.launch = result;
      this.state.verification = null;
      const ok =
        ["running", "starting"].includes(result.status) ||
        result.exitCode === 0;
      await this.event(
        "application",
        ok
          ? "برنامه اجرا شد؛ خروجی و کنترل آن در بخش برنامه در دسترس است."
          : "شروع برنامه با خطا تمام شد؛ خروجی واقعی برای بررسی ذخیره شد.",
        result,
      );
      return {
        ...result,
        ok,
        ...(!ok
          ? {
              error: result.error || `برنامه با کد ${result.exitCode} بسته شد.`,
            }
          : {}),
      };
    }
    if (name === "preview_file") {
      keys(args, ["path", "title"]);
      assert(this.runtime, "پیش‌نمایش در این محیط در دسترس نیست.");
      const result = await this.runtime.preview(
        this.workspace,
        args.path,
        args.title,
      );
      this.state.launch = result;
      await this.event("application", "پیش‌نمایش وب محلی آماده است.", result);
      return result;
    }
    if (name === "app_status") {
      keys(args, []);
      return this.runtime?.refresh(this.workspace.root) || null;
    }
    if (name === "run_skill") {
      keys(args, ["skill", "tool"]);
      const tool = await this.skills.tool(args.skill, args.tool);
      return this.execute(tool.command, {
        skill: `${args.skill}/${args.tool}`,
      });
    }
    throw new Error("ابزار ناشناخته است.");
  }
  async execute(input, { verification = false, skill = null } = {}) {
    const prepared = await this.runner.prepare(
      input,
      this.workspace,
      this.skills.extraPrograms(),
    );
    if (!(await this.authorize(prepared, { verification, skill })))
      return { error: "کاربر اجرای این فرمان را نپذیرفت.", denied: true };
    assert(!this.controller.signal.aborted, "عملیات متوقف شد.", "ABORTED");
    await this.status(
      verification ? "verifying" : "running",
      verification
        ? "در حال اجرای تست واقعی روی فایل‌های فعلی."
        : "فرمان تأییدشده در حال اجراست.",
    );
    const before = await this.workspace.fingerprint();
    const result = await this.runner.run(prepared, {
      signal: this.controller.signal,
      onOutput: (chunk) => this.emit("output", chunk),
    });
    if (verification) {
      const after = await this.workspace.fingerprint();
      result.ok = result.ok && before === after;
      result.stale = before !== after;
      this.state.verification = {
        ...result,
        fingerprint: after,
        at: new Date().toISOString(),
      };
    } else this.state.verification = null;
    await this.event(
      "command",
      result.ok ? "فرمان با موفقیت تمام شد." : "فرمان با خطا یا توقف تمام شد.",
      result,
    );
    return result;
  }
  async authorize(
    prepared,
    { verification = false, skill = null, application = false } = {},
  ) {
    if (this.projectApproval()) {
      await this.event(
        "approval",
        "فرمان با مجوز ذخیره‌شدهٔ همین پروژه تأیید شد.",
        {
          actor: "project-policy",
          approved: true,
          command: prepared.spec,
          application,
        },
      );
      return true;
    }
    const awaiting = this.gate.request(
      {
        runId: this.state.id,
        command: prepared.spec,
        executable: prepared.executable,
        effectiveArgs: prepared.args,
        cwd: prepared.cwd,
        verification,
        skill,
        application,
      },
      this.controller.signal,
    );
    await this.status(
      "awaiting_approval",
      verification
        ? "فرمان تست نهایی آماده است؛ برای اجرای آن تأیید لازم است."
        : "اجرای این فرمان نیاز به تأیید کاربر دارد.",
    );
    return awaiting;
  }
  async decide(runId, nonce, approved, { actor = "human" } = {}) {
    this.gate.decide(runId, nonce, approved);
    await this.event(
      "approval",
      actor === "test-driver"
        ? approved
          ? "درایور تست، فرمان محدود پروژهٔ نمونه را پذیرفت."
          : "درایور تست، فرمان خارج از سناریو را رد کرد."
        : approved
          ? "کاربر این فرمان را تأیید کرد."
          : "کاربر این فرمان را رد کرد.",
      { actor, approved, nonce },
    );
    return this.snapshot();
  }
  async manualSave(file, content, expectedHash) {
    assert(
      !this.busy ||
        ["awaiting_plan", "awaiting_approval"].includes(this.state.status),
      "برای ویرایش دستی، اجرا را متوقف کن یا تا مرحلهٔ تأیید صبر کن.",
    );
    const result = await this.workspace.write(file, content, expectedHash, {
      actor: "human",
    });
    if (this.state) {
      this.state.verification = null;
      this.state.review = null;
      this.state.summary = null;
      if (this.state.status === "completed")
        this.state.status = "needs_attention";
      this.state.changes = this.workspace.changeList();
      await this.event(
        "manual_edit",
        "فایل توسط کاربر ویرایش شد؛ تأیید تست قبلی باطل شد.",
        { path: file },
      );
    }
    return result;
  }
  async stop() {
    if (!this.busy) return this.snapshot();
    this.controller.abort();
    await this.status(
      "stopped",
      "اجرا متوقف شد؛ تغییرات فایل‌ها برای بازبینی باقی مانده‌اند.",
    );
    return this.snapshot();
  }
  async fail(error) {
    if (!this.state) return;
    if (this.controller?.signal.aborted) {
      if (this.state.status !== "stopped")
        await this.status("stopped", "اجرا متوقف شد.");
      return;
    }
    this.state.error = redacted(error.message, this.secrets);
    await this.status("needs_attention", this.state.error);
  }
}
const redacted = (value, secrets) => redact(value, secrets);
module.exports = { Harness, ApprovalGate, busyStates };
