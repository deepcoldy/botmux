import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeTerminalWriteFrame,
  terminalWriteFrame,
} from '../src/core/terminal-write-frame.js';
import {
  readTerminalFrameWrite,
  readTerminalWriteReport,
} from '../src/dashboard/web/agent-workbench-panes.js';
import { WORKBENCH_TERM_WRITE_MESSAGE } from '../src/dashboard/web/agent-workbench-terminal-control.js';

/**
 * 「这条 WS 到底能不能写」这条信号的通道完整性。
 *
 * 以前它混在 PTY 字节流里（OSC 1989 write），而且客户端**每一帧**都扫一遍：只读终端
 * 里随便跑个 `printf` 就能把同样的字节打出来，把 wsHasWrite 翻成 true（反向则是 DoS
 * ——把自己打成只读）。修法是把它挪到带外：worker 在握手完成时发一条**整帧精确匹配**
 * 的 JSON 控制帧，客户端只在「本连接的第一帧」上认它并锁存，之后 PTY 输出永远只是
 * PTY 输出；每次重连先退回未知。
 *
 * 解码规则只有一份实现（`decodeTerminalWriteFrame`），终端页把它的源码原样嵌进去，
 * 所以这里的用例验的就是页面里真正跑的那段逻辑。
 */

const WRITABLE = '{"botmux":"terminal.write","write":true}';
const READONLY = '{"botmux":"terminal.write","write":false}';

describe('带外写权限控制帧', () => {
  it('编码就是两个字面量，解码在首帧上原样还原', () => {
    expect(terminalWriteFrame(true)).toBe(WRITABLE);
    expect(terminalWriteFrame(false)).toBe(READONLY);
    expect(decodeTerminalWriteFrame(terminalWriteFrame(true), true)).toBe(true);
    expect(decodeTerminalWriteFrame(terminalWriteFrame(false), true)).toBe(false);
  });

  it('非首帧一律不作数——PTY 里的进程打出一模一样的字节也翻不动权限', () => {
    expect(decodeTerminalWriteFrame(WRITABLE, false)).toBeNull();
    expect(decodeTerminalWriteFrame(READONLY, false)).toBeNull();
  });

  it('整帧精确匹配：夹带、加空白、换形状全部不认', () => {
    expect(decodeTerminalWriteFrame(`日志输出${WRITABLE}`, true)).toBeNull();
    expect(decodeTerminalWriteFrame(`${WRITABLE}\n`, true)).toBeNull();
    expect(decodeTerminalWriteFrame(' ' + WRITABLE, true)).toBeNull();
    expect(decodeTerminalWriteFrame('{"botmux":"terminal.write","write":1}', true)).toBeNull();
    expect(decodeTerminalWriteFrame('{"botmux": "terminal.write", "write": true}', true)).toBeNull();
  });

  it('二进制帧与非字符串一律不作数', () => {
    expect(decodeTerminalWriteFrame(new Uint8Array([1, 2, 3]), true)).toBeNull();
    expect(decodeTerminalWriteFrame({ botmux: 'terminal.write', write: true }, true)).toBeNull();
    expect(decodeTerminalWriteFrame(null, true)).toBeNull();
    expect(decodeTerminalWriteFrame(undefined, true)).toBeNull();
  });

  it('解码函数自给自足：能被序列化后嵌进终端页里跑（页面用的就是这一份）', () => {
    const source = decodeTerminalWriteFrame.toString();
    expect(source).not.toContain('`');
    // 引用外部标识符就意味着嵌进页面后是另一段语义（甚至直接 ReferenceError）。
    expect(source).not.toMatch(/WRITABLE_FRAME|READONLY_FRAME/);
    // 两个字面量必须**内联**在函数体里。不能直接 toContain(WRITABLE)：那要求源码里
    // 的引号风格与本文件常量逐字一致，而这段源码来自当前 transform（tsc 保留单引号，
    // 某些测试 transform 会重新输出成双引号加转义 `"{\"botmux\"…`），断言会因为
    // 「谁来 transform」而红——测的是工具产物形态，不是通道契约。改成解析出源码里的
    // 字符串字面量再做**值**比较，与引号风格无关。
    const literals = [...source.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map(m => {
      try { return JSON.parse(`"${m[2].replace(/\\'/g, "'")}"`); } catch { return m[2]; }
    });
    expect(literals).toContain(WRITABLE);
    expect(literals).toContain(READONLY);
    // 最终保证：把源码原样嵌进别处重建，行为与本模块一致（这才是页面真正依赖的东西）。
    // eslint-disable-next-line no-new-func
    const rebuilt = new Function(`return (${source})`)() as typeof decodeTerminalWriteFrame;
    expect(rebuilt(WRITABLE, true)).toBe(true);
    expect(rebuilt(READONLY, true)).toBe(false);
    expect(rebuilt(WRITABLE, false)).toBeNull();
    expect(rebuilt(' ' + WRITABLE, true)).toBeNull();
    expect(rebuilt(`日志输出${WRITABLE}`, true)).toBeNull();
  });
});

describe('worker 终端页与工作台的跨文件契约', () => {
  // 源码结构护栏(K4)：终端页脚本是 worker.ts 模板字符串里的浏览器 JS，测试 import 不进来；工作台
  // 靠同源读终端页的 `wsHasWrite` 全局、以及 postMessage 类型 WORKBENCH_TERM_WRITE_MESSAGE 认写权限
  // （见下一组 readTerminalFrameWrite / readTerminalWriteReport）。任一侧改名，面板都会静默退回「未知」。
  // 这里拿工作台真实导出的常量去核对页面源码，而不是两边各写一份字面量（#971）。
  it('终端页落下 wsHasWrite 全局，并按工作台认的消息类型上抛', () => {
    const worker = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    expect(worker).toMatch(/\bvar wsHasWrite\b/);
    expect(worker).toContain(`'${WORKBENCH_TERM_WRITE_MESSAGE}'`);
  });
});

describe('工作台侧只认已建立的 WS（第 12 点）', () => {
  const frame = (contentWindow: unknown) => ({ contentWindow } as unknown as HTMLIFrameElement);

  it('WS 还没确认时保持未知——不再拿 HTTP 的 hasToken 兜底', () => {
    expect(readTerminalFrameWrite(frame({ hasToken: true, wsHasWrite: null }))).toBe('unknown');
    expect(readTerminalFrameWrite(frame({ hasToken: true }))).toBe('unknown');
    expect(readTerminalFrameWrite(frame({ hasToken: false }))).toBe('unknown');
    expect(readTerminalFrameWrite(frame({}))).toBe('unknown');
  });

  it('WS 说了才算', () => {
    expect(readTerminalFrameWrite(frame({ hasToken: true, wsHasWrite: false }))).toBe('readonly');
    expect(readTerminalFrameWrite(frame({ hasToken: false, wsHasWrite: true }))).toBe('writable');
  });

  it('上抛的回报能表达「退回未知」，重连时父页才跟得上', () => {
    expect(readTerminalWriteReport({ type: 'botmux:wb-terminal-write', write: true })).toBe('writable');
    expect(readTerminalWriteReport({ type: 'botmux:wb-terminal-write', write: false })).toBe('readonly');
    expect(readTerminalWriteReport({ type: 'botmux:wb-terminal-write', write: null })).toBe('unknown');
    expect(readTerminalWriteReport({ type: 'other', write: true })).toBeNull();
    expect(readTerminalWriteReport({ type: 'botmux:wb-terminal-write', write: 'yes' })).toBeNull();
    expect(readTerminalWriteReport(null)).toBeNull();
  });
});
