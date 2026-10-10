// Regenerates the display-parity golden fixtures FROM THE WEB MODULES ONLY
// (js/filters.js, js/reports.js, js/hours.js, js/backup.js, js/manage.js,
// js/seed.js). The native ports never feed into these files.
//
// Outputs are local-time dependent, so one file per timezone:
//   TZ=UTC                 tsx scripts/gen-display-golden.ts
//   TZ=Europe/Dublin       tsx scripts/gen-display-golden.ts
//   TZ=America/Los_Angeles tsx scripts/gen-display-golden.ts
// (`npm run golden:display` runs all three.)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { currentZone, forGolden, goldenPath, loadWeb, runCases } from '../tests/display-cases';

async function main(): Promise<void> {
  const web = await loadWeb();
  const path = goldenPath(currentZone());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(forGolden(runCases(web)), null, 1) + '\n');
  console.log(`wrote ${path}`);
}

main().catch(err => { console.error(err); process.exit(1); });
