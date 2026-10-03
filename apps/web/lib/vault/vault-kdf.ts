import { deriveArgon2Key, type Argon2KeyInput } from "./argon2-key";

// Noble's async Argon2 yields microtasks, which do not let WebKit paint or
// process input. A dedicated worker also releases its 64 MiB heap on completion.
let pending: Promise<unknown> = Promise.resolve();
export function deriveResponsivePassphraseKey(input: Argon2KeyInput): Promise<CryptoKey> {
  const task = pending.then(async () => {
    if (typeof Worker === "undefined") return deriveArgon2Key(input);
    let worker: Worker;
    try { worker = new Worker(new URL("./vault-kdf-worker.ts", import.meta.url), { type: "module" }); }
    catch { return deriveArgon2Key(input); }
    return new Promise<CryptoKey>((resolve, reject) => {
      const finish = (key?: CryptoKey) => {
        clearTimeout(timer); worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate(); input.password.fill(0);
        if (key) resolve(key);
        else reject(new Error("端末の鍵導出を完了できませんでした。再試行するか、復旧キーで解除してください。"));
      };
      const timer = setTimeout(() => finish(), 90_000);
      worker.onmessage = (event: MessageEvent<{ key?: CryptoKey }>) => {
        const key = event.data.key;
        finish(key?.type === "secret" && key.extractable === false && key.algorithm.name === "AES-GCM" ? key : undefined);
      };
      worker.onerror = (event) => { event.preventDefault(); finish(); };
      worker.onmessageerror = () => finish();
      try { worker.postMessage(input); input.password.fill(0); } catch { finish(); }
    });
  });
  pending = task.catch(() => undefined);
  return task;
}
