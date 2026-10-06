import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortfolioHistoryCalculator } from "./domain-worker-client";
import type { DomainWorkerRequest, DomainWorkerResponse } from "./domain-worker";
import { emptyPortfolioCalculation, type HistoryDataset } from "./portfolio-history-calculation";

class FakeWorker extends EventTarget {
  messages: DomainWorkerRequest[] = [];
  terminated = false;
  postMessage(value: DomainWorkerRequest) { this.messages.push(value); }
  terminate() { this.terminated = true; }
  reply(value: DomainWorkerResponse) { this.dispatchEvent(new MessageEvent("message", { data: value })); }
}
const dataset: HistoryDataset = { transactions: [], securities: [], bars: [], corporateActions: [], distributions: [] };
const selection = { transactionIds: [], throughDate: "2026-01-01" };
describe("bounded portfolio calculation", () => {
  let worker: FakeWorker;
  let calculator: PortfolioHistoryCalculator;
  beforeEach(() => { worker = new FakeWorker(); vi.stubGlobal("Worker", FakeWorker); calculator = new PortfolioHistoryCalculator(() => worker as unknown as Worker, 100); });
  afterEach(() => { calculator.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("settles 99 superseded requests, retains only a replacement, and copies the dataset once", async () => {
    const results = Array.from({ length: 100 }, () => calculator.calculate(dataset, selection).catch((error) => error.name));
    expect(calculator.diagnostics().pending).toBe(2);
    expect(calculator.diagnostics().maxPending).toBe(2);
    worker.reply({ id: 1, revision: 1, success: false, error: "cancelled" });
    worker.reply({ id: 1, revision: 1, success: true, result: emptyPortfolioCalculation });
    expect(calculator.diagnostics().pending).toBe(1);
    worker.reply({ id: 100, revision: 1, success: true, result: emptyPortfolioCalculation });
    const settled = await Promise.all(results);
    expect(settled.slice(0, 99)).toEqual(Array(99).fill("AbortError"));
    expect(settled[99]).toEqual(emptyPortfolioCalculation);
    expect(worker.messages.filter((message) => message.type === "SET_DATASET")).toHaveLength(1);
    expect(worker.messages.filter((message) => message.type === "CALCULATE")).toHaveLength(2);
    expect(calculator.diagnostics().pending).toBe(0);
  });
  it("bounds a stuck worker and starts the newest request after termination", async () => {
    vi.useFakeTimers();
    const first = calculator.calculate(dataset, selection).catch((error) => error.name);
    const replacement = calculator.calculate(dataset, selection);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toBe("AbortError");
    expect(worker.terminated).toBe(true);
    worker.reply({ id: 2, revision: 2, success: true, result: emptyPortfolioCalculation });
    await expect(replacement).resolves.toEqual(emptyPortfolioCalculation);
  });
  it("falls back and settles after a worker failure", async () => {
    const result = calculator.calculate(dataset, selection);
    worker.dispatchEvent(new Event("error"));
    await expect(result).resolves.toEqual(emptyPortfolioCalculation);
    expect(worker.terminated).toBe(true);
    expect(calculator.diagnostics().pending).toBe(0);
  });
  it("disposal aborts active and queued work and rejects later requests", async () => {
    const first = calculator.calculate(dataset, selection).catch((error) => error.name);
    const second = calculator.calculate(dataset, selection).catch((error) => error.name);
    calculator.dispose();
    expect(await first).toBe("AbortError"); expect(await second).toBe("AbortError");
    await expect(calculator.calculate(dataset, selection)).rejects.toHaveProperty("name", "AbortError");
  });
  it("ignores aborted input without sending any work", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(calculator.calculate(dataset, selection, controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(worker.messages).toEqual([]);
  });
  it("passes an early summary to the visible job only, before its result", async () => {
    const summaries: unknown[] = [];
    const visible = calculator.calculate(dataset, selection, undefined, "foreground", (summary) => summaries.push(summary));
    const early = { summary: emptyPortfolioCalculation.summary, nativeSummary: emptyPortfolioCalculation.nativeSummary, reconciliation: emptyPortfolioCalculation.reconciliation };
    worker.reply({ id: 7, revision: 1, stage: "summary", summary: early });
    expect(summaries).toEqual([]);
    worker.reply({ id: 1, revision: 1, stage: "summary", summary: early });
    expect(summaries).toEqual([early]);
    worker.reply({ id: 1, revision: 1, success: true, result: emptyPortfolioCalculation });
    await expect(visible).resolves.toEqual(emptyPortfolioCalculation);
    worker.reply({ id: 1, revision: 1, stage: "summary", summary: early });
    expect(summaries).toHaveLength(1);
  });
  it("does not let idle warm-up cancel a visible calculation", async () => {
    const visible = calculator.calculate(dataset, selection);
    const warmup = calculator.calculate(dataset, selection, undefined, "background");
    expect(worker.messages.filter((message) => message.type === "CANCEL")).toHaveLength(0);
    worker.reply({ id: 1, revision: 1, success: true, result: emptyPortfolioCalculation });
    await expect(visible).resolves.toEqual(emptyPortfolioCalculation);
    worker.reply({ id: 2, revision: 1, success: true, result: emptyPortfolioCalculation });
    await expect(warmup).resolves.toEqual(emptyPortfolioCalculation);
  });
  it("cancels queued background warmup when a new visible calculation arrives, keeping maxPending <= 2", async () => {
    const visible1 = calculator.calculate(dataset, selection).catch((err: unknown) => err as Error);
    const warmup = calculator.calculate(dataset, selection, undefined, "background").catch((err: unknown) => err as Error);
    expect(calculator.diagnostics().maxPending).toBeLessThanOrEqual(2);
    const visible2 = calculator.calculate(dataset, selection);
    expect(calculator.diagnostics().maxPending).toBeLessThanOrEqual(2);
    expect(((await visible1) as Error).name).toBe("AbortError");
    expect(((await warmup) as Error).name).toBe("AbortError");
    worker.reply({ id: 1, revision: 1, success: false, error: "cancelled" });
    worker.reply({ id: 3, revision: 1, success: true, result: emptyPortfolioCalculation });
    await expect(visible2).resolves.toEqual(emptyPortfolioCalculation);
    expect(calculator.diagnostics().pending).toBe(0);
  });
});
