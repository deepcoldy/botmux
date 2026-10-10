#!/usr/bin/env bash
# Cloud Agent 环境安装脚本（idempotent）。
# 由 .cursor/environment.json 的 install 阶段调用；在 checkout 完成后运行，
# 用于 build 快照/每次 setup 时准备可构建、可测试、可运行的开发环境。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 与 package.json 的 packageManager 字段保持一致（发版编译也钉在此版本）。
BUN_VERSION="1.4.2"

echo "[install] repo root: $REPO_ROOT"

# 1) 系统依赖：bubblewrap 是 Linux 文件沙箱（src/adapters/backend/sandbox.ts，bwrap DIRECT 模式）的
#    运行时依赖，缺失时沙箱相关能力与其单测全部不可用。
if ! command -v bwrap >/dev/null 2>&1; then
  echo "[install] installing bubblewrap"
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends bubblewrap
else
  echo "[install] bubblewrap present: $(bwrap --version)"
fi

# 2) 关闭 Ubuntu 交互式 shell 的 "sudo hint" 横幅。
#    多个单测会以隔离 $HOME spawn `bash -i` 并断言 stdout 干净；该横幅（sudo 组用户在
#    /etc/bash.bashrc 中触发）会污染输出。此改动幂等：patch 后首行不再匹配。
if grep -q '^if \[ ! -e "\$HOME/.sudo_as_admin_successful"' /etc/bash.bashrc 2>/dev/null; then
  echo "[install] disabling interactive sudo-hint banner in /etc/bash.bashrc"
  sudo sed -i 's|^if \[ ! -e "\$HOME/.sudo_as_admin_successful" \] && \[ ! -e "\$HOME/.hushlogin" \] ; then|if false \&\& [ ! -e "$HOME/.sudo_as_admin_successful" ] \&\& [ ! -e "$HOME/.hushlogin" ] ; then|' /etc/bash.bashrc
fi

# 2b) 修复 /etc 顶层的悬空符号链接。
#     v3 distillation 沙箱（src/workflows/v3/distillation-runner.ts）会冻结 /etc：
#     对 readdirSync('/etc') 的每个顶层条目做 `bwrap --ro-bind`。只要有一个条目是
#     指向不存在目标的悬空 symlink（本镜像即有 vconsole.conf -> default/keyboard），
#     bwrap 就会 "Can't find source path" 整体启动失败，导致该沙箱能力及其单测全挂。
#     悬空 symlink 本身已是坏文件，删除无副作用且幂等。
for f in /etc/*; do
  if [ -L "$f" ] && [ ! -e "$f" ]; then
    echo "[install] removing dangling /etc symlink: $f -> $(readlink "$f")"
    sudo rm -f "$f"
  fi
done

# 3) 安装钉住版本的包管理器 bun。
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  echo "[install] installing bun v${BUN_VERSION}"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
fi
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
# 让 bun/bunx 对所有 shell（含非登录 shell）可见，不依赖 shell profile。
sudo ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
sudo ln -sf "$BUN_INSTALL/bin/bunx" /usr/local/bin/bunx
echo "[install] bun: $(bun --version)"

# 4) 安装依赖（frozen lockfile）。trustedDependencies 会让 bun 跑 node-pty 的
#    node-gyp 编出 build/Release/pty.node —— PTY 与编译版二进制都硬依赖它。
echo "[install] bun install --frozen-lockfile"
bun install --frozen-lockfile

if [ ! -f node_modules/node-pty/build/Release/pty.node ]; then
  echo "[install] ERROR: node-pty native addon (pty.node) missing after install" >&2
  exit 1
fi

# 5) 编译（tsc + dashboard bundle 等），产出 dist/cli.js。
echo "[install] bun run build"
bun run build

echo "[install] done"
