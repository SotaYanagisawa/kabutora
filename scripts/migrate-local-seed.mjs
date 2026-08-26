import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sourcePath = process.argv[2];
const applicationSupport = path.join(os.homedir(), "Library", "Application Support", "株トラ");
const vaultPath = process.argv[3] ?? path.join(applicationSupport, "local-vault.json");
const keychainService = "jp.kabutora.local-vault";
const keychainAccount = os.userInfo().username;
const additionalData = Buffer.from("kabutora:local-vault:v1", "utf8");

if (!sourcePath) throw new Error("Usage: migrate-local-seed.mjs <plaintext-seed.json> [local-vault.json]");

const base64Url = (value) => Buffer.from(value).toString("base64url");
const fromBase64Url = (value) => Buffer.from(value, "base64url");

function validateSeed(value) {
  if (!value || typeof value !== "object") throw new Error("Portfolio seed is not an object");
  if (!value.portfolio || !Array.isArray(value.accounts) || !Array.isArray(value.securities) || !Array.isArray(value.transactions)) {
    throw new Error("Portfolio seed is missing required collections");
  }
}

function readKeychainKey() {
  try {
    const encoded = execFileSync("/usr/bin/security", [
      "find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const key = fromBase64Url(encoded);
    if (key.length !== 32) throw new Error("Existing local-vault key has an invalid length");
    return key;
  } catch (error) {
    if (error instanceof Error && error.message.includes("invalid length")) throw error;
    return null;
  }
}

function saveKeychainKey(key) {
  execFileSync("/usr/bin/security", [
    "add-generic-password", "-U",
    "-s", keychainService,
    "-a", keychainAccount,
    "-l", "株トラ ローカル暗号鍵",
    "-w", base64Url(key),
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

function decryptEnvelope(envelope, key) {
  if (envelope?.format !== "kabutora-local-vault" || envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
    throw new Error("Existing local vault has an unsupported format");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromBase64Url(envelope.iv));
  decipher.setAAD(additionalData);
  decipher.setAuthTag(fromBase64Url(envelope.authTag));
  return Buffer.concat([decipher.update(fromBase64Url(envelope.ciphertext)), decipher.final()]);
}

const plaintext = await fs.readFile(sourcePath);
const seed = JSON.parse(plaintext.toString("utf8"));
validateSeed(seed);
const canonicalPlaintext = Buffer.from(`${JSON.stringify(seed)}\n`, "utf8");
const plaintextSha256 = crypto.createHash("sha256").update(canonicalPlaintext).digest("hex");

await fs.mkdir(applicationSupport, { recursive: true, mode: 0o700 });
await fs.chmod(applicationSupport, 0o700);

let key = readKeychainKey();
let createdKey = false;
if (!key) {
  key = crypto.randomBytes(32);
  saveKeychainKey(key);
  createdKey = true;
}

try {
  try {
    const existing = JSON.parse(await fs.readFile(vaultPath, "utf8"));
    const decrypted = decryptEnvelope(existing, key);
    const existingHash = crypto.createHash("sha256").update(decrypted).digest("hex");
    if (existingHash !== plaintextSha256) throw new Error("An existing local vault contains different data; refusing to overwrite it");
    validateSeed(JSON.parse(decrypted.toString("utf8")));
    await fs.chmod(vaultPath, 0o600);
    console.log(JSON.stringify({ status: "already_migrated", vaultPath, accounts: seed.accounts.length, securities: seed.securities.length, transactions: seed.transactions.length }));
    process.exit(0);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(canonicalPlaintext), cipher.final()]);
  const envelope = {
    format: "kabutora-local-vault",
    version: 1,
    algorithm: "AES-256-GCM",
    iv: base64Url(iv),
    authTag: base64Url(cipher.getAuthTag()),
    ciphertext: base64Url(ciphertext),
    plaintextSha256,
    createdAt: new Date().toISOString(),
  };
  const temporaryPath = `${vaultPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporaryPath, vaultPath);
  await fs.chmod(vaultPath, 0o600);

  const verified = decryptEnvelope(JSON.parse(await fs.readFile(vaultPath, "utf8")), key);
  validateSeed(JSON.parse(verified.toString("utf8")));
  if (!crypto.timingSafeEqual(crypto.createHash("sha256").update(verified).digest(), crypto.createHash("sha256").update(canonicalPlaintext).digest())) {
    throw new Error("Local vault verification failed");
  }
  console.log(JSON.stringify({ status: "migrated_and_verified", vaultPath, keychainItemCreated: createdKey, accounts: seed.accounts.length, securities: seed.securities.length, transactions: seed.transactions.length }));
} finally {
  key.fill(0);
  plaintext.fill(0);
  canonicalPlaintext.fill(0);
}
