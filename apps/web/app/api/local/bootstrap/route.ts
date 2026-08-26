import { existsSync } from "node:fs";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LocalVaultEnvelope = {
  format: "kabutora-local-vault";
  version: 1;
  algorithm: "AES-256-GCM";
  iv: string;
  authTag: string;
  ciphertext: string;
  plaintextSha256: string;
  createdAt?: string;
  updatedAt?: string;
};

const parseLocalKey = (encodedKey: string) => {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32) throw new Error("invalid_local_vault_key");
  return key;
};

const decryptLocalVault = (envelope: LocalVaultEnvelope, encodedKey: string) => {
  if (envelope.format !== "kabutora-local-vault" || envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") {
    throw new Error("unsupported_local_vault");
  }
  const key = parseLocalKey(encodedKey);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from("kabutora:local-vault:v1", "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    const checksum = crypto.createHash("sha256").update(plaintext).digest("hex");
    if (checksum !== envelope.plaintextSha256) throw new Error("local_vault_checksum_mismatch");
    return plaintext;
  } finally {
    key.fill(0);
  }
};

const encryptLocalVault = (plaintext: Buffer, encodedKey: string, existing?: LocalVaultEnvelope): LocalVaultEnvelope => {
  const key = parseLocalKey(encodedKey);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("kabutora:local-vault:v1", "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const now = new Date().toISOString();
    return {
      format: "kabutora-local-vault",
      version: 1,
      algorithm: "AES-256-GCM",
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      plaintextSha256: crypto.createHash("sha256").update(plaintext).digest("hex"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  } finally {
    key.fill(0);
  }
};

const validPortfolio = (value: unknown) => {
  if (!value || typeof value !== "object") return false;
  const item = value as { portfolio?: unknown; accounts?: unknown; securities?: unknown; transactions?: unknown };
  return Boolean(item.portfolio && typeof item.portfolio === "object")
    && Array.isArray(item.accounts) && item.accounts.length <= 500
    && Array.isArray(item.securities) && item.securities.length <= 5000
    && Array.isArray(item.transactions) && item.transactions.length <= 100000;
};

export async function GET() {
  const vaultPath = process.env.KABUTORA_LOCAL_VAULT_PATH;
  const vaultKey = process.env.KABUTORA_LOCAL_VAULT_KEY;
  const candidatePaths = [
    path.join(process.cwd(), "data", "demo-seed.json"),
    path.join(process.cwd(), "apps", "web", "data", "demo-seed.json"),
  ];
  const developmentPath = process.env.NODE_ENV === "development"
    ? candidatePaths.find((p) => existsSync(p)) ?? null
    : null;
  if (!vaultPath && !developmentPath) return Response.json({ error: "local_mode_disabled" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const payload = vaultPath
      ? decryptLocalVault(JSON.parse(await readFile(vaultPath, "utf8")) as LocalVaultEnvelope, vaultKey ?? "")
      : await readFile(developmentPath!, "utf8");
    return new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "local_vault_unavailable" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  const vaultPath = process.env.KABUTORA_LOCAL_VAULT_PATH;
  const vaultKey = process.env.KABUTORA_LOCAL_VAULT_KEY;
  if (!vaultPath || !vaultKey) return Response.json({ error: "local_mode_disabled" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") return Response.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  try {
    const serialized = await request.text();
    if (serialized.length > 2_000_000) throw new Error("local_portfolio_too_large");
    const portfolio = JSON.parse(serialized) as unknown;
    if (!validPortfolio(portfolio)) throw new Error("invalid_local_portfolio");
    const plaintext = Buffer.from(`${JSON.stringify(portfolio)}\n`, "utf8");
    try {
      const existing = JSON.parse(await readFile(vaultPath, "utf8")) as LocalVaultEnvelope;
      const envelope = encryptLocalVault(plaintext, vaultKey, existing);
      const temporaryPath = `${vaultPath}.tmp-${crypto.randomUUID()}`;
      await writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, vaultPath);
      await chmod(vaultPath, 0o600);
      return Response.json({ saved: true, updatedAt: envelope.updatedAt }, { headers: { "Cache-Control": "no-store" } });
    } finally {
      plaintext.fill(0);
    }
  } catch {
    return Response.json({ error: "local_vault_write_failed" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
