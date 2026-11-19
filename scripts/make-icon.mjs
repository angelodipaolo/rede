// Renders app/icon.svg to app/icon.icns (macOS) and app/icon.png with headless Chrome,
// sips and iconutil. Run it after changing the SVG: npm run app:icon
// Needs Google Chrome (or CHROME=<path>) and the playwright package (npx playwright).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'app', 'icon.svg'), 'utf8');
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
const png = path.join(root, 'app', 'icon.png');
await page.locator('svg').screenshot({ path: png, omitBackground: true });
await browser.close();

const set = fs.mkdtempSync(path.join(os.tmpdir(), 'rede-icon-')) + '/icon.iconset';
fs.mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(s), String(s), png, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'app', 'icon.icns')]);
fs.rmSync(path.dirname(set), { recursive: true, force: true });
console.log('wrote app/icon.png and app/icon.icns');
