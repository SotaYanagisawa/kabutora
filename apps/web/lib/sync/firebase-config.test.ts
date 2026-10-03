import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Firebase device trust configuration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows the selected trust mode to be restored repeatedly after locking", async () => {
    const config = await import("./firebase-config");
    config.configureDeviceTrust("trusted");
    config.lockDeviceTrustConfiguration();

    expect(() => config.configureDeviceTrust("trusted")).not.toThrow();
    expect(config.getDeviceTrustMode()).toBe("trusted");
  });

  it("rejects changing trust mode after Firebase persistence is locked", async () => {
    const config = await import("./firebase-config");
    config.configureDeviceTrust("trusted");
    config.lockDeviceTrustConfiguration();

    expect(() => config.configureDeviceTrust("shared")).toThrow("端末の保存設定は起動後に変更できません。");
    expect(config.getDeviceTrustMode()).toBe("trusted");
  });
});
