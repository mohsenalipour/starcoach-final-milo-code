"use strict";
// Maintenance helper: use only with both Milo profiles closed.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
function savedSettings(root) {
  const dbFile = path.join(root, "milo.sqlite");
  if (fs.existsSync(dbFile)) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get("application");
      assert(row, "Application settings were not found.");
      return JSON.parse(row.value);
    } finally {
      db.close();
    }
  }
  return JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
}
function encryptedValues(settings) {
  return settings.schemaVersion === 2
    ? (settings.providers || []).map((p) => p.encryptedKey).filter(Boolean)
    : [settings.encryptedKey].filter(Boolean);
}
function migrateCredentialContext(source, target) {
  source = fs.realpathSync(source);
  target = fs.realpathSync(target);
  assert(
    source.toLowerCase() !== target.toLowerCase(),
    "Choose two different profile directories.",
  );
  const sourceValues = new Set(encryptedValues(savedSettings(source)));
  const targetValues = encryptedValues(savedSettings(target));
  assert(
    targetValues.length > 0,
    "The target has no encrypted credentials to migrate.",
  );
  assert(
    targetValues.every((value) => sourceValues.has(value)),
    "The target has unrelated credentials; its encryption context must not be replaced.",
  );
  const sourceFile = path.join(source, "Local State"),
    targetFile = path.join(target, "Local State");
  const sourceBytes = fs.readFileSync(sourceFile),
    targetBytes = fs.readFileSync(targetFile);
  const sourceState = JSON.parse(sourceBytes),
    targetState = JSON.parse(targetBytes);
  const wrapped = sourceState.os_crypt?.encrypted_key;
  assert(
    typeof wrapped === "string" &&
      Buffer.from(wrapped, "base64").subarray(0, 5).toString() === "DPAPI",
    "The source does not have a supported Windows encryption context.",
  );
  if (targetState.os_crypt?.encrypted_key === wrapped)
    return { changed: false, credentials: targetValues.length };
  const backup = path.join(
    target,
    "backups",
    "credential-context-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      crypto.randomUUID().slice(0, 8),
  );
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, "source-Local-State.json"), sourceBytes);
  fs.writeFileSync(path.join(backup, "previous-Local-State.json"), targetBytes);
  // Copy the already DPAPI-wrapped key only; never decrypt, print, or store an API key.
  // Keep the destination's audit and other local-state settings unchanged.
  targetState.os_crypt = { ...targetState.os_crypt, encrypted_key: wrapped };
  const temporary = targetFile + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(targetState), "utf8");
  fs.renameSync(temporary, targetFile);
  return { changed: true, credentials: targetValues.length, backup };
}
if (require.main === module) {
  try {
    assert(
      process.argv.length === 4,
      "Usage: node scripts/migrate-credential-context.cjs SOURCE_PROFILE TARGET_PROFILE",
    );
    if (process.platform === "win32") {
      const { execFileSync } = require("node:child_process");
      for (const image of ["Milo Code.exe", "electron.exe"]) {
        const output = execFileSync(
          "tasklist.exe",
          ["/FI", "IMAGENAME eq " + image, "/FO", "CSV", "/NH"],
          { encoding: "utf8", windowsHide: true },
        );
        assert(
          !output.toLowerCase().includes('"' + image.toLowerCase() + '"'),
          "Close all Milo and source Electron instances before migrating credentials.",
        );
      }
    }
    console.log(
      JSON.stringify(
        migrateCredentialContext(process.argv[2], process.argv[3]),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { migrateCredentialContext };
