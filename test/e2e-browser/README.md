# Midscene Test · Feishu browser E2E

The existing Feishu browser scenarios are executed by `@midscene/test`. Their
Playwright and Midscene Web assertions remain in the original `*.e2e.ts` files;
the YAML cases provide native Midscene Test selection, retries, summaries, and
unified reports without changing the product behavior under test. Visible UI
operations use `aiAct`; `aiWaitFor` and `aiAssert` describe observable results,
while deterministic browser operations remain in TypeScript helpers.

## Run

Create `storageState.json` and configure the Feishu and multimodal-model values
listed in `.env.example`:

```bash
bun run test:e2e-browser:setup
bun run test:e2e-browser
```

The command writes each run below `midscene_run/runs/<run-id>/`. Use
`bun run report:dashboard` to browse historical reports.

## Lanes and parallel runs

Every `cases/*.yaml` file is a lane, run as the Midscene project
`feishu-<file stem>`. Lanes run concurrently (`FEISHU_E2E_CONCURRENCY`,
default 4); cases inside one lane run in order. A lane groups cases that must
not overlap — `full-group.yaml` stays serial because its no-mention case
asserts that no bot answered. The longest lane, `core-group-modes`, starts
first (`LONG_LANES_FIRST` in `lanes.ts`); on CI a failed case runs once more.

| Lane | Covers |
|:--|:--|
| `core-claude` | Claude private chat: new topic, streaming card, ACK reply, output toggle |
| `core-codex` | Codex private chat and prompt submission |
| `core-conversation` | Follow-up in the same topic keeps context; `/status` → `/close` → `/status` |
| `core-queue` | Three back-to-back messages are all answered |
| `core-dm-modes-claude` / `core-dm-modes-codex` | Private-chat modes `chat`, `thread` (topic), `group` (session group) |
| `core-group-modes` | Claude and Codex in the test group: reply modes `chat-topic` / `chat` / `topic` / `new-topic`, @ policies `always` / `never` / `ambient` / `topic` |
| `core-clis` | Public CLIs in their private chats: OpenCode, Pi, Oh My Pi (`OhMyPi`), Kimi, Antigravity, Grok |
| `core-sandbox` | `ClaudeSandbox` (Claude Code, `sandbox: true`): from inside the session's shell, home and harness secrets are hidden, writes stay in the working directory |
| `full-bots` | Internal CLIs Aiden and CoCo (not installed on CI), reply smoke |
| `full-group` | Group @mention routing, group topic replies, bot collaboration |
| `full-claude-ui` | Card lifecycle, private topic mode, image/text mix, web terminal |
| `full-schedule` | Scheduled task stays in its source thread |

`FEISHU_E2E_CASES` picks lanes: unset or `core` runs the `core-*` gate,
`all` runs every lane, and a comma list selects lanes by stem:

```bash
FEISHU_E2E_CASES=core-conversation bun run test:e2e-browser
FEISHU_E2E_CASES=all FEISHU_E2E_CONCURRENCY=2 bun run test:e2e-browser
```

Parallelism stays inside one runner on purpose. Feishu delivers each app's
events to only one of its WebSocket connections, so separate jobs with their
own daemons for the same bots would receive each other's messages.

Some Feishu state is shared across lanes. A bot's private-chat mode is per
bot, not per DM, and group modes are per group. `chat-lease.ts` serialises
only what conflicts:

- `openChat` holds a shared lease on the bot's DM.
- A DM mode case holds that lease exclusively.
- `openGroupChat` holds the group exclusively.

Each mode case reads the current mode first and restores it afterwards.

### Recall probes

The follow-up case and every mode case send recall probes. A probe asks the
model to answer `ACK-<own tag> RECALL <first ACK this session holds>`. With
`BOTMUX_MOCK_LLM=1`, the mock server (`test/helpers/mock-llm-server`) answers
from the history the CLI resends; a real model answers the same way. The reply
line exists only in the bot's answer, so it is matched exactly in the DOM, and
it shows which session answered:

- a fresh session recalls the probe's own ACK;
- a continued session recalls the first probe's ACK.

The DM `group` case finds the new session group by name.
`bun run test:e2e-browser` with `BOTMUX_START_DAEMON=1` turns AI group naming
off for the test daemons, so the name is the first 20 characters of the DM.
The group-mode lane assumes every bot in the test group requires an @ by
default, as the no-mention routing case does.

Set `BOTMUX_E2E_RECORD_VIDEO=1` to record a Playwright WebM for each browser
context. Clips are written under `test/e2e-browser/midscene_run/videos/`
(gitignored) and the report index embeds them when that directory exists.
The Claude and Codex core lanes use `feishu.openAndSend`, `feishu.waitForStreamingCard`,
`feishu.waitForBotResponse`, `feishu.showStreamingOutput`, and `feishu.close`
so each phase keeps its own Midscene snapshots. Other cases use
`feishu.runScenario`.

## GitHub Actions

The `Midscene E2E` workflow runs after merge: on every push to `master`, and
on manual dispatch. Pull requests do not run it. It runs two jobs in parallel.
The Dashboard job needs no Feishu login state, but it does need the configured
Midscene visual model. The Feishu job runs the `core` lanes concurrently.
Manual runs can pick `feishu_cases` (`all` or a lane list) and
`feishu_concurrency`. A third job merges both uploads
(`botmux-midscene-dashboard-data`, `botmux-midscene-feishu-data`), publishes
the HTML report to GitHub Pages, and writes the per-case result to the workflow
Summary page. Without the live-test secrets, only the Feishu lanes are
skipped; the Dashboard run and its report are still required.

Master runs never cancel each other. While one runs, GitHub keeps only the
newest pending one, so a run can cover several merges. Each master run
publishes its report under `master-run-<run id>` (the newest five are kept).
When a master run fails, `scripts/midscene-notify-failure.mjs` comments on every
pull request merged since the last master run that reached a result,
mentioning its author and the repository owner, with the failed cases, the
report link and the run link. A push without a pull request gets a commit
comment instead. To check a branch before merging, dispatch the workflow on it.

Every run drives the same Feishu bots, so only one Feishu job runs at a time.
The `Wait for the Feishu live slot` job (`scripts/feishu-live-queue.mjs`) hands
out the slot first come first served: it waits while another run holds the slot
or started waiting earlier, then lets this run's Feishu job start. A run that
waits longer than the queue budget reports its Feishu cases as not run, and on
master that counts as a failure.

Reports are published with `scripts/publish-gh-pages.sh`, shared with the docs
deploy: each publish replaces its own directory and pushes the branch as a
single commit (with `--force-with-lease`, retrying if the other publisher moved
it), so `gh-pages` never accumulates history.

Configure these repository secrets before running the workflow:

- `FEISHU_TEST_GROUP_URL` (a direct test-group link, not the Messenger home page)
- `FEISHU_STORAGE_STATE_GZIP_BASE64` (gzip-compressed, base64-encoded `storageState.json`; plain `FEISHU_STORAGE_STATE_BASE64` is also supported)
- `MIDSCENE_MODEL_API_KEY`
- `MIDSCENE_MODEL_NAME`
- `MIDSCENE_MODEL_BASE_URL`
- `MIDSCENE_MODEL_FAMILY`
- `MIDSCENE_MODEL_REASONING_ENABLED`
- `PAGES_DEPLOY_KEY`

The stored Feishu account must be a member of the test group and have access
to the private chats of every bot in `BOT_NAMES` (`helpers.ts`). The bots are
named after their CLI; the older `[Botmux]<Name>` names are still recognised. An unrelated
Feishu account can sign in successfully but cannot run these live cases.

The optional chat-name overrides use `FEISHU_TEST_GROUP_CHAT_NAME` and
`FEISHU_TEST_TOPIC_GROUP_NAME`. Manual runs on forks get no repository secrets,
so their Feishu lanes are skipped.

Useful validation commands:

```bash
bun run test:midscene:typecheck
bun run test:midscene:nodes
```
