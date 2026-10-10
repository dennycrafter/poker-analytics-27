// Desktop layout breakpoint (STEP C). Below DESKTOP_MIN the app is the
// mobile phone column with a bottom tab bar; at or above it the shell shows a
// left sidebar and wider content. Pure apart from the matchMedia probe, so the
// sizing rules are testable in Node.

export const DESKTOP_MIN = 880;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN}px)`;

export function isDesktop() {
  return typeof matchMedia === 'function' && matchMedia(DESKTOP_QUERY).matches;
}

// SVG charts are drawn in viewBox units and scaled to their container. On a
// wide column a 340-unit chart would scale its 9-unit axis labels to ~20px and
// grow very tall, so desktop draws on a wider canvas instead. Mobile keeps the
// exact original box.
export function chartBox(width, height, { desktopWidth = 680, desktop = isDesktop() } = {}) {
  if (!desktop) return { width, height };
  return { width: desktopWidth, height: Math.round(height * 1.5) };
}

// Calls fn(isDesktop) whenever the viewport crosses the breakpoint.
export function onLayoutChange(fn) {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia(DESKTOP_QUERY);
  const handler = e => fn(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
