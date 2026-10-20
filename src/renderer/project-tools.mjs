const $ = (id) => document.getElementById(id);
const running = (app) => app && ["running", "starting"].includes(app.status);
const commandText = (command) =>
  command
    ? [
        command.program,
        ...command.args.map((arg) =>
          /\s|["']/.test(arg) ? JSON.stringify(arg) : arg,
        ),
      ].join(" ")
    : "";

export class ProjectTools {
  constructor({ call, guard, toast, context, show }) {
    Object.assign(this, { call, guard, toast, context, show });
    this.value = null;
    this.request = 0;
    const openFolder = () =>
      guard(() => call("openProjectFolder", this.viewData()));
    for (const id of [
      "open-project-folder",
      "delivery-folder",
      "delivery-path",
    ])
      $(id).onclick = openFolder;
    $("project-approval").onclick = () =>
      guard(() => this.setApproval(!this.value?.approval.autoApproveCommands));
    $("show-program").onclick = () => this.reveal();
    $("launch-option").onchange = () => this.renderCommand();
    $("launch-program").onclick = () =>
      guard(async () => {
        $("launch-program").disabled = true;
        try {
          const application = await call("startApp", {
            root: this.value.root,
            optionId: $("launch-option").value,
          });
          if (this.value?.root === application.root) {
            this.value.application = application;
            await this.refresh();
            this.reveal();
          }
        } finally {
          this.render();
        }
      });
    $("stop-application").onclick = () =>
      guard(async () => {
        const application = await call("stopApp", {
          id: this.value.application.id,
        });
        if (this.value?.root === application.root)
          this.value.application = application;
        this.render();
      });
    $("refresh-application").onclick = () =>
      guard(async () => {
        const application = await call("refreshApp");
        if (application && this.value?.root === application.root)
          this.value.application = application;
        this.render();
      });
    $("application-link").onclick = (event) => {
      event.preventDefault();
      void guard(() =>
        call("openApp", { id: this.value.application.id, ...this.viewData() }),
      );
    };
    $("application-input-form").onsubmit = (event) => {
      event.preventDefault();
      void guard(async () => {
        const input = $("application-input");
        await call("appInput", {
          id: this.value.application.id,
          text: input.value,
        });
        input.value = "";
        input.focus();
      });
    };
    $("application-eof").onclick = () =>
      guard(() =>
        call("appInput", {
          id: this.value.application.id,
          text: "",
          eof: true,
        }),
      );
  }
  viewData() {
    const { state } = this.context();
    return state?.readOnly ? { runId: state.id } : {};
  }
  adopt(value) {
    this.request++;
    this.value = value;
    this.render();
  }
  async refresh() {
    const request = ++this.request;
    if (!this.context().project) {
      this.adopt(null);
      return;
    }
    const value = await this.call("resources", this.viewData());
    if (request !== this.request) return;
    this.value = value;
    this.render();
  }
  async setApproval(enabled) {
    const pending = this.context().state?.approval;
    const approval = await this.call("setProjectApproval", {
      root: this.value?.root,
      enabled,
      ...(pending ? { runId: pending.runId, nonce: pending.nonce } : {}),
    });
    if (this.value?.root === approval.root) this.value.approval = approval;
    this.render();
    this.toast(
      enabled
        ? "فرمان‌های این پروژه از این به بعد خودکار تأیید می‌شوند."
        : "اجرای خودکار خاموش شد؛ فرمان بعدی به تأیید تو نیاز دارد.",
    );
  }
  reveal() {
    this.show();
    $("project-delivery").scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }
  application(next) {
    if (this.value?.root !== next.root) return;
    const changed = this.value.application?.id !== next.id;
    this.value.application = next;
    this.render();
    if (changed) this.reveal();
  }
  output(chunk) {
    const app = this.value?.application;
    if (app?.root !== chunk.root || app.id !== chunk.id) return;
    app[chunk.stream] = (app[chunk.stream] + chunk.text).slice(-64000);
    this.renderOutput();
  }
  renderOutput() {
    const app = this.value?.application;
    const output = $("application-output");
    const nearEnd =
      output.scrollHeight - output.scrollTop - output.clientHeight < 55;
    output.textContent = app
      ? (app.stdout || "") + (app.stderr ? "\n[stderr]\n" + app.stderr : "")
      : "";
    output.hidden = !output.textContent;
    if (nearEnd) output.scrollTop = output.scrollHeight;
  }
  renderCommand() {
    const option = this.value?.launches.find(
      (item) => item.id === $("launch-option").value,
    );
    $("launch-command").textContent = option?.path
      ? option.path + " · پیش‌نمایش محلی"
      : commandText(option?.command);
  }
  render() {
    const { project, state, busy } = this.context();
    const value = this.value?.root === project?.root ? this.value : null;
    const readonly = !!state?.readOnly,
      app = value?.application;
    for (const id of [
      "project-approval",
      "open-project-folder",
      "show-program",
    ])
      $(id).hidden = !project;
    $("project-approval").disabled = readonly || !value;
    const automatic = !!value?.approval.autoApproveCommands;
    $("project-approval").textContent = automatic
      ? "اجرای خودکار روشن"
      : "فرمان‌ها: با تأیید";
    $("project-approval").classList.toggle("automatic", automatic);
    $("project-approval").setAttribute("aria-pressed", String(automatic));
    $("project-permission-note").hidden = !automatic;
    $("project-delivery").hidden =
      !value || (!state && !app && !value.launches.length);
    $("show-program").disabled = !value || $("project-delivery").hidden;
    if (!value) return;
    $("delivery-path").textContent = value.root;
    const files = $("delivery-files");
    files.replaceChildren();
    for (const change of (state?.changes || []).slice(0, 5)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = change.path;
      button.dir = "ltr";
      button.title = "نمایش فایل در پوشهٔ ویندوز";
      button.onclick = () =>
        this.guard(() =>
          this.call("revealFile", { ...this.viewData(), path: change.path }),
        );
      files.append(button);
    }
    const options = value.launches,
      select = $("launch-option"),
      chosen = select.value;
    if (select.dataset.options !== JSON.stringify(options)) {
      select.replaceChildren(
        ...options.map((item) => {
          const option = document.createElement("option");
          option.value = item.id;
          option.textContent = item.title;
          return option;
        }),
      );
      if (options.some((item) => item.id === chosen)) select.value = chosen;
      select.dataset.options = JSON.stringify(options);
    }
    $("launch-controls").hidden = !options.length || readonly;
    $("launch-hint").hidden = !!options.length || !!app;
    select.disabled = !!busy || running(app);
    $("launch-program").disabled =
      !!busy || running(app) || readonly || !options.length;
    this.renderCommand();
    $("application-panel").hidden = !app;
    if (!app) return;
    $("application-title").textContent = app.title;
    $("application-status").textContent =
      {
        running: "در حال اجرا",
        starting: "در حال آماده‌شدن",
        failed: "خطا در اجرا",
        exited: app.stopped
          ? "متوقف شد"
          : `پایان اجرا · کد ${app.exitCode ?? "—"}`,
      }[app.status] || app.status;
    $("application-status").className = running(app) ? "app-running" : "";
    $("stop-application").hidden = !running(app) || readonly;
    $("refresh-application").hidden =
      !running(app) || !app.expectedURL || !!app.url || readonly;
    $("application-link").hidden = !app.url;
    $("application-link").href = app.url || "#";
    $("application-link").textContent = app.url ? app.url + " ↗" : "";
    $("application-notice").hidden = !(app.error || app.notice);
    $("application-notice").textContent = app.error || app.notice || "";
    $("application-input-form").hidden =
      !running(app) || !app.inputOpen || readonly;
    this.renderOutput();
  }
}
