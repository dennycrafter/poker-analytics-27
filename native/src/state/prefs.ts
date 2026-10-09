// Device-local display preferences (not synced, like the web app's doc.ui).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import type { StakingMode } from '../lib/types';

const KEY = 'pa27.staking_mode';

/** Net-of-staking (default) vs gross tournament results, persisted per device. */
export function useStakingMode(): [StakingMode, (m: StakingMode) => void] {
  const [mode, setMode] = useState<StakingMode>('net');
  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then(v => { if (v === 'gross') setMode('gross'); })
      .catch(e => console.error('prefs: could not read staking mode', e));
  }, []);
  const set = (m: StakingMode) => {
    setMode(m);
    AsyncStorage.setItem(KEY, m).catch(e => console.error('prefs: could not save staking mode', e));
  };
  return [mode, set];
}
