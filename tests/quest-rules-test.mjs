// Verifies two related fixes reported after a play session where a quest
// passed and nobody understood why:
//   1. No quest can ever require the WHOLE table (max team size = players - 1),
//      so team selection always leaves genuine choice in who to pick.
//   2. Every screen involved in a quest (selection, vote, the quest itself, and
//      the result) explains in words what it takes to pass/fail it.
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
    const p = { ws, state: null, identity: null, errors: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'identity') p.identity = m;
      if (m.type === 'state') { p.state = m.state; if (!p._ready) { p._ready = true; resolve(p); } }
      if (m.type === 'error') { p.errors.push(m.message); if (!p._ready) reject(new Error(m.message)); }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout ' + JSON.stringify(hello))), 8000);
  });
}
const act = (p, action, data = {}) => p.ws.send(JSON.stringify({ type: 'action', action, data }));

// ============ Part 1: quest sizes never equal the full player count ============

const created = await (await fetch(`${BASE}/api/create`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Alice' })
})).json();
const code = created.gameCode;
const host = await connect(code, { playerId: created.playerId, token: created.token });
const players = [host];
for (const n of ['Bob', 'Carl', 'Dave', 'Erin', 'Fran']) { players.push(await connect(code, { name: n })); await wait(40); }
await wait(150);
check('exactly 6 players (the minimum)', host.state.playerCount === 6);

act(host, 'start');
await wait(200);
check('game started', host.state.phase === 'team_selection');

console.log('    questSizes for 6 players:', host.state.questSizes);
check('no quest requires all 6 players', host.state.questSizes.every(size => size < 6));
check('sizes still capped at population-1 (5) where the standard size was 6',
  host.state.questSizes[3] === 5 && host.state.questSizes[4] === 5);
check('smaller quests unaffected (population-1 exceeds their standard size)',
  host.state.questSizes[0] === 3 && host.state.questSizes[1] === 4 && host.state.questSizes[2] === 5);

// A leader trying to propose all 6 players on quest 4 must be rejected, and a
// team of 5 (the new effective size) must be accepted.
const leaderId = host.state.players[host.state.leaderIndex].id;
const leader = players.find(p => p.identity.playerId === leaderId);
const allSix = host.state.players.map(p => p.id);
leader.errors = [];
act(leader, 'propose', { team: allSix });
await wait(200);
check('proposing the whole table is rejected', leader.errors.some(e => /exactly 3 players/i.test(e)));
check('did not advance to team_vote', host.state.phase === 'team_selection');

const teamOfThree = allSix.slice(0, 3);
act(leader, 'propose', { team: teamOfThree });
await wait(200);
check('correctly-sized team (3) is accepted', host.state.phase === 'team_vote');
check('proposed team really is only 3', host.state.proposedTeam.length === 3);

// ============ Part 2: rule explanations render on every relevant screen ============

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

w.document.getElementById('host-name').value = 'Zara';
w.createGame();
let session = null;
for (let i = 0; i < 50 && !session; i++) { await wait(150); session = w.sessionStorage.getItem('mightymen_game'); }
if (!session) throw new Error('createGame never settled');
const code2 = JSON.parse(session).code;

const raw = {};
for (const n of ['P2', 'P3', 'P4', 'P5', 'P6']) { raw[n] = await connect(code2, { name: n }); await wait(40); }
await wait(300);

w.doAction('start');
await wait(500);

const phaseHtml = () => w.document.getElementById('phase-content').innerHTML;

// Quest 1 (index 0): fail requirement is 1 -> the "even 1 Fail vote" wording.
check('team selection explains the rule (quest 1)',
  /needs.*3.*player/i.test(phaseHtml()) && /even 1 Fail vote/i.test(phaseHtml()));

// Whoever is leader proposes; advance to team_vote and check the rule shows there too.
const anyState = raw.P2.state;
const leaderId2 = anyState.players[anyState.leaderIndex].id;
const leaderRaw = Object.values(raw).find(p => p.identity?.playerId === leaderId2);
const team2 = anyState.players.slice(0, 3).map(p => p.id);
if (leaderRaw) act(leaderRaw, 'propose', { team: team2 });
else w.doAction('propose', { team: team2 });
await wait(500);
check('team vote screen explains the rule', /even 1 Fail vote/i.test(phaseHtml()));

// Approve unanimously -> quest phase; rule text must still be visible there.
w.doAction('vote', { approve: true });
for (const n of Object.keys(raw)) { act(raw[n], 'vote', { approve: true }); await wait(40); }
await wait(400);
w.doAction('continueFromVote');
await wait(400);
check('quest phase explains the rule', /even 1 Fail vote/i.test(phaseHtml()));

// Everyone on the team plays success -> quest_result explains WHY it passed.
// Zara (the UI tab) submits via the UI if she's on the team; every other team
// member is a raw socket. (Note: index.html's top-level `let playerId` is a
// script-scope binding, NOT a window property, in a classic <script> tag —
// read her id back out of the session she saved instead of `w.playerId`.)
const zaraId = JSON.parse(w.sessionStorage.getItem('mightymen_game')).playerId;
if (team2.includes(zaraId)) {
  w.doAction('questVote', { success: true });
}
for (const id of team2) {
  if (id === zaraId) continue;
  const p = Object.values(raw).find(p => p.identity?.playerId === id);
  if (p) { act(p, 'questVote', { success: true }); await wait(50); }
}
await wait(600);
check('quest result explains why it passed', /0 Fail votes played.*1 is needed to fail.*succeeded/i.test(phaseHtml()));

// ============ Part 3: the exact confusion that was reported ============
// "Quest 4" (index 3) needs 2 Fail votes, not 1 — the standard Avalon twist
// that caused the original "why did that pass?!" moment. Call the render
// helpers directly with a synthetic quest-4 state to check the wording without
// having to play four quests through raw sockets.

const quest4State = {
  currentQuest: 3,
  questSizes: [3, 4, 5, 5, 5],
  questFailRequirements: [1, 1, 1, 2, 1]
};
const ruleHtml = w.questRuleMessage(quest4State);
check('quest 4 rule explains 2 fails are needed', /2 Fail votes/i.test(ruleHtml));
check('quest 4 rule explicitly says 1 fail will NOT fail it', /single Fail will.*not.*fail it/i.test(ruleHtml));

// The reported scenario: exactly 1 Fail vote on a quest needing 2 -> succeeds,
// and the explanation must say so instead of leaving players guessing.
const passedDespiteOneFail = w.questResultExplanation({ success: true, failCount: 1 }, 2);
check('1 fail (of 2 needed) explained as a success',
  /1 Fail vote played.*2 are needed to fail.*succeeded/i.test(passedDespiteOneFail));

// And the mirror case: 2 fails on that same quest actually fails it.
const failedWithTwo = w.questResultExplanation({ success: false, failCount: 2 }, 2);
check('2 fails (of 2 needed) explained as a failure',
  /2 Fail votes played.*2 are needed to fail.*failed/i.test(failedWithTwo));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
