// Server-level: leave (lobby self-removal) and kick (host removes a player),
// plus the guard rails (non-host can't kick, host can't be removed, no leave
// once the game has started).
import WebSocket from 'ws';
const BASE = 'http://localhost:8799', WSBASE = 'ws://localhost:8799';

function connect(code, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSBASE}/api/ws?code=${code}`);
    const p = { ws, state: null, identity: null, errors: [], removed: null, closed: false };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'identity') p.identity = m;
      if (m.type === 'state') { p.state = m.state; if (!p._ready) { p._ready = true; resolve(p); } }
      if (m.type === 'error') { p.errors.push(m.message); if (!p._ready) reject(new Error(m.message)); }
      if (m.type === 'removed') p.removed = m.message;
    });
    ws.on('close', () => { p.closed = true; });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout ' + JSON.stringify(hello))), 8000);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const act = (p, action, data = {}) => p.ws.send(JSON.stringify({ type: 'action', action, data }));
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const mk = async (name) => (await (await fetch(`${BASE}/api/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json());

// --- Lobby with Alice(host), Bob, Carl ---
const created = await mk('Alice');
const code = created.gameCode;
const host = await connect(code, { playerId: created.playerId, token: created.token });
const bob = await connect(code, { name: 'Bob' }); await wait(40);
const carl = await connect(code, { name: 'Carl' }); await wait(120);
check('lobby has 3 players', host.state.players.length === 3);
const carlId = carl.identity.playerId;

// Non-host cannot kick.
bob.errors = [];
act(bob, 'kick', { targetId: carlId }); await wait(150);
check('non-host kick rejected', bob.errors.some(e => /only the host/i.test(e)));

// Host cannot be removed.
host.errors = [];
act(host, 'kick', { targetId: host.identity.playerId }); await wait(150);
console.log('    DIAG host.errors=', host.errors, 'host.closed=', host.closed, 'players=', host.state.players.length);
check('host cannot be kicked', host.errors.some(e => /host cannot/i.test(e)));

// Bob leaves → removed from roster.
act(bob, 'leave'); await wait(200);
console.log('    DIAG after leave: host.players=', host.state.players.map(p=>p.name), 'bob.errors=', bob.errors, 'host.closed=', host.closed);
check('after Bob leaves: 2 players', host.state.players.length === 2);
check('Bob gone from roster', !host.state.players.some(p => p.name === 'Bob'));

// Host kicks Carl → removed, notified, socket closed.
act(host, 'kick', { targetId: carlId }); await wait(250);
check('after kick: 1 player', host.state.players.length === 1);
check('Carl received "removed" message', !!carl.removed && /removed/i.test(carl.removed));
check('Carl socket closed by server', carl.closed);

// --- Mid-game: leave is rejected once started ---
const g2 = await mk('H');
const c2 = g2.gameCode;
const h2 = await connect(c2, { playerId: g2.playerId, token: g2.token });
const others = [];
for (const n of ['P2', 'P3', 'P4', 'P5', 'P6']) { others.push(await connect(c2, { name: n })); await wait(40); }
await wait(120);
act(h2, 'start'); await wait(200);
check('second game started', h2.state.phase === 'team_selection');
others[0].errors = [];
act(others[0], 'leave'); await wait(150);
check('leave rejected mid-game', others[0].errors.some(e => /lobby/i.test(e)));
check('still 6 players mid-game', h2.state.players.length === 6);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
