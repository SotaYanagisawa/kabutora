import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkClientBoundary } from "./check-client-boundary.mjs";

const workspace = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientModules = checkClientBoundary(workspace);
const targets = process.argv.slice(2).map((value) => path.resolve(value));
if (!targets.length) targets.push(path.join(workspace, "apps", "web", ".open-next"));

const marketMigrationsPath = path.join(workspace, "apps", "web", "migrations");
const marketSchema = fs.readdirSync(marketMigrationsPath)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => fs.readFileSync(path.join(marketMigrationsPath, name), "utf8"))
  .join("\n");
const forbiddenMarketColumns = /\b(transaction|account_id|portfolio_id|quantity|cost_basis|purchase_price|broker|holding|cash_balance|user_id|uid|email|owner_id|display_name)\b/giu;
const forbiddenSchemaMatches = [...marketSchema.matchAll(forbiddenMarketColumns)].map((match) => match[0]);
if (forbiddenSchemaMatches.length) {
  throw new Error(`Market snapshot schema contains private portfolio fields: ${[...new Set(forbiddenSchemaMatches)].join(", ")}`);
}

const refreshRoutePath = path.join(workspace, "apps", "web", "app", "api", "market", "refresh", "route.ts");
const refreshRoute = fs.readFileSync(refreshRoutePath, "utf8");
if (!refreshRoute.includes('key !== "securityIds"') || !refreshRoute.includes("normalizePublicSecurityIds")) {
  throw new Error("Manual market refresh must accept normalized public security identifiers only");
}
if (/\b(quantity|cost_basis|purchase_price|broker|holding|cash_balance|email)\b/iu.test(refreshRoute)) {
  throw new Error("Manual market refresh route references a private portfolio field");
}

const vaultPath = path.join(os.homedir(), "Library", "Application Support", "株トラ", "local-vault.json");
const account = os.userInfo().username;
const keyValue = execFileSync("/usr/bin/security", [
  "find-generic-password", "-s", "jp.kabutora.local-vault", "-a", account, "-w",
], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const key = Buffer.from(keyValue, "base64url");
if (key.length !== 32) throw new Error("Local-vault Keychain item is invalid");

function readPortfolio() {
  const envelope = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
  if (envelope.format !== "kabutora-local-vault" || envelope.version !== 1) throw new Error("Local vault format is invalid");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from("kabutora:local-vault:v1", "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
  const checksum = crypto.createHash("sha256").update(plaintext).digest("hex");
  if (checksum !== envelope.plaintextSha256) throw new Error("Local vault checksum is invalid");
  try {
    return JSON.parse(plaintext.toString("utf8"));
  } finally {
    plaintext.fill(0);
  }
}

const portfolio = readPortfolio();
const realTransactions = portfolio.transactions.filter((item) => item.source !== "demo_fixture");
const probes = realTransactions.slice(0, 40).flatMap((item) => [
  Buffer.from(`"id":"${item.id}"`),
  Buffer.from(`"id": "${item.id}"`),
]);
// A build must contain neither private records nor usable local vault keys.
probes.push(Buffer.from(keyValue), Buffer.from(key.toString("base64")), Buffer.from(key.toString("hex")));
const forbiddenNames = new Set(["seed.json"]);
const hits = [];
let scannedFiles = 0;

for (const target of targets) {
  if (!fs.existsSync(target)) throw new Error(`Privacy-scan target is missing: ${target}`);
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
      continue;
    }
    if (!stat.isFile() || stat.size > 25_000_000) continue;
    scannedFiles += 1;
    if (forbiddenNames.has(path.basename(current))) hits.push(`${current}: forbidden private-data filename`);
    const content = fs.readFileSync(current);
    if (probes.some((probe) => content.includes(probe))) hits.push(`${current}: real transaction identifier`);
  }
}

key.fill(0);
if (hits.length) throw new Error(`Private-data boundary failed:\n${hits.join("\n")}`);
console.log(JSON.stringify({ status: "private_data_absent", targets: targets.length, scannedFiles, probes: probes.length, clientModules, marketSchema: "public_fields_only" }));
