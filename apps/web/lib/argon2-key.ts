import { argon2idAsync } from "@noble/hashes/argon2.js";

export type Argon2KeyInput = { password: Uint8Array; salt: Uint8Array; memoryKiB: number; iterations: number; parallelism: number };

export async function deriveArgon2Key(input: Argon2KeyInput): Promise<CryptoKey> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await argon2idAsync(input.password, input.salt, {
      m: input.memoryKiB, t: input.iterations, p: input.parallelism, dkLen: 32,
      asyncTick: 8, maxmem: Math.max(128 * 1024 * 1024, input.memoryKiB * 2048),
    });
    return await crypto.subtle.importKey("raw", bytes as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally { bytes?.fill(0); input.password.fill(0); }
}
