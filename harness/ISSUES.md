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

### B9 🟠 Leaving a game crashed on a late socket message — RESOLVED
**File:** `public/index.html` (`leaveGame`, `handleStateUpdate`)

Found while adding the "Leave game" button. `leaveGame` set the global `transport`
to `null`, but a `state` message already in flight from the old socket still fired
`handleStateUpdate`, which dereferenced `transport` → `TypeError: ... reading
'getPublicState'`. Fixed by detaching the transport's callbacks *before* destroying
it (so a game you left can't drive the UI) plus a null guard in `handleStateUpdate`.
Part of the leave/`?join=`-precedence change; covered by `leave-test.mjs`.

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

## Second audit (2026-07-16) — deeper pass over the DO-era code

All items were verified against the source (not speculative). **D1–D3 were fixed
on 2026-07-16** (connection-resilience cluster); D4–D12 remain open pending
discussion.

### D1 🟠 No keepalive → silently dead sockets leave a stale UI — RESOLVED
**Files:** `src/worker.js`, `public/ws-transport.js` (no ping/pong anywhere)

There is no heartbeat in either direction and no `visibilitychange` handling. A
phone that sleeps, switches Wi-Fi→cellular, or sits idle through a long table
discussion can lose its socket **without a close event ever firing**. The client
then shows a frozen game and taps do nothing (see D6) until the user refreshes.
**Fix (applied):** DO answers `'ping'`→`'pong'` via `setWebSocketAutoResponse`
(no hibernation wake); client pings every 25s, counts *any* message as liveness,
and presumes the socket dead after 60s of silence → teardown + reconnect. On
`visibilitychange` the client reconnects immediately if the socket isn't OPEN, or
verifies an "open" socket with a 4s ping probe. Bonus: the heartbeat tick also
rescues a socket stuck in CLOSING whose close event never fires.

### D2 🟠 Stale-socket `onclose` race clobbers the new connection — RESOLVED
**File:** `public/ws-transport.js:187-191, 237-250`

`ws.onclose → _handleClose()` operates on `this.ws` unconditionally. Sequence:
connect attempt times out (15s) → `ws.close()` → retry creates a NEW socket and
assigns `this.ws` → the OLD socket's `onclose` finally fires → `_handleClose`
sets `this.ws = null` (clobbering the live socket), rejects the *new* attempt's
pending promise, and can spawn a second parallel reconnect loop.
**Fix (applied):** every socket handler bails early when `this.ws !== ws`;
`_connect` tears down (detaches + closes) any socket it replaces; the connect
timeout also detaches the abandoned socket before rejecting.

### D3 🟠 Auto-reconnect hello omits `name` → permanent reconnect loop — RESOLVED
**File:** `public/ws-transport.js:266`

`_scheduleReconnect` reconnects with `{ playerId, token }` only. If the token was
rotated (the seat was reclaimed from another device — aec7dd6's feature), the
server sees an invalid token and **no name**, answers "Unknown player", and closes.
The client retries forever with the same stale credentials.
**Fix (applied):** the reconnect hello now carries `name` alongside
`playerId`/`token`; the server still prefers the token fast-path when valid, and
falls back to a name reclaim (fresh token) when it isn't.

Verified (all three) by `heartbeat-test.mjs` against `wrangler dev`: raw
ping→pong; a silently-dead socket (neutered send) detected and replaced in ~2s;
reconnect succeeds after a token rotation with the same seat and a fresh token;
roster coherent afterwards. Full regression suite (8 suites, 100+ assertions)
green.

### D4 🟡 Reclaiming a seat doesn't disconnect the previous device — WONTFIX
**File:** `src/worker.js:158-168` (`handleHello` reclaim branch)

The old device's already-open socket keeps its attachment and can still act on
the seat — two devices can drive one player simultaneously.

> **Decision (2026-07-16, by the owner):** intentional. Connectivity is the
> priority, not security — if a player wants to use two devices at once, let
> them. Do not add socket-kicking on reclaim; do not re-flag this in future
> audits. (The in-code comment about "the new device becomes the live one"
> should be read as: the new device holds the current token for future
> reconnects, nothing more.)

### D5 🟡 Player names are not validated server-side — OPEN
**File:** `src/worker.js` (`handleHello`), `src/game-logic.js` (`join`)

`msg.name` is used raw: no trim, no length cap. `" Bob"` and `"Bob"` are distinct
players, and a whitespace-padded name breaks later reclaim-by-name matching
(`toLowerCase()` compare, no trim). A multi-kilobyte name is accepted, persisted,
and rendered (escaped, but layout-breaking). `/api/create` trims; hello doesn't —
inconsistent.
**Fix:** in `handleHello`, `name = (msg.name || '').trim().slice(0, 20)` and reject
empty; compare names with the same normalization everywhere.

### D6 🟡 Actions sent while disconnected are silently dropped — OPEN
**File:** `public/ws-transport.js:276-282` (`_send`)

If the socket isn't OPEN, `_send` just logs to the console. A player who taps
Vote/Success during a blip gets no feedback, nothing is queued, and no reconnect
is triggered — combined with D1 this looks like "the game ate my vote."
**Fix:** surface it (onError / reconnecting notice), kick off a reconnect, and
optionally queue the most recent action to send after resuming.

### D7 🟡 Disconnected players are invisible in the UI — OPEN
**File:** `public/index.html` (`updateLobby`, `renderQuest`)

The server tracks and broadcasts `connected` per player, but no screen renders it.
Mid-game the host can't tell that "waiting for the team" really means "Dave's
phone died." The old WebRTC UI had per-player notices; the WS UI lost them.
**Fix:** gray out / badge disconnected players in the lobby list and the quest
progress list.

### D8 🟡 Stale team selection leaks across quests 4→5 and rejected votes — OPEN
**File:** `public/index.html` (`renderTeamSelection`, `teamSelectionState`)

Selection reset is keyed on **quest size**, but `QUEST_SIZES = [3,4,5,6,6]` —
quests 4 and 5 are both 6, so the leader of quest 5 starts with quest 4's picks
pre-selected. Same for a leader who regains leadership after rejections. Also
`exitToHome` never resets `teamSelectionState`/`assassinationState`, so picks can
leak into the *next game* in the same tab.
**Fix:** key the reset on `currentQuest` (and reset both state objects in
`exitToHome`).

### D9 🟡 A transient failure during auto-rejoin permanently drops the session — OPEN
**File:** `public/index.html` (`rejoinGame` catch block)

On page load, `rejoinGame(true)`'s catch calls `clearSession()` for *any* error —
including a network blip or a slow server. The tab then forgets the game entirely
(user must re-enter code+name via Join).
**Fix:** only clear the session on definitive rejections ("Game not found" /
"removed"); otherwise keep it and retry with backoff.

### D10 ⚪ `GAME_EXPIRY_SECONDS` env var is dead — OPEN
**Files:** `wrangler.toml:14`, `src/worker.js:20`

The worker hardcodes `GAME_EXPIRY_MS = 2h`; the configured var is never read.
**Fix:** read `env.GAME_EXPIRY_SECONDS` in the DO (it has `env`), or delete the var.

### D11 ⚪ Dead code in the UI — OPEN
**File:** `public/index.html`

`playAttentionSound()` is defined but never called (README still advertises
"Sound alerts when it's your turn"); `lastVotes` is declared and never used; a
failed join/create leaves the orphaned transport instance behind (re-`initTransport`
just abandons it).
**Fix:** wire the sound up on turn transitions or remove it; delete `lastVotes`;
destroy the transport on failed connect.

### D12 ⚪ Docs drift — OPEN
**Files:** `README.md`, `src/game-logic.js`

README's WebSocket action list omits `leave`/`kick`; the `version` field in the
game state is vestigial (it existed for WebRTC host-recovery, which is gone).
**Fix:** update README; consider dropping `version` or documenting it as unused.

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
