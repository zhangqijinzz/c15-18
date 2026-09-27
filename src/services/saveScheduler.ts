export interface SaveSchedulerOptions {
  /** 合并窗口：窗口内的连续修改只保留最新一份，窗口结束后落盘一次 */
  delayMs?: number;
  /** 落盘失败后的自动重试间隔 */
  retryDelayMs?: number;
  /** 自动重试次数上限，超过后保留待写数据，等待手动重试或下一次编辑 */
  maxRetries?: number;
  onSaved?: () => void;
  onFailed?: () => void;
}

const DEFAULT_DELAY_MS = 300;
const DEFAULT_RETRY_DELAY_MS = 1500;
const DEFAULT_MAX_RETRIES = 3;

/**
 * 写入合并调度器：把高频的同步写收敛成批量落盘。
 * - schedule() 只记录最新值并重置合并窗口，不立即写；
 * - flush() 立即同步落盘（用于合并窗口结束、页面卸载前、手动重试）；
 * - 写失败时保留待写数据，按 retryDelayMs 自动重试，直到成功或达到 maxRetries。
 */
export class SaveScheduler<T> {
  private pending: T | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;

  private readonly delayMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;

  constructor(
    private readonly write: (value: T) => void,
    private readonly options: SaveSchedulerOptions = {},
  ) {
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  get hasPending(): boolean { return this.pending !== null; }

  schedule(value: T): void {
    this.pending = value;
    this.retries = 0;
    this.clearTimers();
    this.flushTimer = setTimeout(() => { this.flush(); }, this.delayMs);
  }

  /** 立即落盘待写数据。返回 true 表示没有遗留未落盘的修改。 */
  flush(): boolean {
    this.clearTimers();
    if (this.pending === null) return true;
    const value = this.pending;
    try {
      this.write(value);
    } catch {
      // 保留 pending，失败必须可重试，不能丢
      this.options.onFailed?.();
      this.scheduleRetry();
      return false;
    }
    this.pending = null;
    this.retries = 0;
    this.options.onSaved?.();
    return true;
  }

  dispose(): void {
    this.clearTimers();
    this.pending = null;
  }

  private scheduleRetry(): void {
    if (this.retries >= this.maxRetries) return;
    this.retries += 1;
    this.retryTimer = setTimeout(() => { this.flush(); }, this.retryDelayMs);
  }

  private clearTimers(): void {
    if (this.flushTimer !== null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }
}
