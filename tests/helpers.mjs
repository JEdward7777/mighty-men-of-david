// Shared test helpers.

// Poll until `predicate()` holds, or give up after `timeoutMs`. Returns a
// boolean so it drops straight into an existing check():
//
//   check('phase = team_vote', await waitFor(() => host.state.phase === 'team_vote'));
//
// State in these tests arrives asynchronously over a WebSocket (client → DO →
// broadcast → client). Sleeping a fixed guess before asserting is the root
// cause of essentially every "flaky" failure in this suite: 200ms is plenty on
// an idle machine and not nearly enough when the whole suite is hammering one
// dev server. Polling is fast when the system is fast and patient when it is
// not, so a pass means "this really happened" and a failure means "this really
// didn't" — rather than "the machine was busy".
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false; // predicate touched something not ready yet; keep waiting
    }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
