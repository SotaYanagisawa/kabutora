import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const sourceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export function sourceManifest(root = sourceRoot) {
  const releaseStage = process.env.KABUTORA_RELEASE_STAGE ?? "complete";
  if (!["repairs", "complete"].includes(releaseStage)) throw new Error("Unknown release stage");
  const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0");
  const files = [...new Set(names)].filter((name) => name && name !== "apps/web/next-env.d.ts" && fs.existsSync(path.join(root, name)) && fs.statSync(path.join(root, name)).isFile()).sort();
  const entries = files.map((name) => ({ path: name, sha256: createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex") }));
  // Build configuration is identified without exposing its values in artifacts.
  for (const name of ["apps/web/.env.production.local", "apps/web/.env.local"]) if (fs.existsSync(path.join(root, name))) {
    entries.push({ path: name, sha256: createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex") });
  }
  const digest = createHash("sha256").update(JSON.stringify({ entries, releaseStage })).digest("hex");
  return { buildId: `kabutora-${digest.slice(0, 20)}`, digest, releaseStage, files, entries };
}
export function resolveBuildId() {
  if (process.env.KABUTORA_BUILD_ID) return process.env.KABUTORA_BUILD_ID;
  return sourceManifest().buildId;
}
