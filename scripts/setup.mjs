#!/usr/bin/env node
/**
 * One-command Cloudflare setup.
 *
 *   npm run setup
 *
 * Creates the Pages project and the D1 database, wires the binding into
 * wrangler.toml, applies the schema, sets the secrets, and deploys.
 *
 * Safe to re-run: every step checks for existing state first, so if a step
 * fails you can fix the cause and run it again without duplicating anything.
 */
import { execSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML = path.join(ROOT, 'wrangler.toml');
const PROJECT = 'coopqueue';
const DB_NAME = 'g4m1ng';
const BRANCH = 'main';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
};
let step = 0;
const say = (msg) => console.log(`\n${c.blue(`[${++step}]`)} ${c.b(msg)}`);
const ok = (msg) => console.log(`    ${c.green('✓')} ${msg}`);
const note = (msg) => console.log(`    ${c.dim(msg)}`);
const warn = (msg) => console.log(`    ${c.yellow('!')} ${msg}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });

/**
 * Reading an answer must fail loudly. readline's `question()` never settles on a
 * closed stream, so on EOF the process would just run out of work and exit 0 —
 * a silent vanish mid-setup that looks like success. Race the close event so a
 * short answer file becomes an error instead.
 */
const ask = async (q, dflt = '') => {
  const prompt = `    ${q}${dflt ? c.dim(` [${dflt}]`) : ''} `;
  const eof = new Promise((_, reject) =>
    rl.once('close', () => reject(new Error(
      `stdin ended while waiting for: "${q}"\n` +
      '    When piping answers, supply one line per prompt.'))));
  const a = (await Promise.race([rl.question(prompt), eof])).trim();
  return a || dflt;
};
const yes = async (q) => /^y(es)?$/i.test(await ask(`${q} (y/N)`, 'n'));

/**
 * Run wrangler, returning stdout. `quiet` swallows a non-zero exit.
 *
 * stdin is withheld from the child on purpose. Handing it our own descriptor
 * lets the child drain answers meant for the prompts above — which silently
 * desynchronises every later question when setup is driven from a pipe. Only
 * `login`, which has its own interactive flow, gets the real stdin.
 */
function wrangler(args, { quiet = false, input, interactive = false } = {}) {
  const stdin = input !== undefined ? 'pipe' : interactive ? 'inherit' : 'ignore';
  try {
    return execFileSync('npx', ['wrangler', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      stdio: [stdin, 'pipe', 'pipe'],
    });
  } catch (e) {
    if (quiet) return (e.stdout || '') + (e.stderr || '');
    console.error(c.red(`\nwrangler ${args.join(' ')} failed:\n`) + (e.stdout || '') + (e.stderr || ''));
    process.exit(1);
  }
}

async function main() {
  console.log(c.b('\n  g4m1ng — Cloudflare setup\n') + c.dim('  Everything below is on the free tier. No card required.'));

  /* ── 1. account ─────────────────────────────────────────────────────── */
  say('Checking your Cloudflare login');
  let who = wrangler(['whoami'], { quiet: true });
  if (/not authenticated|you are not logged in/i.test(who)) {
    note('Opening a browser to authorise wrangler…');
    wrangler(['login'], { interactive: true });
    who = wrangler(['whoami'], { quiet: true });
  }
  const email = who.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
  ok(`Signed in${email ? ` as ${email}` : ''}`);

  /* ── 2. Pages project ───────────────────────────────────────────────── */
  say('Creating the Pages project');
  const projects = wrangler(['pages', 'project', 'list'], { quiet: true });
  if (new RegExp(`\\b${PROJECT}\\b`).test(projects)) {
    ok(`Project "${PROJECT}" already exists`);
  } else {
    wrangler(['pages', 'project', 'create', PROJECT, '--production-branch', BRANCH]);
    ok(`Created "${PROJECT}"`);
  }

  /* ── 3. D1 database ─────────────────────────────────────────────────── */
  say('Creating the D1 database');
  let toml = readFileSync(TOML, 'utf8');
  const existingId = toml.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1];

  let dbId = existingId;
  if (dbId) {
    ok(`wrangler.toml already points at ${dbId}`);
  } else {
    const list = wrangler(['d1', 'list', '--json'], { quiet: true });
    try {
      const found = JSON.parse(list.slice(list.indexOf('[')))
        .find((d) => d.name === DB_NAME);
      if (found) { dbId = found.uuid; ok(`Found existing database "${DB_NAME}"`); }
    } catch { /* no JSON, fall through to create */ }

    if (!dbId) {
      const out = wrangler(['d1', 'create', DB_NAME]);
      dbId = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
      if (!dbId) {
        console.error(c.red('\n    Could not read the database id from wrangler output.'));
        console.error(out);
        process.exit(1);
      }
      ok(`Created database ${dbId}`);
    }
    toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`);
    writeFileSync(TOML, toml);
    ok('Wrote the id into wrangler.toml');
    warn('Commit that change so Git-based deploys pick it up.');
  }

  /* ── 4. schema ──────────────────────────────────────────────────────── */
  say('Applying the schema');
  const tables = wrangler(
    ['d1', 'execute', DB_NAME, '--remote', '--json', '--command',
     "SELECT name FROM sqlite_master WHERE type='table' AND name='groups'"],
    { quiet: true });
  const hasSchema = /"name"\s*:\s*"groups"/.test(tables);

  if (hasSchema) {
    warn('Tables already exist.');
    if (await yes('Wipe and recreate them? This deletes every group and rating.')) {
      wrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--file', './schema.sql']);
      ok('Schema recreated');
    } else {
      note('Left the existing data alone.');
    }
  } else {
    wrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--file', './schema.sql']);
    ok('Schema applied');

    if (existsSync(path.join(ROOT, 'seed.sql')) &&
        await yes('Import the 92-game g4m1ng group from the old spreadsheet?')) {
      wrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--file', './seed.sql']);
      ok('Seed data imported (92 games, 232 ratings)');

      if (existsSync(path.join(ROOT, 'recommendations.sql')) &&
          await yes('Also add the 22 researched candidates to that group\'s backlog?')) {
        wrangler(['d1', 'execute', DB_NAME, '--remote', '--yes', '--file', './recommendations.sql']);
        ok('22 recommendations added — they land in everyone\'s rating queue');
      }
    }
  }

  /* ── 5. secrets ─────────────────────────────────────────────────────── */
  say('Setting secrets');
  const secret = randomBytes(32).toString('base64');
  wrangler(['pages', 'secret', 'put', 'SESSION_SECRET', '--project-name', PROJECT], { input: secret + '\n' });
  ok('SESSION_SECRET generated and stored');
  note('Rotating it later just signs everyone out; nothing is lost.');

  console.log('');
  note('A Steam Web API key is free and instant: https://steamcommunity.com/dev/apikey');
  note('It is only used for display names and avatars — you can skip it.');
  const steamKey = await ask('Steam API key (blank to skip):');
  if (steamKey) {
    wrangler(['pages', 'secret', 'put', 'STEAM_API_KEY', '--project-name', PROJECT], { input: steamKey + '\n' });
    ok('STEAM_API_KEY stored');
  } else {
    warn('Skipped — people will appear as "Player 1234" until you add it.');
  }

  const priv = await ask('Lock sign-in to specific Steam accounts? Paste comma-separated SteamID64s (blank = anyone can sign up):');
  if (priv) {
    wrangler(['pages', 'secret', 'put', 'ALLOWED_STEAM_IDS', '--project-name', PROJECT], { input: priv + '\n' });
    ok('ALLOWED_STEAM_IDS stored');
  }

  /* ── 6. deploy ──────────────────────────────────────────────────────── */
  say('Deploying');
  // --branch is not optional. Without it wrangler infers the current git branch,
  // and anything other than the production branch becomes a *preview* deploy —
  // which reads the preview environment's secrets, not the ones set above, and
  // so boots with no SESSION_SECRET while still reporting success.
  const out = wrangler(['pages', 'deploy', '--project-name', PROJECT,
                        '--branch', BRANCH, '--commit-dirty=true']);
  ok('Deployed');
  const url = `https://${PROJECT}.pages.dev`;
  note(`Production: ${url}`);

  console.log(c.green('\n  Done.\n'));
  if (url) console.log(`  ${c.b(url)}\n`);
  console.log('  Next:');
  console.log('    1. Open it and sign in through Steam.');
  console.log('    2. If you imported the seed data, claim your identity when asked.');
  console.log('    3. Group tab → Create an invite link → send it to the others.');
  console.log('    4. Backfill Steam art and trailers:');
  console.log(c.dim(`       curl -X POST ${url || 'https://YOUR-SITE.pages.dev'}/api/g/g4m1ng/enrich \\`));
  console.log(c.dim('            -H "Cookie: g4_session=..."   # from browser devtools, repeat until remaining is 0'));
  console.log('');
  console.log(c.dim('  Later: `npm run deploy` to ship changes, `npm run db:backup` for a dump.'));
  console.log('');
  rl.close();
}

main().catch((e) => { console.error(c.red(`\n${e.stack || e.message}`)); rl.close(); process.exit(1); });
