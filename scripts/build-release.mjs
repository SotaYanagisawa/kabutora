import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sourceManifest, sourceRoot } from "./source-build-id.mjs";

const manifest = sourceManifest();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kabutora-release-"));
fs.chmodSync(directory, 0o700);
fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(directory, "files"), manifest.files.join("\0") + "\0", { mode: 0o600 });
execFileSync("tar", ["-czf", path.join(directory, "source.tar.gz"), "-C", sourceRoot, "--null", "-T", path.join(directory, "files")]);
const mode = process.argv[2] ?? "cloudflare";
const command = mode === "next" ? ["node_modules/next/dist/bin/next", "build"] : ["node_modules/@opennextjs/cloudflare/dist/cli/index.js", "build"];
console.log(`Release ${manifest.buildId}; recorded source: ${directory}`);
const child = spawn(process.execPath, command, { cwd: path.join(sourceRoot, "apps/web"), stdio: "inherit", env: { ...process.env, KABUTORA_BUILD_ID: manifest.buildId, NEXT_PUBLIC_KABUTORA_BUILD_ID: manifest.buildId } });
child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  if (sourceManifest().digest !== manifest.digest) { console.error("Source changed during the build; this release must not be deployed."); process.exit(1); }
  fs.writeFileSync(path.join(sourceRoot, "apps/web/.next/kabutora-release.json"), JSON.stringify({ buildId: manifest.buildId, source: directory, digest: manifest.digest }));
});
