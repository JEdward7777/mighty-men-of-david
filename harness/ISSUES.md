# Issues

Problems found during a read-through of the codebase on 2026-07-13.
Severity: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low/cosmetic.

Status legend: **OPEN** · **IN PROGRESS** · **RESOLVED** (with commit ref).

---

## Architecture

### A1 🔴 WebRTC P2P does not work across networks — RESOLVED
**File:** `public/webrtc-transport.js:42-47`

The `iceServers` list contains **STUN only** (`stun:stun.l.google.com`). STUN lets
peers discover their public address but cannot relay traffic. On carrier-grade /
symmetric NATs — which is exactly what phones on cellular data use — direct P2P
connections fail and there is no TURN relay to fall back to. Since this game is
designed for people on their phones (often on different networks / cellular), the
connection silently never establishes.

This is the root cause of "peer to peer connections which were not working across
networks." **Fix = the Durable Object migration** (see `DURABLE-OBJECTS-MIGRATION.md`),
which replaces P2P entirely with a server-authoritative WebSocket hub.

### A2 🔴 Host-in-browser authority is fragile — RESOLVED
**Files:** `public/webrtc-transport.js:636-644, 464-505, 174-194`

The authoritative game state lives in the **host player's browser**. If the host
closes their tab, backgrounds it on mobile (phones aggressively suspend tabs), or
loses signal, the entire game state is lost and must be "recovered" by polling
copies back from other players (`state-recovery`, `_finalizeStateRecovery`, a 2s
"newest version wins" race). Recent commit history ("Fixed a host reconnect bug
but apparently there is still an issue") shows this path is still broken. Moving
state into a Durable Object removes the whole class of problem.

### A3 🔴 All player roles are broadcast to every client — RESOLVED
**File:** `public/webrtc-transport.js:545-557, 787-797`

`broadcastState()` sends the **entire authoritative `gameState`** — including every
player's secret `role` — to every connected client. The client only *renders* a
filtered view via `getPublicGameState()`, but the raw roles are already sitting in
each player's browser memory and are trivially visible in DevTools. For a hidden-role
social-deduction game this defeats the entire point. The DO must compute and send a
**per-player filtered view** server-side, never the raw state.

---

## Correctness bugs

### B1 🟠 Heartbeat monitor interval leak — RESOLVED
**File:** `public/webrtc-transport.js:168-172, 664-684`

`startHeartbeatMonitoring()` calls `setInterval(...)` with no guard and is invoked
from `dataChannel.onopen` on **every** (re)connection. Each reconnect adds another
1-second interval that is never cleared, so after N reconnects there are N concurrent
monitors all firing `checkHeartbeatTimeout()`. Unlike `startHeartbeat()` (host side),
it does not clear a previous handle.

### B2 🟠 Multiple concurrent reconnect loops — RESOLVED
**File:** `public/webrtc-transport.js:686-696, 829-857, 154-165`

A disconnect can trigger reconnection from two independent sources at once:
`dataChannel.onclose` → `playerAttemptReconnect()`, and the heartbeat timeout →
`playerAttemptReconnect()`. Nothing guards against a reconnect already being in
flight, so two (or more) reconnect chains can run in parallel, each posting fresh
offers. On failure the retry is `setTimeout(..., 0)` (line 855) — effectively a
busy retry with no backoff on that path.

### B3 🟡 4-char game codes with no collision check — RESOLVED
**Files:** `src/worker-webrtc.js:10-17, 75-97`

`generateGameCode()` produces a 4-character code from `Math.random()` and
`/api/create` writes it to KV **without checking whether that key already exists**.
Two concurrent games can collide and clobber each other. (Note `game-logic.js`
`generateCode()` defaults to 6 chars — the two code paths disagree on length.)

### B4 🟡 Anyone can hijack the host by name — RESOLVED
**File:** `src/worker-webrtc.js:120-157`

`/api/rejoin-by-name` returns the host's `playerId` to **anyone** who submits the
game code plus a name matching `hostName` (case-insensitive). There is no secret /
token. A player who knows the host's display name can claim host authority. Likewise
`/api/signal/player` has no auth and lets anyone inject pending players. Low real-world
stakes for a party game, but worth noting; the DO design should issue a per-session
token.

> **Update (2026-07-14):** the token requirement was *intentionally relaxed* after
> deploy. Game **code + name** now reclaims a seat from any device, even mid-game,
> so a dead battery / wiped storage can't lock a player out of their own game. This
> knowingly re-accepts the "impersonate by name" risk — acceptable in an in-person
> social game where you already trust the other players. Token is still the
> same-browser fast path.

### B8 🔴 Refresh dropped you from the game; rejoin lost your identity — RESOLVED
**File:** `public/index.html` (session storage, `handleStateUpdate`, load handler)

Reported in `found_problems.txt`. Refreshing returned you to the home screen, and
the manual "Rejoin" put you back but with no "You" badge and no ability to act; a
host who refreshed was no longer host. Three causes:
1. The rejoin **session** was in `localStorage` (shared across tabs), so tabs
   clobbered each other's session and "Rejoin" used whichever was saved last.
   Moved to per-tab `sessionStorage` (survives refresh, isn't shared).
2. **No auto-reconnect** on load — moved to reconnecting this tab on page load.
3. The "You" badge / action gating used a global `playerId` assigned *after* the
   first render, so it stayed unset on reconnect. `handleStateUpdate` now takes
   `playerId`/`gameCode` from the server's per-connection `state.myId`/`state.code`.

Verified with a jsdom test that loads the real page against `wrangler dev` and
simulates refreshes by carrying a tab's storage across page loads (host + player
"You" badges, auto-reconnect to lobby, host stays host, no duplicate players).

### B7 🔴 Second tab in the same browser couldn't join — RESOLVED
**File:** `public/ws-transport.js` (identity persistence)

Reported after deploy: creating a game then joining from a second tab (or a second
incognito tab) didn't add the second player. Tabs in one browser share
`localStorage`, and the transport saved each player's reconnect token under a key
of the **game code only**. So the second tab's `rejoinGame()` found the first
player's token and silently reconnected *as that player* instead of joining fresh —
the new name never reached the server. Fixed by keying identity on **code + name**
(`_identityKey(code, name)`). Verified with a jsdom test that runs three transports
against `wrangler dev` in one shared `localStorage` (three distinct players; nobody
hijacks the host; reconnect still maps back to the same id).

### B6 🔴 Game-over screen never showed (`stopPolling` crash) — RESOLVED
**File:** `public/index.html` (`updateUI`, `game_over` case)

Found during the post-migration cleanup pass, not the original audit. The
`game_over` branch called `stopPolling()` — a function from the deleted KV-polling
transport that no longer exists. The `ReferenceError` aborted `updateUI()` before
`showGameOver()` ran, so **no player ever saw the end-of-game results screen**.
Removed the call; verified with a jsdom test that drives the client to `game_over`.

### B5 ⚪ Misleading heartbeat log — RESOLVED
**File:** `public/webrtc-transport.js:784-785`

`this.lastHeartbeatReceived = Date.now()` is set, then the very next line logs
`elapsed: ${Date.now() - this.lastHeartbeatReceived}ms`, which is always ~0. Cosmetic,
but the log is useless as written.

---

## Cruft / consistency

### C1 🟡 Docs describe files that don't exist — RESOLVED
**Files:** `README.md`, `AGENTS.md`, `package.json`

Both docs and `package.json` `main` reference `src/worker.js` (KV mode) and
`dev-server.js`, **neither of which exists** in the repo — only `src/worker-webrtc.js`
remains. The README's "two deployment modes," the `/api/state`, `/api/knowledge`,
`/api/start`, ... endpoint table, and the "Running Locally: `node dev-server.js`"
instructions are all stale. Update docs after the DO migration.

### C2 🟡 `game-logic.js` mixes CommonJS and ESM — RESOLVED
**File:** `src/game-logic.js:582-622`

The file has both a `module.exports = {...}` block **and** a top-level ESM
`export {...}`. In a Workers ES module the CommonJS branch is dead; in Node
(the now-missing dev server) the `export` keyword would throw. Pick one module system.
`public/game-logic-client.js` is a near-verbatim copy that instead assigns to
`window.GameLogic` — three copies of the same rules to keep in sync.

### C3 ⚪ Dead / broken QR helper — RESOLVED
**File:** `public/index.html:1313-1323`

`generateQRCode()` calls `QRCode.toCanvas(...)`, which is the API of the `qrcode`
(soldair) npm package. The page actually loads **davidshimjs/qrcodejs**, whose API is
`new QRCode(el, opts)`. `generateQRCode()` would throw if called — but it is never
called (the working call site at line 1479 uses the correct `new QRCode(...)`), so
it's just dead, misleading code.

### C4 ⚪ Stale `compatibility_date` — RESOLVED
**File:** `wrangler.toml:12`

`compatibility_date = "2024-01-01"`. Bump when reconfiguring for Durable Objects.

---

## Resolution summary (2026-07-13, Durable Object migration)

All issues above were addressed by replacing the WebRTC P2P transport with a
server-authoritative Durable Object. See `DURABLE-OBJECTS-MIGRATION.md`.

| ID | How it was resolved |
|----|---------------------|
| A1 | WebRTC removed entirely; players now use a plain WebSocket to Cloudflare — no NAT traversal, works across any network. |
| A2 | Authoritative state lives in the `GameRoom` DO, not the host's browser. Host can refresh/drop and the game continues; state-recovery code deleted. |
| A3 | The DO sends each socket only `getPublicGameState`/`getPlayerKnowledge` for *that* player. Raw roles never leave the server (verified by smoke test — other players' `role` is `undefined` pre-game-over). |
| B1, B2, B5 | The buggy `webrtc-transport.js` was deleted. The new `ws-transport.js` uses a single guarded reconnect loop (`_reconnecting` flag) with real backoff and no per-connect interval leak. |
| B6 | Removed the dead `stopPolling()` call in `updateUI`'s `game_over` branch; the results screen renders again (verified with a jsdom DOM test). |
| B3 | Worker generates a code and the DO refuses a code it already holds, so the Worker retries — codes are collision-free. |
| B4 | Reconnection requires `playerId + token` (random per player, held in the DO, never broadcast). Knowing a display name no longer grants a seat or host rights. |
| C1 | `README.md`, `AGENTS.md`, `package.json` updated to the WebSocket/DO architecture. |
| C2 | `src/game-logic.js` is now pure ESM (dead CommonJS block removed); the duplicate client copy `game-logic-client.js` was deleted (client no longer runs game logic). |
| C3 | Dead `generateQRCode()` helper removed with the transport rewrite pass (the working `new QRCode(...)` call site remains). |
| C4 | `compatibility_date` bumped to `2025-01-01`. |

**Verification:** a 24-assertion end-to-end WebSocket test (create → 6 players join →
role-hiding → host guards → propose/vote/quest → reconnect-with-token → bad-token &
unknown-game rejection) passes against `wrangler dev`.

**Remaining:** deploy to the user's Cloudflare account and play-test with real phones.
