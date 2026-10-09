// Minimal hand-drawn SVG icon set (stroke-based, inherits currentColor).

const PATHS = {
  feed: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  stats: '<path d="M5 20v-9M12 20V5M19 20v-6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  reports: '<path d="M6 21V4M6 4h11.5L15 8l2.5 4H6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  filter: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  table: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 19.5c.9-3.5 3.5-5.2 6.5-5.2s5.6 1.7 6.5 5.2"/>',
  pin: '<path d="M12 21s-6.5-5.5-6.5-10.2a6.5 6.5 0 1 1 13 0C18.5 15.5 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  play: '<path d="M8 5.5l10.5 6.5L8 18.5z"/>',
  stack: '<path d="M12 3.5l8.5 4.5L12 12.5 3.5 8z"/><path d="M3.5 13L12 17.5 20.5 13"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  note: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
  hand: '<rect x="3" y="7" width="11" height="13.5" rx="2"/><path d="M17.5 8.5l3 1-3.4 11-5.6-1.6"/>',
  cash: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/>',
  trophy: '<path d="M7 4h10v3.5a5 5 0 0 1-10 0z"/><path d="M7 5.5H4A3.5 3.5 0 0 0 7.5 9M17 5.5h3A3.5 3.5 0 0 1 16.5 9"/><path d="M12 12.5V16m-3.5 4h7"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M15.5 12.5h5.5"/>',
  users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M15.5 6a3 3 0 0 1 0 5.4M17.5 14.7c1.6.6 2.7 1.9 3.2 4.3"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
  bars: '<path d="M5 20v-6M10 20V9M15 20v-9M20 20V6"/>',
  line: '<path d="M3.5 17l5-6 4 3.5 7.5-9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
};

export function icon(name, cls = '') {
  const p = PATHS[name] || '';
  const c = cls ? `icon ${cls}` : 'icon';
  return `<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
