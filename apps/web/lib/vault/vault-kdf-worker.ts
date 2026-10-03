import { deriveArgon2Key, type Argon2KeyInput } from "./argon2-key";

const scope = self as unknown as { onmessage: ((event: MessageEvent<Argon2KeyInput>) => void) | null; postMessage: (value: unknown) => void };
scope.onmessage = (event) => {
  void deriveArgon2Key(event.data).then(
    (key) => scope.postMessage({ key }),
    () => scope.postMessage({ error: "key_derivation_failed" }),
  );
};
