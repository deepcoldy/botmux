# 角色系统实施计划（spec v0.5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书 bot 内自然语言切换角色、每角色独立记忆、知识沉淀到飞书文档并可回流——botmux 侧只加三块通用代码（brandLabel 变量替换、TUI 注入队列 + botmux slash、botmux cd）。

**Architecture:** 方案 C（角色=工作目录 + Claude Code 原生 auto-memory + 会话内 /cd 注入切换）。角色库是文件系统（`~/botmux-roles/`），人设/协议随 cwd 的 CLAUDE.md 机制性加载，botmux 代码全部是 bot 无关的通用能力。spec 全文见 `docs/role-system-design.md`（真源为其头部飞书链接）。

**Tech Stack:** TypeScript (Node)、vitest（`pnpm test` = unit project）、飞书 OpenAPI（协议层，非本计划代码）。

## Global Constraints

- 运行时前提：目标 bot 的 Claude Code ≥ 2.1.205（会话内 /cd 已实测）；本计划代码不依赖该版本（能力位兜底冷启动）
- **读隔离红线**：`src/cli.ts` 新增命令的任何代码路径不得读 `bots.json` 或 `~/.botmux/.dashboard-secret`（后者被 Seatbelt deny）；自识别只用 env + 自身 sessions 文件
- **鉴权（对 spec 11.1 的修正）**：cd/slash IPC 路由采用与 suspend/resume 相同的 loopback 信任（不加 HMAC 签名头）。原因：签名要读 `.dashboard-secret`，隔离 bot 读不到；先例：`dashboard-ipc-server.ts:159-165` 注释明确 suspend/close/resume 均 loopback 信任。安全边界由角色库根校验 + allowlist 承担
- 存量零影响约束：brandLabel 不含 `{` 时行为分毫不变；`tuiSlashAllow` 缺省 = slash 全拒；`/cd` 话题命令行为除「落盘改存 resolvedPath」外不变
- 角色库根：`~/botmux-roles`（常量，v0 不做配置）
- commit 格式 `type(scope): 中文`；每个 PR 合入前 `pnpm build` + `pnpm test` 全绿；live 验证 `pnpm switch:here && botmux restart`
- 每完成一个 Task 即 commit；PR 描述按仓库规范写影响面评估与实测记录

---

## PR1｜feat(card): brandLabel 变量替换（分支 `feat/brand-template`）

### Task 1: brand-template 纯函数 + 单测

**Files:**
- Create: `src/im/lark/brand-template.ts`
- Test: `test/brand-template.test.ts`

**Interfaces:**
- Produces: `renderBrandTemplate(brand: string | undefined, workingDir: string | undefined): string | undefined`；`readDirMeta(workingDir: string): { url?: string; name?: string }`（Task 2 消费）

- [ ] **Step 1: 写失败的测试**

```ts
// test/brand-template.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBrandTemplate } from '../src/im/lark/brand-template.js';

describe('renderBrandTemplate', () => {
  it('不含 { 的模板原样返回（含 undefined/空串/默认值）', () => {
    expect(renderBrandTemplate(undefined, '/tmp/x')).toBeUndefined();
    expect(renderBrandTemplate('', '/tmp/x')).toBe('');
    expect(renderBrandTemplate('[botmux](https://github.com/deepcoldy/botmux)', '/tmp/x'))
      .toBe('[botmux](https://github.com/deepcoldy/botmux)');
  });

  it('{cwdName} 取目录 basename，{cwd} 取全路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    expect(renderBrandTemplate('{cwdName}', dir)).toBe(basename(dir));
    expect(renderBrandTemplate('{cwd}', dir)).toBe(dir);
  });

  it('.botmux-dir.json 的 name 覆盖 basename、url 填充 {cwdUrl}', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: '售后客服', url: 'https://x.feishu.cn/docx/abc' }));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe('[售后客服](https://x.feishu.cn/docx/abc)');
  });

  it('url 缺失时空链接降级为纯文本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe(basename(dir));
  });

  it('workingDir 为 undefined 时变量替换为空串并降级', () => {
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', undefined)).toBe('');
  });

  it('元文件损坏时按不存在处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, '.botmux-dir.json'), '{not json');
    expect(renderBrandTemplate('{cwdName}', dir)).toBe(basename(dir));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/brand-template.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/im/lark/brand-template.ts
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface DirMeta { url?: string; name?: string }

let cache: { path: string; mtimeMs: number; meta: DirMeta } | null = null;

/** 读取目录元数据 <workingDir>/.botmux-dir.json（mtime 缓存；缺失/损坏 → {}）。 */
export function readDirMeta(workingDir: string): DirMeta {
  const p = join(workingDir, '.botmux-dir.json');
  try {
    const st = statSync(p);
    if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs) return cache.meta;
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const meta: DirMeta = {
      url: typeof raw?.url === 'string' ? raw.url : undefined,
      name: typeof raw?.name === 'string' ? raw.name : undefined,
    };
    cache = { path: p, mtimeMs: st.mtimeMs, meta };
    return meta;
  } catch {
    return {};
  }
}

/**
 * brandLabel 变量替换：{cwdName}（元数据 name → basename）、{cwd}、{cwdUrl}。
 * 仅当模板含 '{' 时激活（存量签名零影响）；替换后空链接 [x]() 降级为纯文本 x。
 */
export function renderBrandTemplate(
  brand: string | undefined,
  workingDir: string | undefined,
): string | undefined {
  if (brand === undefined || !brand.includes('{')) return brand;
  const wd = workingDir ?? '';
  const meta = wd ? readDirMeta(wd) : {};
  const rendered = brand
    .replaceAll('{cwdName}', wd ? (meta.name ?? basename(wd)) : '')
    .replaceAll('{cwd}', wd)
    .replaceAll('{cwdUrl}', meta.url ?? '');
  return rendered.replace(/\[([^\]]*)\]\(\)/g, '$1');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/brand-template.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/im/lark/brand-template.ts test/brand-template.test.ts
git commit -m "feat(card): brandLabel 模板变量替换 helper（{cwdName}/{cwd}/{cwdUrl} + 空链接降级）"
```

### Task 2: 接线两处调用点 + dashboard 帮助文案

**Files:**
- Modify: `src/core/worker-pool.ts:2646-2659`（buildContextualReplyCard 的 `brand:` 与 buildMarkdownCard 的第三参）
- Modify: `src/cli.ts:5016`（cmdSend footer 的 brandFooterSegment 入参）
- Modify: dashboard 中 brandLabel 帮助文案（Step 3 grep 定位）

**Interfaces:**
- Consumes: Task 1 的 `renderBrandTemplate`
- Produces: 无新接口（行为接线）

- [ ] **Step 1: worker-pool 接线**

`src/core/worker-pool.ts` 顶部（第 29 行 import 区）加：
```ts
import { renderBrandTemplate } from '../im/lark/brand-template.js';
```
2656 行 `brand: resolveBrandLabel(ds.larkAppId),` 改为：
```ts
brand: renderBrandTemplate(resolveBrandLabel(ds.larkAppId), ds.workingDir),
```
2659 行 `buildMarkdownCard(msg.content, recipientOpenId, resolveBrandLabel(ds.larkAppId), localeForBot(ds.larkAppId));` 改为：
```ts
buildMarkdownCard(msg.content, recipientOpenId, renderBrandTemplate(resolveBrandLabel(ds.larkAppId), ds.workingDir), localeForBot(ds.larkAppId));
```

- [ ] **Step 2: cmdSend 接线（沙箱安全：只读会话工作目录下的元文件，不碰 bots.json）**

`src/cli.ts:4381` 附近 import 区加：
```ts
import { renderBrandTemplate } from './im/lark/brand-template.js';
```
5016 行 `const brandSeg = brandFooterSegment(resolveBrandLabel(appId));` 改为（`s` 即 4569 行取到的 session 记录）：
```ts
const brandSeg = brandFooterSegment(renderBrandTemplate(resolveBrandLabel(appId), s.workingDir));
```

- [ ] **Step 3: 更新 dashboard 帮助文案**

Run: `grep -rn "卡片页脚签名" src/`
Expected: 命中 dashboard web 页的帮助字符串（含「留空保存＝不显示」）。在该字符串末尾追加：
```
支持变量：{cwdName}=会话当前目录显示名（.botmux-dir.json 的 name，缺省目录名）、{cwd}=完整路径、{cwdUrl}=目录下 .botmux-dir.json 的 url；空链接自动降级纯文本。例：[{cwdName}]({cwdUrl})
```
若该文案存在 zh/en 两份（grep "card footer" 或英文对应），两份都改。

- [ ] **Step 4: 构建 + 全量单测**

Run: `pnpm build && pnpm test`
Expected: 通过；无既有测试回归

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(card): 回复卡与 botmux send 脚注接入 brandLabel 变量替换，更新 dashboard 帮助文案"
```

- [ ] **Step 6: live 验证（PR 描述附截图）**

```bash
pnpm switch:here && botmux restart
```
把某测试 bot 的 brandLabel 配为 `[{cwdName}]({cwdUrl})`，在其工作目录放 `.botmux-dir.json`（含 url），飞书发消息验证：脚注显示目录名且可点击；去掉 url 后为纯文本；未配模板的 bot 脚注不变。截图入 PR。

---

## PR2｜feat(core): TUI 注入队列 + botmux slash（分支 `feat/tui-inject`，可与 PR1 并行）

### Task 3: worker 侧 inject_command 队列

**Files:**
- Modify: `src/types.ts:323` 附近（DaemonToWorker union）
- Modify: `src/worker.ts`（新增队列 + case + markPromptReady 钩子）

**Interfaces:**
- Produces: DaemonToWorker 新成员 `{ type: 'inject_command'; command: string }`（Task 5/PR3 Task 9 消费）；语义 = 排队，会话 idle（isPromptReady）时经 `sendRawCommandLine` 敲入 TUI

- [ ] **Step 1: types.ts 加消息类型**

在 `src/types.ts:323`（`tui_keys` 行）旁加入：
```ts
  | { type: 'inject_command'; command: string }
```

- [ ] **Step 2: worker.ts 实现队列**

在 `handleTuiKeys`（worker.ts:2873）附近新增：
```ts
const pendingInjections: string[] = [];
let injectionFlushing = false;

/** 排队注入一行 TUI 命令：idle（isPromptReady）时经 sendRawCommandLine 敲入。 */
async function flushPendingInjections(): Promise<void> {
  if (injectionFlushing) return;
  injectionFlushing = true;
  try {
    while (pendingInjections.length > 0 && backend && isPromptReady) {
      const cmd = pendingInjections.shift()!;
      isPromptReady = false;
      idleDetector?.reset();
      await sendRawCommandLine(backend, cmd);
      await awaitPtyQuiescence(STARTUP_CMD_QUIET_MS, STARTUP_CMD_CAP_MS);
      log(`Injected command: ${cmd}`);
    }
  } finally {
    injectionFlushing = false;
  }
}
```
消息分发处（worker.ts:6001 的 `case 'tui_keys'` 旁）加：
```ts
    case 'inject_command': {
      pendingInjections.push(msg.command);
      void flushPendingInjections();
      break;
    }
```
`markPromptReady()`（worker.ts:3178）函数末尾（send prompt_ready 之后）加：
```ts
  if (pendingInjections.length > 0) void flushPendingInjections();
```

- [ ] **Step 3: 构建确认无类型错误**

Run: `pnpm build`
Expected: 通过（该逻辑在 worker 进程内，单测由 Task 4 的纯函数与 live 验证覆盖）

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/worker.ts
git commit -m "feat(worker): inject_command 消息——idle 后向 TUI 注入一行命令的共享队列"
```

### Task 4: slash 校验纯函数 + tuiSlashAllow 配置字段 + 单测

**Files:**
- Create: `src/core/slash-inject.ts`
- Modify: `src/bot-registry.ts`（接口字段 ~474 行、解析 ~1099-1108 模式、对象字面量 ~1195、新增只读 accessor）
- Test: `test/slash-inject.test.ts`

**Interfaces:**
- Produces: `validateSlashInjection(command: string, allowlist: readonly string[] | undefined): { ok: true; command: string } | { ok: false; error: string }`；`BotConfig.tuiSlashAllow?: string[]`；`getBotTuiSlashAllow(larkAppId: string): string[] | undefined`（Task 5 消费）

- [ ] **Step 1: 写失败的测试**

```ts
// test/slash-inject.test.ts
import { describe, expect, it } from 'vitest';
import { validateSlashInjection } from '../src/core/slash-inject.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';

describe('validateSlashInjection', () => {
  const allow = ['/compact', '/model'];
  it('放行 allowlist 内的单行斜杠命令（带参数）', () => {
    expect(validateSlashInjection('/model opus', allow)).toEqual({ ok: true, command: '/model opus' });
  });
  it('拒绝非斜杠开头 / 多行 / 空串', () => {
    expect(validateSlashInjection('rm -rf /', allow).ok).toBe(false);
    expect(validateSlashInjection('/compact\n恶意第二行', allow).ok).toBe(false);
    expect(validateSlashInjection('  ', allow).ok).toBe(false);
  });
  it('/cd 固定禁止——即使在 allowlist 里', () => {
    const r = validateSlashInjection('/cd /tmp', ['/cd']);
    expect(r).toEqual({ ok: false, error: 'command_forbidden' });
  });
  it('allowlist 缺省/为空 → 全拒（默认关闭）', () => {
    expect(validateSlashInjection('/compact', undefined).ok).toBe(false);
    expect(validateSlashInjection('/compact', []).ok).toBe(false);
  });
  it('不在 allowlist 内 → 拒绝', () => {
    expect(validateSlashInjection('/logout', allow)).toEqual({ ok: false, error: 'not_in_allowlist' });
  });
});

describe('bots.json tuiSlashAllow 解析', () => {
  it('归一化：补斜杠、去重、丢弃非法项', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_test', larkAppSecret: 's',
      tuiSlashAllow: ['compact', '/Model', '/compact', 'bad name!', 42],
    }]));
    expect(cfgs[0].tuiSlashAllow).toEqual(['/compact', '/model']);
  });
  it('缺省为 undefined', () => {
    const cfgs = parseBotConfigsFromText(JSON.stringify([{ larkAppId: 'cli_test', larkAppSecret: 's' }]));
    expect(cfgs[0].tuiSlashAllow).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/slash-inject.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 validateSlashInjection**

```ts
// src/core/slash-inject.ts
/** 通用注入通道禁止的命令：改变 daemon 记录所描述状态的命令必须走专用路由（如 botmux cd）。 */
const FORBIDDEN = new Set(['/cd']);

export function validateSlashInjection(
  command: string,
  allowlist: readonly string[] | undefined,
): { ok: true; command: string } | { ok: false; error: string } {
  const cmd = command.trim();
  if (!cmd.startsWith('/')) return { ok: false, error: 'not_slash_command' };
  if (/[\r\n]/.test(cmd)) return { ok: false, error: 'multiline_rejected' };
  const name = cmd.split(/\s+/)[0].toLowerCase();
  if (FORBIDDEN.has(name)) return { ok: false, error: 'command_forbidden' };
  if (!allowlist || allowlist.length === 0) return { ok: false, error: 'allowlist_empty' };
  if (!allowlist.includes(name)) return { ok: false, error: 'not_in_allowlist' };
  return { ok: true, command: cmd };
}
```

- [ ] **Step 4: bot-registry 加字段与 accessor**

接口（`src/bot-registry.ts:474` brandLabel 旁）：
```ts
  /**
   * botmux slash 可注入的 CLI 原生斜杠命令 allowlist（如 ["/compact","/model"]）。
   * 缺省/空 = 通用注入关闭。/cd 永远被拒（见 core/slash-inject.ts）。
   */
  tuiSlashAllow?: string[];
```
解析（照抄 1099-1108 的 customPassthroughCommands 模式，放其后）：
```ts
    let tuiSlashAllow: string[] | undefined;
    if (Array.isArray(entry.tuiSlashAllow)) {
      const normalized = entry.tuiSlashAllow
        .filter((x: any): x is string => typeof x === 'string')
        .map((x: string) => x.trim().toLowerCase())
        .map((x: string) => (x.startsWith('/') ? x : `/${x}`))
        .filter((x: string) => /^\/[a-z0-9][a-z0-9:_-]*$/.test(x));
      const uniq = [...new Set<string>(normalized)];
      if (uniq.length > 0) tuiSlashAllow = uniq;
    }
```
对象字面量（~1195 行 `customPassthroughCommands,` 旁）加 `tuiSlashAllow,`。
只读 accessor（仿 `resolveBrandLabel`，bot-registry.ts:905 旁；daemon 内存态即可，无需磁盘回退）：
```ts
export function getBotTuiSlashAllow(larkAppId: string): string[] | undefined {
  return bots.get(larkAppId)?.config.tuiSlashAllow;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run test/slash-inject.test.ts && pnpm test`
Expected: 新用例 PASS，全量无回归。若 `parseBotConfigsFromText` 的导出签名与用例不符（以 `src/bot-registry.ts:970` 实际签名为准）调整用例调用方式。

- [ ] **Step 6: Commit**

```bash
git add src/core/slash-inject.ts src/bot-registry.ts test/slash-inject.test.ts
git commit -m "feat(core): slash 注入校验（/ 开头单行、/cd 固定禁止）+ bots.json tuiSlashAllow 字段"
```

### Task 5: IPC 路由 POST /api/sessions/:id/slash

**Files:**
- Modify: `src/core/dashboard-ipc-server.ts`（suspend 路由 292-316 之后新增）

**Interfaces:**
- Consumes: Task 3 `inject_command`、Task 4 `validateSlashInjection`/`getBotTuiSlashAllow`
- Produces: `POST /api/sessions/:sessionId/slash`，body `{ command: string }`，200 `{ok:true,queued}` / 403 `{ok:false,error}` / 404 / 409（Task 6 消费）

- [ ] **Step 1: 实现路由（loopback 信任，同 suspend；安全边界=allowlist+校验）**

在 suspend 路由后新增（import 区补 `validateSlashInjection`、`getBotTuiSlashAllow`、`DaemonToWorker`）：
```ts
/** 向本会话 CLI 注入一条 allowlist 内的原生斜杠命令（idle 后生效）。
 *  Loopback-trusted（同 suspend/resume）：签名所需 .dashboard-secret 被读隔离
 *  deny，沙箱内 CLI 无法签名；安全边界由 allowlist（默认空=全拒）承担。 */
ipcRoute('POST', '/api/sessions/:sessionId/slash', async (req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  if (!ds.worker || ds.worker.killed) return jsonRes(res, 409, { ok: false, error: 'no_live_worker' });
  const body = await readJsonBody<{ command?: string }>(req).catch(() => ({} as { command?: string }));
  const allow = ds.session.larkAppId ? getBotTuiSlashAllow(ds.session.larkAppId) : undefined;
  const v = validateSlashInjection(body?.command ?? '', allow);
  if (!v.ok) return jsonRes(res, 403, { ok: false, error: v.error });
  ds.worker.send({ type: 'inject_command', command: v.command } as DaemonToWorker);
  jsonRes(res, 200, { ok: true, sessionId: params.sessionId, queued: v.command });
});
```

- [ ] **Step 2: 构建 + 全量测试 + Commit**

Run: `pnpm build && pnpm test` → PASS
```bash
git add src/core/dashboard-ipc-server.ts
git commit -m "feat(ipc): /api/sessions/:id/slash 注入路由（allowlist 门禁，loopback 信任同 suspend）"
```

### Task 6: cmdSlash CLI 命令 + help

**Files:**
- Modify: `src/cli.ts`（cmdSuspend 3137 附近新增 cmdSlash；switch 6546 加 case；showHelp 3600 区加行）

**Interfaces:**
- Consumes: Task 5 路由；`findAncestorSessionContext`（cli.ts 现有，`botmux schedule` 同款自识别）、`findDaemon`（cli.ts:3259）
- Produces: `botmux slash "<斜杠命令>" [--session <id>]`

- [ ] **Step 1: 确认自识别函数签名**

Run: `grep -n "function findAncestorSessionContext\|findAncestorSessionContext(" src/cli.ts | head -5`
Expected: 得到函数定义行与返回结构（含 sessionId）。cmdSlash 按该实际签名取 sessionId；无 marker/env 时它返回空 → 报错退出。

- [ ] **Step 2: 实现 cmdSlash（红线：不读 bots.json / .dashboard-secret）**

```ts
/** botmux slash "<斜杠命令>"：请求 daemon 在本会话 idle 后把命令敲入自己的 CLI。
 *  自识别当前会话（pid marker → BOTMUX_SESSION_ID env），allowlist 由 daemon 侧校验。 */
async function cmdSlash(): Promise<void> {
  const argv = process.argv.slice(3);
  const sIdx = argv.indexOf('--session');
  const explicitSid = sIdx >= 0 ? argv[sIdx + 1] : undefined;
  const command = argv.filter((a, i) => !a.startsWith('--') && !(sIdx >= 0 && i === sIdx + 1))[0];
  if (!command) { console.error('用法: botmux slash "/compact" [--session <id>]'); process.exit(1); }

  const ctx = explicitSid ? null : findAncestorSessionContext();
  const sid = explicitSid ?? ctx?.sessionId;
  if (!sid) { console.error('❌ 无法定位当前会话（需在 bot 会话内执行，或用 --session 指定）'); process.exit(1); }
  const sessions = loadSessions();
  const s = [...sessions.values()].find(x => x.sessionId === sid || x.sessionId.startsWith(sid));
  if (!s) { console.error(`❌ 未找到 session ${sid}`); process.exit(1); }
  const daemon = findDaemon(s.larkAppId);
  if (!daemon) { console.error('❌ daemon 不在线'); process.exit(1); }
  const res = await fetch(
    `http://127.0.0.1:${daemon.ipcPort}/api/sessions/${encodeURIComponent(s.sessionId)}/slash`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command }) },
  );
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && body?.ok) { console.log(`✓ 已排队注入: ${body.queued}（会话空闲时执行）`); return; }
  console.error(`✗ 被拒绝: ${body?.error ?? `HTTP ${res.status}`}`);
  process.exit(1);
}
```
switch（cli.ts:6547 `case 'suspend'` 旁）加：
```ts
  case 'slash':   await cmdSlash(); break;
```
showHelp（3602 suspend 行后）加：
```
  slash "<斜杠命令>"   会话空闲后向本会话 CLI 注入一条原生斜杠命令（需 bots.json 配 tuiSlashAllow；/cd 恒被拒）
```

- [ ] **Step 3: 构建 + Commit**

Run: `pnpm build && pnpm test` → PASS
```bash
git add src/cli.ts
git commit -m "feat(cli): botmux slash——会话内请求向自身 CLI 注入 allowlist 内的斜杠命令"
```

- [ ] **Step 4: live 验证（PR 描述附记录）**

`pnpm switch:here && botmux restart`；给测试 bot 配 `"tuiSlashAllow": ["/compact"]`；飞书里让 bot 执行 `botmux slash "/compact"`：观察本轮结束后 TUI 自动执行 /compact；再验证 `botmux slash "/cd /tmp"` 与未配 allowlist 的 bot 均被 403 拒绝；隔离 bot 内执行同样可用（全程未读 bots.json）。

---

## PR3｜feat(core): botmux cd（分支 `feat/botmux-cd`，依赖 PR2 合入）

### Task 7: 角色库路径校验 + 单测

**Files:**
- Create: `src/core/role-library.ts`
- Test: `test/role-library.test.ts`

**Interfaces:**
- Produces: `validateRoleLibraryPath(input: string, rootOverride?: string): { ok: true; resolvedPath: string } | { ok: false; error: string }`；`roleLibraryRoot(): string`（= `~/botmux-roles`）（Task 9 消费）

- [ ] **Step 1: 写失败的测试**

```ts
// test/role-library.test.ts
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRoleLibraryPath } from '../src/core/role-library.js';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'rolelib-'));
  const root = join(base, 'botmux-roles');
  mkdirSync(join(root, 'users', 'ou_x', '产品经理'), { recursive: true });
  return { base, root };
}

describe('validateRoleLibraryPath', () => {
  it('放行根下的角色目录（返回 realpath）', () => {
    const { root } = setup();
    const r = validateRoleLibraryPath(join(root, 'users', 'ou_x', '产品经理'), root);
    expect(r.ok).toBe(true);
  });
  it('拒绝根之外的目录与 .. 穿越', () => {
    const { base, root } = setup();
    expect(validateRoleLibraryPath(base, root).ok).toBe(false);
    expect(validateRoleLibraryPath(join(root, 'users', '..', '..'), root).ok).toBe(false);
  });
  it('拒绝符号链接逃逸', () => {
    const { base, root } = setup();
    const outside = join(base, 'secret'); mkdirSync(outside);
    symlinkSync(outside, join(root, 'evil'));
    const r = validateRoleLibraryPath(join(root, 'evil'), root);
    expect(r).toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('拒绝前缀兄弟目录（botmux-roles-evil）', () => {
    const { base, root } = setup();
    mkdirSync(join(base, 'botmux-roles-evil'));
    expect(validateRoleLibraryPath(join(base, 'botmux-roles-evil'), root))
      .toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('拒绝不存在的路径与文件', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath(join(root, 'nope'), root).ok).toBe(false);
    const f = join(root, 'a.txt'); writeFileSync(f, 'x');
    expect(validateRoleLibraryPath(f, root)).toEqual({ ok: false, error: 'not_a_directory' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/role-library.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// src/core/role-library.ts
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/** 角色库根：v0 固定约定，不做配置。 */
export function roleLibraryRoot(): string {
  return join(homedir(), 'botmux-roles');
}

/**
 * botmux cd 的目标目录硬校验（调用方是模型，不可信）：
 * realpath 归一化（防 ../ 与符号链接逃逸）→ 必须位于角色库根之下（带尾分隔符、
 * darwin 大小写不敏感比较，防前缀兄弟目录）→ 必须是已存在的目录。
 */
export function validateRoleLibraryPath(
  input: string,
  rootOverride?: string,
): { ok: true; resolvedPath: string } | { ok: false; error: string } {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, error: 'empty_path' };
  let rootReal: string;
  try { rootReal = realpathSync(rootOverride ?? roleLibraryRoot()); }
  catch { return { ok: false, error: 'role_library_missing' }; }
  let real: string;
  try { real = realpathSync(raw); }
  catch { return { ok: false, error: 'dir_not_found' }; }
  const norm = process.platform === 'darwin' ? (s: string) => s.toLowerCase() : (s: string) => s;
  if (norm(real) !== norm(rootReal) && !norm(real).startsWith(norm(rootReal) + sep)) {
    return { ok: false, error: 'outside_role_library' };
  }
  if (norm(real) === norm(rootReal)) return { ok: false, error: 'outside_role_library' };
  try { if (!statSync(real).isDirectory()) return { ok: false, error: 'not_a_directory' }; }
  catch { return { ok: false, error: 'dir_not_found' }; }
  return { ok: true, resolvedPath: real };
}
```

- [ ] **Step 4: 跑测试确认通过 + Commit**

Run: `pnpm vitest run test/role-library.test.ts` → PASS
```bash
git add src/core/role-library.ts test/role-library.test.ts
git commit -m "feat(core): 角色库路径硬校验（realpath 防逃逸 + 根包含性）"
```

### Task 8: 抽取 /cd 重钉共享函数（含 resolvedPath 落盘修正）

**Files:**
- Create: `src/core/session-cwd.ts`
- Modify: `src/core/command-handler.ts:1260-1264`

**Interfaces:**
- Produces: `repinSessionWorkingDir(ds: DaemonSession, resolvedPath: string): void`（内存 + 落盘；Task 9 消费）

- [ ] **Step 1: 确认 sessionStore 的引用方式**

Run: `grep -n "sessionStore" src/core/command-handler.ts | head -3`
Expected: 找到 import 来源（如 `import { sessionStore } from '...'` 或经 deps 注入）。session-cwd.ts 按同源引用。

- [ ] **Step 2: 实现共享函数**

```ts
// src/core/session-cwd.ts
import type { DaemonSession } from './types.js';
// import { sessionStore } from '<Step 1 确认的同源路径>';

/**
 * 重钉一个话题会话的工作目录（daemon 记录 = 唯一事实源）：
 * 内存（ds.workingDir / ds.session.workingDir）+ sessions 文件落盘。
 * 注意统一存 resolvedPath（修正 /cd 历史行为：曾存用户原始输入如 "~/x"）。
 */
export function repinSessionWorkingDir(ds: DaemonSession, resolvedPath: string): void {
  ds.workingDir = resolvedPath;
  ds.session.workingDir = resolvedPath;
  sessionStore.updateSession(ds.session);
}
```

- [ ] **Step 3: 改写 /cd case 调用共享函数**

`command-handler.ts:1260-1264` 改为：
```ts
        const resolvedPath = validation.resolvedPath;
        killWorker(ds);
        repinSessionWorkingDir(ds, resolvedPath);
```
（import 区加 `import { repinSessionWorkingDir } from './session-cwd.js';`。行为微调：落盘由原始输入改为 resolvedPath——PR 描述影响面里注明，dashboard 展示的路径形态可能从 `~/x` 变绝对路径。）

- [ ] **Step 4: 构建 + 全量测试 + Commit**

Run: `pnpm build && pnpm test` → PASS（若有既有 /cd 测试断言原始路径，改为断言 resolvedPath）
```bash
git add src/core/session-cwd.ts src/core/command-handler.ts
git commit -m "refactor(core): /cd 重钉逻辑抽共享函数，统一落盘 resolvedPath"
```

### Task 9: 适配器能力位 + IPC cd 路由

**Files:**
- Modify: `src/adapters/cli/types.ts`（CliAdapter 接口，`supportsReadIsolation` 253 行旁）
- Modify: `src/adapters/cli/claude-code.ts:457` 附近（createClaudeFamilyAdapter 返回对象）
- Modify: `src/core/dashboard-ipc-server.ts`（新路由）
- Test: `test/cli-adapters.test.ts`（追加断言）

**Interfaces:**
- Consumes: Task 3 `inject_command`、Task 7 `validateRoleLibraryPath`、Task 8 `repinSessionWorkingDir`
- Produces: `CliAdapter.supportsSessionCwdMove?: boolean`；`POST /api/sessions/:sessionId/cd` body `{ dir: string }` → 200 `{ok:true, mode:'inject'|'cold-restart', dir}` / 400 / 403 / 404

- [ ] **Step 1: 接口与 claude 家族置位**

`types.ts`（253 行 `supportsReadIsolation` 旁）：
```ts
  /** CLI 支持会话内移动工作目录（如 Claude Code ≥2.1.205 的 /cd）。
   *  true → botmux cd 走 idle 注入（不重启进程）；缺省 → 杀进程冷启动兜底。 */
  readonly supportsSessionCwdMove?: boolean;
```
`claude-code.ts:457`（`supportsReadIsolation: true,` 旁）加：
```ts
    supportsSessionCwdMove: true,
```
`test/cli-adapters.test.ts` 追加：
```ts
  it('supportsSessionCwdMove：claude-code true，codex 缺省', () => {
    expect(createCliAdapterSync('claude-code').supportsSessionCwdMove).toBe(true);
    expect(createCliAdapterSync('codex').supportsSessionCwdMove).toBeUndefined();
  });
```
（该测试文件的现有 import 已含 `createCliAdapterSync`；若无则从 `../src/adapters/cli/registry.js` 引入。）

- [ ] **Step 2: 确认 ds 上的 cliId 字段名**

Run: `grep -n "cliId" src/core/types.ts | head -10`
Expected: 找到 DaemonSession/SessionInfo 上承载 CLI 类型的字段（如 `ds.session.cliId` 或 `ds.initConfig.cliId`）。路由代码按实际字段取值。

- [ ] **Step 3: 实现 cd 路由（slash 路由旁）**

```ts
/** 会话内切换工作目录（角色切换专用）：硬校验角色库根 → 更新记录落盘（唯一事实源）
 *  → 按能力位选择 idle 注入 /cd（进程不死）或杀进程冷启动兜底。
 *  Loopback-trusted 同 suspend；不发话题消息（AI 自己发角色化确认）。 */
ipcRoute('POST', '/api/sessions/:sessionId/cd', async (req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (!ds) return jsonRes(res, 404, { ok: false, error: 'session_not_active' });
  const body = await readJsonBody<{ dir?: string }>(req).catch(() => ({} as { dir?: string }));
  const v = validateRoleLibraryPath(body?.dir ?? '');
  if (!v.ok) {
    return jsonRes(res, v.error === 'outside_role_library' ? 403 : 400, { ok: false, error: v.error });
  }
  repinSessionWorkingDir(ds, v.resolvedPath);
  const cliId = /* Step 2 确认的字段 */ ds.session.cliId;
  let canInject = false;
  try { canInject = !!(cliId && createCliAdapterSync(cliId as CliId).supportsSessionCwdMove); } catch { /* unknown cli */ }
  if (ds.worker && !ds.worker.killed && canInject) {
    ds.worker.send({ type: 'inject_command', command: `/cd ${v.resolvedPath}` } as DaemonToWorker);
    return jsonRes(res, 200, { ok: true, mode: 'inject', dir: v.resolvedPath });
  }
  if (ds.worker && !ds.worker.killed) killWorker(ds);
  jsonRes(res, 200, { ok: true, mode: 'cold-restart', dir: v.resolvedPath });
});
```
（import 区补：`validateRoleLibraryPath`、`repinSessionWorkingDir`、`createCliAdapterSync`、`killWorker`（第 58 行已有 suspendWorker/forkWorker 同源）、`CliId` 类型。）

- [ ] **Step 4: 构建 + 测试 + Commit**

Run: `pnpm build && pnpm test` → PASS
```bash
git add src/adapters/cli/types.ts src/adapters/cli/claude-code.ts src/core/dashboard-ipc-server.ts test/cli-adapters.test.ts
git commit -m "feat(ipc): /api/sessions/:id/cd 角色切换路由 + supportsSessionCwdMove 能力位"
```

### Task 10: cmdCd CLI 命令 + help

**Files:**
- Modify: `src/cli.ts`（cmdSlash 旁新增 cmdCd；switch 加 case；showHelp 加行）

**Interfaces:**
- Consumes: Task 9 路由
- Produces: `botmux cd <目标目录> [--session <id>]`

- [ ] **Step 1: 实现 cmdCd（与 cmdSlash 同构；红线同样适用）**

```ts
/** botmux cd <角色目录>：请求 daemon 重钉本话题工作目录（角色切换）。
 *  daemon 侧校验目录必须在 ~/botmux-roles 下；Claude 家族 idle 注入 /cd 不重启，
 *  其余 CLI 杀进程冷启动。协议要求本命令是该轮最后一个动作。 */
async function cmdCd(): Promise<void> {
  const argv = process.argv.slice(3);
  const sIdx = argv.indexOf('--session');
  const explicitSid = sIdx >= 0 ? argv[sIdx + 1] : undefined;
  const dir = argv.filter((a, i) => !a.startsWith('--') && !(sIdx >= 0 && i === sIdx + 1))[0];
  if (!dir) { console.error('用法: botmux cd <目标目录> [--session <id>]'); process.exit(1); }

  const ctx = explicitSid ? null : findAncestorSessionContext();
  const sid = explicitSid ?? ctx?.sessionId;
  if (!sid) { console.error('❌ 无法定位当前会话（需在 bot 会话内执行，或用 --session 指定）'); process.exit(1); }
  const sessions = loadSessions();
  const s = [...sessions.values()].find(x => x.sessionId === sid || x.sessionId.startsWith(sid));
  if (!s) { console.error(`❌ 未找到 session ${sid}`); process.exit(1); }
  const daemon = findDaemon(s.larkAppId);
  if (!daemon) { console.error('❌ daemon 不在线'); process.exit(1); }
  const res = await fetch(
    `http://127.0.0.1:${daemon.ipcPort}/api/sessions/${encodeURIComponent(s.sessionId)}/cd`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir }) },
  );
  const body: any = await res.json().catch(() => ({}));
  if (res.ok && body?.ok) {
    console.log(body.mode === 'inject'
      ? `✓ 已切换到 ${body.dir}（会话空闲时生效，进程不重启）`
      : `✓ 已切换到 ${body.dir}（下条消息在新目录冷启动）`);
    return;
  }
  console.error(`✗ 切换被拒绝: ${body?.error ?? `HTTP ${res.status}`}`);
  process.exit(1);
}
```
switch 加 `case 'cd': await cmdCd(); break;`；showHelp 加：
```
  cd <目录>        （会话内）切换本话题工作目录到角色库内的目录——角色切换用；
                   目录必须位于 ~/botmux-roles 之下
```

- [ ] **Step 2: 构建 + 测试 + Commit**

Run: `pnpm build && pnpm test` → PASS
```bash
git add src/cli.ts
git commit -m "feat(cli): botmux cd——会话内切换话题工作目录（角色切换入口）"
```

- [ ] **Step 3: live 验证（PR 描述附记录 + 截图）**

`pnpm switch:here && botmux restart`；建最小角色树（`~/botmux-roles/<bot>/shared/默认助理` + `users/<open_id>/测试角色`，各放不同 CLAUDE.md）；飞书话题内让 bot 执行 `botmux cd`：验证 ①注入模式生效、人设变化、上下文保留 ②脚注随切换变化（PR1 已并入时）③`botmux cd /tmp` 被 403 ④记忆桶按新目录分桶（`~/.botmux/bots/<appId>/claude/projects/` 出现新 slug）⑤挂起会话时 cd → mode=cold-restart，下条消息新目录生效 ⑥隔离 bot 全链路可用。

---

## PR4｜docs(roles): 协议模板 + 部署 runbook（分支 `docs/role-protocol`，无代码依赖）

### Task 11: 角色协议模板、CLAUDE.md 模板与 runbook

**Files:**
- Create: `docs/roles/role-protocol-template.md`（= 部署时的 `~/botmux-roles/<bot>/_role-protocol.md`）
- Create: `docs/roles/role-claude-md-template.md`（角色目录 CLAUDE.md 模板）
- Create: `docs/roles/deploy-runbook.md`（spec §11/§12 落成可执行步骤）

- [ ] **Step 1: 写协议模板**

`docs/roles/role-protocol-template.md` 全文：

````markdown
# 角色系统协议（_role-protocol.md）

> 本文件被每个角色目录的 CLAUDE.md `@import`，是角色行为的单一规则源。
> 占位符 `<ROLES_ROOT>` = `~/botmux-roles/<bot名>`，部署时替换。

## 你的身份与角色库

- 你当前扮演的角色 = 本工作目录的角色（人设见本目录 CLAUDE.md 首段）。
- 角色库：`<ROLES_ROOT>/shared/`（全员共享）与 `<ROLES_ROOT>/users/<open_id>/`（用户私有）。
- 每条用户消息带 `<sender open_id="...">` 标签——这是判断「说话的是谁」的唯一依据。

## 触发词与处理流程（语义等价的说法都算，不做字面匹配）

### 「切换角色」/「有哪些角色」
1. 列出 `shared/*` 与 `users/<发送者open_id>/*` 下的角色目录名，编号展示（标注共享/我的角色）。
2. 用户回复编号或角色名后执行「切到XX」流程。
3. 其他用户的私有角色不展示、不可切换；被点名要求切换他人角色时明确拒绝。

### 「切到XX」
1. 校验 XX 在发送者可用集合内（shared + 本人 users 目录），不在则拒绝并列出可用项。
2. 先用 botmux send 发送确认：`✅ 已切换为「XX」，本话题内生效`。
3. 最后一步执行：`botmux cd <该角色目录绝对路径>`（此后本轮不得再有任何动作）。
4. 切换完成后的新会话开场：先读本目录 `memory/MEMORY.md`（若存在于你的记忆目录）——
   会话内移动不会自动注入已有记忆索引。

### 「新建角色：<一句话描述>」
1. 按 role-claude-md-template.md 起草人设，预览给用户确认。
2. 确认后在 `users/<发送者open_id>/<角色名>/` 创建 CLAUDE.md（模板替换人设段），
   然后走「切到XX」流程。角色名即目录名，限 32 字符内、不含 `/`。

### 「沉淀知识」
按以下顺序执行（pull → merge → distill → push）：
1. pull：若本目录 `.botmux-dir.json` 已有知识文档 url/token，拉取飞书文档最新版
   （吸收用户人工修订）；没有则本次创建文档「<角色名>·领域知识」，并把 url 回填
   `.botmux-dir.json`、把文档分享给角色主人（编辑权限）。
2. merge + distill：三方语义合并（文档修订版 + 本地 knowledge/ + 记忆目录新原始记忆）。
   优先级：用户人工修订默认保留（与新记忆冲突→汇报请裁决）＞ 新记忆更新机器旧知识
   （变更列入汇报）。删除也是修订：文档没有、本地还有 → 同步删除本地，不复活。
3. 写回本地 `knowledge/<主题>.md` + 重建 `knowledge/INDEX.md` → push 飞书文档
   （push 前再 diff 一次，防沉淀期间用户同时编辑）。
4. 记忆生命周期：已入知识 → 移记忆目录 `archive/`；仍有记忆价值但不宜共享 → 保留；
   过期噪音 → 清除；重建 MEMORY.md。
5. 汇报：新增/修订/待裁决清单 + 文档链接。

### 「同步知识」
拉取知识飞书文档最新版 → 按「删除也是修订」语义更新本地 knowledge/ 与 INDEX.md → 汇报差异。

## 硬性约束

- `botmux cd` 只能指向角色库内目录（daemon 会硬校验，越界必被拒——不要尝试）。
- 知识文档只用简单 markdown（标题/列表/段落/表格），保证 docx↔md 往返无损。
- 涉及角色归属判断时以 `<sender open_id>` 为准，不以用户自称为准。
````

- [ ] **Step 2: 写 CLAUDE.md 模板**

`docs/roles/role-claude-md-template.md` 全文：

````markdown
# 角色目录 CLAUDE.md 模板

> 复制到 `<角色目录>/CLAUDE.md`，替换「人设」段与 `<ROLES_ROOT>`。

```markdown
# 角色：<角色名>

<人设：角色定位 / 语气 / 专长 / 边界。新建角色流程由模型按用户一句话描述起草。
默认角色「默认助理」此段仅一行：你是通用助理，未设定特定角色人设。>

@<ROLES_ROOT>/_role-protocol.md
@knowledge/INDEX.md
```

说明：`@import` 使 协议 + 知识索引 随每个新会话机制性加载；`knowledge/INDEX.md`
不存在时 import 静默失败不影响会话（首次沉淀会创建）。
````

- [ ] **Step 3: 写部署 runbook**

`docs/roles/deploy-runbook.md`（按 spec §11 部署清单 + §12 验证清单逐条落成命令级步骤，此处列结构）：

````markdown
# 角色系统部署 runbook

前提：PR1-3 已合入并部署（pnpm switch:here && botmux restart）。

1. 选定目标 bot：确认 `claude --version` ≥ 2.1.205；确认是否 readIsolation；
   确认无指向他处的 oncall 绑定。
2. 建角色库：
   mkdir -p ~/botmux-roles/<bot>/shared/默认助理/knowledge
   按模板写 _role-protocol.md（替换 <ROLES_ROOT>）与 默认助理/CLAUDE.md（零人设一行）。
3. bots.json 配置该 bot：
   "defaultWorkingDir": "~/botmux-roles/<bot>/shared/默认助理",
   "brandLabel": "[{cwdName}]({cwdUrl})",
   "tuiSlashAllow": ["/compact"]        # 可选
4. 信任预置：把 ~/botmux-roles 加入该 bot 的受信目录（复用现有信任种子机制，
   参考 provisionIsolatedBotHome 的 trust 注入路径），避免注入 /cd 弹信任框。
5. 飞书凭证验证：bot 会话内跑通「建测试文档→写入→分享」一遍（lark-cli --as bot
   或 app 凭证 curl；隔离 bot 用自己的 send-cred）。
6. botmux restart 后按 spec §12 验证清单逐项真机验收（清单复制于此，逐项打勾）。
7. 回滚：bots.json 还原 defaultWorkingDir/brandLabel 即回到无角色状态；
   角色库目录与记忆桶保留不影响其它功能。
````
（写入时把 spec §12 的 12 条 checkbox 全文复制进第 6 步。）

- [ ] **Step 4: Commit**

```bash
git add docs/roles/
git commit -m "docs(roles): 角色协议模板、CLAUDE.md 模板与部署 runbook"
```

---

## Self-Review 记录

- **Spec 覆盖**：§5/§6/§7 协议与模板 → Task 11；7.4 脚注 → Task 1-2；11.1 cd/slash/注入/能力位/红线 → Task 3-10；§9 沉淀 → Task 11 协议模板（零代码，按 spec 设计）；§12 验证清单 → 各 PR live 步骤 + runbook 第 6 步。未覆盖项：无。
- **Spec 偏差（需评审知悉）**：① cd/slash 路由不加 HMAC 签名（.dashboard-secret 被读隔离 deny；suspend/resume 同为 loopback 信任先例）；② `--silent` 参数取消——路由不发话题消息，AI 的角色化确认已覆盖该职责，YAGNI。
- **占位符扫描**：无 TBD/TODO；三处「grep 确认」步骤（findAncestorSessionContext 签名、sessionStore 引用、cliId 字段名）均带确切命令与预期，属实现前置校验而非留白。
- **类型一致性**：`inject_command`（Task 3 定义，Task 5/9 消费）、`validateSlashInjection`/`getBotTuiSlashAllow`（Task 4→5）、`validateRoleLibraryPath`/`repinSessionWorkingDir`（Task 7/8→9）、`supportsSessionCwdMove`（Task 9 定义与消费）签名一致。
