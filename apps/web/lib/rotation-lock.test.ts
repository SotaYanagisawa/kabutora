import { describe, expect, it, vi } from "vitest";
import { applyPortraitRotationLock } from "./rotation-lock";

describe("applyPortraitRotationLock", () => {
  it("requests a portrait-primary lock", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);

    await expect(applyPortraitRotationLock(true, { lock })).resolves.toBe("locked");
    expect(lock).toHaveBeenCalledWith("portrait-primary");
  });

  it("falls back when the browser does not expose orientation locking", async () => {
    await expect(applyPortraitRotationLock(true, {})).resolves.toBe("fallback");
  });

  it("falls back when the native lock is restricted", async () => {
    const lock = vi.fn().mockRejectedValue(new Error("NotAllowedError"));

    await expect(applyPortraitRotationLock(true, { lock })).resolves.toBe("fallback");
  });

  it("releases a native lock when disabled", async () => {
    const unlock = vi.fn();

    await expect(applyPortraitRotationLock(false, { unlock })).resolves.toBe("unlocked");
    expect(unlock).toHaveBeenCalledOnce();
  });
});
