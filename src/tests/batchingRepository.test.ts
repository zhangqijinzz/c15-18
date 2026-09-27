// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleScenario } from '../domain';
import { LocalEnergyRepository, type PersistEvent } from '../repository';
import { EnergyLensViewModel } from '../viewModel';
import type { EnergyDocument } from '../types';

const STORAGE_KEY = 'energy-lens.document.v1';

function makeDocument(name: string): EnergyDocument {
  return { version: 1, scenarios: [{ ...structuredClone(exampleScenario), name }], activeScenarioId: exampleScenario.id };
}

function savedScenarioName(): string {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as EnergyDocument).scenarios[0].name : '';
}

describe('batched persistence', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('coalesces a burst of edits into a single write with the latest data', () => {
    const repository = new LocalEnergyRepository();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    repository.save(makeDocument('a'));
    repository.save(makeDocument('b'));
    repository.save(makeDocument('c'));
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(savedScenarioName()).toBe('c');
    repository.dispose();
  });

  it('bounds the flush wait during continuous typing', () => {
    const repository = new LocalEnergyRepository();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    repository.save(makeDocument('a'));
    for (const name of ['b', 'c', 'd', 'e']) {
      vi.advanceTimersByTime(200);
      repository.save(makeDocument(name));
    }
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250); // 距首次修改已 1050ms，越过最长等待窗口
    expect(writes).toHaveBeenCalledTimes(1);
    expect(savedScenarioName()).toBe('e');
    repository.dispose();
  });

  it('flushes the last pending edit synchronously when the page is closed or refreshed', () => {
    const repository = new LocalEnergyRepository();
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    repository.save(makeDocument('last-keystroke'));
    window.dispatchEvent(new Event('pagehide'));
    expect(savedScenarioName()).toBe('last-keystroke');
    expect(writes).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000); // 落盘后不再有重复写入
    expect(writes).toHaveBeenCalledTimes(1);
    repository.dispose();
  });

  it('flushes pending edits when the page becomes hidden', () => {
    const repository = new LocalEnergyRepository();
    repository.save(makeDocument('backgrounded'));
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'hidden' });
    window.document.dispatchEvent(new Event('visibilitychange'));
    expect(savedScenarioName()).toBe('backgrounded');
    delete (window.document as { visibilityState?: string }).visibilityState;
    repository.dispose();
  });

  it('keeps pending data and reports failure when a write fails, then recovers on retry', () => {
    const repository = new LocalEnergyRepository();
    const events: PersistEvent[] = [];
    repository.subscribe((event) => events.push(event));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    repository.save(makeDocument('x'));
    vi.advanceTimersByTime(300);
    expect(events).toEqual(['pending', 'failed']);
    expect(savedScenarioName()).toBe(''); // 失败不假装成功：存储里确实没有
    vi.restoreAllMocks();
    repository.flush(); // 补救：重试应把保留的修改写进去
    expect(events).toEqual(['pending', 'failed', 'saved']);
    expect(savedScenarioName()).toBe('x');
    repository.dispose();
  });

  it('surfaces a batched write failure through the view model and recovers via retryPersist', () => {
    const repository = new LocalEnergyRepository();
    const vm = new EnergyLensViewModel(repository);
    vm.initialize();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    vm.addDevice();
    expect(vm.getState().persist).toBe('pending');
    vi.advanceTimersByTime(300);
    expect(vm.getState().persist).toBe('failed');
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().notice?.text).toContain('保存失败');
    vi.restoreAllMocks();
    vm.retryPersist();
    expect(vm.getState().persist).toBe('saved');
    expect(vm.getState().status).toBe('editing');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as EnergyDocument;
    expect(saved.scenarios[0].devices).toHaveLength(exampleScenario.devices.length + 1);
    repository.dispose();
  });
});
