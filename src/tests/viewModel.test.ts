import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleScenario } from '../domain';
import type { EnergyDocument } from '../types';
import { EnergyLensViewModel } from '../viewModel';
import type { EnergyRepository } from '../repository';

function makeRepository(): EnergyRepository & { data: EnergyDocument; save: ReturnType<typeof vi.fn> } {
  const data: EnergyDocument = { version: 1, scenarios: [structuredClone(exampleScenario)], activeScenarioId: exampleScenario.id };
  return { data, load: () => data, save: vi.fn((next: EnergyDocument) => { data.scenarios = next.scenarios; data.activeScenarioId = next.activeScenarioId; }) };
}

describe('EnergyLensViewModel', () => {
  let repository: ReturnType<typeof makeRepository>;
  let vm: EnergyLensViewModel;
  beforeEach(() => { repository = makeRepository(); vm = new EnergyLensViewModel(repository); vm.initialize(); });

  it('initializes, persists edits, and recalculates results', () => {
    expect(vm.getState().status).toBe('ready');
    const before = vm.activeSummary?.total.monthlyKwh;
    vm.updateDevice('device-aircon', { dailyHours: 2 });
    expect(vm.activeSummary?.total.monthlyKwh).toBeLessThan(before ?? Infinity);
    vm.flushPendingSave();
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('merges a burst of edits into a single write', () => {
    vm.updateDevice('device-aircon', { dailyHours: 2 });
    vm.updateDevice('device-aircon', { dailyHours: 3 });
    vm.updateSettings({ pricePerKwh: 0.8 });
    expect(repository.save).not.toHaveBeenCalled();
    expect(vm.getState().saveState).toBe('saving');
    vm.flushPendingSave();
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.data.scenarios[0].pricePerKwh).toBe(0.8);
    expect(repository.data.scenarios[0].devices[0].dailyHours).toBe(3);
    expect(vm.getState().saveState).toBe('saved');
  });

  it('keeps invalid values out of the document and exposes an error notice', () => {
    vm.updateDevice('device-aircon', { watts: -50 });
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().notice?.text).toBe('功率不能为负数');
    expect(vm.activeScenario?.devices[0].watts).toBe(1200);
  });

  it('duplicates a scenario and can recover a saved document', () => {
    vm.duplicateActive();
    vm.flushPendingSave();
    expect(vm.getState().document?.scenarios).toHaveLength(2);
    const recovered = new EnergyLensViewModel(repository);
    recovered.initialize();
    expect(recovered.getState().document?.scenarios).toHaveLength(2);
  });

  it('surfaces persistence failure as a recoverable error', () => {
    repository.save.mockImplementation(() => { throw new Error('quota'); });
    vm.addDevice();
    vm.flushPendingSave();
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().saveState).toBe('failed');
    expect(vm.getState().notice?.text).toContain('保存失败');
    vm.dispose();
  });

  it('recovers once a failed save succeeds on retry', () => {
    repository.save.mockImplementationOnce(() => { throw new Error('quota'); });
    vm.addDevice();
    vm.flushPendingSave();
    expect(vm.getState().saveState).toBe('failed');
    vm.flushPendingSave();
    expect(vm.getState().saveState).toBe('saved');
    expect(vm.getState().status).toBe('editing');
    expect(vm.getState().notice?.text).toBe('已恢复自动保存');
    expect(repository.data.scenarios[0].devices).toHaveLength(4);
  });

  it('persists the last edit when the page is closed right after typing', () => {
    vm.updateDevice('device-aircon', { dailyHours: 1 });
    vm.dispose();
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.data.scenarios[0].devices[0].dailyHours).toBe(1);
  });

  it('completes only after pending edits are persisted', () => {
    vm.updateDevice('device-aircon', { dailyHours: 1 });
    vm.complete();
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(vm.getState().status).toBe('completed');
  });

  it('does not claim completion when the final flush fails', () => {
    repository.save.mockImplementation(() => { throw new Error('quota'); });
    vm.updateDevice('device-aircon', { dailyHours: 1 });
    vm.complete();
    expect(vm.getState().status).toBe('error');
    expect(vm.getState().saveState).toBe('failed');
    vm.dispose();
  });
});
