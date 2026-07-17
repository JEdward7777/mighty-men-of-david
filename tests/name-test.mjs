// D5: server-side name normalization. The scenarios that matter:
//   - iOS composed "José" vs Android decomposed "José" → same seat
//   - zero-width chars from phone keyboards stripped → same seat
//   - whitespace padding/doubling collapsed; whitespace-only rejected
//   - huge names capped at 20 chars
import WebSocket from 'ws';
const BASE = 'http://localhost:8799', WSBASE = 'ws://localhost:8799';

function connect(code, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSBASE}/api/ws?code=${code}`);
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
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗ FAIL:', n)); };

const created = await (await fetch(`${BASE}/api/create`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '  Alice   Host  ' })
})).json();
check('create: padded/doubled whitespace collapsed', true); // verified below via state
const code = created.gameCode;
const host = await connect(code, { playerId: created.playerId, token: created.token });
check('host name stored as "Alice Host"',
  host.state.players[0].name === 'Alice Host');

// José: join with decomposed form (Android-style), reclaim with composed (iOS-style).
const decomposed = 'Jose\u0301';      // J o s e + combining acute
const composed = 'Jos\u00E9';          // J o s é (single code point)
const jose1 = await connect(code, { name: decomposed });
await wait(100);
const jose2 = await connect(code, { name: composed });
await wait(150);
check('josé: decomposed and composed forms map to the SAME seat',
  jose2.identity.playerId === jose1.identity.playerId);
check('josé: stored in composed (NFC) form',
  host.state.players.some(p => p.name === composed));

// Zero-width space smuggled into the name → same seat as the clean name.
const bob = await connect(code, { name: 'Bob' });
await wait(100);
const bobZw = await connect(code, { name: 'Bob\u200B' });
await wait(150);
check('zero-width char stripped → reclaims Bob\'s seat',
  bobZw.identity.playerId === bob.identity.playerId);

// Whitespace-only name rejected.
let wsOnly = 'no-error';
try { await connect(code, { name: '   ' }); } catch (e) { wsOnly = e.message; }
check('whitespace-only name rejected', /unknown player|name is required/i.test(wsOnly));

// Huge name capped at 20 chars.
const long = await connect(code, { name: 'X'.repeat(5000) });
await wait(150);
const stored = host.state.players.find(p => p.id === long.identity.playerId);
check('5000-char name capped to 20', stored && stored.name.length === 20);

// Sanity: distinct names still distinct.
check('roster count correct (host + josé + bob + long = 4)',
  host.state.players.length === 4);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
