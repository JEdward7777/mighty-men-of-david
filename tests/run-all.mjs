// Test runner: boots `wrangler dev` (or reuses one already running on the
// port), runs every suite sequentially, prints a summary, and exits nonzero if
// anything failed.
//
//   npm test               run everything
//   npm test -- smoke      run only suites whose name contains "smoke"
//
// The suites are end-to-end: real WebSockets against the real Worker + Durable
// Object, and the jsdom ones load the real index.html.
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Roughly fast-to-slow; pure-WebSocket suites first, jsdom UI suites after.
const SUITES = [
  'smoke',
  'name-test',
  'reclaim-test',
  'kick-test',
  'multitab-test',
  'refresh-test',
  'leave-test',
  'kick-ui-test',
  'heartbeat-test',
  'send-fail-test',
  'away-test',
  'sound-test',
  'rejoin-retry-test',
  'selection-test',   // slowest: replays games until the host draws leader
];

const filter = process.argv[2];
const suites = filter ? SUITES.filter((s) => s.includes(filter)) : SUITES;
if (suites.length === 0) {
  console.error(`No suites match "${filter}". Available: ${SUITES.join(', ')}`);
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp() {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

let wrangler = null;

async function startServer() {
  if (await serverUp()) {
    console.log(`Reusing dev server already running on :${PORT}\n`);
    return;
  }
  console.log(`Starting wrangler dev on :${PORT} ...`);
  wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], {
    cwd: path.resolve(TESTS_DIR, '..'),
    stdio: 'ignore',
    detached: true, // own process group, so we can kill workerd children too
  });
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    if (await serverUp()) {
      console.log('Server ready.\n');
      return;
    }
  }
  throw new Error('wrangler dev did not become ready within 60s');
}

function stopServer() {
  if (!wrangler) return; // we reused an external server; leave it alone
  try {
    process.kill(-wrangler.pid, 'SIGTERM'); // kill the whole process group
  } catch { /* already gone */ }
}

process.on('SIGINT', () => { stopServer(); process.exit(130); });

await startServer();

const results = [];
for (const suite of suites) {
  const file = path.join(TESTS_DIR, `${suite}.mjs`);
  process.stdout.write(`── ${suite} `.padEnd(28, '─') + '\n');
  const started = Date.now();
  const run = spawnSync('node', [file], {
    stdio: 'inherit',
    timeout: 300_000,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = run.status === 0;
  results.push({ suite, ok, seconds });
  console.log('');
}

stopServer();

console.log('══════════ summary ══════════');
let failed = 0;
for (const r of results) {
  console.log(` ${r.ok ? '✓' : '✗'} ${r.suite.padEnd(20)} ${r.seconds}s`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} suites passed`);
process.exit(failed ? 1 : 0);
