// D11: the attention sound beeps exactly once per new decision point and never
// on mere re-broadcasts. AudioContext is stubbed; beeps counted via oscillators.
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

const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: `${BASE}/`,
  beforeParse(w) {
    w.WebSocket = WebSocket;
    w.fetch = (u, o) => fetch(u.startsWith('http') ? u : BASE + u, o);
    w.alert = () => {}; w.confirm = () => true;
    // Stub WebAudio: count beeps by oscillator creation, contexts by ctor.
    w.__beeps = 0; w.__ctxCount = 0;
    w.AudioContext = class {
      constructor() { w.__ctxCount++; this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() {}
      createOscillator() {
        w.__beeps++;
        return { connect() {}, start() {}, stop() {}, frequency: {} };
      }
      createGain() {
        return { connect() {}, gain: { value: 0, exponentialRampToValueAtTime() {} } };
      }
    };
  }
});
const w = dom.window;
await wait(30);

// Host creates; 5 raw players fill the lobby.
w.document.getElementById('host-name').value = 'Alice';
w.createGame();
let session = null;
for (let i = 0; i < 50 && !session; i++) {
  await wait(150);
  session = w.sessionStorage.getItem('mightymen_game');
}
if (!session) throw new Error('createGame never settled');
const code = JSON.parse(session).code;
const players = {};
for (const n of ['Bob', 'Carl', 'Dave', 'Erin', 'Fran']) {
  players[n] = await rawConnect(code, { name: n });
  await wait(40);
}
await wait(300);
check('no beeps in the lobby', w.__beeps === 0);

// Start → team_selection. (If Alice drew leader this beeps once; record it.)
w.doAction('start');
await wait(500);
const afterStart = w.__beeps;
const anyRaw = players.Carl;
const leaderId = anyRaw.state.players[anyRaw.state.leaderIndex].id;
const leaderRaw = Object.values(players).find(p => p.identity?.playerId === leaderId);
check('team_selection: beep count sane (0 or 1)', afterStart === 0 || afterStart === 1);

// Propose → team_vote: host hasn't voted → exactly +1.
const team = anyRaw.state.players.slice(0, 3).map(p => p.id);
if (leaderRaw) act(leaderRaw, 'propose', { team });
else w.doAction('propose', { team });
await wait(500);
check('entering team_vote beeps once', w.__beeps === afterStart + 1);
const afterVotePrompt = w.__beeps;

// A re-broadcast (player drops + reclaims) must NOT re-beep.
players.Fran.ws.terminate();
await wait(600);
players.Fran = await rawConnect(code, { name: 'Fran' });
await wait(600);
check('re-broadcasts do not re-beep', w.__beeps === afterVotePrompt);

// Host votes → no new beep (no longer their turn).
w.doAction('vote', { approve: true });
await wait(300);
check('own vote does not beep', w.__beeps === afterVotePrompt);

// Everyone else votes → vote_result; host is host → +1 (continue prompt).
for (const n of ['Bob', 'Carl', 'Dave', 'Erin', 'Fran']) { act(players[n], 'vote', { approve: true }); await wait(50); }
await wait(500);
check('vote_result beeps the host once', w.__beeps === afterVotePrompt + 1);

// Shared AudioContext: many beeps, one context.
check('one shared AudioContext across all beeps', w.__ctxCount === 1);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
