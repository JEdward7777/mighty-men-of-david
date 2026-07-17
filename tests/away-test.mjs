// D7: disconnected players are visible to everyone.
// A jsdom host tab renders the real UI; raw-ws players drive the game.
// We kill one player's socket and assert the host tab shows the Away badge and
// the "Waiting on X (disconnected)" line, then reconnect and assert they clear.
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

function rawConnect(code, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8799/api/ws?code=${code}`);
    const p = { ws, state: null, identity: null };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'identity') p.identity = m;
      if (m.type === 'state') { p.state = m.state; if (!p._ready) { p._ready = true; resolve(p); } }
      if (m.type === 'error' && !p._ready) reject(new Error(m.message));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 8000);
  });
}
const act = (p, action, data = {}) => p.ws.send(JSON.stringify({ type: 'action', action, data }));

// --- Host tab (real UI) creates the game ---
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
w.document.getElementById('host-name').value = 'Alice';
w.createGame();
await wait(1200);
const code = JSON.parse(w.sessionStorage.getItem('mightymen_game')).code;
check('host tab in lobby', !w.document.getElementById('screen-lobby').classList.contains('hidden'));

// --- Five raw players join ---
const players = {};
for (const n of ['Bob', 'Carl', 'Dave', 'Erin', 'Fran']) {
  players[n] = await rawConnect(code, { name: n });
  await wait(50);
}
await wait(400);

const lobbyHtml = () => w.document.getElementById('lobby-players').innerHTML;

// --- Lobby: kill Bob's socket → Away badge appears for everyone ---
players.Bob.ws.terminate();
await wait(800);
check('lobby: Away badge on Bob after his socket dies',
  /Bob[\s\S]*?Away/.test(lobbyHtml()));
check('lobby: Bob grayed out', lobbyHtml().includes('player-item disconnected'));
check('lobby: others not marked away', !/Carl[\s\S]{0,120}?Away/.test(lobbyHtml()));

// Reconnect Bob (name reclaim) → badge clears.
players.Bob = await rawConnect(code, { name: 'Bob' });
await wait(500);
check('lobby: badge cleared after Bob reconnects', !/Away/.test(lobbyHtml()));

// --- Start the game and reach team_vote ---
w.doAction('start');
await wait(500);
const stateNow = () => players.Carl.state; // any raw player's view
const leaderId = stateNow().players[stateNow().leaderIndex].id;
const team = stateNow().players.slice(0, 3).map(p => p.id);
const leaderRaw = Object.values(players).find(p => p.identity?.playerId === leaderId);
if (leaderRaw) act(leaderRaw, 'propose', { team });
else w.doAction('propose', { team }); // Alice (host tab) is leader
await wait(500);
check('reached team_vote', stateNow().phase === 'team_vote');

// Everyone votes except Dave; host tab votes via its own UI action.
w.doAction('vote', { approve: true });
for (const n of ['Bob', 'Carl', 'Erin', 'Fran']) { act(players[n], 'vote', { approve: true }); await wait(50); }
await wait(300);

// Kill Dave (the lone blocker) → host tab must say so.
players.Dave.ws.terminate();
await wait(800);
const phaseHtml = () => w.document.getElementById('phase-content').innerHTML;
check('vote screen: Away badge on Dave', /Dave[\s\S]*?Away/.test(phaseHtml()));
check('vote screen: "Waiting on Dave (disconnected)" line',
  /Waiting on Dave \(disconnected\)/.test(phaseHtml()));

// Dave comes back and votes → phase advances, indicators gone.
players.Dave = await rawConnect(code, { name: 'Dave' });
await wait(400);
check('vote screen: waiting line cleared on reconnect', !/disconnected\)/.test(phaseHtml()));
act(players.Dave, 'vote', { approve: true });
await wait(500);
check('phase advanced to vote_result after Dave votes', stateNow().phase === 'vote_result');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
