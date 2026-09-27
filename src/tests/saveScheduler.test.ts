import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveScheduler } from '../services/saveScheduler';

describe('SaveScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces a burst of schedules into one write with the latest value', () => {
    const write = vi.fn();
    const scheduler = new SaveScheduler<number>(write, { delayMs: 300 });
    scheduler.schedule(1);
    scheduler.schedule(2);
    scheduler.schedule(3);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(3);
    scheduler.dispose();
  });

  it('keeps waiting while edits continue within the merge window', () => {
    const write = vi.fn();
    const scheduler = new SaveScheduler<number>(write, { delayMs: 300 });
    scheduler.schedule(1);
    vi.advanceTimersByTime(200);
    scheduler.schedule(2);
    vi.advanceTimersByTime(200);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(2);
    scheduler.dispose();
  });

  it('flushes immediately on demand and stays idle when nothing is pending', () => {
    const write = vi.fn();
    const onSaved = vi.fn();
    const scheduler = new SaveScheduler<string>(write, { onSaved });
    scheduler.schedule('a');
    expect(scheduler.flush()).toBe(true);
    expect(write).toHaveBeenCalledWith('a');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending).toBe(false);
    expect(scheduler.flush()).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps the pending value on failure and retries until it succeeds', () => {
    const write = vi.fn()
      .mockImplementationOnce(() => { throw new Error('quota'); })
      .mockImplementationOnce(() => { throw new Error('quota'); })
      .mockImplementation(() => undefined);
    const onFailed = vi.fn();
    const onSaved = vi.fn();
    const scheduler = new SaveScheduler<string>(write, { delayMs: 100, retryDelayMs: 1000, onFailed, onSaved });
    scheduler.schedule('a');
    vi.advanceTimersByTime(100);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(onFailed).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(scheduler.hasPending).toBe(false);
    expect(write).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });

  it('stops auto-retrying after maxRetries but keeps data for a manual flush', () => {
    const write = vi.fn((): void => { throw new Error('quota'); });
    const onFailed = vi.fn();
    const scheduler = new SaveScheduler<string>(write, { delayMs: 100, retryDelayMs: 1000, maxRetries: 2, onFailed });
    scheduler.schedule('a');
    vi.advanceTimersByTime(100 + 1000 * 5);
    expect(write).toHaveBeenCalledTimes(3);
    expect(onFailed).toHaveBeenCalledTimes(3);
    expect(scheduler.hasPending).toBe(true);
    write.mockImplementation(() => undefined);
    expect(scheduler.flush()).toBe(true);
    expect(write).toHaveBeenCalledTimes(4);
    scheduler.dispose();
  });
});
