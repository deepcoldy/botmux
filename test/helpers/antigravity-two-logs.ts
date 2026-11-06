import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Synthetic Antigravity brain logs with the shape of a real long-reply
 * conversation (agy 1.4.7): 26 records — step 0 USER_INPUT, steps 1–23 odd
 * PLANNER_RESPONSE(run_command), steps 2–24 even GENERIC tool output, step 25
 * the content-only final with `thinking`. All text is generated here.
 *
 * transcript.jsonl (compact) cuts every field over ~4 KB to its head and tail
 * around `<truncated N bytes>` and lists it in `truncated_fields` (five tool
 * outputs and the final, as in the real log). transcript_full.jsonl carries
 * the same records untruncated; its only "truncated" text is what the model
 * itself saw — agy's middle-cut tool output notice on steps 12/14 and a tool
 * command that prints "[truncated, total length …]" on step 13.
 */
export interface AntigravityTwoLogs {
  compactRecords: any[];
  fullRecords: any[];
  /** The complete final reply (step 25 in the full log). */
  finalText: string;
  /** A line that only exists in the middle of the final reply. */
  middleSentinel: string;
  userRequest: string;
}

const KEEP_BYTES = 2048;

function utf8Boundary(buf: Buffer, at: number, back: boolean): number {
  let i = at;
  while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i += back ? -1 : 1;
  return i;
}

/** Cut like agy's compact log: first/last ~2 KB around a byte-count marker. */
export function cutLikeCompactLog(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= KEEP_BYTES * 2) return text;
  const headEnd = utf8Boundary(buf, KEEP_BYTES, true);
  const tailStart = utf8Boundary(buf, buf.length - KEEP_BYTES, false);
  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  return `${head}\n<truncated ${tailStart - headEnd} bytes>\n${tail}`;
}

function syntheticFinal(middleSentinel: string): string {
  const parts: string[] = ['# 合成回复：工具调用模式对比', ''];
  for (let i = 1; i <= 24; i++) {
    parts.push(`## 第 ${i} 节 合成小节标题`, '');
    parts.push(`这是第 ${i} 节的合成正文，用来把回复撑到十几 KB。它描述一个虚构的流程：先读取配置，再校验参数，最后汇总结果。`.repeat(5), '');
    if (i % 6 === 0) {
      parts.push('| 项目 | 方式 A | 方式 B |', '|---|---|---|', `| 第 ${i} 行 | 合成值甲 | 合成值乙 |`, '');
    }
    if (i % 8 === 0) parts.push('```python', `def step_${i}(x):`, '    return x * 2', '```', '');
    if (i === 12) parts.push(middleSentinel, '');
  }
  parts.push('以上为合成回复的结尾。');
  return parts.join('\n');
}

function toolOutput(step: number, kb: number): string {
  const line = `[step ${step}] synthetic tool output line with some padding text\n`;
  return line.repeat(Math.ceil((kb * 1024) / line.length));
}

export function buildAntigravityTwoLogs(): AntigravityTwoLogs {
  const middleSentinel = 'MIDDLE-ONLY 这一行只出现在回复的中段，compact 日志会把它截掉';
  const finalText = syntheticFinal(middleSentinel);
  const userRequest = '请对比两种合成的工具调用方式，给出详细说明';
  const created = (step: number) => `2026-10-24T14:0${Math.floor(step / 10)}:${String(step % 10).padStart(2, '0')}Z`;
  const tokens = { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 500 };

  const full: any[] = [];
  full.push({
    step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: created(0),
    content: `<USER_REQUEST>\n${userRequest}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-24.\n</ADDITIONAL_METADATA>`,
  });
  const bigOutputs: Record<number, number> = { 2: 6, 12: 10, 14: 9, 16: 7, 18: 5 };
  for (let step = 1; step <= 24; step++) {
    if (step % 2 === 1) {
      const args = step === 13
        ? { CommandLine: 'python3 -c "print(f\'[truncated, total length {len(source)}]\')"' }
        : { CommandLine: `echo synthetic-${step}` };
      full.push({
        step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: created(step), ...tokens,
        ...(step === 1 || step === 23 ? { thinking: `合成思考 ${step}` } : {}),
        tool_calls: [{ id: `call-${step}`, name: 'run_command', args }],
      });
    } else {
      let content = toolOutput(step, bigOutputs[step] ?? 1);
      if (step === 12 || step === 14) {
        content = `The tool's output was truncated due to being too long. You can find the full output in a file at file:///synthetic/steps/${step}/output.txt.\n`
          + `${content.slice(0, 5000)}\n<truncated 9000 of 19000 bytes from the middle of the output>\n${content.slice(-5000)}`;
      }
      full.push({ step_index: step, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: created(step), content });
    }
  }
  full.push({
    step_index: 25, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: created(25), ...tokens,
    thinking: '合成的收尾思考', content: finalText,
  });

  const compact = full.map(record => {
    if (typeof record.content !== 'string') return record;
    const cut = cutLikeCompactLog(record.content);
    return cut === record.content ? record : { ...record, content: cut, truncated_fields: ['content'] };
  });
  return { compactRecords: compact, fullRecords: full, finalText, middleSentinel, userRequest };
}

export const jsonl = (records: readonly any[]): string => records.map(r => `${JSON.stringify(r)}\n`).join('');

export interface WrittenAntigravityTwoLogs extends AntigravityTwoLogs {
  logsDir: string;
  compactPath: string;
  fullPath: string;
}

/** Write both logs (or only the compact one) under
 *  `<brainDir>/<conversationId>/.system_generated/logs/`. */
export function writeAntigravityTwoLogs(
  brainDir: string,
  conversationId: string,
  opts: { withFull?: boolean } = {},
): WrittenAntigravityTwoLogs {
  const logs = buildAntigravityTwoLogs();
  const logsDir = join(brainDir, conversationId, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const compactPath = join(logsDir, 'transcript.jsonl');
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  writeFileSync(compactPath, jsonl(logs.compactRecords));
  if (opts.withFull !== false) writeFileSync(fullPath, jsonl(logs.fullRecords));
  return { ...logs, logsDir, compactPath, fullPath };
}
