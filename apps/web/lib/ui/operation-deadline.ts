export const OPTIONAL_STORAGE_TIMEOUT_MS = 2_000;
export const STARTUP_TIMEOUT_MS = 15_000;

export class OperationTimeoutError extends Error {
  constructor(readonly operation: string) {
    super(`operation_timeout:${operation}`);
    this.name = "TimeoutError";
  }
}

/** Always consumes late rejections, and clears the timer on every settlement. */
export function withDeadline<T>(task: PromiseLike<T>, milliseconds: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperationTimeoutError(operation)), milliseconds);
    Promise.resolve(task).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function abortError() {
  return new DOMException("Calculation superseded", "AbortError");
}

/**
 * Safari versions that can still run Kabutora do not all expose the newer
 * AbortSignal.timeout() convenience API. Keep request deadlines available on
 * those browsers without making the request fail before fetch() starts.
 */
export function timeoutSignal(milliseconds: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(milliseconds);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), milliseconds);
  return controller.signal;
}
