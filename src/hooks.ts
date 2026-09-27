import { useEffect, useState } from 'react';
import { LocalEnergyRepository } from './repository';
import { EnergyLensViewModel, type EnergyLensState } from './viewModel';

export function useEnergyLens(): { vm: EnergyLensViewModel; state: EnergyLensState } {
  const [vm] = useState(() => new EnergyLensViewModel(new LocalEnergyRepository()));
  const [state, setState] = useState(vm.getState());
  useEffect(() => {
    const unsubscribe = vm.subscribe(setState);
    vm.initialize();
    return unsubscribe;
  }, [vm]);
  useEffect(() => {
    // 合并窗口内可能还有未落盘的修改，页面隐藏/关闭前必须同步落盘
    const flush = () => vm.flushPendingSave();
    const flushWhenHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flushWhenHidden);
      vm.dispose();
    };
  }, [vm]);
  return { vm, state };
}
