/**
 * PTY worker 专用的 CLI 怪癖表。只在 flow 模块内生效，不改共用 adapter——
 * adapter 的 busyPattern 还服务于主 worker 的卡片复活/重连探测，放宽它会有
 * 回归面；这里的模式只用于「就绪确认」和「回合结算前的 busy 复核」。
 */
import type { CliAdapter } from '../adapters/cli/types.js';

/**
 * 启动期 busy 标记：这些屏幕状态下 composer 尚不接收输入，即使 readyPattern
 * 已经命中（codex 的状态栏 `Context 100% left` 在 MCP servers 启动完成前就会
 * 出现，此时粘贴的 prompt 会被丢弃）。
 */
const STARTUP_BUSY_PATTERNS: Readonly<Record<string, RegExp>> = {
  // 三段启动态都不能收 prompt：`model: loading`（最早一帧，composer 已画出但
  // 随后整屏重绘会丢掉输入）、`· Starting ·` 状态栏、`Starting MCP servers` 进度行。
  codex: /model:\s+loading|·\s*Starting\s*·|Starting MCP servers|\(\d+s • esc to interrupt\)/i,
  traex: /model:\s+loading|·\s*Starting\s*·|Starting MCP servers/i,
};

export function startupBusyPattern(adapter: Pick<CliAdapter, 'id'>): RegExp | undefined {
  return STARTUP_BUSY_PATTERNS[adapter.id];
}

/** 屏幕尾部是否仍显示「正在工作」——adapter 自己的 busyPattern 与启动期标记取并集。 */
export function screenLooksBusy(adapter: Pick<CliAdapter, 'id' | 'busyPattern'>, screenTail: string): boolean {
  if (adapter.busyPattern?.test(screenTail)) return true;
  const startup = startupBusyPattern(adapter);
  return startup !== undefined && startup.test(screenTail);
}

/**
 * 「需要人来完成一次性设置」的屏幕：登录向导、鉴权方式选择、文件夹信任对话框。
 * 这些屏幕里常带 `❯` 选择符，会被 readyPattern 误判成 composer 就绪，prompt 会被
 * 当成菜单输入吞掉；之后 CLI 停在 OAuth 粘贴码那一页，回合永远不结束，而上游
 * 只看到 `running`。PTY worker 没有人盯屏，所以一旦识别出来就直接以
 * `cli_needs_setup` 失败（不可重试），把屏幕上的那句话带进错误信息。
 *
 * 模式只收录各 CLI 实测过/文档明确的措辞，宁缺毋滥：误判会把正常回合当失败。
 */
const SETUP_SCREEN_PATTERNS: Readonly<Record<string, RegExp>> = {
  'claude-code': /Select login method|Paste code here if prompted|Use the url below to sign in|Do you trust the files in this folder\?/i,
  codex: /Sign in with ChatGPT|Provide your own API key|Welcome to Codex.*?sign in/i,
  gemini: /Select Auth Method|How would you like to authenticate|Login with Google/i,
};

export function screenNeedsSetup(adapter: Pick<CliAdapter, 'id'>, screenTail: string): string | undefined {
  const pattern = SETUP_SCREEN_PATTERNS[adapter.id];
  if (!pattern) return undefined;
  const match = pattern.exec(screenTail);
  if (!match) return undefined;
  // 带上命中的整行，错误信息里一眼能看出是哪个向导。
  const lineStart = screenTail.lastIndexOf('\n', match.index) + 1;
  const lineEnd = screenTail.indexOf('\n', match.index);
  return screenTail.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
}

/**
 * 启动期的「信任这个目录吗」对话框：与登录向导不同，它不需要人——主 worker 对同一
 * 对话框的策略就是自动回车接受（botmux 是运行时管理者，cwd 由用户/脚本指定）。
 * 只收录实测过的措辞；识别到就按一次 Enter 选中默认项「Yes, continue」，之后继续
 * 等就绪。claude-code 不在此列：它由 `ensureClaudeFolderTrust` 在 spawn 前写入信任，
 * 仍然出现对话框说明预写失败，按 setup 屏幕处理。
 */
const TRUST_DIALOG_PATTERNS: Readonly<Record<string, RegExp>> = {
  codex: /Do you trust the contents of this directory\?[\s\S]*Yes, continue/i,
};

export function trustDialogPattern(adapter: Pick<CliAdapter, 'id'>): RegExp | undefined {
  return TRUST_DIALOG_PATTERNS[adapter.id];
}

const ESC = '\x1b';
const CTRL_C = '\x03';

/**
 * 打断当前回合的按键。绝大多数 TUI 用 ESC（提示语 "esc to interrupt"）；grok 的
 * 状态栏写的是 "Ctrl+c: cancel"，ESC 对它无效。Ctrl-C 在多数 CLI 上按两次会退出
 * 整个进程，所以只对明确需要它的 CLI 使用，且 cancel 只发一次。
 */
const INTERRUPT_KEYS: Readonly<Record<string, string>> = {
  grok: CTRL_C,
};

export function interruptKeys(adapter: Pick<CliAdapter, 'id'>): string {
  return INTERRUPT_KEYS[adapter.id] ?? ESC;
}
