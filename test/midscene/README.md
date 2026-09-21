# Midscene Test · Dashboard smoke

This suite runs the real Botmux Dashboard bundle in an isolated temporary home,
opens it with Playwright, and uses `@midscene/test` YAML cases plus Midscene Web
to verify the core read-only navigation. It never reads or modifies the user's
real `~/.botmux` data.

## Run

Configure a multimodal model in the environment:

```bash
export MIDSCENE_MODEL_NAME=...
export MIDSCENE_MODEL_API_KEY=...
export MIDSCENE_MODEL_BASE_URL=...
export MIDSCENE_MODEL_FAMILY=...
bun run test:midscene
```

Set `HEADLESS=false` to watch the browser. Native replayable HTML reports are
written below `midscene_run/report/`; the directory is gitignored.

Useful checks:

```bash
bun run test:midscene:typecheck
bun run test:midscene:nodes
```
