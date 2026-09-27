import { exampleScenario } from './domain';
import { readDocument, writeDocument } from './services/storageService';
import type { EnergyDocument, EnergyScenario } from './types';

export type PersistEvent = 'pending' | 'saved' | 'failed';
export type PersistListener = (event: PersistEvent) => void;

export interface EnergyRepository {
  load(): EnergyDocument;
  save(document: EnergyDocument): void;
  /** 立即落盘所有待写入的修改；不支持合并写的仓库可以不实现。 */
  flush?(): void;
  /** 订阅落盘进度事件；不支持合并写的仓库可以不实现。 */
  subscribe?(listener: PersistListener): () => void;
}

/** 连续输入在此窗口内合并成一次写入。 */
const FLUSH_DELAY_MS = 250;
/** 持续输入时最长容忍的未落盘时间，避免保存提示一直停在“保存中”。 */
const MAX_FLUSH_WAIT_MS = 1000;

export class LocalEnergyRepository implements EnergyRepository {
  private pending: EnergyDocument | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<PersistListener>();
  private readonly handlePageHide = (): void => this.flush();
  private readonly handleVisibilityChange = (): void => {
    if (window.document.visibilityState === 'hidden') this.flush();
  };

  constructor() {
    // 页面隐藏/关闭/刷新时同步落盘，守住合并窗口内的最后一次修改。
    // 监听器的生命周期与页面一致，不随 React 组件卸载（StrictMode 会重复挂载）。
    window.addEventListener('pagehide', this.handlePageHide);
    window.document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  load(): EnergyDocument {
    const saved = readDocument();
    if (!saved || saved.scenarios.length === 0) {
      return { version: 1, scenarios: [exampleScenario], activeScenarioId: exampleScenario.id };
    }
    const activeExists = saved.scenarios.some((scenario) => scenario.id === saved.activeScenarioId);
    return activeExists ? saved : { ...saved, activeScenarioId: saved.scenarios[0].id };
  }

  save(document: EnergyDocument): void {
    this.pending = document;
    this.emit('pending');
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.flush(), MAX_FLUSH_WAIT_MS);
    }
  }

  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }
    if (!this.pending) return;
    try {
      writeDocument(this.pending);
      this.pending = null;
      this.emit('saved');
    } catch {
      // 写失败时保留 pending：下一次修改、手动重试或页面隐藏时都会再尝试。
      this.emit('failed');
    }
  }

  subscribe(listener: PersistListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.flush();
    window.removeEventListener('pagehide', this.handlePageHide);
    window.document.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private emit(event: PersistEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

export function findScenario(document: EnergyDocument, id: string): EnergyScenario | undefined {
  return document.scenarios.find((scenario) => scenario.id === id);
}
