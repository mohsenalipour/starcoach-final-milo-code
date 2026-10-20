"use strict";
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { id } = require("./protocol.cjs");
async function desktopPersistence({ win, database, store, restoreSession }) {
  const phase = process.env.MILO_STORAGE_PHASE;
  await win.webContents.executeJavaScript("window.miloReady");
  const invoke = (name, payload) =>
    win.webContents.executeJavaScript(
      "window.milo[" +
        JSON.stringify(name) +
        "](" +
        JSON.stringify(payload) +
        ").then(p=>{if(!p.ok)throw Error(p.error);return p.value;})",
    );
  if (phase === "seed") {
    const selected = await invoke("createProject", {
      name: "آزمون ذخیره‌سازی",
    });
    const settings = await invoke("saveSettings", {
      providerId: "avalai",
      baseURL: "https://api.avalai.ir/v1",
      model: "persistence-test-model",
      apiKey: "test-only-no-real-credential",
      makeDefault: true,
    });
    assert.equal(settings.providers[0].keyStorage, "encrypted");
    await invoke("saveDraft", {
      root: selected.project.root,
      text: "پیش‌نویس فارسی پس از بازکردن",
      selection: { providerId: "avalai", model: "draft-model" },
      remember: false,
    });
    const at = new Date().toISOString(),
      firstId = id(),
      secondId = id();
    const base = {
      root: selected.project.root,
      mode: "live",
      connection: {
        providerId: "avalai",
        providerName: "AvalAI",
        model: "persistence-test-model",
      },
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
      createdAt: at,
      updatedAt: at,
    };
    await store.save({
      ...base,
      id: firstId,
      conversationId: firstId,
      task: "یک برنامهٔ ساده بساز",
      summary: "فایل‌های نمونه آماده شدند.",
      status: "completed",
    });
    await store.save({
      ...base,
      id: secondId,
      conversationId: firstId,
      continuation: { runId: firstId, conversationId: firstId },
      task: "قابلیت دیگری به همین برنامه اضافه کن",
      status: "awaiting_approval",
      approval: { nonce: "must-not-replay" },
    });
    database.setSetting("session", {
      root: selected.project.root,
      runId: secondId,
      mode: "live",
    });
    database.setSetting("storage-smoke-fixture", {
      firstId,
      secondId,
      root: selected.project.root,
    });
    await restoreSession();
    const loaded = once(win.webContents, "did-finish-load");
    win.webContents.reload();
    await loaded;
    await win.webContents.executeJavaScript("window.miloReady");
  }
  const fixture = database.getSetting("storage-smoke-fixture");
  assert(fixture);
  const packet = await invoke("boot");
  assert.equal(packet.project.root, fixture.root);
  if (phase === "draft") assert.equal(packet.state, null);
  else {
    assert.equal(packet.state.id, fixture.secondId);
    assert.equal(packet.state.readOnly, true);
    assert.equal(packet.state.approval, null);
  }
  assert.equal(packet.settings.hasKey, true);
  assert.equal(packet.settings.keyStorage, "encrypted");
  assert.equal(
    packet.draft.text,
    phase === "draft"
      ? "ذخیرهٔ درخواست بلافاصله هنگام بستن"
      : "پیش‌نویس فارسی پس از بازکردن",
  );
  assert.equal(packet.database.counts.conversations, 1);
  assert.equal(packet.database.counts.runs, 2);
  if (phase === "restore") {
    assert.equal(packet.state.status, "interrupted");
    assert.equal(packet.state.interrupted, true);
  }
  const ui = await win.webContents.executeJavaScript(
    "(" +
      async function () {
        await window.miloReady;
        const q = (s) => document.querySelector(s);
        q("#open-data").click();
        const deadline = Date.now() + 4000;
        while (!q("#data-dialog").open && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
        const result = {
          sidebarConversationCount:
            document.querySelectorAll(".history-row").length,
          otherTurns: document.querySelectorAll(".thread-turn").length,
          draftText: q("#task").value,
          dataDialogOpen: q("#data-dialog").open,
          projectCards: document.querySelectorAll(".recent-project").length,
          databasePathVisible:
            q("#database-path").textContent.endsWith("milo.sqlite"),
          noHorizontalOverflow:
            document.documentElement.scrollWidth <= window.innerWidth,
        };
        q("#data-dialog").close();
        return result;
      }.toString() +
      ")()",
  );
  assert.equal(ui.sidebarConversationCount, 1);
  assert.equal(ui.otherTurns, phase === "draft" ? 0 : 1);
  assert.equal(ui.draftText, packet.draft.text);
  assert(
    ui.dataDialogOpen &&
      ui.databasePathVisible &&
      ui.projectCards === 1 &&
      ui.noHorizontalOverflow,
  );
  assert(database.integrity().ok);
  if (phase === "restore") {
    await win.webContents.executeJavaScript(
      "(" +
        async function () {
          document.getElementById("new-task").click();
          const deadline = Date.now() + 4000;
          while (
            document.getElementById("task").disabled &&
            Date.now() < deadline
          )
            await new Promise((r) => setTimeout(r, 15));
          const input = document.getElementById("task");
          if (input.disabled)
            throw Error("New conversation did not become editable");
          input.value = "ذخیرهٔ درخواست بلافاصله هنگام بستن";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }.toString() +
        ")()",
    );
  }
  return {
    phase,
    encryptedCredentials: true,
    restoredProject: true,
    restoredConversation: true,
    draftRestored: true,
    closeFlushVerified: phase === "draft",
    conversationTurns: 2,
    interruptedWithoutReplay: phase === "restore",
    databaseIntegrity: true,
    ui,
  };
}
module.exports = { desktopPersistence };
