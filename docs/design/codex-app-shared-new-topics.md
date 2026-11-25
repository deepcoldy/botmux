# New Topics on an Existing Codex App Server

`existingAppServer` normally requires `/adopt` to select an existing thread.
Setting `newTopics: "create"` also lets ordinary Feishu topics create a new
thread on that same server. Existing threads and `/adopt` keep their current
behavior; forks, HTTP launches, schedules and workflows are not enrolled.

```json
{
  "cliId": "codex",
  "existingAppServer": {
    "endpoint": "unix:///tmp/codex-app-server.sock",
    "newTopics": "create"
  }
}
```

The existing server remains responsible for model configuration and thread
ownership. BotMux does not start, stop or replace it. After binding, BotMux
uses the existing remote TUI worker, bridge and shared-adopt cleanup behavior.

The first input is persisted in the existing activation journal before any
creation request. New messages use the same FIFO, and the journal is cleared
by the existing worker submission acknowledgement, not by thread creation.

Creation has three durable checkpoints: unrequested, creating, and a received
thread ID. The binding fields are committed together. Preparation failures
retry the received ID without creating another thread; no persistent owner
token survives a daemon restart. A received ID is saved even if the worker
generation changes. Closing or changing the route prevents the stale runtime
from launching. A final worker-admission rejection after binding releases only
the runtime route claim: the activation journal remains authoritative and the
next inbound turn replays its old head.

If a closed row is reactivated while its previous creation is still in flight,
the sessionId single-flight lock is retained and the replacement runtime gets a
generation-, route-, activation- and claim-fenced handoff when that attempt
settles. It then resumes a committed binding or retries a received ID. An
attempt still stuck at `creating` remains an unknown creation result: no second
`thread/start` is issued and the replacement receives the reconciliation error.

If the server disconnects before returning a creation receipt, the result is
unknown: input remains queued and automatic creation is not repeated. The
protocol has no proven idempotent creation key. A timeout cannot establish that
the server did not create a thread. The failure is reported to the topic;
reconciling that case requires an authoritative thread ID.

`thread/name/set` persists the initial rollout before the remote TUI resumes
the thread. A name already returned by `thread/read` is left unchanged.
The API has no compare-and-set name operation: a concurrent manual rename
between that read and the initial set can be overwritten.
The bootstrap client never submits a model turn or grants approval requests.

This change extends the existing shared-adopt behavior introduced by #974 and
#978. It does not add shared-thread fork support or change provider routing.

Local verification includes a real Codex App Server and remote TUI worker
against a deterministic Responses provider. Set `BOTMUX_TEST_REAL_CODEX_BIN`
and run `vitest run test/shared-thread-real-server.e2e.ts` to opt in. This does
not exercise the Feishu service or Codex Desktop UI.
