import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVisibilityAwareLoop,
  getVisibilityServerSnapshot,
  getVisibilitySnapshot,
  isDocumentVisible,
  onVisibilityChange,
  subscribeVisibility,
  syncPageVisibilityDataset,
} from "./page-visibility";

class MockDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  documentElement = {
    dataset: {} as Record<string, string | undefined>,
  };
}

describe("page-visibility utilities", () => {
  it("defaults to true in SSR / non-browser environments when document is absent", () => {
    expect(isDocumentVisible(undefined)).toBe(true);
    expect(getVisibilityServerSnapshot()).toBe(true);
  });

  it("reports correct visibility state with isDocumentVisible", () => {
    const mockDoc = new MockDocument();

    mockDoc.visibilityState = "visible";
    expect(isDocumentVisible(mockDoc as unknown as Document)).toBe(true);

    mockDoc.visibilityState = "hidden";
    expect(isDocumentVisible(mockDoc as unknown as Document)).toBe(false);
  });

  it("notifies listeners on visibility changes via onVisibilityChange", () => {
    const mockDoc = new MockDocument();
    mockDoc.visibilityState = "visible";

    const listener = vi.fn();
    const cleanup = onVisibilityChange(listener, mockDoc as unknown as Document);

    mockDoc.visibilityState = "hidden";
    mockDoc.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledWith(false);

    mockDoc.visibilityState = "visible";
    mockDoc.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledWith(true);

    cleanup();
    mockDoc.visibilityState = "hidden";
    mockDoc.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

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

  it("suspends canvas loop when hidden and resumes when visible", () => {
    let nextFrameId = 1;
    const rafCallbacks = new Map<number, FrameRequestCallback>();

    const fakeWindow = {
      requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
        const id = nextFrameId++;
        rafCallbacks.set(id, cb);
        return id;
      }),
      cancelAnimationFrame: vi.fn((id: number) => {
        rafCallbacks.delete(id);
      }),
    } as unknown as Window;

    const mockDoc = new MockDocument();
    mockDoc.visibilityState = "visible";

    const renderCallback = vi.fn();

    const loop = createVisibilityAwareLoop(renderCallback, fakeWindow, mockDoc as unknown as Document);
    loop.start();

    expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledTimes(1);

    // Simulate 1 tick of the loop
    const [id, cb] = [...rafCallbacks.entries()][0];
    rafCallbacks.delete(id);
    cb(100);

    expect(renderCallback).toHaveBeenCalledWith(100);
    expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledTimes(2);

    // Switch tab to hidden: should cancel frame and pause loop
    mockDoc.visibilityState = "hidden";
    mockDoc.dispatchEvent(new Event("visibilitychange"));
    expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalled();
    expect(loop.isRunning()).toBe(false);

    // Switch tab back to visible: should automatically resume requestAnimationFrame
    mockDoc.visibilityState = "visible";
    mockDoc.dispatchEvent(new Event("visibilitychange"));
    expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledTimes(3);
    expect(loop.isRunning()).toBe(true);

    loop.destroy();
    expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalled();
  });

  describe("global document integration", () => {
    let originalDoc: unknown;

    beforeEach(() => {
      originalDoc = globalThis.document;
    });

    afterEach(() => {
      // @ts-expect-error restoring original
      globalThis.document = originalDoc;
    });

    it("supports subscribeVisibility and getVisibilitySnapshot", () => {
      const mockDoc = new MockDocument();
      // @ts-expect-error mocking global document
      globalThis.document = mockDoc;

      mockDoc.visibilityState = "visible";
      expect(getVisibilitySnapshot()).toBe(true);

      const listener = vi.fn();
      const unsubscribe = subscribeVisibility(listener);

      mockDoc.visibilityState = "hidden";
      mockDoc.dispatchEvent(new Event("visibilitychange"));

      expect(listener).toHaveBeenCalled();
      expect(getVisibilitySnapshot()).toBe(false);

      unsubscribe();
    });
  });
});
