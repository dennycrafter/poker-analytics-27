// Loading placeholders shown while the first cloud pull runs on a device with
// no cached copy (fresh sign-in). They mirror the real screen's rhythm (top
// bar, segmented control, 64-72px rows) so the swap to data does not jump.

const TITLES = { feed: 'Feed', stats: 'Statistics', calendar: 'Calendar', reports: 'Reports', more: 'More' };

const bar = (w, cls = '') => `<span class="skel ${cls}" style="width:${w}"></span>`;

function sessionRowSkel(i) {
  // Vary widths so the list reads as content, not a barcode.
  const title = ['62%', '54%', '70%', '58%'][i % 4];
  const sub = ['40%', '46%', '36%', '44%'][i % 4];
  return `<div class="session-row skel-row">
    <span class="date-col">${bar('26px', 'skel-xs')}${bar('22px', 'skel-md')}</span>
    <span class="mid">${bar(title)}${bar(sub, 'skel-sm')}</span>
    ${bar('56px', 'skel-md')}
  </div>`;
}

function statRowSkel(i) {
  return `<div class="stat-row skel-row">
    <span class="stat-main">${bar(['34%', '42%', '28%'][i % 3], 'skel-xs')}${bar(['46%', '38%', '52%'][i % 3], 'skel-lg')}</span>
  </div>`;
}

function listRowSkel(i) {
  return `<div class="field-row skel-row">${bar(['38%', '30%', '44%'][i % 3])}${bar(['18%', '24%', '14%'][i % 3])}</div>`;
}

function bodyFor(tab) {
  const n = Array.from({ length: 7 }, (_, i) => i);
  if (tab === 'feed') {
    return `<div class="segmented skel-seg">${[0, 1, 2, 3].map(() => '<span class="skel skel-pill"></span>').join('')}</div>
      <div class="list"><div class="month-head">${bar('96px', 'skel-xs')}${bar('52px', 'skel-xs')}</div>${n.map(sessionRowSkel).join('')}</div>`;
  }
  if (tab === 'stats') {
    return `<div class="list"><div class="month-head">${bar('48px', 'skel-xs')}</div>${n.slice(0, 6).map(statRowSkel).join('')}</div>`;
  }
  return `<div class="rows">${n.map(listRowSkel).join('')}</div>`;
}

// Full screen placeholder for a tab. aria-busy + a visually hidden status line
// tell assistive tech that content is on its way.
export function skeletonScreen(tab) {
  const title = TITLES[tab] || 'Poker Analytics 27';
  return `<div class="screen skeleton-screen" aria-busy="true">
    <header class="topbar">
      <span class="topbtn" style="visibility:hidden"></span>
      <h1>${title}</h1>
      <span class="topbtn" style="visibility:hidden"></span>
    </header>
    <p class="sr-only" role="status">Loading your sessions…</p>
    <div aria-hidden="true">${bodyFor(tab)}</div>
  </div>`;
}

// Inline single-line placeholder for small async values (e.g. account email).
export function skeletonText(width = '140px') {
  return `<span class="skel skel-inline" style="width:${width}" aria-hidden="true"></span><span class="sr-only">Loading</span>`;
}
