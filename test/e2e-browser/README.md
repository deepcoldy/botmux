# Midscene Test · Feishu browser E2E

The existing Feishu browser scenarios are executed by `@midscene/test`. Their
Playwright and Midscene Web assertions remain in the original `*.e2e.ts` files;
the YAML cases provide native Midscene Test selection, retries, summaries, and
unified reports without changing the product behavior under test.

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

The `Midscene E2E` workflow runs these same 17 scenarios on same-repository
branches. It uploads the native HTML report and runner data as the
`midscene-feishu-report` artifact, and writes the case results to the workflow
Summary page even when a scenario fails.

Configure these repository secrets before running the workflow:

- `FEISHU_TEST_GROUP_URL`
- `FEISHU_STORAGE_STATE_BASE64` (base64-encoded `storageState.json`)
- `MIDSCENE_MODEL_API_KEY`
- `MIDSCENE_MODEL_NAME`
- `MIDSCENE_MODEL_BASE_URL`
- `MIDSCENE_MODEL_FAMILY`

The optional chat-name overrides use `FEISHU_TEST_GROUP_CHAT_NAME` and
`FEISHU_TEST_TOPIC_GROUP_NAME`. GitHub withholds repository secrets from forked
pull requests, so the live job is intentionally limited to same-repository
branches and manual runs.

Useful validation commands:

```bash
bun run test:midscene:typecheck
bun run test:midscene:nodes
```
