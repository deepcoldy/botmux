/**
 * `botmux send` 把**附件消息 id** 交给调用方的**接线**回归。
 *
 * 为什么需要这个文件：`sendFileAttachments` / `sendVideoAttachments` 返回的 `sent`
 * 在 `test/cli-send-dispatch.test.ts` 里已经有覆盖（全成功/部分失败/全失败三种），
 * 但 helper 全绿**不能**证明 `cmdSend` 没有再次把它丢掉 —— 本次缺陷恰好就发生在这一层：
 * 调用处长期只解构 `failed`，`sent` 从未进入任何输出，于是「核验刚发出的消息带不带附件」
 * 这个判据永远不成立，调用方把成功判成静默失败并重发（实测一份文件被重发 3 次）。
 *
 * 所以这里按源码钉住整条接线：两个 dispatch 的 `sent` 都被接住、都进入最终 JSON、
 * 且失败字段不被顶掉、字段是按非空条件输出（全失败时不冒充成功）。
 *
 * Run: bunx vitest run test/send-attachment-message-ids-wiring.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSource = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');

/** 按真实大括号配对取块，不用固定行宽：窄了会被新增几行推出窗口（干净代码变红），
 *  宽了会越过闭合括号（把块外的内容也算进来，断言失去意义）。同时剔除注释行，
 *  避免把代码注释掉之后、注释里残留的同样字符仍然满足断言。 */
function blockFrom(anchor: string): string {
  const lines = cliSource.split('\n');
  const hits = lines.filter(l => l.includes(anchor)).length;
  if (hits === 0) throw new Error(`anchor not found: ${anchor}`);
  // 锚点必须唯一：`console.log(JSON.stringify({` 这类在本文件里有 30+ 处，
  // 取第一处会安静地断言到别的代码块上（本测试第一版就踩了这个）。
  if (hits > 1) throw new Error(`anchor is ambiguous (${hits} hits): ${anchor}`);
  const start = lines.findIndex(l => l.includes(anchor));
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

/** 成功 JSON 那个对象字面量：`console.log(JSON.stringify({` 在本文件有 30+ 处，
 *  所以先用块内的唯一行定位，再回溯到它所属的那个 `JSON.stringify({`，
 *  然后按括号配对取整块。这样锚点唯一，且块边界仍由括号决定。 */
function successJsonBlock(): string {
  const lines = cliSource.split('\n');
  const uniq = 'quotedMessageId: primaryQuotedId,';
  const hits = lines.filter(l => l.includes(uniq)).length;
  if (hits !== 1) throw new Error(`inner anchor must be unique, got ${hits}`);
  const inner = lines.findIndex(l => l.includes(uniq));
  let open = -1;
  for (let i = inner; i >= 0; i--) {
    if (lines[i].includes('JSON.stringify({')) { open = i; break; }
  }
  if (open < 0) throw new Error('enclosing JSON.stringify({ not found');
  let depth = 0;
  const out: string[] = [];
  for (let i = open; i < lines.length; i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (i > open && depth <= 0) break;
  }
  return out.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

describe('send 附件消息 id 的接线（helper 返回 ≠ cmdSend 输出）', () => {
  it('文件附件的 sent 被接住，不是只解构 failed', () => {
    const block = blockFrom('await sendFileAttachments(');
    expect(block).toContain('sent: attachmentMessageIds');
    expect(block).toContain('failed: failedAttachments');
  });

  it('视频附件的 sent 在每一个消费 failed 的调用点都被接住', () => {
    // 只数**赋值语句本身**，不要数"提到 videoResult.sent"的行：
    // 纯视频路径里有一处 `if (videoResult.sent.length === 0)` 的失败判断也含这个串，
    // 把它算进来会让计数凑够、于是删掉一处真正的赋值仍然全绿（本测试第一版就是这样漏的）。
    const code = cliSource.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const failedAssign = code.filter(l => l.includes('failedVideoAttachments = videoResult.failed;')).length;
    const sentAssign = code.filter(l => l.includes('videoMessageIds = videoResult.sent;')).length;
    expect(failedAssign).toBeGreaterThan(0);
    expect(sentAssign).toBe(failedAssign);
  });

  it('两个 id 数组都进入最终成功 JSON，且失败字段仍在', () => {
    const block = successJsonBlock();
    expect(block).toContain('attachmentMessageIds');
    expect(block).toContain('videoMessageIds');
    // 回归护栏：新字段不得把既有失败字段顶掉
    expect(block).toContain('failedAttachments');
    expect(block).toContain('failedVideoAttachments');
  });

  it('id 字段按非空条件输出：全失败时不冒充成功', () => {
    const block = successJsonBlock();
    expect(block).toMatch(/attachmentMessageIds\.length > 0 \? \{ attachmentMessageIds \}/);
    expect(block).toMatch(/videoMessageIds\.length > 0 \? \{ videoMessageIds \}/);
  });

  it('stderr 提示排除掉「就是主消息」的那一条，JSON 侧不受影响', () => {
    // 纯视频路径下 `messageId = videoResult.sent[0]`，于是 videoMessageIds[0] === messageId。
    // 提示行若不过滤就会打印「附件消息: om_X（附件是独立消息，主消息 om_X 上查不到它们）」——
    // 列出的那个 id 就是主消息自己。单视频无正文是该路径最常见的用法，会稳定触发。
    const code = cliSource.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // ① 过滤集合确实是「两个 id 数组减去主消息 id」
    expect(code).toMatch(
      /const separateAttachmentMessageIds = \[\.\.\.attachmentMessageIds, \.\.\.videoMessageIds\]\s*\.filter\(id => id !== messageId\);/,
    );
    // ② 提示行用的是过滤后的集合，不是原始拼接（回到原形态即红）
    const hint = blockFrom('separateAttachmentMessageIds.length > 0');
    expect(hint).toContain('separateAttachmentMessageIds.join');
    expect(hint).not.toContain('...attachmentMessageIds, ...videoMessageIds');
    // ③ JSON 侧必须仍输出**未过滤**的完整数组，否则调用方「要几个附件就该有几个 id」
    //    这条核验判据会在纯视频路径下少一个而误判成上传失败。
    expect(successJsonBlock()).not.toContain('separateAttachmentMessageIds');
  });
});
