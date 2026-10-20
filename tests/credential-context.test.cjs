"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  migrateCredentialContext,
} = require("../scripts/migrate-credential-context.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milo-crypt-"));
  t.after(() => {
    assert(
      path.dirname(root) === os.tmpdir() &&
        path.basename(root).startsWith("milo-crypt-"),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  for (const dir of [source, target]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        schemaVersion: 2,
        providers: [
          { id: "avalai", encryptedKey: "identical-encrypted-credential" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "Local State"),
      JSON.stringify({
        keep: dir,
        os_crypt: {
          audit_enabled: dir === target,
          encrypted_key: Buffer.from("DPAPI" + dir).toString("base64"),
        },
      }),
    );
  }
  return { root, source, target };
}
test("credential context migration preserves destination settings, backs up both originals and is idempotent", (t) => {
  const f = fixture(t),
    sf = path.join(f.source, "Local State"),
    tf = path.join(f.target, "Local State");
  const beforeSource = fs.readFileSync(sf),
    beforeTarget = fs.readFileSync(tf),
    settingsBefore = fs.readFileSync(path.join(f.target, "settings.json"));
  const result = migrateCredentialContext(f.source, f.target);
  assert(result.changed && result.credentials === 1);
  const after = JSON.parse(fs.readFileSync(tf, "utf8"));
  assert.equal(
    after.os_crypt.encrypted_key,
    JSON.parse(beforeSource).os_crypt.encrypted_key,
  );
  assert.equal(after.keep, f.target);
  assert.equal(after.os_crypt.audit_enabled, true);
  assert.deepEqual(fs.readFileSync(sf), beforeSource);
  assert.deepEqual(
    fs.readFileSync(path.join(f.target, "settings.json")),
    settingsBefore,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(result.backup, "previous-Local-State.json")),
    beforeTarget,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(result.backup, "source-Local-State.json")),
    beforeSource,
  );
  assert.equal(migrateCredentialContext(f.source, f.target).changed, false);
});
test("unrelated target credentials cannot lose their encryption context", (t) => {
  const f = fixture(t),
    targetFile = path.join(f.target, "Local State"),
    before = fs.readFileSync(targetFile);
  fs.writeFileSync(
    path.join(f.target, "settings.json"),
    JSON.stringify({
      schemaVersion: 2,
      providers: [{ encryptedKey: "different-credential" }],
    }),
  );
  assert.throws(
    () => migrateCredentialContext(f.source, f.target),
    /unrelated/,
  );
  assert.deepEqual(fs.readFileSync(targetFile), before);
});
test("invalid Windows encryption metadata and same-directory inputs leave profiles intact", (t) => {
  const f = fixture(t),
    targetFile = path.join(f.target, "Local State"),
    before = fs.readFileSync(targetFile);
  assert.throws(
    () => migrateCredentialContext(f.source, f.source),
    /different/,
  );
  fs.writeFileSync(path.join(f.source, "Local State"), '{"os_crypt":{}}');
  assert.throws(
    () => migrateCredentialContext(f.source, f.target),
    /supported/,
  );
  assert.deepEqual(fs.readFileSync(targetFile), before);
});
