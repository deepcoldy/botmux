import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readTerminalFrameStatus } from '../src/dashboard/web/agent-workbench-panes.js';

// PR #1943 的跨模块契约：工作台 readTerminalFrameStatus 用**字面全等**读终端 iframe
// 里 #status 的 textContent 来判定 WS 状态（agent-workbench-panes.tsx）。曾经一版改动
// 把 "connected · 已接收 N B" 写进同一个 #status，导致 reader 恒返回 unknown，触屏端
// 「实时连接未建立」浮层连上后也撤不掉。修复约定：#status 只放短词 connected /
// disconnected，变化的字节数放独立的 #status-bytes。本测试同时钉住两侧：
//   - reader 侧：只认字面量，带后缀的文案必须判 unknown（reader 若退化成 startsWith
//     会在这里变红）；
//   - 页面侧（served HTML）：onopen 写进 #status 的必须是裸 'connected'，字节文案写进
//     aria-hidden 的独立节点（页面若把字节塞回 #status 会在这里变红）。

function frameWithStatus(text: string | null | undefined) {
  return {
    contentWindow: {
      document: { getElementById: () => (text === undefined ? null : { textContent: text }) },
    },
  } as unknown as HTMLIFrameElement;
}

describe('readTerminalFrameStatus 字面量契约', () => {
  it('认裸 connected / disconnected', () => {
    expect(readTerminalFrameStatus(frameWithStatus('connected'))).toBe('connected');
    expect(readTerminalFrameStatus(frameWithStatus('disconnected'))).toBe('disconnected');
  });

  it('带字节后缀的 connected 必须判 unknown —— 字节不允许进 #status', () => {
    expect(readTerminalFrameStatus(frameWithStatus('connected · 已接收 0 B'))).toBe('unknown');
    expect(readTerminalFrameStatus(frameWithStatus('connected · 已接收 12.3 KB'))).toBe('unknown');
  });

  it('启动阶段中文案 / 空 / 节点缺失 / 抛错 一律 unknown', () => {
    expect(readTerminalFrameStatus(frameWithStatus('加载中…'))).toBe('unknown');
    expect(readTerminalFrameStatus(frameWithStatus('初始化…'))).toBe('unknown');
    expect(readTerminalFrameStatus(frameWithStatus('加载失败'))).toBe('unknown');
    expect(readTerminalFrameStatus(frameWithStatus('connecting...'))).toBe('unknown');
    expect(readTerminalFrameStatus(frameWithStatus('   '))).toBe('unknown');
    expect(readTerminalFrameStatus(frameWithStatus(undefined))).toBe('unknown');
    expect(readTerminalFrameStatus(null)).toBe('unknown');
    const throwing = { get contentWindow() { throw new Error('cross-origin'); } } as unknown as HTMLIFrameElement;
    expect(readTerminalFrameStatus(throwing)).toBe('unknown');
  });
});

// ── 页面侧：从 getTerminalHtml 模板还原真正发出的 HTML（与
// web-terminal-served-script-parses.test.ts 同一套转义处理，插值打平为字面量）──
const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
function servedHtml(): string {
  const start = workerSource.indexOf('function getTerminalHtml(');
  const open = workerSource.indexOf('return `', start);
  const bodyStart = open + 'return `'.length;
  let i = bodyStart;
  let depth = 0;
  for (; i < workerSource.length; i++) {
    const ch = workerSource[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '$' && workerSource[i + 1] === '{') { depth++; i++; continue; }
    if (ch === '}' && depth > 0) { depth--; continue; }
    if (ch === '`' && depth === 0) break;
  }
  const raw = workerSource.slice(bodyStart, i);
  return raw
    .replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, esc: string) => {
      switch (esc[0]) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'v': return '\v';
        case '0': return esc === '0' ? '\0' : esc;
        case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
        case 'u': return esc[1] === '{'
          ? String.fromCodePoint(parseInt(esc.slice(2, -1), 16))
          : String.fromCharCode(parseInt(esc.slice(1), 16));
        default: return esc;
      }
    })
    .replace(/\$\{[\s\S]*?\}/g, '0');
}

// 源码结构护栏(K4)：终端页脚本写在 worker.ts 的模板字符串里，工作台的 readTerminalFrameStatus 用字面全等
// 读它下发的 #status；两侧都是手写字面量，只能还原 served HTML 核对 #status 只放短状态词、字节数与启动错误
// 详情放独立节点（#1943 曾因把字节拼进 #status 导致连上后浮层撤不掉）。
describe('终端页 #status 与字节角标的 served 契约', () => {
  const html = servedHtml();

  it('#status 只承载短状态词；字节数在独立且对辅助技术隐藏的节点；启动错误详情进居中块', () => {
    expect(html).toContain('<div id="status" class="err" role="status">');
    expect(html).toMatch(/<div id="status-bytes"[^>]*aria-hidden="true"[^>]*>/);
    expect(html).toMatch(/<div id="boot-error"[^>]*aria-live="assertive"[^>]*>/);
  });

  it('onopen/status 写进 #status 的是裸 connected，绝不拼接字节后缀', () => {
    expect(html).toContain("el.textContent='connected'");
    expect(html).not.toContain("el.textContent='connected · 已接收");
    // 字节文案只能写进独立节点
    expect(html).toContain("_wbBytesEl.textContent='已接收 '");
  });

  it('启动失败：#status 只留短词，长详情写进居中的 boot-error（不与顶部横幅同位）', () => {
    expect(html).toContain("status.textContent='加载失败'");
    expect(html).toContain('box.textContent=detail');
    expect(html).toContain("box.classList.add('show')");
  });

  it('启动 error 监听在连接建立后摘除（良性运行时报错不再劫持健康状态），连上后收起中央错误块', () => {
    expect(html).toContain("addEventListener('error',_wbBootstrapError,true)");
    expect(html).toContain("removeEventListener('error',_wbBootstrapError,true)");
    expect(html).toContain("_wbBootErrorEl.classList.remove('show')");
  });

  it('每次（重）连把字节计数归零，断开时收起字节角标', () => {
    expect(html).toMatch(/function _wbResetBytes\(\)\{_wbReceivedBytes=0/);
    // connect 建立新 socket 后调用复位（二进制帧设置之后）
    expect(html).toContain("ws.binaryType='arraybuffer'");
    expect(html).toContain('_wbResetBytes();');
    // onclose 体内收起角标
    const onclose = html.slice(html.indexOf('ws.onclose=function(){'), html.indexOf('ws.onerror=function'));
    expect(onclose).toContain('_wbHideBytes()');
    expect(onclose).toContain("el.textContent='disconnected'");
  });
});
