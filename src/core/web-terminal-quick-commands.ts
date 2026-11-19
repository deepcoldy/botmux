/**
 * 手机 Web 终端「快捷指令」菜单的数据层：默认指令、用户自定义列表的校验、按键记法的解析。
 *
 * 自定义列表按 Bot 和 CLI 家族存在本机的终端设置里（web-terminal-settings.json），而不是浏览器
 * localStorage：直连 worker 端口时每个会话都是不同的 origin，存浏览器里换个会话就没了。
 * 页面加载时随 HTML 下发（只给可写页面），修改经 WebSocket 上行的 JSON 帧保存，worker 只认
 * 可写连接。它**不走** PTY 字节流：终端里跑的进程能打印任意字节，如果菜单能被带内帧改写，
 * `cat` 一个恶意文件就能把「/status」换成一条危险命令等人去点。
 *
 * 带 `*Source` 导出的函数会被终端页原样嵌进去（页面代码住在 worker.ts 的模板字符串里，
 * 没法 import），单测跑的也是这一份。这些函数因此必须**自给自足**：不引用任何外部
 * 标识符（包括本文件的其它函数与常量）、函数体里不声明内层函数、不出现反引号。
 */

export interface QuickCommand {
  /** 菜单上显示的名字。 */
  label: string;
  /** 发给终端的内容，支持 <Esc> <Enter> <Tab> <C-c> 这类按键记法（见 quickCommandSequence）。 */
  send: string;
  /** 发完是否再按一次 Enter 提交。false 时只把内容放进 CLI 输入框，等用户补参数。 */
  enter: boolean;
  /** 一句话说明，可空。 */
  hint: string;
}

export type QuickCommandProfile = 'codex' | 'default';

/** 自定义列表按哪一套存：Codex 家族的斜杠命令和其它 CLI 不一样，其余共用一套。 */
export function quickCommandProfile(cliId: unknown): QuickCommandProfile {
  // coco / traex 与 codex 跑同一套 traecli/codex-rs TUI：适配器都标 stuckPageFamily:'codex-family'，
  // 配置格式都是 codex-toml。以本机 traecli 0.214.1 实测：codex 档的 /status /compact /model /review
  // /diff 都是它的 TUI 斜杠命令；default 档里的 /effort、/usage 在它里面没有对应斜杠命令（它也有
  // /rewind、/context，所以真正的区分点是 /effort、/usage，不是 /rewind）。
  // 这里只决定快捷指令的默认档，与 adapters/cli/types.ts 的 isCodexFamilyCliId（管 bridge/升级行为，
  // 刻意不含 coco/traex）是两件事，不要合并判定。
  return cliId === 'codex' || cliId === 'codex-app' || cliId === 'coco' || cliId === 'traex'
    ? 'codex'
    : 'default';
}

export function defaultQuickCommands(profile: unknown): QuickCommand[] {
  if (profile === 'codex') {
    return [
      { label: '/status', send: '/status', enter: true, hint: '查看会话状态' },
      { label: '/compact', send: '/compact', enter: true, hint: '压缩上下文' },
      { label: '/model', send: '/model', enter: true, hint: '切换模型与推理强度' },
      { label: '/review', send: '/review', enter: true, hint: '审查当前改动' },
      { label: '/diff', send: '/diff', enter: true, hint: '查看 git diff' },
    ];
  }
  return [
    { label: '/rewind', send: '/rewind', enter: true, hint: '回退到之前的对话' },
    { label: '/compact', send: '/compact', enter: true, hint: '压缩上下文' },
    { label: '/status', send: '/status', enter: true, hint: '查看会话状态' },
    { label: '/effort', send: '/effort', enter: true, hint: '调整思考强度' },
    { label: '/model', send: '/model', enter: true, hint: '切换模型' },
    { label: '/context', send: '/context', enter: true, hint: '查看上下文用量' },
    { label: '/usage', send: '/usage', enter: true, hint: '查看额度用量' },
  ];
}

/**
 * 校验并规整一份指令列表（页面表单、WebSocket 上行帧、设置文件都经过这里）。整体形状不对
 * （不是数组）返回 null，调用方退回默认；单条不合法只丢那一条。空数组是合法结果——用户把指令
 * 删光了，不能悄悄变回默认。长度与条数都有上限：菜单是点一下就发出去的东西，不该装得下
 * 一整段脚本；扫描的条目数也封顶，一个塞满垃圾的超长数组不会让它一直转下去。
 */
export function normalizeQuickCommands(raw: unknown): QuickCommand[] | null {
  if (!Array.isArray(raw)) return null;
  const out: QuickCommand[] = [];
  for (let i = 0; i < raw.length && i < 200 && out.length < 40; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const send = typeof rec.send === 'string' ? rec.send : '';
    if (!send.trim() || send.length > 500) continue;
    let label = typeof rec.label === 'string' ? rec.label.trim() : '';
    if (!label) label = send.trim();
    if (label.length > 40) label = label.slice(0, 40);
    let hint = typeof rec.hint === 'string' ? rec.hint.trim() : '';
    if (hint.length > 60) hint = hint.slice(0, 60);
    out.push({ label, send, enter: rec.enter !== false, hint });
  }
  return out;
}

/**
 * 把指令里的按键记法换成终端字节。记法不区分大小写：
 *   <Esc> <Enter>/<CR> <Tab> <S-Tab> <BS> <Del> <Space> <Up> <Down> <Left> <Right>
 *   <Home> <End> <PgUp> <PgDn> <C-a> … <C-z>（Ctrl+字母） <lt>（字面的 <）
 * 认不出的 <…> 原样保留，所以普通文本里的尖括号不受影响。
 */
export function quickCommandSequence(send: string): string {
  const keys: Record<string, string> = {
    esc: '\x1b', escape: '\x1b', enter: '\r', cr: '\r', return: '\r', tab: '\t',
    's-tab': '\x1b[Z', bs: '\x7f', backspace: '\x7f', del: '\x1b[3~', delete: '\x1b[3~',
    space: ' ', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
    home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pageup: '\x1b[5~', pgdn: '\x1b[6~', pagedown: '\x1b[6~',
    lt: '<',
  };
  let out = '';
  let i = 0;
  while (i < send.length) {
    const open = send.indexOf('<', i);
    if (open < 0) {
      out += send.slice(i);
      break;
    }
    out += send.slice(i, open);
    const close = send.indexOf('>', open + 1);
    if (close < 0) {
      out += send.slice(open);
      break;
    }
    const name = send.slice(open + 1, close).toLowerCase();
    const ctrl = /^c-([a-z])$/.exec(name);
    if (Object.prototype.hasOwnProperty.call(keys, name)) {
      out += keys[name];
      i = close + 1;
    } else if (ctrl) {
      out += String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
      i = close + 1;
    } else {
      // 不是记法：只吃掉这一个 <，从下一个字符接着找，避免「<a <Esc>」里的记法被跳过。
      out += '<';
      i = open + 1;
    }
  }
  return out;
}

export type QuickCommandsRequest =
  | { op: 'get'; nonce: string }
  | { op: 'save'; nonce: string; base: QuickCommand[] | null; commands: QuickCommand[] | null };

export type QuickCommandsReplyStatus = 'ok' | 'conflict' | 'error';

/**
 * 解析终端页发上来的快捷指令请求，每帧都带一个页面随机生成的 nonce：
 *   {"type":"quick_commands","nonce":"…","op":"get"}                     → 取当前列表
 *   {"type":"quick_commands","nonce":"…","base":[…]|null,"commands":[…]} → 保存
 *   {"type":"quick_commands","nonce":"…","base":[…]|null,"reset":true}   → 恢复默认
 * base 是页面这次修改所基于的列表（null = 内置默认），和服务端当前的对不上就拒绝：另一个页面刚存过，
 * 旧页面的整表保存不能把它盖掉。
 * 其它任何东西返回 null——同一条 WebSocket 上还跑着键盘输入和 resize，先用包含检查快速放过，
 * 不对每个按键做 JSON.parse。体积上限给得宽：两份 40 条 × 500 字符的列表再加 JSON 转义。
 */
export function parseQuickCommandsMessage(raw: unknown): QuickCommandsRequest | null {
  if (typeof raw !== 'string' || raw.length > 512 * 1024 || !raw.includes('"quick_commands"')) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const rec = msg as Record<string, unknown>;
  if (rec.type !== 'quick_commands') return null;
  const nonce = rec.nonce;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return null;
  if (rec.op === 'get') return { op: 'get', nonce };
  const base = rec.base === null ? null : normalizeQuickCommands(rec.base);
  if (rec.base !== null && !base) return null;
  if (rec.reset === true) return { op: 'save', nonce, base, commands: null };
  const commands = normalizeQuickCommands(rec.commands);
  return commands ? { op: 'save', nonce, base, commands } : null;
}

/**
 * worker 给请求方的应答：只发给发请求的那条连接，独占一个 WebSocket 帧，带上服务端当前的列表
 * （null = 内置默认）。它和 PTY 输出走同一条连接，终端里的程序也能打印出一样的字节；页面只认
 * nonce 和自己这次请求对得上的整帧，而 nonce 只在页面到 worker 的上行帧里出现过，终端里的程序看不到，
 * 也就伪造不了应答。JSON.stringify 会转义控制字符，正文里不会出现裸 BEL。
 */
export function formatQuickCommandsReply(
  nonce: string,
  status: QuickCommandsReplyStatus,
  commands: QuickCommand[] | null,
): string {
  return `\x1b]1989;quick_commands;${nonce};${status};${JSON.stringify(commands)}\x07`;
}

/** 页面侧：一帧是不是对应 nonce 的应答；是就返回状态和列表（未规整），不是返回 null。 */
export function decodeQuickCommandsReply(
  data: unknown,
  nonce: unknown,
): { status: QuickCommandsReplyStatus; commands: unknown } | null {
  if (typeof data !== 'string' || typeof nonce !== 'string' || !nonce || data.length > 512 * 1024) return null;
  const prefix = '\x1b]1989;quick_commands;' + nonce + ';';
  if (data.slice(0, prefix.length) !== prefix || data.charAt(data.length - 1) !== '\x07') return null;
  const rest = data.slice(prefix.length, -1);
  const sep = rest.indexOf(';');
  const status = sep < 0 ? '' : rest.slice(0, sep);
  if (status !== 'ok' && status !== 'conflict' && status !== 'error') return null;
  let commands: unknown;
  try {
    commands = JSON.parse(rest.slice(sep + 1));
  } catch {
    return null;
  }
  return { status, commands };
}

/**
 * 估计 CLI 输入行里还有多少没提交的字，发送前用它提醒「自动回车会把残留内容和指令拼成一行」。
 * 只看本页发出去的字节：回车、Ctrl-C、Ctrl-U 清零，退格减一，括号粘贴里的字逐个计入。
 * 转义序列不计，包括终端替 CLI 自动发回的应答（颜色、版本查询这类 OSC/DCS 字符串，一直跳到 BEL 或 ST）。
 * ↑/↓ 会把历史翻进输入行，看不到翻出了什么，就当作可能有字。CLI 自己也会改输入行（补全、单键回答），
 * 所以这只是估计，不拿它拦任何输入。
 */
export function unsubmittedLineLength(prev: number, data: unknown): number {
  let len = prev > 0 ? prev : 0;
  if (typeof data !== 'string') return len;
  // state：0 普通字符，1 刚读到 ESC，2 CSI 参数，3 SS3 的最后一个字符，4 OSC/DCS/APC/PM/SOS 字符串。
  let state = 0;
  let params = '';
  let paste = false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (state === 4) {
      if (c === 0x07 || c === 0x9c) state = 0;
      else if (c === 0x1b) state = 1;
      continue;
    }
    if (state === 1) {
      if (c === 0x5b) { state = 2; params = ''; }
      else if (c === 0x4f) state = 3;
      else if (c === 0x5d || c === 0x50 || c === 0x5f || c === 0x5e || c === 0x58) state = 4;
      else state = 0;
      continue;
    }
    if (state === 3) {
      state = 0;
      if (c === 0x41 || c === 0x42) len = len > 0 ? len : 1;
      continue;
    }
    if (state === 2) {
      if (c < 0x40 || c > 0x7e) { params += data.charAt(i); continue; }
      state = 0;
      if (c === 0x7e && params === '200') paste = true;
      else if (c === 0x7e && params === '201') paste = false;
      else if (c === 0x41 || c === 0x42) len = len > 0 ? len : 1;
      continue;
    }
    if (c === 0x1b) { state = 1; continue; }
    if (c === 0x9b) { state = 2; params = ''; continue; }
    if (c === 0x90 || c === 0x98 || c === 0x9d || c === 0x9e || c === 0x9f) { state = 4; continue; }
    if (paste || (c >= 0x20 && c !== 0x7f && (c < 0x80 || c > 0x9f))) len++;
    else if (c === 0x0d || c === 0x0a || c === 0x03 || c === 0x15) len = 0;
    else if ((c === 0x7f || c === 0x08) && len > 0) len--;
  }
  return len;
}

/** 终端页里那份内嵌实现的源码（见文件头注释：一份实现，两处运行）。 */
export const quickCommandProfileSource = quickCommandProfile.toString();
export const defaultQuickCommandsSource = defaultQuickCommands.toString();
export const normalizeQuickCommandsSource = normalizeQuickCommands.toString();
export const quickCommandSequenceSource = quickCommandSequence.toString();
export const decodeQuickCommandsReplySource = decodeQuickCommandsReply.toString();
export const unsubmittedLineLengthSource = unsubmittedLineLength.toString();
