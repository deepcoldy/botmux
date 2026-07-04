# botmux 文档站

botmux 的中文功能文档站，基于 [**rspress**](https://rspress.dev/) 构建，发布在**飞书妙搭（Miaoda）**上。

- 线上地址：<https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/>
- 源码：本目录（`docs/` 下的 Markdown + `rspress.config.ts`）

## 形态与托管（重要）

飞书妙搭只服务 **HTML 页面**，**不服务本地打包出来的 JS/CSS 资源文件**（请求会回退到 index.html）。所以这里采用「**HTML 壳发妙搭 + 资源走外链 CDN**」的方案：

- `rspress build` 产出多页静态站（`doc_build/`：每个路由一个 `.html` + `static/` 里的 JS/CSS/分包/搜索索引）。
- **`static/` 整个推到 GitHub 的一个 git tag**（`docs-assets-vN`），用 [jsDelivr](https://www.jsdelivr.com/) 当 CDN 服务它；`rspress.config.ts` 里的 `assetPrefix` 指向这个 jsDelivr 前缀。
- **只有那些 `.html` 壳发到妙搭**。浏览器打开妙搭给的 HTML → 主包 / 分包 / 搜索索引全部从 jsDelivr 加载，妙搭不碰资源。
- `base` 设为妙搭子路径 `/app/app_4k9smq6rdxher/`，路由链接走妙搭、资源链接走 jsDelivr，互不干扰。
- jsDelivr 对 **tag** 是不可变缓存（更新秒生效、免 purge），所以每次部署都发到一个**新的 tag 版本号**（`docs-assets-v1` → `v2` → …）。

> 选妙搭而不是妙笔：rspress 是多页框架，妙笔 HTML Box 是单页 + 无 same-origin 沙箱，跑不了 rspress 路由；妙搭支持多 HTML 路由，所以文档站在妙搭。

## 本地预览

```bash
cd docs-site
pnpm install
pnpm dev          # 本地热更新预览（assetPrefix 在本地不影响，直接读本地 static）
```

## 改内容

- 改 / 加某页 → 编辑 `docs/<id>.md`；新增页记得在 `rspress.config.ts` 的 `themeConfig.sidebar` 里挂上。
- 页面间跳转用站内路由：`[文字](/relay)`、`[文字](/slash-commands)`。
- **图片**：截图传 TOS（或任意公开图床）拿外链，markdown 里 `![](url)` 引用。
- **视频**：必须写在 **`.mdx`** 文件里（`.md` 里 `<video>` 会被解析器丢弃），用 JSX 形式：
  ```mdx
  <video src="https://.../x.mp4" controls preload="metadata" style={{ width: '100%', borderRadius: '8px' }}></video>
  ```
  视频建议先压一下（`ffmpeg -crf 30 -movflags +faststart`），`preload="metadata"` 让它点开才加载。

## 发布

```bash
cd docs-site
./deploy.sh 4      # 把资源发到 docs-assets-v4 并发布 HTML 壳；每次部署版本号 +1
```

`deploy.sh` 会：把 `assetPrefix` 指到新 tag → `rspress build` → 把 `static/` 推到该 tag（jsDelivr 立即可服务）→ 把 HTML 壳（去掉 `static/`）发到妙搭 app。

前提：`pnpm install` 过、`lark-cli auth login --domain apps` 登录过妙搭、能 ssh push 到 `deepcoldy/botmux`。妙搭 app（`app_4k9smq6rdxher`）绑定在文档维护者的妙搭账号下，更新官方站需由持有该账号的人来跑。
