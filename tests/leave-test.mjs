// Verifies the Leave button and the "?join=<different code> wins over
// auto-reconnect" behaviour, using the real page against wrangler dev.
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

function makeTab(storage, urlSuffix = '/') {
  return new JSDOM(html, {
    runScripts: 'dangerously', url: `${BASE}${urlSuffix}`,
    beforeParse(window) {
      window.WebSocket = WebSocket;
      window.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
      window.alert = () => {};
      window.confirm = () => true;
      if (storage) {
        for (const [k, v] of Object.entries(storage.local || {})) window.localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(storage.session || {})) window.sessionStorage.setItem(k, v);
      }
    }
  });
}
function snapshot(w) {
  const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i)); return o; };
  return { local: dump(w.localStorage), session: dump(w.sessionStorage) };
}
const shown = (w, id) => !w.document.getElementById(id).classList.contains('hidden');

// --- Set up: host creates game A ---
const hostTab = makeTab(null);
await wait(30);
hostTab.window.document.getElementById('host-name').value = 'Alice';
hostTab.window.createGame();
await wait(1200);
check('in lobby after create', shown(hostTab.window, 'screen-lobby'));
const codeA = JSON.parse(hostTab.window.sessionStorage.getItem('mightymen_game')).code;
const storageA = snapshot(hostTab.window);

// --- Leave button: returns to home, clears session ---
hostTab.window.document.getElementById('btn-leave').click();
await wait(200);
check('leave: home screen shown', shown(hostTab.window, 'screen-home'));
check('leave: lobby hidden', !shown(hostTab.window, 'screen-lobby'));
check('leave: session cleared', hostTab.window.sessionStorage.getItem('mightymen_game') === null);
check('leave: code badge hidden', hostTab.window.document.getElementById('game-code-display').style.display === 'none');

// --- After leaving, a refresh must NOT pull back into the old game ---
const afterLeave = makeTab(snapshot(hostTab.window)); // storage now cleared of session
await wait(400);
check('after leave: stays on home (no auto-reconnect)', shown(afterLeave.window, 'screen-home'));

// --- ?join=<different code> wins over auto-reconnect ---
// Same tab still has game A's session, but the URL points at a different game.
const otherCode = codeA === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
const qrTab = makeTab(storageA, `/?join=${otherCode}`);
await wait(800);
check('QR to new game: does NOT auto-reconnect to old', !shown(qrTab.window, 'screen-lobby'));
check('QR to new game: home shown', shown(qrTab.window, 'screen-home'));
check('QR to new game: join code prefilled with new code', qrTab.window.document.getElementById('join-code').value === otherCode);
check('QR to new game: still offers rejoin to old game', shown(qrTab.window, 'rejoin-section'));

// --- Control: same-code URL (or none) still auto-reconnects ---
const refreshSame = makeTab(storageA, `/?join=${codeA}`);
await wait(900);
check('same-code URL: auto-reconnects to lobby', shown(refreshSame.window, 'screen-lobby'));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
