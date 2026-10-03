import { afterEach, describe, expect, it, vi } from "vitest";
import { PreferenceSaveScheduler } from "./preference-save-scheduler";

describe("PreferenceSaveScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst of independent preference edits into one save", async () => {
    vi.useFakeTimers();
    const saved: Array<Record<string, unknown>> = [];
    const scheduler = new PreferenceSaveScheduler<Record<string, unknown>>(async (value) => { saved.push(value); }, 2_500);

    scheduler.enqueue({ summaryRange: "1M" });
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.enqueue({ summaryMarketFilter: "US" });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(saved).toEqual([{ summaryRange: "1M", summaryMarketFilter: "US" }]);
  });

  it("flushes pending preferences immediately for page lifecycle events", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => undefined);
    const scheduler = new PreferenceSaveScheduler<{ theme: string }>(save, 2_500);
    scheduler.enqueue({ theme: "dark" });

    await scheduler.flush();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ theme: "dark" });
  });
});
