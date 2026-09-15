import { deriveArgon2Key } from "./argon2-key";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const KEY_AAD = textEncoder.encode("kabutora:key-wrap:v1");
const RECOVERY_AAD = textEncoder.encode("kabutora:recovery-wrap:v1");
const PAYLOAD_AAD = textEncoder.encode("kabutora:vault-payload:v1");
const RECORD_AAD = textEncoder.encode("kabutora:vault-record:v1");

const ARGON2_MEMORY_KIB = 64 * 1024;
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 1;

export type EncryptedBlock = {
  algorithm: "AES-256-GCM";
  iv: string;
  ciphertext: string;
};

export type KabutoraVaultEnvelope = {
  format: "kabutora-encrypted-vault";
  version: 1 | 2;
  keyId?: string;
  legacyKeys?: EncryptedBlock;
  ownerUid?: string;
  kdf: {
    algorithm: "ARGON2ID";
    salt: string;
    memoryKiB: number;
    iterations: number;
    parallelism: number;
  };
  wrappedKey: EncryptedBlock;
  recoveryWrappedKey: EncryptedBlock;
  payload: EncryptedBlock;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type CreatedVault<T> = {
  envelope: KabutoraVaultEnvelope;
  recoveryKey: string;
  accountKey: string;
  data: T;
  dataKey: CryptoKey;
};

const cryptoApi = () => {
  if (!globalThis.crypto?.subtle) throw new Error("このブラウザは必要な暗号化機能に対応していません。");
  return globalThis.crypto;
};

const randomBytes = (length: number) => cryptoApi().getRandomValues(new Uint8Array(length));

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const fromBase64Url = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const importAesKey = (bytes: Uint8Array, usages: KeyUsage[]) =>
  cryptoApi().subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM", length: 256 }, false, usages);

const encryptBytes = async (key: CryptoKey, plaintext: Uint8Array, additionalData: Uint8Array): Promise<EncryptedBlock> => {
  const iv = randomBytes(12);
  const ciphertext = await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: additionalData as BufferSource, tagLength: 128 },
    key,
    plaintext as BufferSource,
  );
  return { algorithm: "AES-256-GCM", iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
};

const decryptBytes = async (key: CryptoKey, block: EncryptedBlock, additionalData: Uint8Array) => {
  if (block.algorithm !== "AES-256-GCM") throw new Error("未対応の暗号形式です。");
  try {
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(block.iv) as BufferSource, additionalData: additionalData as BufferSource, tagLength: 128 },
      key,
      fromBase64Url(block.ciphertext) as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("復号できませんでした。パスフレーズまたは復旧キーを確認してください。");
  }
};

const derivePassphraseKey = async (passphrase: string, envelope: KabutoraVaultEnvelope["kdf"]) => {
  if (passphrase.length < 16) throw new Error("暗号化パスフレーズは16文字以上にしてください。");
  if (
    envelope.algorithm !== "ARGON2ID" ||
    !Number.isInteger(envelope.memoryKiB) || envelope.memoryKiB < 32 * 1024 || envelope.memoryKiB > 256 * 1024 ||
    !Number.isInteger(envelope.iterations) || envelope.iterations < 2 || envelope.iterations > 10 ||
    !Number.isInteger(envelope.parallelism) || envelope.parallelism < 1 || envelope.parallelism > 4
  ) throw new Error("安全でない、または未対応の鍵導出設定です。");
  const input = { password: textEncoder.encode(passphrase), salt: fromBase64Url(envelope.salt), memoryKiB: envelope.memoryKiB, iterations: envelope.iterations, parallelism: envelope.parallelism };
  if (typeof Worker === "undefined") return deriveArgon2Key(input);
  return (await import("./vault-kdf")).deriveResponsivePassphraseKey(input);
};

const normalizeRecoveryKey = (value: string) => value.trim().replace(/^KBT1-/u, "").replaceAll(/\s/gu, "");

const parsePayload = <T>(bytes: Uint8Array): T => {
  try {
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch {
    throw new Error("暗号化データの内容が壊れています。");
  } finally {
    bytes.fill(0);
  }
};

export const isKabutoraVaultEnvelope = (value: unknown): value is KabutoraVaultEnvelope => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<KabutoraVaultEnvelope>;
  return item.format === "kabutora-encrypted-vault"
    && (item.version === 1 || (item.version === 2 && typeof item.keyId === "string" && /^[\w-]{32,64}$/u.test(item.keyId)))
    && Number.isSafeInteger(item.revision) && item.revision! > 0
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string"
    && item.kdf?.algorithm === "ARGON2ID" && typeof item.kdf.salt === "string"
    && /^[\w-]{22}$/u.test(item.kdf.salt)
    && Number.isInteger(item.kdf.memoryKiB) && item.kdf.memoryKiB >= 32768 && item.kdf.memoryKiB <= 262144
    && Number.isInteger(item.kdf.iterations) && item.kdf.iterations >= 2 && item.kdf.iterations <= 10
    && Number.isInteger(item.kdf.parallelism) && item.kdf.parallelism >= 1 && item.kdf.parallelism <= 4
    && isEncryptedBlock(item.wrappedKey) && isEncryptedBlock(item.recoveryWrappedKey) && isEncryptedBlock(item.payload)
    && (item.legacyKeys === undefined || isEncryptedBlock(item.legacyKeys));
};

export function isEncryptedBlock(value: unknown): value is EncryptedBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Partial<EncryptedBlock>;
  return block.algorithm === "AES-256-GCM" && typeof block.iv === "string" && /^[\w-]{16}$/u.test(block.iv)
    && typeof block.ciphertext === "string" && block.ciphertext.length >= 22 && block.ciphertext.length <= 900_000 && /^[\w-]+$/u.test(block.ciphertext);
}

export async function createEncryptedVault<T>(data: T, passphrase: string, ownerUid?: string): Promise<CreatedVault<T>> {
  const now = new Date().toISOString();
  const salt = randomBytes(16);
  const rawDataKey = randomBytes(32);
  const rawRecoveryKey = randomBytes(32);
  const kdf: KabutoraVaultEnvelope["kdf"] = {
    algorithm: "ARGON2ID",
    salt: toBase64Url(salt),
    memoryKiB: ARGON2_MEMORY_KIB,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
  };
  const passphraseKey = await derivePassphraseKey(passphrase, kdf);
  const dataKey = await importAesKey(rawDataKey, ["encrypt", "decrypt"]);
  const recoveryKey = await importAesKey(rawRecoveryKey, ["encrypt", "decrypt"]);
  try {
    const [wrappedKey, recoveryWrappedKey, payload] = await Promise.all([
      encryptBytes(passphraseKey, rawDataKey, KEY_AAD),
      encryptBytes(recoveryKey, rawDataKey, RECOVERY_AAD),
      encryptBytes(dataKey, textEncoder.encode(JSON.stringify(data)), PAYLOAD_AAD),
    ]);
    return {
      envelope: {
        format: "kabutora-encrypted-vault",
        version: 1,
        ...(ownerUid ? { ownerUid } : {}),
        kdf,
        wrappedKey,
        recoveryWrappedKey,
        payload,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      recoveryKey: `KBT1-${toBase64Url(rawRecoveryKey)}`,
      accountKey: toBase64Url(rawDataKey),
      data,
      dataKey,
    };
  } finally {
    rawDataKey.fill(0);
    rawRecoveryKey.fill(0);
    salt.fill(0);
  }
}

/**
 * Creates the cloud copy used after Google authentication. Its data key is
 * stored in the UID-restricted key document, so no password KDF is needed on
 * every new phone. User-exported backups still use createEncryptedVault.
 */
export async function createGoogleProtectedVault<T>(data: T, ownerUid: string): Promise<CreatedVault<T>> {
  const now = new Date().toISOString();
  const salt = randomBytes(16);
  const rawDataKey = randomBytes(32);
  const rawWrappingKey = randomBytes(32);
  const rawRecoveryKey = randomBytes(32);
  const kdf: KabutoraVaultEnvelope["kdf"] = {
    algorithm: "ARGON2ID",
    salt: toBase64Url(salt),
    memoryKiB: ARGON2_MEMORY_KIB,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
  };
  const [dataKey, wrappingKey, recoveryKey] = await Promise.all([
    importAesKey(rawDataKey, ["encrypt", "decrypt"]),
    importAesKey(rawWrappingKey, ["encrypt"]),
    importAesKey(rawRecoveryKey, ["encrypt"]),
  ]);
  try {
    const [wrappedKey, recoveryWrappedKey, payload] = await Promise.all([
      encryptBytes(wrappingKey, rawDataKey, KEY_AAD),
      encryptBytes(recoveryKey, rawDataKey, RECOVERY_AAD),
      encryptBytes(dataKey, textEncoder.encode(JSON.stringify(data)), PAYLOAD_AAD),
    ]);
    return {
      envelope: {
        format: "kabutora-encrypted-vault",
        version: 1,
        ownerUid,
        kdf,
        wrappedKey,
        recoveryWrappedKey,
        payload,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      recoveryKey: `KBT1-${toBase64Url(rawRecoveryKey)}`,
      accountKey: toBase64Url(rawDataKey),
      data,
      dataKey,
    };
  } finally {
    salt.fill(0);
    rawDataKey.fill(0);
    rawWrappingKey.fill(0);
    rawRecoveryKey.fill(0);
  }
}

export async function unlockVaultWithPassphrase<T>(envelope: KabutoraVaultEnvelope, passphrase: string) {
  if (!isKabutoraVaultEnvelope(envelope)) throw new Error("株トラの暗号化データではありません。");
  const passphraseKey = await derivePassphraseKey(passphrase, envelope.kdf);
  const rawDataKey = await decryptBytes(passphraseKey, envelope.wrappedKey, KEY_AAD);
  try {
    const dataKey = await importAesKey(rawDataKey, ["encrypt", "decrypt"]);
    const plaintext = await decryptBytes(dataKey, envelope.payload, PAYLOAD_AAD);
    return { data: parsePayload<T>(plaintext), dataKey, accountKey: toBase64Url(rawDataKey) };
  } finally {
    rawDataKey.fill(0);
  }
}

export async function unlockVaultWithRecoveryKey<T>(envelope: KabutoraVaultEnvelope, recoveryKeyValue: string) {
  if (!isKabutoraVaultEnvelope(envelope)) throw new Error("株トラの暗号化データではありません。");
  const rawRecoveryKey = fromBase64Url(normalizeRecoveryKey(recoveryKeyValue));
  if (rawRecoveryKey.length !== 32) throw new Error("復旧キーの形式が正しくありません。");
  const recoveryKey = await importAesKey(rawRecoveryKey, ["decrypt"]);
  const rawDataKey = await decryptBytes(recoveryKey, envelope.recoveryWrappedKey, RECOVERY_AAD);
  try {
    const dataKey = await importAesKey(rawDataKey, ["encrypt", "decrypt"]);
    const plaintext = await decryptBytes(dataKey, envelope.payload, PAYLOAD_AAD);
    return { data: parsePayload<T>(plaintext), dataKey, accountKey: toBase64Url(rawDataKey) };
  } finally {
    rawRecoveryKey.fill(0);
    rawDataKey.fill(0);
  }
}

export async function decryptVaultWithDataKey<T>(envelope: KabutoraVaultEnvelope, dataKey: CryptoKey): Promise<T> {
  if (!isKabutoraVaultEnvelope(envelope)) throw new Error("株トラの暗号化データではありません。");
  return parsePayload<T>(await decryptBytes(dataKey, envelope.payload, PAYLOAD_AAD));
}

export async function importGoogleAccountKey(value: string) {
  const bytes = fromBase64Url(value);
  if (bytes.length !== 32) throw new Error("Googleアカウント鍵の形式が正しくありません。");
  try {
    return await importAesKey(bytes, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}

export async function updateEncryptedVault<T>(envelope: KabutoraVaultEnvelope, dataKey: CryptoKey, data: T, ownerUid?: string): Promise<KabutoraVaultEnvelope> {
  return {
    ...envelope,
    ...(ownerUid ? { ownerUid } : {}),
    payload: await encryptBytes(dataKey, textEncoder.encode(JSON.stringify(data)), PAYLOAD_AAD),
    revision: envelope.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

export const encryptVaultRecord = async <T>(dataKey: CryptoKey, data: T) =>
  encryptBytes(dataKey, textEncoder.encode(JSON.stringify(data)), RECORD_AAD);

export const decryptVaultRecord = async <T>(dataKey: CryptoKey, block: EncryptedBlock): Promise<T> =>
  parsePayload<T>(await decryptBytes(dataKey, block, RECORD_AAD));

export const serializeVault = (envelope: KabutoraVaultEnvelope) => JSON.stringify(envelope, null, 2);

/** Recovery generations never expose their usable key to a cloud-store API. */
export async function createRecoveryVault<T>(data: T, passphrase: string, ownerUid: string, legacyKeys: Record<string, string> = {}) {
  const created = await createEncryptedVault(data, passphrase, ownerUid);
  const envelope: KabutoraVaultEnvelope = {
    ...created.envelope,
    version: 2,
    keyId: cryptoApi().randomUUID(),
    ...(Object.keys(legacyKeys).length ? { legacyKeys: await encryptVaultRecord(created.dataKey, legacyKeys) } : {}),
  };
  return { envelope, dataKey: created.dataKey, recoveryKey: created.recoveryKey };
}

export async function readLegacyVaultKeys(envelope: KabutoraVaultEnvelope, dataKey: CryptoKey): Promise<Record<string, string>> {
  if (!envelope.legacyKeys) return {};
  const keys = await decryptVaultRecord<Record<string, string>>(dataKey, envelope.legacyKeys);
  if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.entries(keys).some(([id, key]) => !id || typeof key !== "string" || !/^[\w-]{43}$/u.test(key))) {
    throw new Error("legacy_keys_invalid");
  }
  return keys;
}
