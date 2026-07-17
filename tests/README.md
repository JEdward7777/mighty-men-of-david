# Tests

End-to-end suites that run against a real `wrangler dev` server: raw WebSockets
against the Worker + `GameRoom` Durable Object, and jsdom "browser tabs" that
load the real `public/index.html`.

```bash
npm test                # run everything (boots wrangler dev itself)
npm test -- heartbeat   # run only suites whose name contains "heartbeat"
```

If a dev server is already running on port 8799, the runner reuses it (and
leaves it running afterwards).

| Suite | Covers |
|-------|--------|
| `smoke` | Full game flow: create → join ×5 → roles hidden → propose/vote/quest → reconnect by token → bad token & unknown game rejected |
| `name-test` | Server-side name normalization (NFC unicode, zero-width chars, whitespace, length cap) |
| `reclaim-test` | Seat reclaim by code + name from a new device, mid-game, same role restored |
| `kick-test` | Lobby leave/kick server rules (host-only, lobby-only, notifications) |
| `multitab-test` | Multiple tabs in one browser = distinct players (shared localStorage) |
| `refresh-test` | Page refresh auto-reconnects; "You" badge and host status survive |
| `leave-test` | Leave button; `?join=<other game>` overrides auto-reconnect |
| `kick-ui-test` | Host's Remove buttons; kicked tab returns home with notice |
| `heartbeat-test` | ping/pong keepalive; silent-death detection; reconnect after token rotation |
| `send-fail-test` | Action on a dead socket surfaces the disconnect and triggers reconnect |
| `away-test` | "Away" badges and "Waiting on X (disconnected)" lines |
| `sound-test` | Turn-alert beep: once per decision point, never on re-broadcasts |
| `rejoin-retry-test` | Gmail-style endless rejoin retry via a killable TCP proxy; Retry-now button; fatal errors clear the session |
| `selection-test` | Team selection can't leak across games/quests; survives re-renders (replays games until the host draws leader, so it's the slowest) |

Conventions: each suite prints `✓`/`✗` per assertion and a final
`RESULT: N passed, M failed`, and exits nonzero on failure. Timing-sensitive
suites use generous waits — if one flakes under heavy load, rerun it alone
(`npm test -- <name>`) before suspecting a real regression.
