# E2E 浏览器测试设计

## 目标

为 botmux 构建基于浏览器的 E2E 测试框架，验证飞书网页版的完整消息流程：在话题群发送消息 → bot 创建话题并回复消息卡片。

测试用例可发布到 GitHub，零凭证泄露。任何人 clone 项目后，填入自己的飞书账号和 Midscene API key 即可运行。

## 技术栈

- **Midscene.js** (`@midscene/web`) — AI 视觉驱动的页面交互，用自然语言代替 CSS 选择器
- **Playwright** — 浏览器自动化引擎（Midscene 底层封装）
- **Vitest** — 测试运行器（复用项目现有配置）

## 凭证管理

所有敏感数据存放在 gitignored 文件中：

| 文件 | 内容 | 是否入 Git？ |
|------|------|-------------|
| `.env` | Midscene API key、飞书测试群 URL | 否（gitignored） |
| `storageState.json` | 飞书登录态（cookies/localStorage） | 否（gitignored） |
| `.env.example` | 变量模板，展示需要填写的内容 | 是 |

### `.env.example` 变量

```bash
# 飞书测试群 URL（bot 所在的话题群）
FEISHU_TEST_GROUP_URL=https://xxx.feishu.cn/next/messenger/...

# Midscene AI 模型配置
MIDSCENE_MODEL_NAME=your-model-name
MIDSCENE_MODEL_API_KEY=your-api-key
MIDSCENE_MODEL_BASE_URL=https://your-endpoint
MIDSCENE_MODEL_FAMILY=your-model-family
```

## 文件结构

```
test/e2e-browser/
  setup-login.ts          # 一次性登录脚本，生成 storageState.json
  feishu-bot-reply.e2e.ts # 核心测试：发消息 → bot 回复 → 验证卡片
  helpers.ts              # 共用工具（浏览器启动、page/agent 创建）
```

## 浏览器配置

```typescript
const BROWSER_CONFIG = {
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
};
```

### 系统字体要求

Headless Linux 环境需要安装字体以支持 emoji 和中文渲染：

- `fonts-noto-color-emoji` — 彩色 emoji 渲染
- `fonts-noto-cjk` — 中日韩字体支持

setup 脚本会检测字体是否已安装，缺失时打印安装命令。

## 使用流程

### 一次性准备

```bash
# 1. 安装依赖
pnpm install

# 2. 安装 Playwright 浏览器
npx playwright install chromium

# 3. 安装系统字体（如缺失）
apt install fonts-noto-color-emoji fonts-noto-cjk

# 4. 复制并填写环境变量
cp .env.example .env
# 编辑 .env，填入你的 Midscene API key 和飞书群 URL

# 5. 登录飞书（打开浏览器，手动登录）
pnpm test:e2e-browser:setup
# 脚本检测登录成功后自动保存 storageState.json
```

### 运行测试

```bash
pnpm test:e2e-browser
```

### npm Scripts

```json
{
  "test:e2e-browser:setup": "tsx test/e2e-browser/setup-login.ts",
  "test:e2e-browser": "vitest run test/e2e-browser/"
}
```

## 测试用例：feishu-bot-reply.e2e.ts

### 流程

1. 使用已保存的 `storageState.json` 启动 Chromium（视口 1920x1080）
2. 导航到 `.env` 中配置的飞书测试群 URL
3. 通过 Midscene AI 在输入框中输入测试消息（如 `"e2e-test-{timestamp}"`）并发送
4. 等待 bot 回复（Midscene `aiWaitFor`，带超时）
5. 断言 bot 的回复 / 消息卡片出现在话题中

### 关键决策

- **消息唯一性**：每次测试使用带时间戳的消息，避免冲突
- **超时时间**：60 秒等待 bot 回复（CLI 启动 + 首次响应可能较慢）
- **暂不测试卡片交互**：Phase 1 仅验证回复出现；卡片按钮测试后续扩展

## setup-login.ts

### 流程

1. **前置检查**：
   - Playwright 浏览器是否已安装？
   - 系统字体（emoji、CJK）是否已安装？
   - `.env` 文件是否存在且包含必要变量？
2. **打开浏览器**（有头模式，非 headless）至飞书登录页
3. **等待用户**手动完成登录
4. **检测登录成功**：通过 URL 变化或 messenger UI 元素判断
5. **保存** `storageState.json`（通过 `context.storageState({ path: ... })`）
6. **打印**成功信息并关闭浏览器

## helpers.ts

导出：
- `createBrowser()` — 启动 Chromium，应用浏览器配置
- `createPage(browser)` — 创建 context，加载 storageState + 视口 + 语言
- `createAgent(page)` — 用 Midscene `PlaywrightAgent` 封装 page
- `checkPrerequisites()` — 校验字体、环境变量、storageState 是否存在

## 后续扩展（不在本期范围）

框架支持后续添加以下测试场景：

- 卡片按钮交互测试（展开/收起、重启、关闭）
- Web Terminal 链接可访问性验证
- 多 bot @mention 路由测试
- 截图对比 / 视觉回归测试
