// Loads the real index.html + ws-transport.js in jsdom against wrangler dev.
// Simulates a browser "refresh" by carrying a tab's storage across a new page
// load, and verifies: the "You" badge, host-keeps-host, join, and that
// auto-reconnect on load restores the player without duplicating them.
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

// Build a "browser tab": jsdom with WebSocket/fetch injected and optional
// pre-seeded storage (to model a refresh carrying sessionStorage+localStorage).
function makeTab(storage) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}/`,
    beforeParse(window) {
      window.WebSocket = WebSocket;
      window.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
      window.alert = (m) => console.log('    [alert]', m);
      window.confirm = () => true;
      window.addEventListener('error', (e) => console.log('    [window error]', e.message || e.error));
      window.addEventListener('unhandledrejection', (e) => console.log('    [unhandled]', e.reason && e.reason.message));
      if (storage) {
        for (const [k, v] of Object.entries(storage.local || {})) window.localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(storage.session || {})) window.sessionStorage.setItem(k, v);
      }
    }
  });
  return dom;
}
function snapshot(w) {
  const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i)); return o; };
  return { local: dump(w.localStorage), session: dump(w.sessionStorage) };
}
function youName(w) {
  const items = [...w.document.querySelectorAll('#lobby-players .player-item')];
  const mine = items.find(li => li.querySelector('.player-badge.you'));
  return mine ? mine.querySelector('.player-name').textContent.trim() : null;
}
function hostControlsVisible(w) {
  const el = w.document.getElementById('host-controls');
  return el && !el.classList.contains('hidden');
}

// --- Host creates a game ---
const hostTab = makeTab(null);
await wait(30);
hostTab.window.document.getElementById('host-name').value = 'Alice';
hostTab.window.createGame();
await wait(1200);
check('host: "You" badge on Alice', youName(hostTab.window) === 'Alice');
check('host: host controls visible', hostControlsVisible(hostTab.window));
const code = JSON.parse(hostTab.window.sessionStorage.getItem('mightymen_game')).code;
check('host: game code captured', !!code);
const hostStorage = snapshot(hostTab.window);

// --- A second browser joins as Bob ---
const bobTab = makeTab(null);
await wait(30);
bobTab.window.document.getElementById('join-code').value = code;
bobTab.window.document.getElementById('join-name').value = 'Bob';
bobTab.window.joinGame();
await wait(1300);
check('bob: "You" badge on Bob', youName(bobTab.window) === 'Bob');
check('bob: NOT host', !hostControlsVisible(bobTab.window));
const bobStorage = snapshot(bobTab.window);

// --- Bob refreshes (new page load, same tab storage) -> auto-reconnect ---
const bobRefresh = makeTab(bobStorage);
await wait(1500);
check('bob refresh: auto-reconnected to lobby (not home)', !bobRefresh.window.document.getElementById('screen-lobby').classList.contains('hidden'));
check('bob refresh: "You" still on Bob', youName(bobRefresh.window) === 'Bob');

// --- Host refreshes -> must still be host, not a new player ---
const hostRefresh = makeTab(hostStorage);
await wait(1500);
check('host refresh: "You" still on Alice', youName(hostRefresh.window) === 'Alice');
check('host refresh: still host', hostControlsVisible(hostRefresh.window));

// --- Server must still see exactly TWO players (no duplicates from refreshes) ---
const created = await (await fetch(`${BASE}/api/create`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:'probe'}) })).json();
// Re-read Alice's view via the host tab's live state:
const players = [...hostRefresh.window.document.querySelectorAll('#lobby-players .player-item .player-name')].map(e => e.textContent.trim()).sort();
console.log('    host refresh sees players:', players);
check('exactly Alice + Bob in lobby (no dup)', JSON.stringify(players) === JSON.stringify(['Alice','Bob']));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
