// UI path for kick + lobby-leave-removal: real index.html in jsdom, real
// WebSockets to wrangler dev.
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

function makeTab() {
  return new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}/`,
    beforeParse(window) {
      window.WebSocket = WebSocket;
      window.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
      window.__alerts = [];
      window.alert = (m) => window.__alerts.push(m);
      window.confirm = () => true;
    }
  });
}
const shown = (w, id) => !w.document.getElementById(id).classList.contains('hidden');
const lobbyNames = (w) => [...w.document.querySelectorAll('#lobby-players .player-name')].map(e => e.textContent.trim()).sort();

// Host + two players in the lobby.
const host = makeTab(); await wait(30);
host.window.document.getElementById('host-name').value = 'Alice';
host.window.createGame(); await wait(1200);
const code = JSON.parse(host.window.sessionStorage.getItem('mightymen_game')).code;

async function join(name) {
  const t = makeTab(); await wait(30);
  t.window.document.getElementById('join-code').value = code;
  t.window.document.getElementById('join-name').value = name;
  t.window.joinGame(); await wait(1200);
  return t;
}
const bob = await join('Bob');
const carl = await join('Carl');
await wait(400);
check('host lobby shows all three', JSON.stringify(lobbyNames(host.window)) === JSON.stringify(['Alice', 'Bob', 'Carl']));
check('host sees Remove buttons for the two players', host.window.document.querySelectorAll('#lobby-players .kick-btn').length === 2);
check('non-host sees no Remove buttons', bob.window.document.querySelectorAll('#lobby-players .kick-btn').length === 0);

// --- Host clicks Remove on Bob ---
const bobId = bob.window.sessionStorage.getItem('mightymen_game') && JSON.parse(bob.window.sessionStorage.getItem('mightymen_game')).playerId;
const bobBtn = [...host.window.document.querySelectorAll('#lobby-players .kick-btn')].find(b => b.dataset.id === bobId);
check('found Bob\'s Remove button', !!bobBtn);
bobBtn.click();
await wait(600);
check('kicked Bob: his tab returned home', shown(bob.window, 'screen-home') && !shown(bob.window, 'screen-lobby'));
check('kicked Bob: was alerted', bob.window.__alerts.some(a => /removed/i.test(a)));
check('kicked Bob: session cleared', bob.window.sessionStorage.getItem('mightymen_game') === null);
check('host lobby now shows Alice + Carl', JSON.stringify(lobbyNames(host.window)) === JSON.stringify(['Alice', 'Carl']));

// --- Carl uses the Leave button (non-host, lobby) → removed from roster ---
carl.window.document.getElementById('btn-leave').click();
await wait(600);
check('Carl left: his tab returned home', shown(carl.window, 'screen-home'));
check('host lobby now shows only Alice', JSON.stringify(lobbyNames(host.window)) === JSON.stringify(['Alice']));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
