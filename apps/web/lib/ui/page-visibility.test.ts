import { describe, expect, it } from "vitest";
import { syncPageVisibilityDataset } from "./page-visibility";

class MockDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  documentElement = {
    dataset: {} as Record<string, string | undefined>,
  };
}

describe("page-visibility utilities", () => {
  it("updates document.documentElement.dataset.pageVisibility with syncPageVisibilityDataset", () => {
    const mockDoc = new MockDocument();
    mockDoc.visibilityState = "visible";

    const cleanup = syncPageVisibilityDataset(mockDoc as unknown as Document);
    expect(mockDoc.documentElement.dataset.pageVisibility).toBe("visible");

    mockDoc.visibilityState = "hidden";
    mockDoc.dispatchEvent(new Event("visibilitychange"));
    expect(mockDoc.documentElement.dataset.pageVisibility).toBe("hidden");

    mockDoc.visibilityState = "visible";
    mockDoc.dispatchEvent(new Event("visibilitychange"));
    expect(mockDoc.documentElement.dataset.pageVisibility).toBe("visible");

    cleanup();
  });

  it("is a no-op without a document", () => {
    expect(() => syncPageVisibilityDataset(undefined)()).not.toThrow();
  });
});
