import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const errors = [];
const ignorable = (t) => /steamstatic|steampowered|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(t);

const startHarness = (scenario) => new Promise((resolve, reject) => {
  const p = spawn('node', [path.join(here, 'harness.mjs')], { cwd: ROOT, env: { ...process.env, SCENARIO: scenario }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => { if (String(d).includes('harness on')) resolve(p); });
  p.stderr.on('data', (d) => { const s = String(d); if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) reject(new Error(s)); });
  setTimeout(() => reject(new Error(`harness (${scenario}) did not start`)), 8000);
});

const browser = await chromium.launch({ executablePath: CHROME });

async function shoot(scenario, jobs) {
  const proc = await startHarness(scenario);
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 2 });
  page.on('console', (m) => { if (m.type() === 'error' && !ignorable(m.text())) errors.push(`[${scenario}] console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${scenario}] pageerror: ${e.message}`));

  await page.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const out = await jobs(page);

  await page.close();
  proc.kill();
  await new Promise((r) => setTimeout(r, 350));
  return out;
}

// ── signed out ──────────────────────────────────────────────────────────────
await shoot('anon', async (page) => {
  await page.screenshot({ path: path.join(ROOT, 'shots', 'landing.png'), fullPage: true });
  console.log('shot: landing');
});

// ── signed in, no groups ────────────────────────────────────────────────────
await shoot('fresh', async (page) => {
  await page.screenshot({ path: path.join(ROOT, 'shots', 'onboard.png') });
  console.log('shot: onboard');
});

// ── in a group, nothing claimed ─────────────────────────────────────────────
await shoot('claim', async (page) => {
  await page.screenshot({ path: path.join(ROOT, 'shots', 'claim.png') });
  console.log('shot: claim');
});

// ── full app, two groups ────────────────────────────────────────────────────
const checks = await shoot('member', async (page) => {
  for (const [view, full] of [['queue', false], ['next', true], ['library', true], ['stats', true], ['members', true]]) {
    await page.click(`.tab[data-view="${view}"]`);
    await page.waitForTimeout(650);
    await page.screenshot({ path: path.join(ROOT, 'shots', `${view}.png`), fullPage: full });
    console.log(`shot: ${view}`);
  }

  // group switcher open
  await page.click('#group-btn');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(ROOT, 'shots', 'switcher.png'), clip: { x: 0, y: 0, width: 800, height: 340 } });
  console.log('shot: switcher');

  // switch to the second group and confirm the data actually changes
  await page.click('#group-menu .group-item:not(.is-current)');
  await page.waitForTimeout(900);
  const second = await page.evaluate(() => ({
    group: document.querySelector('#group-name')?.textContent,
    hash: location.hash,
    rows: document.querySelectorAll('#lib-table tbody tr').length,
  }));
  await page.click('.tab[data-view="library"]');
  await page.waitForTimeout(500);
  const secondLib = await page.evaluate(() =>
    [...document.querySelectorAll('#lib-table tbody tr td:first-child')].map((t) => t.textContent.trim()));

  // back to group one
  await page.goto('http://127.0.0.1:4321/#/g/g4m1ng/library', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const first = await page.evaluate(() => ({
    group: document.querySelector('#group-name')?.textContent,
    rows: document.querySelectorAll('#lib-table tbody tr').length,
    headers: [...document.querySelectorAll('#lib-table th.c-p')].map((t) => t.textContent),
    queue: document.querySelector('#queue-count')?.textContent,
  }));

  // mobile
  const m = await browser.newPage({ viewport: { width: 400, height: 880 }, deviceScaleFactor: 2 });
  await m.goto('http://127.0.0.1:4321/', { waitUntil: 'networkidle' });
  await m.waitForTimeout(800);
  await m.screenshot({ path: path.join(ROOT, 'shots', 'mobile.png') });
  await m.close();
  console.log('shot: mobile');

  return { second, secondLib, first };
});

await browser.close();

console.log('\nGroup 2 (Tuesday Trio):', JSON.stringify(checks.second));
console.log('Group 2 library      :', JSON.stringify(checks.secondLib));
console.log('Group 1 (g4m1ng)     :', JSON.stringify(checks.first));

const leaked = checks.secondLib.some((n) => /Sea of Thieves|Elden Ring|Grounded/.test(n));
console.log(leaked ? '\nLEAK: group 1 games visible in group 2' : '\nno cross-group leakage in the UI');

if (errors.length) { console.log('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('no console/page errors');
