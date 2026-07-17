// Verifies: game code + name reclaims a seat from a "new browser" (no saved
// token), even mid-game, restoring the same player id, role and host status.
import WebSocket from 'ws';

const BASE = 'http://localhost:8799';
const WSBASE = 'ws://localhost:8799';

function connect(code, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSBASE}/api/ws?code=${code}`);
    const p = { ws, state: null, knowledge: null, identity: null, errors: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'identity') p.identity = m;
      if (m.type === 'state') { p.state = m.state; p.knowledge = m.knowledge; if (!p._ready) { p._ready = true; resolve(p); } }
      if (m.type === 'error') { p.errors.push(m.message); if (!p._ready) reject(new Error(m.message)); }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout ' + JSON.stringify(hello))), 8000);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const act = (p, action, data = {}) => p.ws.send(JSON.stringify({ type: 'action', action, data }));
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

// Create + fill a 6-player game and start it.
const created = await (await fetch(`${BASE}/api/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Alice' }) })).json();
const code = created.gameCode;
const host = await connect(code, { playerId: created.playerId, token: created.token });
const players = { Alice: host };
for (const n of ['Bob', 'Carl', 'Dave', 'Erin', 'Fran']) { players[n] = await connect(code, { name: n }); await wait(40); }
await wait(150);
act(host, 'start'); await wait(200);
check('game started', host.state.phase === 'team_selection');

// Capture Bob's original id + secret role BEFORE reclaiming.
const bobId = players.Bob.identity.playerId;
const bobRole = players.Bob.knowledge.role;
console.log(`    Bob id=${bobId} role=${bobRole}`);

// --- New browser reclaims Bob's seat with ONLY name + code (no token) ---
const bobNewDevice = await connect(code, { name: 'Bob' });
await wait(150);
check('reclaim: same player id returned', bobNewDevice.identity.playerId === bobId);
check('reclaim: got a fresh token', !!bobNewDevice.identity.token && bobNewDevice.identity.token !== created.token);
check('reclaim: state myId is Bob', bobNewDevice.state.myId === bobId);
check('reclaim: same secret role restored', bobNewDevice.knowledge.role === bobRole);
check('reclaim: not flagged host', bobNewDevice.identity.isHost === false);

// --- New browser reclaims the HOST seat by name mid-game ---
const aliceNewDevice = await connect(code, { name: 'Alice' });
await wait(120);
check('reclaim host: same host id', aliceNewDevice.identity.playerId === created.playerId);
check('reclaim host: isHost true', aliceNewDevice.identity.isHost === true);

// --- A brand-new name mid-game is still rejected ---
let rejected = false;
try { await connect(code, { name: 'Zoe' }); } catch (e) { rejected = /already started/i.test(e.message); }
check('new name mid-game rejected', rejected);

// --- Reclaimed Bob can act as Bob: if on a proposed team he can quest-vote ---
const leaderId = host.state.players[host.state.leaderIndex].id;
const leader = Object.values(players).find(p => p.identity.playerId === leaderId)
  || (leaderId === bobId ? bobNewDevice : null);
const size = host.state.questSizes[0];
// Build a team that includes Bob.
const team = [bobId, ...host.state.players.map(p => p.id).filter(id => id !== bobId)].slice(0, size);
if (leader) {
  act(leader, 'propose', { team }); await wait(150);
  if (host.state.phase === 'team_vote') {
    // everyone approves
    for (const p of [...Object.values(players), bobNewDevice].filter(p => p !== players.Bob)) { act(p, 'vote', { approve: true }); await wait(30); }
    await wait(150);
    act(host, 'continueFromVote'); await wait(150);
    bobNewDevice.errors = [];
    act(bobNewDevice, 'questVote', { success: true }); await wait(150);
    check('reclaimed Bob acts as Bob (quest vote accepted)', bobNewDevice.errors.length === 0);
  } else { console.log('    (skipped act-as-Bob: leader could not propose)'); }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
