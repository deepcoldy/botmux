import { afterEach, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { nativeProxyFixture } from './helpers/model-proxy-native.js';

const executable = process.env.BOTMUX_MODEL_ONLY_CLAUDE;
const sdkPath = process.env.BOTMUX_MODEL_PROXY_OPENAI_SDK;
const ocrPath = process.env.BOTMUX_MODEL_PROXY_OCR;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
it.skipIf(!executable || !sdkPath)('unmodified OpenAI SDK completes text and an external tool roundtrip through the native CLI', async () => {
  const h = await nativeProxyFixture(executable!, chat => {
    if (!chat.tools?.length) return { content: 'hello', tool_calls: [] };
    if (chat.messages.at(-1)?.role === 'tool') return { content: '42', tool_calls: [] };
    return { content: '', tool_calls: [{ name: 'add', arguments: '{"left":19,"right":23}' }] };
  }); cleanups.push(() => h.close());
  const { default: OpenAI } = await import(pathToFileURL(sdkPath!).href);
  const sdk = new OpenAI({ baseURL: h.baseURL, apiKey: h.token, maxRetries: 0 });
  const text = await sdk.chat.completions.create({ model: 'reasoner', messages: [{ role: 'user', content: 'hello' }] });
  expect(text.choices[0].message.content).toBe('hello');
  const tools = [{ type: 'function', function: { name: 'add', parameters: { type: 'object', properties: { left: { type: 'integer' }, right: { type: 'integer' }, optional_label: { type: 'string' } }, required: ['left', 'right'], additionalProperties: false } } }];
  const messages: any[] = [{ role: 'system', content: 'Use the external calculator.' }, { role: 'user', content: '19 + 23' }];
  const first = await sdk.chat.completions.create({ model: 'reasoner', messages, tools, tool_choice: 'required', parallel_tool_calls: false, max_completion_tokens: 4096 });
  expect(first.choices[0].finish_reason).toBe('tool_calls');
  const c = first.choices[0].message.tool_calls[0]; const args = JSON.parse(c.function.arguments);
  const sum = args.left + args.right; // Caller executes its own tool.
  messages.push(first.choices[0].message, { role: 'tool', tool_call_id: c.id, content: String(sum) });
  const second = await sdk.chat.completions.create({ model: 'reasoner', messages, tools, tool_choice: 'none' });
  expect(second.choices[0].message.content).toBe('42');
  expect(h.chats[2].messages).toEqual(messages);
  expect(h.nativeRequests[1].max_tokens).toBe(4096);
  expect(h.nativeRequests.every(r => r.tools.every((t: any) => t.name === 'StructuredOutput'))).toBe(true);
  expect(h.failures).toEqual([]); expect(second.usage).toBeNull();
  expect(second.botmux.native_invocation_usage.outputTokens).toBeGreaterThan(0);
});

it.skipIf(!executable || !ocrPath)('unmodified OCR release source build performs a native review and reads external tool results', async () => {
  const h = await nativeProxyFixture(executable!, chat => {
    const system = JSON.stringify(chat.messages.filter(m => m.role === 'system'));
    if (system.includes('task planning')) return { content: 'Summary: Review the synthetic arithmetic module.\n\nIssues\n\n1. [low] Verify the addition contract.\n   → file_read math.ts — inspect the complete module', tool_calls: [] };
    if (!chat.tools?.length) return { content: '[]', tool_calls: [] };
    const readResult = chat.messages.find(m => m.role === 'tool');
    if (!readResult) return { content: '', tool_calls: [{ name: 'file_read', arguments: JSON.stringify({ file_path: 'math.ts' }) }] };
    return { content: '', tool_calls: [{ name: 'task_done', arguments: '{"state":"DONE"}' }] };
  }); cleanups.push(() => h.close());
  const repo = join(h.root, 'review-repo'); const home = join(h.root, 'ocr-home');
  mkdirSync(repo); mkdirSync(home); mkdirSync(join(home, '.opencodereview'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'Synthetic baseline'], { cwd: repo });
  // Enough changed lines to exercise OCR's native planning stage too.
  writeFileSync(join(repo, 'math.ts'), 'export function add(left: number, right: number): number {\n  return left + right;\n}\n' + Array.from({ length: 65 }, (_, i) => `export const fixture${i} = ${i};`).join('\n') + '\n');
  const resultPath = join(h.root, 'review.json');
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(ocrPath!, ['review', '--repo', repo, '--audience', 'agent', '--format', 'json', '--concurrency', '1', '--timeout', '2', '--output', resultPath], { env: { PATH: process.env.PATH, HOME: home, OCR_LLM_URL: h.baseURL, OCR_LLM_TOKEN: h.token, OCR_LLM_MODEL: 'reasoner', OCR_LLM_PROTOCOL: 'openai', NO_PROXY: '127.0.0.1' } });
    let stdout = ''; let stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  expect(output.code, output.stderr + '\n' + JSON.stringify(h.failures)).toBe(0);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  expect(result.status).toBe('complete');
  expect(result.tool_calls.failure).toBe(0);
  expect(result.tool_calls.by_tool.file_read).toBe(1);
  expect(result.manifest.coverage.selected.map((item: any) => item.path)).toEqual(['math.ts']);
  expect(result.manifest.coverage.completed).toEqual(result.manifest.coverage.selected);
  expect(result.manifest.coverage.failed).toEqual([]);
  expect(result.manifest.coverage.waived).toEqual([]);
  // Inspect the real report and tool-result payload; exit 0 alone proves little.
  expect(h.chats.some(c => JSON.stringify(c.messages).includes('task planning'))).toBe(true);
  const results = h.chats.flatMap(c => c.messages.filter(m => m.role === 'tool'));
  expect(results.length).toBeGreaterThan(0);
  expect(results.some(m => JSON.stringify(m).includes('return left + right'))).toBe(true);
  expect(results.every(m => !/Error:|tool not found|file not found/i.test(JSON.stringify(m)))).toBe(true);
  expect(h.nativeRequests.every(r => r.tools.every((t: any) => t.name === 'StructuredOutput'))).toBe(true);
  expect(h.chats.every(c => c.max_completion_tokens === 16384)).toBe(true);
  expect(h.nativeRequests.every(r => r.max_tokens === 16384)).toBe(true);
  expect(h.failures).toEqual([]);
  // Kept synthetic and safe to print for reproducing the acceptance assertions.
  if (process.env.BOTMUX_MODEL_PROXY_EVIDENCE) writeFileSync(process.env.BOTMUX_MODEL_PROXY_EVIDENCE, JSON.stringify({ result, requests: h.chats, nativeTools: h.nativeRequests.map(r => r.tools.map((t: any) => t.name)), nativeLimits: h.nativeRequests.map(r => r.max_tokens) }, null, 2));
}, 120000);

it.skipIf(!executable)('public request disconnect cancels the native process before the configured deadline', async () => {
  const h = await nativeProxyFixture(executable!, () => undefined); cleanups.push(() => h.close());
  const controller = new AbortController();
  const response = fetch(`${h.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'reasoner', messages: [{ role: 'user', content: 'hang' }] }), signal: controller.signal }).catch(() => null);
  for (let i = 0; i < 100 && !h.nativeRequests.length; i++) await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.nativeRequests).toHaveLength(1); expect(h.pids).toHaveLength(1);
  controller.abort(); await response;
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    try { process.kill(h.pids[0], 0); } catch { alive = false; }
  }
  expect(alive).toBe(false);
});
