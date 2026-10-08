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

## GitHub Actions

The `Midscene E2E` workflow runs the Dashboard project without Feishu login
state, but it still requires the configured Midscene visual model. It
uploads the complete native report data as the `botmux-midscene-report`
artifact, publishes the HTML report to GitHub Pages, and writes the real case
result to the workflow Summary page. When the live-test secrets and Botmux test
chats are available,
the same workflow also runs these 17 Feishu scenarios. Without those secrets,
only the Feishu project is skipped; the Dashboard Midscene run and its report
are still required.

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
to the Aiden, Claude, CoCo, Codex, and OpenCode bot conversations. An unrelated
Feishu account can sign in successfully but cannot run these live cases.

The optional chat-name overrides use `FEISHU_TEST_GROUP_CHAT_NAME` and
`FEISHU_TEST_TOPIC_GROUP_NAME`. GitHub withholds repository secrets from forked
pull requests, so the live job is intentionally limited to same-repository
branches and manual runs.

Useful validation commands:

```bash
bun run test:midscene:typecheck
bun run test:midscene:nodes
```
