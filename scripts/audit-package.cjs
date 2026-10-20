"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const asar = require("@electron/asar");
const root = path.resolve(__dirname, "..");
const archive = path.join(root, "dist/win-unpacked/resources/app.asar");
const entries = asar
  .listPackage(archive)
  .map((p) => p.replace(/\\/g, "/").replace(/^\/+/, ""));
let checked = 0;
for (const entry of entries) {
  if (!/^(src|skills|examples|assets)\//.test(entry)) continue;
  const local = path.join(root, ...entry.split("/"));
  if (!fs.existsSync(local) || !fs.statSync(local).isFile()) continue;
  assert(
    asar
      .extractFile(archive, entry.split("/").join(path.sep))
      .equals(fs.readFileSync(local)),
    `Package/source mismatch: ${entry}`,
  );
  checked++;
}
assert(checked >= 30, "Audit did not inspect the expected application files");
const forbidden = entries.filter((p) =>
  /(?:^|\/)(?:\.env[^/]*|node_modules|\.dev-data|\.test-output)(?:\/|$)/.test(
    p,
  ),
);
assert.equal(forbidden.length, 0, "Private/development files found in package");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  const { parseEnv } = require("../src/core/settings.cjs");
  const key = parseEnv(fs.readFileSync(envFile, "utf8")).OPENAI_API_KEY;
  if (key && key !== "your-api-key")
    assert(
      !fs.readFileSync(archive).includes(Buffer.from(key)),
      "Configured secret found in package",
    );
}
const installer = "Milo-Code-Setup-1.0.0-x64.exe";
const bytes = fs.readFileSync(path.join(root, "dist", installer));
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(
  path.join(root, "dist/SHA256SUMS.txt"),
  `${sha256}  ${installer}\n`,
);
console.log(
  JSON.stringify(
    {
      matchingApplicationFiles: checked,
      packagedEntries: entries.length,
      privateFiles: forbidden.length,
      installerBytes: bytes.length,
      sha256,
    },
    null,
    2,
  ),
);
