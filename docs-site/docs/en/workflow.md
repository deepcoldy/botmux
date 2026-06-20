# Workflow (experimental ops)

`botmux workflow` exposes the state of workflow runs as a first-class citizen — see which runs are in flight, read the event stream, recover from a crash / awaiting state, or cancel. All commands read and write `BOTMUX_WORKFLOW_RUNS_DIR` (default `~/.botmux/workflow-runs`), and **don't require the daemon to be online**.

| Command | Description |
|------|------|
| `botmux workflow run <id> [--param k=v ...]` | Drive a workflow offline; humanGate nodes run up to awaiting-wait and exit |
| `botmux workflow resume <runId>` | Cold-recover an existing run from the on-disk runDir |
| `botmux workflow cancel <runId> [--reason <text>]` | Write run-level cancelRequested and drive cancel recovery |
| `botmux workflow ls [--all] [--status ...] [--wide] [--json]` | List all runs; non-terminal only by default |
| `botmux workflow tail <runId> [--from N] [--follow]` | Print a compact event table |
| `botmux workflow show <runId>` | Replay events and print a Snapshot summary |

A typical ops flow:

```bash
botmux workflow ls                         # See which runs are in flight
botmux workflow tail wf-abc-123            # Enter a run and watch events
botmux workflow resume wf-abc-123          # Run stuck / restarted → cold recover
botmux workflow cancel wf-abc-123 --reason 'external dependency timed out'
```

> This is an experimental capability, mainly for ops/debugging of workflow orchestration. Regular use doesn't require it.
