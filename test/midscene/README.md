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
