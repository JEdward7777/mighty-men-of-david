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
- Reconnection uses a per-player `token` (issued by the DO, stored in
  `localStorage`), so state survives a host/player refresh and seats can't be
  hijacked by name.

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
Open multiple browser tabs to simulate players; each tab keeps its own
identity/token in `localStorage`. There is also a scripted end-to-end WebSocket
test used during the DO migration (see `harness/DURABLE-OBJECTS-MIGRATION.md`).

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
On join the DO issues a per-player `token` bound to the `playerId`. The client
stores `{playerId, token}` in `localStorage` (`mightymen_id_<CODE>`). Reconnecting
sends `{type:'hello', playerId, token}`; the DO re-attaches the socket and pushes
current state. State lives in the DO, so nothing is lost on refresh.

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
