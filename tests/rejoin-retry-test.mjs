// D9: Gmail-style rejoin. A transient failure during auto-rejoin must KEEP the
// session and retry forever with backoff; "Retry now" skips the wait; a fatal
// rejection ("Game not found") must clear the session and stop.
// The tab talks to a local TCP proxy we can kill and resurrect to simulate the
// server disappearing.
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import net from 'net';
import fs from 'fs';

const UPSTREAM = 8799;      // wrangler dev
const PROXY = 8798;         // what the "browser" talks to
const BASE = `http://localhost:${PROXY}`;
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
let html = fs.readFileSync(`${ROOT}/public/index.html`, 'utf8');
const wsTransport = fs.readFileSync(`${ROOT}/public/ws-transport.js`, 'utf8');
html = html.replace('<script src="/ws-transport.js"></script>', `<script>${wsTransport}</script>`);
html = html.replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, '');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

// ---- Killable TCP proxy ----
let proxyServer = null;
let proxySockets = new Set();
function startProxy() {
  return new Promise((resolve) => {
    proxyServer = net.createServer((client) => {
      const up = net.connect(UPSTREAM, 'localhost');
      proxySockets.add(client); proxySockets.add(up);
      client.pipe(up); up.pipe(client);
      const drop = () => { client.destroy(); up.destroy(); proxySockets.delete(client); proxySockets.delete(up); };
      client.on('error', drop); up.on('error', drop);
      client.on('close', drop); up.on('close', drop);
    });
    proxyServer.listen(PROXY, resolve);
  });
}
function stopProxy() {
  return new Promise((resolve) => {
    for (const s of proxySockets) s.destroy();
    proxySockets.clear();
    proxyServer.close(() => resolve());
  });
}

function makeTab(storage) {
  return new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}/`,
    beforeParse(w) {
      w.WebSocket = WebSocket;
      w.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
      w.__alerts = [];
      w.alert = (m) => w.__alerts.push(m);
      w.confirm = () => true;
      if (storage) {
        for (const [k, v] of Object.entries(storage.local || {})) w.localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(storage.session || {})) w.sessionStorage.setItem(k, v);
      }
    }
  });
}
function snapshot(w) {
  const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i)); return o; };
  return { local: dump(w.localStorage), session: dump(w.sessionStorage) };
}
const bannerVisible = (w) => {
  const n = w.document.getElementById('reconnecting-notice');
  return !!n && n.style.display !== 'none';
};
const shown = (w, id) => !w.document.getElementById(id).classList.contains('hidden');

await startProxy();

// --- Setup: host + Bob through the proxy ---
const hostTab = makeTab(null);
await wait(30);
hostTab.window.document.getElementById('host-name').value = 'Alice';
hostTab.window.createGame();
await wait(1400);
const code = JSON.parse(hostTab.window.sessionStorage.getItem('mightymen_game')).code;

const bobTab = makeTab(null);
await wait(30);
bobTab.window.document.getElementById('join-code').value = code;
bobTab.window.document.getElementById('join-name').value = 'Bob';
bobTab.window.joinGame();
await wait(1400);
check('bob joined through proxy', shown(bobTab.window, 'screen-lobby'));
const bobStorage = snapshot(bobTab.window);
// (leave bobTab running; jsdom's window.close() kills the document out from
// under its own pending timers)

// --- Server "unreachable": kill the proxy, then Bob's tab reloads ---
await stopProxy();
const bobRefresh = makeTab(bobStorage);
await wait(2500); // initial attempt fails fast (refused) + first backoff cycle
check('transient failure: session KEPT', bobRefresh.window.sessionStorage.getItem('mightymen_game') !== null);
check('transient failure: banner with Retry now shown',
  bannerVisible(bobRefresh.window) && !!bobRefresh.window.document.getElementById('btn-retry-now'));
check('transient failure: no scary alert', bobRefresh.window.__alerts.length === 0);

// Let it churn a couple more cycles — still retrying, session still intact.
await wait(4000);
check('still retrying, session still intact', bobRefresh.window.sessionStorage.getItem('mightymen_game') !== null);
check('still not falsely connected', !shown(bobRefresh.window, 'screen-lobby'));

// --- Server returns; player taps "Retry now" ---
await startProxy();
bobRefresh.window.document.getElementById('btn-retry-now').click();
await wait(2000);
check('retry now: reconnected to the lobby', shown(bobRefresh.window, 'screen-lobby'));
check('retry now: banner hidden', !bannerVisible(bobRefresh.window));
check('retry now: host sees Bob connected again',
  /Bob/.test(hostTab.window.document.getElementById('lobby-players').innerHTML));

// --- Fatal case: session for a game that doesn't exist ---
const ghostStorage = { local: {}, session: { mightymen_game: JSON.stringify({ code: 'XXXX', playerId: 'p_dead', name: 'Ghost' }) } };
const ghostTab = makeTab(ghostStorage);
await wait(2500);
check('fatal: session cleared', ghostTab.window.sessionStorage.getItem('mightymen_game') === null);
check('fatal: no endless banner', !bannerVisible(ghostTab.window));
check('fatal: home screen shown', shown(ghostTab.window, 'screen-home'));

await stopProxy().catch(() => {});
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
