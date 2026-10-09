// Module worker for the equity screen: runs the engine off the main thread
// so a 1s PLO5 multiway run never freezes the UI. Errors come back as
// { error } so the screen can show them.

import { calculateEquity } from './equity.js';

self.onmessage = (e) => {
  const { id, input } = e.data;
  let result;
  try {
    result = calculateEquity(input);
  } catch (err) {
    result = { error: `Calculation failed: ${err && err.message ? err.message : err}` };
  }
  self.postMessage({ id, result });
};
