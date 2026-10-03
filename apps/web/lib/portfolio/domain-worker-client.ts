import type { DomainWorkerRequest, DomainWorkerResponse } from "./domain-worker";
import { abortError, OperationTimeoutError } from "../ui/operation-deadline";
import { calculatePortfolio, emptyPortfolioCalculation, indexHistoryDataset, type PortfolioCalculationResult, type HistoryDataset, type HistorySelection, type IndexedHistoryDataset } from "./portfolio-history-calculation";

type Job = {
  id: number;
  dataset: HistoryDataset;
  selection: HistorySelection;
  resolve: (points: PortfolioCalculationResult) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  cleanup: () => void;
  priority: "foreground" | "background";
};

/** One active job and one replacement, shared by one dashboard lifetime. */
export class PortfolioHistoryCalculator {
  private worker: Worker | null = null;
  private workerDisabled = false;
  private dataset: HistoryDataset | null = null;
  private indexed: IndexedHistoryDataset | null = null;
  private revision = 0;
  private sequence = 0;
  private active: Job | null = null;
  private queuedForeground: Job | null = null;
  private queuedBackground: Job | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private stats = { sent: 0, datasets: 0, barCopies: 0, maxPending: 0 };

  constructor(private readonly workerFactory = () => new Worker(new URL("./domain-worker.ts", import.meta.url), { type: "module" }), private readonly timeoutMs = 15_000) {}

  diagnostics() { return { ...this.stats, pending: Number(Boolean(this.active)) + Number(Boolean(this.queuedForeground)) + Number(Boolean(this.queuedBackground)) }; }

  calculate(dataset: HistoryDataset, selection: HistorySelection, signal?: AbortSignal, priority: "foreground" | "background" = "foreground"): Promise<PortfolioCalculationResult> {
    if (this.disposed || signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.sequence, dataset, selection, resolve, reject, settled: false, cleanup: () => undefined, priority };
      const cancel = () => {
        this.settle(job, abortError());
        if (this.queuedForeground === job) this.queuedForeground = null;
        if (this.queuedBackground === job) this.queuedBackground = null;
        if (this.active === job) this.cancelActive();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      job.cleanup = () => signal?.removeEventListener("abort", cancel);
      if (priority === "foreground") {
        if (this.queuedForeground) this.settle(this.queuedForeground, abortError());
        if (this.queuedBackground) {
          this.settle(this.queuedBackground, abortError());
          this.queuedBackground = null;
        }
        this.queuedForeground = job;
        // A visible result always wins over idle warm-up work.
        if (this.active) {
          this.settle(this.active, abortError());
          this.cancelActive();
        }
      } else {
        if (this.queuedForeground) {
          this.settle(job, abortError());
          return;
        }
        if (this.queuedBackground) this.settle(this.queuedBackground, abortError());
        this.queuedBackground = job;
      }
      this.stats.maxPending = Math.max(this.stats.maxPending, Number(Boolean(this.active)) + Number(Boolean(this.queuedForeground)) + Number(Boolean(this.queuedBackground)));
      this.pump();
    });
  }

  private settle(job: Job, error?: unknown, points: PortfolioCalculationResult = emptyPortfolioCalculation) {
    if (job.settled) return;
    job.settled = true;
    job.cleanup();
    if (error) job.reject(error); else job.resolve(points);
  }

  private cancelActive() {
    this.controller?.abort();
    if (this.active && this.worker) {
      try { this.worker.postMessage({ type: "CANCEL", id: this.active.id } satisfies DomainWorkerRequest); }
      catch { this.workerFailed(); }
    }
  }

  private pump() {
    if (this.active || this.disposed) return;
    const job = this.queuedForeground ?? this.queuedBackground;
    if (!job) return;
    if (job.priority === "foreground") this.queuedForeground = null;
    else this.queuedBackground = null;
    this.active = job;
    if (!this.worker && !this.workerDisabled && typeof Worker !== "undefined") {
      try {
        const worker = this.workerFactory();
        this.worker = worker;
        worker.addEventListener("message", (event: MessageEvent<DomainWorkerResponse>) => {
          if (this.worker !== worker) return;
          const response = event.data;
          if (response.id !== this.active?.id || response.revision !== this.revision) return;
          this.finish(response.success ? undefined : response.error === "cancelled" ? abortError() : new Error("history_calculation_failed"), response.success ? response.result : emptyPortfolioCalculation);
        });
        worker.addEventListener("error", (e) => { console.warn("[WORKER_EVENT_ERROR]", e.message); if (this.worker === worker) this.workerFailed(); });
        worker.addEventListener("messageerror", (e) => { console.warn("[WORKER_MESSAGE_ERROR]", e); if (this.worker === worker) this.workerFailed(); });
      } catch { this.workerDisabled = true; }
    }
    this.timer = setTimeout(() => {
      this.worker?.terminate();
      this.worker = null;
      this.dataset = null;
      this.controller?.abort();
      this.finish(new OperationTimeoutError("portfolio-history"));
    }, this.timeoutMs);
    try {
      if (this.dataset !== job.dataset) {
        this.dataset = job.dataset;
        this.revision += 1;
        if (this.worker) {
          this.worker.postMessage({ type: "SET_DATASET", revision: this.revision, dataset: job.dataset } satisfies DomainWorkerRequest);
          this.stats.datasets += 1;
          this.stats.barCopies += job.dataset.bars.length;
          this.indexed = null;
        } else this.indexed = indexHistoryDataset(job.dataset);
      }
      this.stats.sent += 1;
      if (this.worker) this.worker.postMessage({ type: "CALCULATE", id: job.id, revision: this.revision, selection: job.selection } satisfies DomainWorkerRequest);
      else {
        this.controller = new AbortController();
        const id = job.id;
        void calculatePortfolio(this.indexed!, job.selection, this.controller.signal).then(
          (points) => { if (this.active?.id === id) this.finish(undefined, points); },
          (error) => { if (this.active?.id === id) this.finish(error); },
        );
      }
    } catch (error) {
      console.warn("[POST_MESSAGE_OR_PUMP_ERROR]", error);
      if (this.worker) this.workerFailed(); else this.finish(error);
    }
  }

  private workerFailed() {
    console.warn("[WORKER_FAILED]");
    this.worker?.terminate();
    this.worker = null;
    this.workerDisabled = true;
    this.dataset = null;
    this.indexed = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const job = this.active;
    this.active = null;
    if (job && !job.settled) {
      if (job.priority === "foreground" && !this.queuedForeground) this.queuedForeground = job;
      else if (job.priority === "background" && !this.queuedBackground) this.queuedBackground = job;
      else this.settle(job, abortError());
    }
    else if (job) this.settle(job, abortError());
    this.pump();
  }

  private finish(error?: unknown, points: PortfolioCalculationResult = emptyPortfolioCalculation) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) this.settle(this.active, error, points);
    this.active = null;
    this.controller = null;
    this.pump();
  }

  dispose() {
    this.disposed = true;
    this.controller?.abort();
    this.worker?.terminate();
    if (this.timer) clearTimeout(this.timer);
    if (this.active) this.settle(this.active, abortError());
    if (this.queuedForeground) this.settle(this.queuedForeground, abortError());
    if (this.queuedBackground) this.settle(this.queuedBackground, abortError());
    this.active = this.queuedForeground = this.queuedBackground = null;
    this.worker = null;
    this.dataset = null;
    this.indexed = null;
  }
}
