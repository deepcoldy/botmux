# botmux 文档站

botmux 的中文功能文档站，发布在**飞书妙笔（HTML Box）**上。

- 线上地址：<https://magic.solutionsuite.cn/html-box/vkWHeJn1Fn2>
- 源码：本目录的 [`index.html`](./index.html)

## 形态

一个**自包含的单文件 HTML 应用**（妙笔 HTML Box 是「一个 HTML = 一个应用」模型，扛不了多页静态站，所以做成单页富 SPA）：

- 左侧导航树 + 站内搜索（`/` 唤起）+ 代码高亮 + 移动端自适应（汉堡菜单）
- 依赖（Tailwind / marked / highlight.js）走 CDN
- **文档内容**内嵌在 `<script type="text/markdown" data-doc="...">` 块里，写纯 Markdown 即可
- **导航结构**由 JS 里的 `NAV` 数组定义（每项 `[data-doc, 标题]`，需与某个 markdown 块的 `data-doc` 对应）
- 图片走 **TOS 外链**（不内联，保持 HTML 精简）

> ⚠️ 妙笔把页面跑在 **无 `allow-same-origin` 的 sandbox iframe** 里：写 `location.hash` 会触发 iframe 重载、把视图打回首页，所以路由不依赖 hash、点击直接 `render()`（代码里有 `IN_IFRAME` 判断）。改路由相关逻辑时注意这点。

## 维护（改内容）

直接编辑 `index.html`：

- 改/加某节内容 → 改对应的 `<script type="text/markdown" data-doc="xxx">` 块（纯 Markdown）。
- 加新一节 → 新增一个 markdown 块 + 在 `NAV` 数组里加一项指向它的 `data-doc`。
- 本地预览 → 浏览器直接打开 `index.html` 即可（本地非 iframe，hash 路由可用）。

### 加图片

截图 / GIF 先传 TOS 拿公开 URL，再在 Markdown 里 `![](url)` 外链（**不要内联 base64**，会撑大 HTML）：

```bash
# magic-builder 技能里的上传脚本
node <magic-builder>/upload-file-to-tos/scripts/upload.js ./your-image.png -q
```

## 发布（到飞书妙笔）

发布用妙笔官方的 **magic-builder** 技能，**token 只存在你本机、永不进仓库**：

1. 安装 magic-builder 技能：下载并解压 <https://magic-builder.tos-cn-beijing.volces.com/skills/magic-builder.skill.zip>
2. 拿**你自己的**妙笔开发 token：给妙笔机器人（<https://applink.larkoffice.com/T94fcr4NqQPz>）发 `dev`，复制返回的 token。
3. 存 token（写到 `~/.magic-token`，已被 `.gitignore` 忽略，**绝不要提交**）：
   ```bash
   node <magic-builder>/publish-magic-page/scripts/publish.js token <你的token>
   ```
4. 发布：
   ```bash
   node <magic-builder>/publish-magic-page/scripts/publish.js publish docs-site/index.html --title "botmux 文档"
   ```

### 谁能发布？会暴露我的 token 吗？

- **不会暴露**：token 只在各自本机的 `~/.magic-token` 里，从不进仓库。每个维护者用**自己的**妙笔账号 token。
- **人人可维护源码**：`index.html` 在仓库里，任何人都能改、提 PR。
- **关于官方线上 URL**：妙笔 app 绑定在「发布者的妙笔账号」下。
  - 用你自己的 token 首次发布，会在**你账号下新建一个 app**（你自己的预览 URL）——适合自测 / 预览。
  - 要更新**官方那个站**（`vkWHeJn1Fn2`），需由持有该 app 的妙笔账号 token 的人来发（magic-builder 按「相对路径 → remoteId」映射做原地更新，所以**在仓库根目录、用同一文件路径**发布即可命中原 app，不会产生重复）。

> 简言之：**源码人人可改、可各自发预览；官方站的更新由 owner 跑一条命令完成**。
