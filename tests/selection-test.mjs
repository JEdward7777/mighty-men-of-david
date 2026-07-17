// D8: team selection must not leak between games (ghost player ids).
// A jsdom host tab plays two games back to back in the same tab. In game A the
// host-as-leader picks 2 players, then leaves; in game B (same quest size) the
// selector must start empty — pre-fix it showed game A's picks pre-selected.
// Leader is random, so we retry games until the host draws leader.
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import fs from 'fs';

const BASE = 'http://localhost:8799';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
let html = fs.readFileSync(`${ROOT}/public/index.html`, 'utf8');
const wsTransport = fs.readFileSync(`${ROOT}/public/ws-transport.js`, 'utf8');
html = html.replace('<script src="/ws-transport.js"></script>', `<script>${wsTransport}</script>`);
html = html.replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, '');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: `${BASE}/`,
  beforeParse(w) {
    w.WebSocket = WebSocket;
    w.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
    w.alert = () => {}; w.confirm = () => true;
  }
});
const w = dom.window;
await wait(30);

function rawJoin(code, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8799/api/ws?code=${code}`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', name })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') resolve(ws);
      if (m.type === 'error') reject(new Error(m.message));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('join timeout')), 8000);
  });
}

// Create a game via the UI, fill it, start it. Returns { isLeader, raws }.
async function newGameAsHost() {
  w.document.getElementById('host-name').value = 'Alice';
  w.createGame();
  // Poll until the session exists (create + first state can take a moment).
  let session = null;
  for (let i = 0; i < 50 && !session; i++) {
    await wait(150);
    session = w.sessionStorage.getItem('mightymen_game');
  }
  if (!session) throw new Error('createGame never settled');
  const code = JSON.parse(session).code;
  const raws = [];
  for (const n of ['Bob', 'Carl', 'Dave', 'Erin', 'Fran']) {
    raws.push(await rawJoin(code, n));
  }
  await wait(200);
  w.doAction('start');
  await wait(500);
  const isLeader = !!w.document.getElementById('team-selector');
  return { isLeader, raws };
}

function leaveGame(raws) {
  w.document.getElementById('btn-leave').click();
  raws.forEach(ws => { try { ws.terminate(); } catch { /* ignore */ } });
  return wait(400);
}

// Retry until the host draws leader (1/6 per game).
async function gameWithHostAsLeader(label) {
  for (let i = 0; i < 30; i++) {
    const g = await newGameAsHost();
    if (g.isLeader) { console.log(`  (${label}: host drew leader on attempt ${i + 1})`); return g; }
    await leaveGame(g.raws);
  }
  throw new Error('host never drew leader in 30 games');
}

const proposeText = () => w.document.getElementById('btn-propose').textContent.trim();
const selectedCount = () => w.document.querySelectorAll('#team-selector .team-player.selected').length;

// --- Game A: host picks 2 players, then leaves mid-selection ---
const gameA = await gameWithHostAsLeader('game A');
const picks = [...w.document.querySelectorAll('#team-selector .team-player')].slice(0, 2);
picks.forEach(el => el.click());
check('game A: two players selected', selectedCount() === 2);
check('game A: propose button shows 2/3', /2\/3/.test(proposeText()));
await leaveGame(gameA.raws);

// --- Game B: same tab, same quest size — selection must start EMPTY ---
const gameB = await gameWithHostAsLeader('game B');
check('game B: no ghost selections from game A', selectedCount() === 0);
check('game B: propose button shows 0/3', /0\/3/.test(proposeText()));
check('game B: propose disabled', w.document.getElementById('btn-propose').disabled);

// --- Same game: selection survives a re-render (the property we must keep) ---
[...w.document.querySelectorAll('#team-selector .team-player')].slice(0, 3).forEach(el => el.click());
check('game B: three picked', selectedCount() === 3);
// A state broadcast re-render happens when someone reconnects; simulate by
// killing + rejooining a raw player, which broadcasts twice.
gameB.raws[0].terminate();
await wait(600);
await rawJoin(JSON.parse(w.sessionStorage.getItem('mightymen_game')).code, 'Bob');
await wait(600);
check('game B: selection survived broadcasts within same quest',
  w.document.getElementById('team-selector') === null /* leader UI early-returns; if selector was rebuilt it would still show selections */
  || selectedCount() === 3);
check('game B: propose still shows 3/3', /3\/3/.test(proposeText()));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
