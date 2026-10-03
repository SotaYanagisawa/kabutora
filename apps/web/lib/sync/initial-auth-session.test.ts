import { describe, expect, it, vi } from "vitest";
import { settleInitialAuthSession } from "./initial-auth-session";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("initial auth session", () => {
  it("does not expose auth state until redirect and persisted session restoration finish", async () => {
    const redirect = deferred();
    const restored = deferred();
    const currentUser = vi.fn(() => ({ uid: "trusted-user" }));
    let settled = false;
    const result = settleInitialAuthSession({
      completeRedirect: () => redirect.promise,
      authStateReady: () => restored.promise,
      currentUser,
    }).then((value) => { settled = true; return value; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(currentUser).not.toHaveBeenCalled();

    redirect.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(currentUser).not.toHaveBeenCalled();

    restored.resolve();
    await expect(result).resolves.toEqual({ user: { uid: "trusted-user" }, redirectFailed: false });
    expect(currentUser).toHaveBeenCalledOnce();
  });

  it("still waits for authoritative auth state when redirect inspection fails", async () => {
    const restored = deferred();
    const result = settleInitialAuthSession({
      completeRedirect: () => Promise.reject(new Error("redirect unavailable")),
      authStateReady: () => restored.promise,
      currentUser: () => null,
    });

    restored.resolve();
    await expect(result).resolves.toEqual({ user: null, redirectFailed: true });
  });
});
