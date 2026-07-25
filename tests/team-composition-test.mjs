// Verifies the lobby's "how many bad guys?" role-breakdown table: it lists
// every supported player count with the correct good/evil split, notes when
// Doeg joins (evil >= 3), and highlights the row matching the current lobby
// size as players join.
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

function connect(code, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8799/api/ws?code=${code}`);
    const p = { ws, state: null };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') { p.state = m.state; if (!p._ready) { p._ready = true; resolve(p); } }
      if (m.type === 'error' && !p._ready) reject(new Error(m.message));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 8000);
  });
}

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

const tableText = () => w.document.getElementById('team-comp-table').innerHTML;
const rowFor = (n) => {
  const html = tableText();
  const re = new RegExp(`<div class="team-comp-row([^"]*)">\\s*<span class="team-comp-count">${n} players</span>[\\s\\S]*?</div>`);
  return html.match(re);
};

// Host creates the game (1 player) — the reference table should already be
// present even below the 6-player minimum, since it's a static reference.
w.document.getElementById('host-name').value = 'Alice';
w.createGame();
let session = null;
for (let i = 0; i < 50 && !session; i++) { await wait(150); session = w.sessionStorage.getItem('mightymen_game'); }
if (!session) throw new Error('createGame never settled');
const code = JSON.parse(session).code;

check('table lists all 7 supported sizes (6-12)',
  [6, 7, 8, 9, 10, 11, 12].every(n => rowFor(n)));
check('6 players: 4 good / 2 evil, no Doeg note', /6 players.*?4 Good.*?2 Evil(?!.*incl\. Doeg)/s.test(rowFor(6)[0]));
check('7 players: 4 good / 3 evil, WITH Doeg note', /7 players.*?4 Good.*?3 Evil.*?incl\. Doeg/s.test(rowFor(7)[0]));
check('12 players: 8 good / 4 evil, WITH Doeg note', /12 players.*?8 Good.*?4 Evil.*?incl\. Doeg/s.test(rowFor(12)[0]));
check('with only 1 player, no row is highlighted as current', !/class="team-comp-row current"/.test(tableText()));

// Five more join -> 6 players -> the 6-player row should now be highlighted.
for (const n of ['Bob', 'Carl', 'Dave', 'Erin', 'Fran']) {
  await connect(code, { name: n });
  await wait(150);
}
await wait(300);
check('at 6 players, the 6-player row is highlighted', /class="team-comp-row current">\s*<span class="team-comp-count">6 players/.test(tableText()));
check('the 7-player row is NOT highlighted at 6 players', !/current">\s*<span class="team-comp-count">7 players/.test(tableText()));

// A 7th player joins -> highlight should move to the 7-player row.
await connect(code, { name: 'Greg' });
await wait(400);
check('after a 7th joins, highlight moves to the 7-player row',
  /current">\s*<span class="team-comp-count">7 players/.test(tableText()));
check('the 6-player row is no longer highlighted', !/current">\s*<span class="team-comp-count">6 players/.test(tableText()));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
