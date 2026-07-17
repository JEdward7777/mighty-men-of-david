// D1–D3 verification against wrangler dev:
//   D1: server answers raw 'ping' with 'pong'; client heartbeat detects a
//       silently-dead socket (send neutered, no pongs) and auto-reconnects.
//   D2: exercised implicitly — recovery replaces the socket and the old one's
//       events can't clobber it (guards in _connect/_teardownSocket).
//   D3: after another device reclaims a seat by name (rotating the token), the
//       dropped client reconnects via the name fallback instead of looping.
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import fs from 'fs';

const BASE = 'http://localhost:8799';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const transportSrc = fs.readFileSync(`${ROOT}/public/ws-transport.js`, 'utf8');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: `${BASE}/`, runScripts: 'outside-only'
});
const { window } = dom;
window.WebSocket = WebSocket;
window.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
window.eval(transportSrc);

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

// --- Setup: host creates a game ---
const host = new window.GameTransport();
const { gameCode: code } = await host.createGame('Alice');
check('host created game', !!code);

// --- D1a: raw ping → pong from the server (hibernation auto-response) ---
const raw = new WebSocket(`ws://localhost:8799/api/ws?code=${code}`);
const pong = await new Promise((res, rej) => {
  raw.on('open', () => raw.send('ping'));
  raw.on('message', (d) => res(d.toString()));
  raw.on('error', rej);
  setTimeout(() => rej(new Error('no pong within 3s')), 3000);
}).catch(e => `ERR:${e.message}`);
check('D1: server answers ping with pong', pong === 'pong');
raw.close();

// --- D3: reconnect survives a token rotation (seat reclaimed elsewhere) ---
const bob = new window.GameTransport();
const bobEvents = [];
bob.onConnectionChange = (e) => bobEvents.push(e.type);
await bob.joinGame(code, 'Bob');
const bobId = bob.playerId, tokenA = bob.token;
check('bob connected', !!bobId && !!tokenA);

// Another "device" reclaims Bob's seat by name → server rotates Bob's token.
const dev2 = new WebSocket(`ws://localhost:8799/api/ws?code=${code}`);
await new Promise((res, rej) => {
  dev2.on('open', () => dev2.send(JSON.stringify({ type: 'hello', name: 'Bob' })));
  dev2.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'state') res(); });
  setTimeout(() => rej(new Error('dev2 reclaim timeout')), 4000);
});

// Bob's original device now holds a STALE token. Kill its socket abruptly
// (terminate = network-style drop, fires close immediately) to force a
// reconnect — pre-fix this looped on "Unknown player" forever.
bob.ws.terminate();
await wait(3500);
check('D3: bob auto-reconnected despite rotated token', !!bob.ws && bob.ws.readyState === WebSocket.OPEN && bob._gotFirstState);
check('D3: same seat after reconnect', bob.playerId === bobId);
check('D3: client picked up the fresh token', !!bob.token && bob.token !== tokenA);
check('D3: disconnect + reconnect events emitted',
  bobEvents.includes('disconnected-from-host') &&
  bobEvents.filter(t => t === 'connected-to-host').length >= 2);
dev2.close();

// --- D1b: heartbeat detects a silently dead socket and recovers ---
const carol = new window.GameTransport();
carol._heartbeatIntervalMs = 300;  // speed up for the test
carol._heartbeatTimeoutMs = 900;
const carolEvents = [];
carol.onConnectionChange = (e) => carolEvents.push(e.type);
await carol.joinGame(code, 'Carol');
check('carol connected', carol._gotFirstState);
const deadSocket = carol.ws;
deadSocket.send = () => {}; // pings vanish; no pong ever returns — "silent death"
await wait(4500);           // stale detection (~1.2s) + backoff (~1s±jitter) + reconnect
check('D1: heartbeat presumed dead socket and reconnected',
  !!carol.ws && carol.ws !== deadSocket && carol.ws.readyState === WebSocket.OPEN);
check('D1: disconnect event emitted on silent death', carolEvents.includes('disconnected-from-host'));
await wait(800);
check('D1: pongs flowing on the replacement socket', Date.now() - carol._lastPong < 1500);

// --- Sanity: the game state is still coherent after all the churn ---
const names = (host.getPublicState().players || []).map(p => p.name).sort();
check('roster still exactly Alice/Bob/Carol', JSON.stringify(names) === JSON.stringify(['Alice', 'Bob', 'Carol']));

[host, bob, carol].forEach(t => t.destroy());
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
