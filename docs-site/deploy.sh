#!/usr/bin/env bash
# 部署 botmux 文档站：rspress 构建 → static 推到 jsDelivr（git tag，不可变缓存）→ HTML 壳发飞书妙搭。
#
#   用法：./deploy.sh <版本号>     例：./deploy.sh 3   （把资源发到 tag docs-assets-v3）
#
# 前提：
#   - 已 `pnpm install`
#   - lark-cli 已登录妙搭域（lark-cli auth login --domain apps）
#   - 能 ssh push 到 deepcoldy/botmux（git@github.com）
#
# 为什么这么绕：飞书妙搭只服务 HTML 页面、不服务本地 JS/CSS 资源，所以把构建产物 static/
# 放到 GitHub 上、用 jsDelivr 当 CDN（assetPrefix 指过去），妙搭 只发那些 HTML 壳。
set -euo pipefail

V="${1:?用法: ./deploy.sh <N>   N=资源 tag 版本号，例 3}"
TAG="docs-assets-v${V}"
APP_ID="app_4k9smq6rdxher"
REPO="git@github.com:deepcoldy/botmux.git"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

echo "==> assetPrefix 指向 @${TAG}"
sed -i.bak -E "s#@docs-assets-v[0-9]+/#@${TAG}/#" rspress.config.ts && rm -f rspress.config.ts.bak

echo "==> 构建"
pnpm install --frozen-lockfile
pnpm build

echo "==> 把 static/ 推到不可变 tag ${TAG}（孤儿提交，临时仓库隔离）"
TMP="$(mktemp -d)"
cp -r doc_build/static "$TMP/static"
( cd "$TMP" && git init -q && git add static \
  && git commit -q -m "docs assets ${TAG}" \
  && git tag -f "$TAG" && git push -f "$REPO" "$TAG" )
rm -rf "$TMP"

echo "==> 把 HTML 壳（去掉 static/）发到妙搭 ${APP_ID}"
HTMLDIR="$(mktemp -d)"
cp -r doc_build/* "$HTMLDIR"/ && rm -rf "$HTMLDIR/static"
( cd "$HTMLDIR" && lark-cli apps +html-publish --app-id "$APP_ID" --path . )
rm -rf "$HTMLDIR"

echo "==> 完成：https://bytedance.aiforce.cloud/app/${APP_ID}/  （资源 @${TAG}）"
