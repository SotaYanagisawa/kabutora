import { afterEach, describe, expect, it, vi } from "vitest";
import { timeoutSignal, withDeadline } from "./operation-deadline";
import { settleInitialAuthSession } from "./initial-auth-session";
describe("startup deadlines", () => {
  afterEach(() => vi.useRealTimers());
  it("does not wait forever on redirect storage", async () => {
    vi.useFakeTimers();
    const result = settleInitialAuthSession({ completeRedirect: () => new Promise(() => {}), authStateReady: async () => {}, currentUser: () => null }, 15_000);
    const assertion = expect(result).rejects.toHaveProperty("name", "TimeoutError");
    await vi.advanceTimersByTimeAsync(15_000); await assertion;
  });
  it("handles a rejection that arrives after storage timed out", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const task = new Promise<void>((_, fail) => { reject = fail; });
    const result = withDeadline(task, 2_000, "storage");
    const assertion = expect(result).rejects.toHaveProperty("name", "TimeoutError");
    await vi.advanceTimersByTimeAsync(2_000); await assertion;
    reject(new Error("late failure")); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("provides request deadlines when AbortSignal.timeout is unavailable", async () => {
    vi.useFakeTimers();
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
    try {
      const signal = timeoutSignal(4_000);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toHaveProperty("name", "TimeoutError");
    } finally {
      Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: original });
    }
  });
});
