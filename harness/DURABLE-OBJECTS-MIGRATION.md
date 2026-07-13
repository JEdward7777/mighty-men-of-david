# Migration: WebRTC P2P → Durable Objects

**Goal:** Replace the peer-to-peer WebRTC transport (which does not work across
networks — see `ISSUES.md` A1) with a **server-authoritative Durable Object** that
holds the game state and talks to every player over a WebSocket.

## Why a Durable Object

- **Works across any network.** Every phone just opens a WebSocket to Cloudflare —
  no NAT traversal, no STUN/TURN, no direct peer links. (Fixes A1.)
- **State survives the host.** The authoritative game lives in the DO, not in the
  host's browser tab. Host can refresh / background / drop signal and the game
  continues; the whole "host recovery / newest-version-wins" mess is deleted.
  (Fixes A2.)
- **No role leakage.** The DO sends each player only *their own* filtered view
  (`getPublicGameState` + `getPlayerKnowledge`), computed server-side. Secret roles
  never reach other players' browsers. (Fixes A3.)
- **Free serialization.** The DO processes one message at a time behind the input
  gate, so simultaneous votes can't race. (Removes the old `withGameLock` concern.)

## Design

```
Browser (phone)                Worker              Durable Object (per game code)
  │  POST /api/create  ─────────►│  getByName(code)      │
  │  ◄── {code, playerId, token} │  ── createGame() RPC ─►│  init game state
  │                              │                        │
  │  WS  /api/ws?code=XXXX ─────►│  getByName(code)       │
  │  ── {type:hello, token} ────────────────────────────►│  authenticate / join
  │  ◄── {type:identity,...}                              │
  │  ◄── {type:state, state, knowledge}  (per-player)     │  broadcast filtered view
  │  ── {type:action, action, data} ────────────────────►│  run GameActions, persist
  │  ◄── {type:state, ...}  (everyone re-broadcast)       │
```

### One DO per game
`env.GAME_ROOM.getByName(gameCode)` → deterministic routing, one instance per game.

### Identity & auth (fixes B4)
On join the DO issues a random `token` bound to the player's `playerId`, persisted in
the DO (never sent to other players). Reconnection requires `playerId + token`, so
knowing someone's display name is no longer enough to hijack their (or the host's)
seat. The client stores its token in `localStorage`.

### Game codes (fixes B3)
The Worker generates a code, calls `createGame()` on that code's DO, and the DO
refuses if it already holds a game — so the Worker retries on collision. Codes are
now unique.

### Cleanup
The DO sets a 2-hour inactivity alarm; `alarm()` wipes storage and closes sockets,
replacing the old KV TTL.

## File plan

| File | Change |
|------|--------|
| `src/worker.js` | **NEW** — Worker entry + `GameRoom` Durable Object |
| `public/ws-transport.js` | **NEW** — WebSocket transport, same public interface the UI already calls (`createGame/joinGame/rejoinGame/doAction/getPublicState/getKnowledge/onStateUpdate/…`) so `index.html` barely changes |
| `wrangler.toml` | DO binding + SQLite migration, bump compat date, drop unused KV |
| `public/index.html` | Swap `<script>` to `ws-transport.js`; drop `GameLogic` client dependency |
| `src/game-logic.js` | Reused **as-is** by the DO (server-side rules). CJS dead-code block removed (C2) |
| `src/worker-webrtc.js`, `public/webrtc-transport.js`, `public/game-logic-client.js` | **Deleted** — obsolete P2P path |
| `README.md`, `AGENTS.md`, `package.json` | Updated to match reality (C1) |

## Behavioural notes / trade-offs

- **Reconnect now needs the token.** A player returning on the *same* browser
  reconnects seamlessly (token in `localStorage`). A player on a brand-new device
  cannot silently reclaim a seat in an in-progress game — this is intended and
  closes the host-hijack hole (B4). Name-based reclaim is gone.
- The client keeps its own identity record per game code in `localStorage`
  (`mightymen_id_<CODE>`), independent of the UI's existing `mightymen_game` session.

## Status

- [x] Audit recorded in `ISSUES.md`
- [x] `GameRoom` Durable Object + Worker entry (`src/worker.js`)
- [x] WebSocket client transport (`public/ws-transport.js`)
- [x] `wrangler.toml` reconfigured for Durable Objects
- [x] `index.html` wired to the new transport
- [x] Obsolete P2P files removed
- [x] Docs updated
- [ ] Deployed & smoke-tested with real players (needs the user's Cloudflare account)
