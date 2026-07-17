# Mighty Men of David - Repository Knowledge

## Project Overview
A multiplayer social deduction game inspired by Avalon with a biblical theme. Players use their phones to join games, receive roles, and vote on quests.

## Architecture

The game is **server-authoritative** using a Cloudflare **Durable Object**.
(It previously used WebRTC peer-to-peer, which did not work across networks —
see `harness/ISSUES.md` A1. That code was removed; history is in `harness/`.)

- One `GameRoom` Durable Object per game code holds the authoritative state.
- Players connect over a **WebSocket** (`/api/ws?code=XXXX`).
- The DO runs all game rules and sends each player only *their own* filtered view
  (`getPublicGameState` + `getPlayerKnowledge`) — secret roles never reach other
  players' browsers.
- The DO processes one message at a time behind the input gate, so simultaneous
  votes cannot race (no explicit locking needed).
- Reconnection: a per-player `token` (in `localStorage`) is the same-browser fast
  path; otherwise game code + name reclaims the seat from any device, even mid-game.
- Lobby management: a player can `leave` (removed from the roster in the lobby;
  mid-game they just disconnect), and the host can `kick` another player in the
  lobby (removed player is notified and dropped to the home screen).

### File Structure
```
src/
  game-logic.js      # Shared game rules (roles, phases, validation) — ESM
  worker.js          # Worker entry + GameRoom Durable Object
public/
  index.html         # Frontend (single-page app)
  ws-transport.js    # WebSocket transport (talks to the DO)
wrangler.toml        # Cloudflare config (DO binding + migration)
harness/             # Issue tracking + migration notes
```

### Game Flow
1. Host creates game → gets game code
2. Players join with code
3. Host starts game → roles assigned
4. 5 quests, each with:
   - Leader proposes team
   - Everyone votes approve/reject
   - If approved: team members vote pass/fail
   - Track quest successes/failures
5. If good wins 3 quests → Saul can assassinate Samuel
6. Game ends when one side wins

### Character Roles
- **Good**: Samuel (knows evil), David (sees Samuel/Phinehas), Mighty Man
- **Evil**: Saul (hidden, assassin), Phinehas (confuses David), Doeg (lone wolf), Sheep

## Development

### Running Locally
```bash
npx wrangler dev
# Serves the Worker + Durable Object locally via Miniflare
```

### Testing
```bash
npm test                # all 14 end-to-end suites (boots wrangler dev itself)
npm test -- heartbeat   # filter by suite name
```
The suites in `tests/` use raw WebSockets and jsdom tabs against the real
Worker + DO; see `tests/README.md` for what each covers. Run them after any
change to `src/` or `public/`. For manual testing, open multiple browser tabs —
each tab is its own player.

### Deploying to Cloudflare
```bash
npx wrangler deploy
```

## Key Implementation Details

### Vote race safety
No explicit locking is needed: the Durable Object handles one WebSocket message
at a time behind the input gate, and each `GameActions` call mutates state
synchronously before any `await`, so concurrent votes can't lose updates.

### Reconnection
On join the DO issues a per-player `token` bound to the `playerId`; the client
stores it in `localStorage` keyed by `code + name` (`mightymen_id_<CODE>_<name>`),
and keeps a per-tab session in `sessionStorage` so a refresh auto-reconnects and
tabs don't clobber each other. `hello` carries `{name, playerId?, token?}`:
- valid `playerId + token` → reconnect that seat (same browser, no token change);
- otherwise, if `name` matches an existing player → **reclaim that seat from any
  device/browser, even mid-game** (a fresh token is issued). Game code + name is
  intentionally enough to get back in — see the trade-off note in the migration doc;
- otherwise a new `name` joins (lobby only).
State lives in the DO, so nothing is lost on refresh or device switch.

### Per-player views
Clients never receive raw game state. The DO computes `getPublicGameState` and
`getPlayerKnowledge` per player and sends only that.

## Common Issues

1. **Vote button doesn't work**: Check that `game.votes[playerId] !== undefined` (not `!!value`)
2. **Phase not rendering**: Ensure all phases listed in `updateUI()` switch statement
3. **State missing after connect**: the transport resolves `createGame/joinGame`
   only after the first `state` message arrives — check the WebSocket opened.

## GitHub Repository
https://github.com/JEdward7777/mighty-men-of-david
