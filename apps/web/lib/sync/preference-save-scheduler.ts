export class PreferenceSaveScheduler<T extends object> {
  private pending: Partial<T> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly save: (value: Partial<T>) => Promise<void>,
    private readonly delayMs: number,
  ) {}

  enqueue(value: Partial<T>) {
    this.pending = { ...this.pending, ...value };
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delayMs);
  }

  flush(): Promise<void> {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    const value = this.pending;
    this.pending = null;
    if (!value) return this.writes;
    const result = this.writes.catch(() => undefined).then(() => this.save(value));
    this.writes = result;
    return result;
  }

  cancel() {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
