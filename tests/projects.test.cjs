"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createProject, continuationFrom } = require("../src/core/projects.cjs");

test("new projects are empty, unique, and stay in the app's projects folder", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milo-projects-"));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith("milo-projects-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const a = await createProject(root, "مدیریت کارها");
  const b = await createProject(root, "مدیریت کارها");
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.join(root, "projects"));
  assert.deepEqual(await fs.readdir(a), []);
  await fs.writeFile(path.join(a, "keep.txt"), "existing work");
  const c = await createProject(root, "مدیریت کارها");
  assert.notEqual(a, c);
  assert.equal(
    await fs.readFile(path.join(a, "keep.txt"), "utf8"),
    "existing work",
  );
  for (const bad of ["../outside", "D:\\outside", "", "bad.", "bad\nname"]) {
    await assert.rejects(createProject(root, bad));
  }
  assert.equal((await fs.readdir(path.join(root, "projects"))).length, 3);
});

test("follow-up context includes the request and result without copying report credentials or outputs", () => {
  const run = {
    id: "previous-run",
    task: "Build a small application",
    summary: "Created the first working version",
    changes: [{ path: "app.cjs", before: "old", after: "new" }],
    connection: { apiKey: "a-secret" },
    observations: [{ stdout: "private output" }],
  };
  const context = continuationFrom(run);
  assert.deepEqual(context, {
    runId: "previous-run",
    task: run.task,
    summary: run.summary,
    changedFiles: ["app.cjs"],
  });
  run.changes[0].path = "later.cjs";
  assert.equal(context.changedFiles[0], "app.cjs");
  assert.equal(continuationFrom(null), null);
});
