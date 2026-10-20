# Midscene Test · Dashboard smoke

This project runs the real Botmux Dashboard bundle with isolated synthetic data.
It uses a Playwright-backed Midscene agent to verify the core read-only pages
without reading or modifying the developer's `~/.botmux` directory.

## Run

Build Botmux, configure the four `MIDSCENE_MODEL_*` variables from
`.env.example`, install Playwright Chromium, and run:

```bash
bun run build
bun x playwright install chromium
bun run test:midscene
```

Set `HEADLESS=false` to watch the browser. Native replayable HTML reports are
written below the gitignored `midscene_run/` directory.

The credential-dependent Feishu browser scenarios remain in
`test/e2e-browser/` and run through `bun run test:midscene:feishu`.

## CI credentials and reports

Repository CI requires `FEISHU_TEST_GROUP_URL` plus an authenticated Playwright
storage state. Because a complete Feishu state can exceed GitHub's secret size
limit, store `gzip -c storageState.json | base64` as
`FEISHU_STORAGE_STATE_GZIP_BASE64`. The legacy uncompressed
`FEISHU_STORAGE_STATE_BASE64` value remains supported when it fits.

The workflow publishes a case-level evidence site under
`https://deepcoldy.github.io/botmux-midscene/`. Every executed case links to
its exact native Midscene step and includes the screenshot used by that node.
The same links and thumbnails are written to the GitHub Actions Summary.
