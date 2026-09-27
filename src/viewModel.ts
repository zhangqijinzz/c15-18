import { cloneScenario, summarizeScenario, validateDevice, validateScenarioSettings } from './domain';
import { findScenario, type EnergyRepository } from './repository';
import { SaveScheduler, type SaveSchedulerOptions } from './services/saveScheduler';
import type { EnergyDevice, EnergyDocument, EnergyScenario, Notice, SaveState, ViewStatus } from './types';

export interface EnergyLensState {
  document: EnergyDocument | null;
  status: ViewStatus;
  notice: Notice | null;
  saveState: SaveState;
}

type Listener = (state: EnergyLensState) => void;

export class EnergyLensViewModel {
  private state: EnergyLensState = { document: null, status: 'loading', notice: null, saveState: 'saved' };
  private readonly listeners = new Set<Listener>();
  private readonly scheduler: SaveScheduler<EnergyDocument>;

  constructor(private readonly repository: EnergyRepository, schedulerOptions: SaveSchedulerOptions = {}) {
    this.scheduler = new SaveScheduler<EnergyDocument>((document) => this.repository.save(document), {
      ...schedulerOptions,
      onSaved: () => this.handleSaved(),
      onFailed: () => this.handleSaveFailed(),
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): EnergyLensState { return this.state; }

  initialize(): void {
    try {
      this.state = { document: this.repository.load(), status: 'ready', notice: null, saveState: 'saved' };
    } catch {
      this.state = { document: null, status: 'error', notice: { kind: 'error', text: '本地数据读取失败，请刷新重试' }, saveState: 'saved' };
    }
    this.emit();
  }

  get activeScenario(): EnergyScenario | null {
    if (!this.state.document) return null;
    return findScenario(this.state.document, this.state.document.activeScenarioId) ?? null;
  }

  get activeSummary() {
    return this.activeScenario ? summarizeScenario(this.activeScenario) : null;
  }

  updateDevice(deviceId: string, patch: Partial<Pick<EnergyDevice, 'name' | 'watts' | 'dailyHours'>>): void {
    const scenario = this.activeScenario;
    if (!scenario) return;
    const device = scenario.devices.find((item) => item.id === deviceId);
    if (!device) return;
    const next = { ...device, ...patch };
    const error = validateDevice(next);
    if (error) {
      this.setNotice({ kind: 'error', text: error });
      return;
    }
    this.commit((current) => ({ ...current, devices: current.devices.map((item) => item.id === deviceId ? next : item) }), '参数已更新');
  }

  addDevice(): void {
    const scenario = this.activeScenario;
    if (!scenario) return;
    const device: EnergyDevice = { id: `device-${Date.now()}`, name: '新设备', watts: 100, dailyHours: 1 };
    this.commit((current) => ({ ...current, devices: [...current.devices, device] }), '已添加设备，可继续修改参数');
  }

  removeDevice(deviceId: string): void {
    const scenario = this.activeScenario;
    if (!scenario || scenario.devices.length <= 1) {
      this.setNotice({ kind: 'info', text: '至少保留一个设备，便于计算方案' });
      return;
    }
    this.commit((current) => ({ ...current, devices: current.devices.filter((item) => item.id !== deviceId) }), '设备已移除');
  }

  updateSettings(patch: Partial<Pick<EnergyScenario, 'name' | 'pricePerKwh' | 'daysPerMonth'>>): void {
    const scenario = this.activeScenario;
    if (!scenario) return;
    const next = { ...scenario, ...patch };
    const error = validateScenarioSettings(next.pricePerKwh, next.daysPerMonth);
    if (error) {
      this.setNotice({ kind: 'error', text: error });
      return;
    }
    this.commit((current) => ({ ...current, name: next.name.trim() || '未命名方案', pricePerKwh: next.pricePerKwh, daysPerMonth: next.daysPerMonth }), '计费参数已更新');
  }

  duplicateActive(): void {
    const source = this.activeScenario;
    if (!source || !this.state.document) return;
    const id = `scenario-${Date.now()}`;
    const copy = cloneScenario(source, id, `${source.name} · 副本`);
    const document = { ...this.state.document, scenarios: [...this.state.document.scenarios, copy], activeScenarioId: id };
    this.persist(document, '方案已复制，现在可以修改副本');
  }

  selectScenario(id: string): void {
    if (!this.state.document || !findScenario(this.state.document, id)) return;
    this.persist({ ...this.state.document, activeScenarioId: id }, '已切换方案');
  }

  complete(): void {
    // 宣称"已保存"之前必须先落盘；落盘失败则交给失败回调暴露，不假装成功
    if (!this.scheduler.flush()) return;
    this.state = { ...this.state, status: 'completed', notice: { kind: 'success', text: '本次推演已保存，可随时回来继续调整' } };
    this.emit();
  }

  /** 立即落盘所有待写修改：页面卸载前、手动重试都会走这里。 */
  flushPendingSave(): void {
    this.scheduler.flush();
  }

  /** 卸载前最后一次落盘，并清理合并/重试计时器。 */
  dispose(): void {
    this.scheduler.flush();
    this.scheduler.dispose();
  }

  private commit(update: (scenario: EnergyScenario) => EnergyScenario, notice: string): void {
    if (!this.state.document) return;
    const document = { ...this.state.document, scenarios: this.state.document.scenarios.map((scenario) => scenario.id === this.state.document?.activeScenarioId ? update(scenario) : scenario) };
    this.persist(document, notice);
  }

  private persist(document: EnergyDocument, notice: string): void {
    // 乐观更新界面，落盘合并到调度器里批量执行，避免每次输入都同步序列化
    this.state = { document, status: 'editing', notice: { kind: 'success', text: notice }, saveState: 'saving' };
    this.scheduler.schedule(document);
    this.emit();
  }

  private handleSaved(): void {
    const recovered = this.state.saveState === 'failed';
    this.state = {
      ...this.state,
      saveState: 'saved',
      status: recovered && this.state.status === 'error' ? 'editing' : this.state.status,
      notice: recovered ? { kind: 'success', text: '已恢复自动保存' } : this.state.notice,
    };
    this.emit();
  }

  private handleSaveFailed(): void {
    this.state = { ...this.state, status: 'error', saveState: 'failed', notice: { kind: 'error', text: '保存失败，会自动重试；也可以点「立即重试」' } };
    this.emit();
  }

  private setNotice(notice: Notice): void {
    this.state = { ...this.state, status: notice.kind === 'error' ? 'error' : 'editing', notice };
    this.emit();
  }

  private emit(): void { this.listeners.forEach((listener) => listener(this.state)); }
}
