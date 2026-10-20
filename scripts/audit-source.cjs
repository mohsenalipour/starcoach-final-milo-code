"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  gitArgs = [
    "-c",
    "safe.directory=" + root.replace(/\\/g, "/"),
    "ls-files",
    "-z",
  ];
const files = execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
assert(
  files.length >= 40,
  "Expected source files to be staged before auditing",
);
const envFile = path.join(root, ".env");
let key;
if (fs.existsSync(envFile))
  key = require("../src/core/settings.cjs").parseEnv(
    fs.readFileSync(envFile, "utf8"),
  ).OPENAI_API_KEY;
for (const file of files) {
  assert(
    !/^(?:node_modules|dist|\.dev-data|\.test-output|\.npm-cache)\//.test(file),
    "Generated/private file tracked",
  );
  assert(
    file === ".env.example" || !/(?:^|\/)\.env(?:\.|$)/.test(file),
    "Private environment file tracked",
  );
  const bytes = fs.readFileSync(path.join(root, file));
  assert(bytes.length < 20 * 1024 * 1024, "Unexpected large file in Git");
  if (key && key !== "your-api-key")
    assert(
      !bytes.includes(Buffer.from(key)),
      "Configured API key found in tracked source",
    );
}
console.log(
  JSON.stringify(
    {
      trackedFiles: files.length,
      privateFiles: 0,
      configuredKeyIncluded: false,
    },
    null,
    2,
  ),
);
