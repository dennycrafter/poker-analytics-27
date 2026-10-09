// Global 1-second tick registry. Screens register handlers for live regions
// (timers, live net values) so ticks never trigger full re-renders.

const handlers = new Set();

export function onTick(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export function tick() {
  for (const fn of [...handlers]) {
    try { fn(); } catch (e) { console.error('tick handler failed', e); }
  }
}
