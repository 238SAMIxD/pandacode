// Renders the six App Store screenshots at 1320x2868.
// Run from the repo root: node docs/app-store/mockups/render.mjs
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'screenshots');
const names = ['01-inbox', '02-task', '03-approval', '04-working', '05-new-task', '06-settings'];

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1320, height: 2868 }, deviceScaleFactor: 1 });
for (const [i, name] of names.entries()) {
  await page.goto(`${pathToFileURL(path.join(here, 'index.html'))}?${i + 1}`);
  await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(img => img.decode())]));
  await page.screenshot({ path: path.join(out, `${name}.png`), omitBackground: false });
  console.log(`${name}.png`);
}
await browser.close();
