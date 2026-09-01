import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  decodeTerminalWriteFrame,
  terminalWriteFrame,
} from '../src/core/terminal-write-frame.js';
import {
  readTerminalFrameWrite,
  readTerminalWriteReport,
} from '../src/dashboard/web/agent-workbench-panes.js';

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

describe('worker 终端页的跨文件接缝', () => {
  const worker = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  it('握手完成后发的是带外控制帧，不再往 PTY 流里塞 OSC 写权限', () => {
    expect(worker).toContain('terminalWriteFrame(hasWrite)');
    expect(worker).not.toContain(']1989;write;');
  });

  it('终端页嵌的是同一份解码器，且只在首帧上用', () => {
    expect(worker).toContain('decodeTerminalWriteFrameSource');
    expect(worker).toContain('_wbFirstFrame');
  });

  it('每次重连先把写权限退回未知', () => {
    expect(worker).toContain('_wbSetWsWrite(null)');
  });

  it('ws.onclose 当下就把写权限退回未知并上抛（重连中不再停留在旧判定）', () => {
    // 关闭那一刻就 reset，不能等 2 秒后的 connect() 才退回未知：否则断线到重连的
    // 空窗里，终端页仍以上一条连接的 wsHasWrite 放行输入，父页也还显示旧的可写判定。
    const at = worker.indexOf('ws.onclose=function(){');
    expect(at, 'worker.ts 里应有 ws.onclose 处理器').toBeGreaterThan(-1);
    const body = worker.slice(at, worker.indexOf('}', at) + 1);
    expect(body).toContain('_wbSetWsWrite(null)');
    // 且必须等新连接的新首帧才恢复——onclose 先把首帧标志复位。
    expect(body).toContain('_wbFirstFrame=true');
  });

  it('页面仍然导出 wsHasWrite 全局并按同一个消息类型上抛', () => {
    expect(worker).toContain('var wsHasWrite=null');
    expect(worker).toContain("'botmux:wb-terminal-write'");
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

/**
 * 终端页的**输入门**：只有已建立的 WS 明确回报可写(wsHasWrite===true)才放行，null
 * （还没确认 / 重连中）与 false（这条连接只读）一律不发（第 17 点）。
 *
 * 上面「工作台侧只认已建立的 WS」验的是**父页读数**（readTerminalFrameWrite）；这一
 * 组钉的是**终端页自己发不发输入**——把 worker.ts 里 term.onData 与触屏 toolbar 那两处
 * if 判据从源码抓出来直接跑真值表，抓的就是页面里真正那行逻辑，改回「只拦 ===false」
 * 会立刻红。
 */
describe('终端页输入门只放行已确认可写的 WS（第 17 点）', () => {
  const worker = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  // 从 worker.ts 源码里抓 anchor 之后那处对 wsHasWrite 的输入门判据，构造出「这一状态
  // 放不放行」的真值函数——跑的是页面里真正那行 if，不是另写一份等价物。
  function inputGate(anchor: string): (wsHasWrite: boolean | null) => boolean {
    const at = worker.indexOf(anchor);
    expect(at, `worker.ts 里应有 ${anchor}`).toBeGreaterThan(-1);
    const region = worker.slice(at, at + 400);
    const matched = region.match(/if\((wsHasWrite!==true)\)/);
    expect(matched, `${anchor} 之后应以「只有 wsHasWrite===true 才放行」为输入门`).not.toBeNull();
    const guard = matched![1];
    // guard 为真 = 拦截；放行 = !guard。用 Function 把源码里那条判据原样跑起来。
    // eslint-disable-next-line no-new-func
    const blocks = new Function('wsHasWrite', `return (${guard});`) as (v: boolean | null) => boolean;
    return (wsHasWrite) => !blocks(wsHasWrite);
  }

  it('term.onData 与触屏 toolbar：只有 wsHasWrite===true 放行，null/false 都拦', () => {
    for (const anchor of ['term.onData(function(d){', 'function fire(){']) {
      const allows = inputGate(anchor);
      expect(allows(true)).toBe(true);   // WS 明确回报可写 → 放行
      expect(allows(false)).toBe(false); // 明确只读 → 拦截
      expect(allows(null)).toBe(false);  // 还没确认（含重连中）→ 拦截，桌面也等首帧
    }
  });

  it('不再以「只拦 wsHasWrite===false」放行 hasToken=true & wsHasWrite=null 的盲打', () => {
    const onData = worker.slice(
      worker.indexOf('term.onData(function(d){'),
      worker.indexOf('var fixedSize='),
    );
    // 拦截块（带 { 的那条 if）必须是新判据；输入放行由它把守，_sendInput 在其后。
    expect(onData).toContain('if(wsHasWrite!==true){');
    expect(onData.indexOf('if(wsHasWrite!==true){')).toBeLessThan(onData.indexOf('_sendInput(d);'));
    // 回归的形状：旧门 `if(!hasToken||wsHasWrite===false){` 把守输入，hasToken=true &
    // wsHasWrite=null 时照发，用户对着未确认连接盲打。注意：同样的判据现在只作为**只读
    // 提示**的条件保留（不带 {、不 return），所以这里钉的是带 { 的那条拦截块已消失。
    expect(onData).not.toContain('if(!hasToken||wsHasWrite===false){');
  });
});
