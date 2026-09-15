import { calculatePortfolio, indexHistoryDataset, type PortfolioCalculationResult, type HistoryDataset, type HistorySelection, type IndexedHistoryDataset } from "./portfolio-history-calculation";

export type DomainWorkerRequest =
  | { type: "SET_DATASET"; revision: number; dataset: HistoryDataset }
  | { type: "CALCULATE"; id: number; revision: number; selection: HistorySelection }
  | { type: "CANCEL"; id: number };
export type DomainWorkerResponse =
  | { id: number; revision: number; success: true; result: PortfolioCalculationResult }
  | { id: number; revision: number; success: false; error: string };

let indexed: IndexedHistoryDataset | null = null;
let revision = 0;
let active: { id: number; controller: AbortController } | null = null;
self.addEventListener("message", (event: MessageEvent<DomainWorkerRequest>) => {
  const data = event.data;
  if (data.type === "CANCEL") {
    if (active?.id === data.id) active.controller.abort();
    return;
  }
  if (data.type === "SET_DATASET") {
    active?.controller.abort();
    indexed = indexHistoryDataset(data.dataset);
    revision = data.revision;
    return;
  }
  const controller = new AbortController();
  active?.controller.abort();
  active = { id: data.id, controller };
  const task = indexed && revision === data.revision
    ? calculatePortfolio(indexed, data.selection, controller.signal)
    : Promise.reject(new Error("dataset_revision_mismatch"));
  void task.then((result) => {
    self.postMessage({ id: data.id, revision: data.revision, success: true, result } satisfies DomainWorkerResponse);
  }, (error: unknown) => {
    self.postMessage({ id: data.id, revision: data.revision, success: false, error: error instanceof Error && error.name === "AbortError" ? "cancelled" : "calculation_failed" } satisfies DomainWorkerResponse);
  }).finally(() => { if (active?.id === data.id) active = null; });
});
