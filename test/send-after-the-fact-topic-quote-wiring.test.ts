/**
 * `botmux send` 侧「事后开的话题」拦截的**接线**回归。
 *
 * 为什么需要这个文件：`shouldDropAfterTheFactTopicQuote` 是纯函数、单测很好写，
 * 但纯函数全绿**不能**证明 cmdSend 真的用了它 —— 实测把调用点的
 * `effectiveQuoteTargetId = undefined` 注释掉（修复变死代码），send-policy 与
 * cli-send-dispatch 共 92 个测试**全部照常通过**。所以这里按源码钉住整条接线：
 * 判据被调用、结论被消费、探测短路条件、以及送进发送函数的是**收敛后**的值。
 *
 * Run: bunx vitest run test/send-after-the-fact-topic-quote-wiring.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');

/** 判据收敛块，按真实大括号配对取，不用固定行宽。固定宽度窗口两个方向都不安全：
 *  窄了 → 块里新增几行就把目标推出窗口，干净代码也变红；宽了 → 越过闭合括号，
 *  于是「赋值必须落在判据 if 块内」这类断言即便赋值被移到块外也照样通过。
 *  剔除注释行，避免把代码注释掉后、注释里残留的同样字符仍能满足断言。 */
function convergenceBlock(): string {
  const lines = cliSource.split('\n');
  const start = lines.findIndex(
    l => l.includes('if (quoteTargetId && !explicitQuote && quotedTurnInThread === false)'),
  );
  if (start < 0) throw new Error('convergence block guard not found');
  let depth = 0;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (i > start && depth <= 0) break;
  }
  return out.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

describe('botmux send: 事后开的话题不再被 quote 带进去（接线）', () => {
  it('判据从 send-policy 导入,不在 cli 里手抄一份', () => {
    // 手抄副本会让判据本体的变异测不到 —— 同一个 PR 的 dispatcher 侧已经踩过一次。
    expect(cliSource).toMatch(/import \{[\s\S]{0,400}shouldDropAfterTheFactTopicQuote,/);
    // 不得出现就地重写的等价表达式。
    expect(cliSource).not.toMatch(/quotedTurnInThread === false\s*&&\s*typeof/);
  });

  it('inThread 取自会话持久化的 per-turn 记录(优先本轮 turnId,回退 quote 目标)', () => {
    expect(cliSource).toMatch(
      /const quotedTurnInThread = quoteTargetId\s*\?\s*\(s\.turnReplyContexts\?\.\[currentTurnId \?\? ''\]\?\.inThread\s*\?\?\s*s\.turnReplyContexts\?\.\[quoteTargetId\]\?\.inThread\)/,
    );
  });

  it('只在「确证顶层进来 + 本次真要 quote + 非 --quote」时才探测飞书(热路径不多付调用)', () => {
    expect(cliSource).toMatch(
      /if \(quoteTargetId && !explicitQuote && quotedTurnInThread === false\) \{/,
    );
    expect(cliSource).toMatch(/getMessageThreadId\(appId, quoteTargetId\)\.catch\(\(\) => undefined\)/);
  });

  it('判据命中 → 真的把 quote 收敛掉,而不是算完不用(MUT-E 拆的就是这一行)', () => {
    // ⚠️ 不能只 toMatch 一段含该赋值的正则：把那行注释掉后，注释里仍留着同样的
    // 字符，正则照样匹配 —— 实测这么写 98 个测试全绿、变异毫无牙。所以必须**逐行**
    // 检查：赋值语句必须以行首缩进开始，不能是 `//` 开头的注释行。
    const lines = cliSource.split('\n');
    const assignLines = lines.filter(l => /effectiveQuoteTargetId = undefined;/.test(l));
    expect(assignLines.length).toBeGreaterThan(0);
    // 至少有一行是**真正执行**的赋值（非注释）。
    const live = assignLines.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(live.length).toBeGreaterThan(0);
    // 且它落在判据的 if 块里。
    expect(convergenceBlock()).toMatch(/effectiveQuoteTargetId = undefined;/);
  });

  it('送进发送链的是**收敛后**的值,不是原始 quoteTargetId', () => {
    expect(cliSource).toMatch(
      /\.\.\.\(effectiveQuoteTargetId \? \{ quoteTargetId: effectiveQuoteTargetId \} : \{\}\)/,
    );
    // 原始值不得再直接进 proposedOutput（那样收敛就被绕过了）。
    expect(cliSource).not.toMatch(/\.\.\.\(quoteTargetId \? \{ quoteTargetId \} : \{\}\)/);
  });

  it('探测走 catch 兜底 ⇒ 飞书报错不阻断发送(失败方向=保持既有 quote)', () => {
    expect(cliSource).toMatch(/const probedThreadId = await getMessageThreadId\([^)]*\)\.catch/);
  });
});
