#!/usr/bin/env bash
#
# O1 dogfood: 演示 `botmux workflow` 运维三件套 (ls / tail / cancel) +
# resume，全程在临时 runsDir 里跑，不碰真实 ~/.botmux/workflow-runs。
#
# 默认 dry-run：不真发飞书、不调真实 schedule store；fixture 故意停在
# humanGate 等审批，给 ls/tail/resume/cancel 一个可观察的活态 run。
#
# 用法:
#   ./scripts/dogfood-o1.sh             # 跑完所有阶段
#   BOTMUX_DOGFOOD_KEEP=1 ./scripts/dogfood-o1.sh  # 保留临时 runsDir 供事后检查
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
WORKFLOW_FILE="$ROOT/workflows/o1-canary.workflow.json"

if [[ ! -f "$CLI" ]]; then
  echo "dist/cli.js 不存在，先跑 pnpm build" >&2
  exit 1
fi
if [[ ! -f "$WORKFLOW_FILE" ]]; then
  echo "找不到 fixture：$WORKFLOW_FILE" >&2
  exit 1
fi

TMP="$(mktemp -d -t botmux-dogfood-o1-XXXXXX)"
RUNS_DIR="$TMP/runs"
WD="$TMP/wd"
mkdir -p "$RUNS_DIR" "$WD/workflows"
cp "$WORKFLOW_FILE" "$WD/workflows/"
cd "$WD"

export BOTMUX_WORKFLOW_RUNS_DIR="$RUNS_DIR"

cleanup() {
  if [[ "${BOTMUX_DOGFOOD_KEEP:-0}" == "1" ]]; then
    echo
    echo "(KEEP=1) 临时目录保留：$TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

banner() {
  echo
  echo "─── $* ─────────────────────────────────────────"
}

RUN_ID="o1-canary-$(date +%s)"

banner "1) workflow run — 启动一个会停在 humanGate 的 run"
node "$CLI" workflow run o1-canary --run-id "$RUN_ID"

banner "2) workflow ls — 应该能看到 run 处于 running"
node "$CLI" workflow ls

banner "3) workflow ls --json — 同样的数据机器可解析"
node "$CLI" workflow ls --json

banner "4) workflow tail — 历史 4 条事件 (runCreated/runStarted/attemptCreated/waitCreated)"
node "$CLI" workflow tail "$RUN_ID"

banner "5) workflow resume — CLI 没有审批入口，应继续 awaiting-wait，不写新事件"
node "$CLI" workflow resume "$RUN_ID"

banner "6) workflow cancel — 写入 cancelRequested + 推动 cancel recovery 到 cancelled"
node "$CLI" workflow cancel "$RUN_ID" --reason 'O1 dogfood'

banner "7) workflow ls --all — 现在能看到这个 run 已 cancelled"
node "$CLI" workflow ls --all

banner "8) workflow tail --from 5 — 看到 cancel 阶段写入的事件"
node "$CLI" workflow tail "$RUN_ID" --from 5

echo
echo "✓ O1 dogfood 通过；run=$RUN_ID 已 cancelled。"
