// Models multiple tabs in ONE browser (shared localStorage) joining a game on the
// live wrangler dev server, using the real ws-transport.js + real WebSockets.
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import fs from 'fs';

const BASE = 'http://localhost:8799';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const transportSrc = fs.readFileSync(`${ROOT}/public/ws-transport.js`, 'utf8');

// One shared browser environment (one localStorage for all "tabs").
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${BASE}/`, runScripts: 'outside-only' });
const { window } = dom;
window.WebSocket = WebSocket;
window.fetch = (url, opts) => fetch(url.startsWith('http') ? url : BASE + url, opts);
window.eval(transportSrc); // defines window.GameTransport

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

// Replicate index.html's join handler: try rejoin first, fall back to a fresh join.
async function uiJoin(code, name) {
  const t = new window.GameTransport();
  try {
    return { t, res: await t.rejoinGame(code, name) };
  } catch (e) {
    if (e.message.includes('No player with that name')) {
      return { t, res: await t.joinGame(code, name) };
    }
    throw e;
  }
}

// Host creates the game (tab 0).
const host = new window.GameTransport();
const created = await host.createGame('Alice');
const code = created.gameCode;
check('host created game', !!code);

// Tab 1 joins as Bob, Tab 2 joins as Charlie — same browser, shared localStorage.
const bob = await uiJoin(code, 'Bob');
const charlie = await uiJoin(code, 'Charlie');
await wait(300);

const ids = [host.playerId, bob.t.playerId, charlie.t.playerId];
check('three distinct player ids', new Set(ids).size === 3);
check('Bob did not become host', bob.t.isHost === false);
check('Charlie did not become host', charlie.t.isHost === false);

const names = (host.getPublicState().players || []).map(p => p.name).sort();
console.log('    host sees players:', names);
check('host lobby shows all three names', JSON.stringify(names) === JSON.stringify(['Alice','Bob','Charlie']));

// Reconnection still works: Charlie "refreshes" (new transport, same shared storage).
const charlie2 = new window.GameTransport();
const r = await charlie2.rejoinGame(code, 'Charlie');
await wait(200);
check('Charlie reconnects to same id (not a 4th player)', charlie2.playerId === charlie.t.playerId);
check('still exactly three players after reconnect', host.getPublicState().players.length === 3);

// Cleanup
[host, bob.t, charlie.t, charlie2].forEach(t => t.destroy());
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
