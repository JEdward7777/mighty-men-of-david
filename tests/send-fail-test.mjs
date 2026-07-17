// D6: an action sent on a dead socket must surface the disconnect and trigger
// an immediate reconnect (option 1: no queuing — the player just retries).
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import fs from 'fs';

const BASE = 'http://localhost:8799';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const src = fs.readFileSync(`${ROOT}/public/ws-transport.js`, 'utf8');
const dom = new JSDOM('<!doctype html><html></html>', { url: `${BASE}/`, runScripts: 'outside-only' });
const w = dom.window;
w.WebSocket = WebSocket;
w.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
w.eval(src);

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const host = new w.GameTransport();
const { gameCode: code } = await host.createGame('Alice');

const bob = new w.GameTransport();
const events = [];
const errors = [];
bob.onConnectionChange = (e) => events.push(e.type);
bob.onError = (m) => errors.push(m);
await bob.joinGame(code, 'Bob');
check('bob connected', bob._gotFirstState);

// Simulate a silently dead socket: not OPEN, and no close event ever fired.
// (This is the phone-lost-Wi-Fi-mid-tap case.)
const fakeDead = { readyState: WebSocket.CLOSED, close() {}, send() { throw new Error('dead'); } };
const realSocket = bob.ws;
realSocket.onclose = null; realSocket.onmessage = null; // orphan the real one quietly
realSocket.terminate();
bob.ws = fakeDead;

// Player taps a button.
bob.doAction('start'); // any action; delivery is what we're testing
check('D6: tap on dead socket surfaced as disconnect', events.includes('disconnected-from-host'));

// Recovery should kick in immediately (visibility-check path, attempt reset).
await wait(2500);
check('D6: reconnected after failed send', !!bob.ws && bob.ws !== fakeDead && bob.ws.readyState === WebSocket.OPEN);
check('D6: reconnect event emitted', events.filter(t => t === 'connected-to-host').length >= 2);

// A retry now actually reaches the server: non-host 'start' must come back
// with the host-only error — proof of end-to-end delivery.
bob.doAction('start');
await wait(400);
check('D6: retried action reached the server', errors.some(m => /only the host/i.test(m)));

[host, bob].forEach(t => t.destroy());
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
