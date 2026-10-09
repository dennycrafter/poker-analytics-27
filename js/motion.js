// Route transition choice, kept pure (no DOM, no store) so it is testable in Node.

// Full-screen modal routes (start form, live, stack, detail, hand/note views)
// rise from the bottom like an iOS sheet; everything else moves sideways.
const MODAL_RE = /^\/(new|live|session|hand|note)\//;

const depth = p => p.split('/').filter(Boolean).length;

// The entrance motion for a path change: 'up' | 'push' | 'pop' | 'fade', or
// null for no animation (first paint, or a store-driven re-render of the
// same path, which must never replay a transition).
export function transitionFor(prev, next, prevTab, nextTab) {
  if (!prev || prev === next) return null;
  if (MODAL_RE.test(next) && !MODAL_RE.test(prev)) return 'up';
  if (MODAL_RE.test(prev) && !MODAL_RE.test(next)) return 'fade';
  if (prevTab !== nextTab) return 'fade';
  if (depth(next) > depth(prev)) return 'push';
  if (depth(next) < depth(prev)) return 'pop';
  return 'fade';
}
