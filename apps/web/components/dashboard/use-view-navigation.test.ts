import { describe, expect, it } from "vitest";
import { readLastView } from "./use-view-navigation";

const storageWith = (value: string | null) => ({ getItem: () => value }) as unknown as Storage;

describe("readLastView", () => {
  it("restores the main menu page shown last on this device", () => {
    expect(readLastView(storageWith("dividends"))).toBe("dividends");
    expect(readLastView(storageWith("settings"))).toBe("settings");
  });

  it("opens the overview when nothing usable was stored", () => {
    expect(readLastView(storageWith(null))).toBe("overview");
    expect(readLastView(storageWith("security"))).toBe("overview");
    expect(readLastView(storageWith("performance"))).toBe("overview");
    expect(readLastView(storageWith("unknown"))).toBe("overview");
  });
});
