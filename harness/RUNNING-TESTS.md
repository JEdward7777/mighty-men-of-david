# Running the tests (notes to self)

Hard-won lessons. Read this before concluding "the tests are flaky."

## The command

```bash
cd /home/lansford/Sync/projects/mighty-men-of-david
timeout 280 node tests/run-all.mjs > /tmp/rt.log 2>&1; echo "exit=$?"; tail -20 /tmp/rt.log
```

- `npm test` runs the same thing; invoking `run-all.mjs` directly just avoids an
  extra npm wrapper in the process tree.
- The runner **starts and stops its own `wrangler dev`** on port 8799 (and reuses
  one already listening there). You do not need to start a server yourself.
- Redirect to a file and `tail` it. The full suite prints ~1300 lines — piping it
  straight back is pure noise and buries the summary.
- Full run is ~110-150s. Give it a real timeout; don't kill it at 60s and call
  it hung.
- One suite: `npm test -- heartbeat` (substring match on the suite name).

## ⚠️ Do not shoot yourself in the foot with pkill

**This wasted a lot of time.** These fail with exit code 144 and no output:

```bash
pkill -f "wrangler dev"      # ← kills the shell running THIS command
pkill -f wrangler            # ← same
```

`pkill -f` matches against full command lines — **including the command line of
the shell you're running it in**, because that string contains "wrangler". The
shell kills itself mid-command. The symptom looks exactly like the environment
eating background jobs at random: commands returning 144, log files never
created, background servers vanishing. It's self-inflicted.

Use the bracket trick so the pattern can't match itself:

```bash
pkill -f "[w]rangler dev"    # safe
pkill -x workerd             # safe (exact name match)
```

Usually you don't need to kill anything at all — the runner cleans up after
itself, and reuses a server that's already up.

## Exit code 144 is a lie you'll be tempted to believe

144 = 128 + 16. In this environment it shows up when a command's own shell gets
killed (see above), and background-task tooling reports it as "failed" even when
the underlying work succeeded. **Always confirm against the actual artifact** —
read the log file, check the port, look at the summary — before believing a
failure. More than once here the work had completed fine and only the wrapper
reported failure.

## A failing test is a failing test

The suite is deterministic as of 2026-07-25: three consecutive full runs, 16/16,
zero failures. If something fails:

1. **Do not** re-run until it goes green and move on.
2. Read the actual assertion that failed and the log lines around it.
3. Reproduce it in isolation (`npm test -- <suite>`), several times.
4. Only after understanding *why* should you decide it's environmental.

This matters because it already burned us: intermittent `heartbeat`/`smoke`
failures were waved off twice as "known flaky timing," and they were a real
reconnect-loop bug that would have hit players whose phones woke from sleep. See
**D13** in `ISSUES.md`. The flake *was* the bug.

## Writing tests

Conventions and the `waitFor()` rules live in [`../tests/README.md`](../tests/README.md).
Short version: never sleep a fixed guess before asserting; make wait predicates
specific to the thing you're waiting for; keep fixed waits only for *negative*
assertions, where polling can't prove absence.
