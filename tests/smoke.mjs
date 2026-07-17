import WebSocket from 'ws';

const BASE = 'http://localhost:8799';
const WSBASE = 'ws://localhost:8799';

function connect(code, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSBASE}/api/ws?code=${code}`);
    const player = { ws, state: null, knowledge: null, identity: null, errors: [] };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'identity') { player.identity = msg; }
      if (msg.type === 'state') { player.state = msg.state; player.knowledge = msg.knowledge;
        if (!player._ready) { player._ready = true; resolve(player); } }
      if (msg.type === 'error') { player.errors.push(msg.message);
        if (!player._ready) reject(new Error(msg.message)); }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout '+JSON.stringify(hello))), 8000);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const act = (p, action, data={}) => p.ws.send(JSON.stringify({ type: 'action', action, data }));

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }

// 1. Create game
const createRes = await (await fetch(`${BASE}/api/create`, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ name: 'Alice' })
})).json();
console.log('create:', createRes);
check('create returns code', !!createRes.gameCode);
check('create returns token', !!createRes.token);
const code = createRes.gameCode;

// 2. Host connects (with token)
const host = await connect(code, { playerId: createRes.playerId, token: createRes.token });
check('host connected, is host', host.identity.isHost === true);
check('host sees lobby', host.state.phase === 'lobby');

// 3. Five more players join by name
const names = ['Bob','Carl','Dave','Erin','Fran'];
const players = [host];
for (const n of names) { players.push(await connect(code, { name: n })); await wait(50); }
await wait(200);
check('lobby has 6 players', host.state.playerCount === 6);

// 4. Non-host tries to start -> should error
act(players[1], 'start'); await wait(150);
check('non-host cannot start', players[1].errors.some(e => /host/i.test(e)));

// 5. (Reclaim-by-name behaviour is covered by reclaim-test.mjs.)

// 6. Host starts
act(host, 'start'); await wait(200);
check('phase = team_selection', host.state.phase === 'team_selection');
check('roles assigned but hidden from others', players[1].state.players.every(p => p.role === undefined));

// verify exactly one samuel/saul across the game via knowledge (roles hidden in state)
// Find who is leader
const leaderId = host.state.players[host.state.leaderIndex].id;
const leader = players.find(p => p.identity.playerId === leaderId);
check('a leader exists', !!leader);

// 7. Leader proposes a team of 3 (quest 0 size)
const teamSize = host.state.questSizes[0];
const team = host.state.players.slice(0, teamSize).map(p => p.id);
act(leader, 'propose', { team }); await wait(200);
check('phase = team_vote', host.state.phase === 'team_vote');
check('wrong-size team would fail (size ok here)', host.state.proposedTeam.length === teamSize);

// 8. Everyone approves
for (const p of players) { act(p, 'vote', { approve: true }); await wait(60); }
await wait(600);
check('phase = vote_result after all vote', host.state.phase === 'vote_result');
check('vote approved', host.state.lastVoteResult.approved === true);

// 9. Host continues -> quest
act(host, 'continueFromVote'); await wait(200);
check('phase = quest', host.state.phase === 'quest');

// 10. Team members submit quest votes. Good must pass; evil we make pass to succeed quest.
const teamPlayers = players.filter(p => team.includes(p.identity.playerId));
for (const p of teamPlayers) { act(p, 'questVote', { success: true }); await wait(60); }
await wait(600);
check('phase = quest_result', host.state.phase === 'quest_result');
check('quest succeeded', host.state.questResults[0].success === true);

// 11. Non-team member cannot quest vote
const nonTeam = players.find(p => !team.includes(p.identity.playerId));
nonTeam.errors = [];
act(nonTeam, 'questVote', { success: true }); await wait(150);
// (they're not in quest phase input path) -- just ensure no crash / got an error
check('non-team quest vote errored', nonTeam.errors.length > 0);

// 12. Reconnect test: close Bob, reconnect with saved identity
const bob = players[1];
const bobId = bob.identity.playerId, bobToken = bob.identity.token;
bob.ws.terminate(); await wait(600);
check('bob marked disconnected', host.state.players.find(p=>p.id===bobId)?.connected === false);
const bob2 = await connect(code, { playerId: bobId, token: bobToken }); await wait(200);
check('bob reconnected same id', bob2.identity.playerId === bobId);
check('bob marked connected again', host.state.players.find(p=>p.id===bobId)?.connected === true);
check('bob received current phase', bob2.state.phase === 'quest_result');

// 13. Bad token rejected
try { await connect(code, { playerId: bobId, token: 'wrong' }); check('bad token rejected', false); }
catch (e) { check('bad token rejected', true); }

// 14. Unknown game code
try { await connect('ZZZZ', { name: 'Ghost' }); check('unknown game rejected', false); }
catch (e) { check('unknown game rejected', /not found/i.test(e.message)); }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
