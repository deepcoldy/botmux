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

Useful validation commands:

```bash
bun run test:midscene:typecheck
bun run test:midscene:nodes
```
