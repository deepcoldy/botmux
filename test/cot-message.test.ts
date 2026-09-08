/**
 * Native CoT message (im.v1 message_cot) — unit tests.
 *
 * Covers the daemon-side bridge: create-on-first-update with AG-UI prologue,
 * cumulative segment list → one reasoning message (node) per segment,
 * latest-wins pumping, RUN_FINISHED terminal batch on finalize, per-turn
 * disable on API failure (handleCotThinkingUpdate returns false; thinking is
 * simply not displayed), and the error-path explicit complete when the
 * terminal batch fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const request = vi.fn();
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { thinkingCard: true } })),
  getBotClient: vi.fn(() => ({ request })),
}));

import { mkdtempSync, existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleCotThinkingUpdate, finalizeCotMessage, abortCotMessage, sweepOrphanCotMessages, settleCotMessageForShutdown } from '../src/im/lark/cot-message.js';
import { getBot } from '../src/bot-registry.js';

// Orphan markers land under config.session.dataDir — point it at a tmp dir so
// tests never touch the packaged data directory.
const dataDir = mkdtempSync(join(tmpdir(), 'cot-test-'));
process.env.SESSION_DATA_DIR = dataDir;
const orphanDir = join(dataDir, 'cot-orphans');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Default: a thread-scope (topic) session — scope undefined ≠ 'chat', with
 *  the topic root as rootMessageId, matching real topic sessions. */
const makeDs = (over: any = {}): any => ({
  larkAppId: 'app1',
  chatId: 'oc_chat1',
  ...over,
  session: { sessionId: 's1', rootMessageId: 'om_root1', ...(over.session ?? {}) },
});

const think = (text: string): any => ({ kind: 'thinking', text });
const upd = (entries: any[], turnId = 'om_turn1'): any => ({ type: 'thinking_update', entries, turnId });

/** All PUT event batches flattened to [event_type, parsed content] pairs. */
function pushedEvents(): Array<{ type: string; content: any }> {
  return request.mock.calls
    .filter(([req]) => req.method === 'PUT')
    .flatMap(([req]) => req.data.events.map((e: any) => ({ type: e.event_type, content: JSON.parse(e.content) })));
}

beforeEach(() => {
  request.mockReset().mockImplementation(async (req: any) => {
    if (req.method === 'POST' && req.url === '/open-apis/im/v1/message_cot') {
      return { code: 0, data: { cot_id: 'cot1', message_id: 'om_cot_msg1' } };
    }
    return { code: 0, data: {} };
  });
  vi.mocked(getBot).mockClear().mockReturnValue({ config: { thinkingCard: true } } as any);
  rmSync(orphanDir, { recursive: true, force: true });
});

describe('handleCotThinkingUpdate', () => {
  it('topic session: creates INSIDE the topic (root anchor + reply_in_thread), sends the AG-UI prologue', async () => {
    const ds = makeDs();
    expect(handleCotThinkingUpdate(ds, upd([think('step 1')]))).toBe(true);
    await flush();
    const create = request.mock.calls.find(([req]) => req.method === 'POST')![0];
    expect(create.params).toEqual({ receive_id_type: 'chat_id' });
    // origin_message_id alone parents the bubble but leaves it at chat level
    // (outside the topic) — reply_in_thread is what actually threads it.
    expect(create.data).toEqual({ receive_id: 'oc_chat1', origin_message_id: 'om_root1', reply_in_thread: true });
    const events = pushedEvents();
    expect(events.map(e => e.type)).toEqual([
      'RUN_STARTED', 'REASONING_START',
      'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT', 'REASONING_MESSAGE_END',
    ]);
    expect(events[3].content.delta).toBe('step 1');
  });

  it('topic session with a synthetic (non om_) turn id still threads via the topic root', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('x')], 'sched-123'));
    await flush();
    const create = request.mock.calls.find(([req]) => req.method === 'POST')![0];
    expect(create.data).toEqual({ receive_id: 'oc_chat1', origin_message_id: 'om_root1', reply_in_thread: true });
  });

  it('chat-scope session: anchors to the triggering message WITHOUT reply_in_thread (a plain-group anchor must not spawn a topic)', async () => {
    const ds = makeDs({ scope: 'chat' });
    handleCotThinkingUpdate(ds, upd([think('x')]));
    await flush();
    const create = request.mock.calls.find(([req]) => req.method === 'POST')![0];
    expect(create.data).toEqual({ receive_id: 'oc_chat1', origin_message_id: 'om_turn1' });
  });

  it('chat-scope session skips origin_message_id for synthetic turn ids', async () => {
    const ds = makeDs({ scope: 'chat' });
    handleCotThinkingUpdate(ds, upd([think('x')], 'sched-123'));
    await flush();
    const create = request.mock.calls.find(([req]) => req.method === 'POST')![0];
    expect(create.data).toEqual({ receive_id: 'oc_chat1' });
  });

  it('chat-scope turn folded into a topic (per-turn thread reply target) threads into that topic', async () => {
    const ds = makeDs({ scope: 'chat', session: { replyTargets: { om_turn1: { rootMessageId: 'om_fold_root' } } } });
    handleCotThinkingUpdate(ds, upd([think('x')]));
    await flush();
    const create = request.mock.calls.find(([req]) => req.method === 'POST')![0];
    expect(create.data).toEqual({ receive_id: 'oc_chat1', origin_message_id: 'om_fold_root', reply_in_thread: true });
  });

  it('uses the FROZEN per-turn context, so a pruned live entry cannot flatten the bubble', async () => {
    // replyTargets is capped at 32 (REPLY_TARGETS_MAX) while turnReplyContexts
    // holds 256, and the live entry is written at message-arrival while the
    // bubble is created on the turn's first thinking_update. On a busy session
    // the live entry can be pruned in that window: the frozen context still
    // says {thread, om_fold} where resolveSessionReplyTarget has degraded to
    // {plain} — which would resurrect this very bug in the fold-back case.
    const ds = makeDs({
      scope: 'chat',
      currentReplyTarget: { rootMessageId: 'om_other', turnId: 'om_other_turn', updatedAt: new Date().toISOString() },
      session: {
        // Live per-turn entry for om_turn1 is GONE (pruned); only the frozen one remains.
        replyTargets: {},
        turnReplyContexts: { om_turn1: { target: { mode: 'thread', rootMessageId: 'om_fold_root' } } },
        currentReplyTarget: { rootMessageId: 'om_other', turnId: 'om_other_turn', updatedAt: new Date().toISOString() },
      },
    });
    handleCotThinkingUpdate(ds, upd([think('x')]));
    await flush();
    const create = request.mock.calls.find(([req]) => req.method === 'POST')![0];
    expect(create.data).toEqual({ receive_id: 'oc_chat1', origin_message_id: 'om_fold_root', reply_in_thread: true });
  });

  it('degrades to a chat-level bubble when the thread anchor is not an om_ message id', async () => {
    // session.rootMessageId is NOT always a message id on a thread-scope
    // session: a silent new-topic schedule stores `schedule-run:<task>:<uuid>`,
    // and `schedule add --topic --root-msg-id <any string>` is unvalidated (the
    // cross-thread fire path anchors it verbatim without probing, so it does
    // not self-heal). Feishu rejects a non-om_ origin and a failed create kills
    // thinking for the WHOLE turn — a chat-level bubble is strictly better.
    for (const bad of ['schedule-run:task1:uuid1', 'oc_chat1']) {
      request.mockClear();
      const ds = makeDs({ session: { rootMessageId: bad } });
      handleCotThinkingUpdate(ds, upd([think('x')], 'schedule:task1:uuid1'));
      await flush();
      const create = request.mock.calls.find(([req]) => req.method === 'POST')![0];
      expect(create.data, `non-om_ anchor ${bad} must not reach Feishu`)
        .toEqual({ receive_id: 'oc_chat1' });
    }
  });

  it('chat-scope quote-only reply target anchors to the quote WITHOUT reply_in_thread', async () => {
    const ds = makeDs({ scope: 'chat', session: { replyTargets: { om_turn1: { rootMessageId: 'om_quote_tgt', quoteOnly: true } } } });
    handleCotThinkingUpdate(ds, upd([think('x')]));
    await flush();
    const create = request.mock.calls.find(([req]) => req.method === 'POST')![0];
    expect(create.data).toEqual({ receive_id: 'oc_chat1', origin_message_id: 'om_quote_tgt' });
  });

  it('pushes each new thinking entry as its own reasoning message (one node per entry)', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('seg A')]));
    await flush();
    handleCotThinkingUpdate(ds, upd([think('seg A'), think('seg B'), think('seg C')]));
    await flush();
    const contents = pushedEvents().filter(e => e.type === 'REASONING_MESSAGE_CONTENT');
    expect(contents.map(e => e.content.delta)).toEqual(['seg A', 'seg B', 'seg C']);
    // Distinct messageIds → distinct nodes; already-sent segments never resent.
    const ids = contents.map(e => e.content.messageId);
    expect(new Set(ids).size).toBe(3);
    // Each node is opened and closed around its content.
    const types = pushedEvents().map(e => e.type).filter(t => t.startsWith('REASONING_MESSAGE'));
    expect(types).toEqual([
      'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT', 'REASONING_MESSAGE_END',
      'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT', 'REASONING_MESSAGE_END',
      'REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT', 'REASONING_MESSAGE_END',
    ]);
  });

  it('maps tool entries to TOOL_CALL_* events with icon, args, and code-style result', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([
      think('let me check'),
      { kind: 'tool_call', id: 'toolu_1', name: 'Bash', args: '{"command":"ls"}' },
      { kind: 'tool_result', id: 'toolu_1', result: 'file-a\nfile-b' },
      { kind: 'tool_call', id: 'toolu_2', name: 'Grep', args: '' },
    ]));
    await flush();
    const events = pushedEvents();
    const start1 = events.find(e => e.type === 'TOOL_CALL_START' && e.content.toolCallId === 'toolu_1')!;
    expect(start1.content.icon).toBe('bash');
    expect(start1.content.toolCallName).toBe('Bash');
    // Category label PLUS the concrete command — the renderer ignores
    // TOOL_CALL_ARGS, so the title is the only place the command shows up.
    expect(start1.content.title).toContain('ls');
    expect(start1.content.title).not.toContain('{'); // never the raw JSON blob
    expect(start1.content.parentMessageId).toBeDefined(); // attached to the preceding thinking node
    const args = events.find(e => e.type === 'TOOL_CALL_ARGS')!;
    expect(args.content).toEqual({ toolCallId: 'toolu_1', delta: '{"command":"ls"}' });
    const result = events.find(e => e.type === 'TOOL_CALL_RESULT')!;
    expect(result.content.toolCallId).toBe('toolu_1');
    // Shell output is tagged `bash` so the block highlights instead of
    // reading「plaintext」(the renderer never infers this on its own).
    expect(JSON.parse(result.content.content)).toEqual({ type: 'code', language: 'bash', code: 'file-a\nfile-b' });
    // Empty args → no TOOL_CALL_ARGS event, but START/END still sent.
    const start2 = events.find(e => e.type === 'TOOL_CALL_START' && e.content.toolCallId === 'toolu_2')!;
    expect(start2.content.icon).toBe('search');
    expect(events.filter(e => e.type === 'TOOL_CALL_ARGS').length).toBe(1);
    expect(events.filter(e => e.type === 'TOOL_CALL_END').map(e => e.content.toolCallId)).toEqual(['toolu_1', 'toolu_2']);
  });

  /**
   * The title is the ONLY carrier the Feishu CoT renderer draws for a tool
   * call: a live A/B showed a node with full TOOL_CALL_ARGS and a control
   * node with no args event at all rendering identically. Each case below is
   * a real shape harvested from on-disk transcripts, not an invented one.
   */
  it('carries the tool subject in the title across both CLIs\' arg shapes', async () => {
    const ds = makeDs();
    const titleOf = (id: string): string =>
      pushedEvents().find(e => e.type === 'TOOL_CALL_START' && e.content.toolCallId === id)!.content.title;

    handleCotThinkingUpdate(ds, upd([
      // Claude Bash — by far the most common call (~1900 in local transcripts).
      { kind: 'tool_call', id: 't1', name: 'Bash', args: '{"command":"git log --oneline -5","description":"recent commits"}' },
      // Claude file ops key off file_path, not command.
      { kind: 'tool_call', id: 't2', name: 'Read', args: '{"file_path":"/root/iserver/botmux/src/daemon.ts","limit":50}' },
      // Codex local_shell_call: command is argv; the script is the last element.
      { kind: 'tool_call', id: 't3', name: 'shell', args: '{"command":["bash","-lc","pnpm run build"]}' },
      // Codex custom_tool_call ships a RAW non-JSON string — must not be dropped.
      { kind: 'tool_call', id: 't4', name: 'exec', args: 'await tools.exec_command({ cmd: "free -h" })' },
      // Multi-line script collapses to one line (the title never wraps).
      { kind: 'tool_call', id: 't5', name: 'Bash', args: '{"command":"line one\\nline two\\n  line three"}' },
    ]));
    await flush();

    expect(titleOf('t1')).toContain('git log --oneline -5');
    expect(titleOf('t1')).not.toContain('recent commits'); // description is not the subject
    expect(titleOf('t2')).toContain('/root/iserver/botmux/src/daemon.ts');
    expect(titleOf('t3')).toContain('pnpm run build');
    expect(titleOf('t3')).not.toContain('bash'); // argv boilerplate stripped
    expect(titleOf('t4')).toContain('free -h');
    expect(titleOf('t5')).toBe('执行命令 · line one line two line three');
  });

  it('falls back to the bare category label when no subject can be extracted', async () => {
    const ds = makeDs();
    const titleOf = (id: string): string =>
      pushedEvents().find(e => e.type === 'TOOL_CALL_START' && e.content.toolCallId === id)!.content.title;

    handleCotThinkingUpdate(ds, upd([
      { kind: 'tool_call', id: 'n1', name: 'TaskList', args: '' },            // no args at all
      { kind: 'tool_call', id: 'n2', name: 'TaskUpdate', args: '{"taskId":"1","status":"done"}' }, // no known field
      { kind: 'tool_call', id: 'n3', name: 'Bash', args: '{"command":"   "}' },  // whitespace-only
      { kind: 'tool_call', id: 'n4', name: 'Bash', args: '{"command":' },        // truncated/invalid JSON
    ]));
    await flush();

    // Degrades to exactly today's rendering — never '[object Object]' or a
    // dangling separator.
    expect(titleOf('n1')).toBe('任务管理');
    expect(titleOf('n2')).toBe('任务管理');
    expect(titleOf('n3')).toBe('执行命令');
    expect(titleOf('n4')).toBe('执行命令'); // broken JSON fragment never shown
    for (const id of ['n1', 'n2', 'n3', 'n4']) {
      expect(titleOf(id)).not.toContain('·');
      expect(titleOf(id)).not.toContain('object Object');
    }
  });

  /**
   * The renderer echoes `language` verbatim and never auto-detects (verified
   * live: a bogus value prints as-is; Python content with no language set
   * still reads "plaintext"). So the mapping must be a whitelist, and an
   * unmapped tool must omit the field rather than pass an extension through.
   */
  it('tags result code blocks with a whitelisted language, omitting it when unknown', async () => {
    const ds = makeDs();
    const resultFor = (id: string): any =>
      JSON.parse(pushedEvents().find(e => e.type === 'TOOL_CALL_RESULT' && e.content.toolCallId === id)!.content.content);

    handleCotThinkingUpdate(ds, upd([
      { kind: 'tool_call', id: 'g1', name: 'Bash', args: '{"command":"ls -la"}' },
      { kind: 'tool_result', id: 'g1', result: 'total 0' },
      { kind: 'tool_call', id: 'g2', name: 'Read', args: '{"file_path":"/a/b/daemon.ts"}' },
      { kind: 'tool_result', id: 'g2', result: 'export const x = 1;' },
      { kind: 'tool_call', id: 'g3', name: 'Read', args: '{"file_path":"/a/b/conf.yml"}' },
      { kind: 'tool_result', id: 'g3', result: 'key: value' },
      // Extension with no whitelist entry: must NOT leak "wat" as the label.
      { kind: 'tool_call', id: 'g4', name: 'Read', args: '{"file_path":"/a/b/notes.wat"}' },
      { kind: 'tool_result', id: 'g4', result: 'blah' },
      // No file, no shell → no language at all (renders as plaintext).
      { kind: 'tool_call', id: 'g5', name: 'TaskUpdate', args: '{"taskId":"1"}' },
      { kind: 'tool_result', id: 'g5', result: 'Updated task #1' },
    ]));
    await flush();

    expect(resultFor('g1')).toEqual({ type: 'code', language: 'bash', code: 'total 0' });
    expect(resultFor('g2').language).toBe('typescript');
    expect(resultFor('g3').language).toBe('yaml');
    // Unmapped / inapplicable → field absent entirely, never a bogus label.
    expect(resultFor('g4')).toEqual({ type: 'code', code: 'blah' });
    expect(resultFor('g5')).toEqual({ type: 'code', code: 'Updated task #1' });
    expect(resultFor('g4').language).toBeUndefined();
    expect(resultFor('g5').language).toBeUndefined();
  });

  /**
   * Regression: truncation is a rendering concern and must not feed logic.
   * The first version resolved the language off the DISPLAY string, so any
   * path longer than the 80-char title cap lost its extension to the ellipsis
   * and silently fell back to plaintext.
   */
  it('detects the language from the untruncated path, not the shortened title', async () => {
    const ds = makeDs();
    const longPath = '/root/iserver/botmux/src/very/deeply/nested/directory/structure/that/goes/on/module.ts';
    expect(longPath.length).toBeGreaterThan(80); // the case only bites past the cap
    handleCotThinkingUpdate(ds, upd([
      { kind: 'tool_call', id: 'L', name: 'Read', args: JSON.stringify({ file_path: longPath }) },
      { kind: 'tool_result', id: 'L', result: 'export const x = 1;' },
    ]));
    await flush();
    const title = pushedEvents().find(e => e.type === 'TOOL_CALL_START')!.content.title as string;
    const body = JSON.parse(pushedEvents().find(e => e.type === 'TOOL_CALL_RESULT')!.content.content);
    expect(title.endsWith('…')).toBe(true);   // still bounded for layout
    expect(title).not.toContain('.ts');        // extension really is cut from the title
    expect(body.language).toBe('typescript');  // …yet detection still sees it
  });

  /**
   * The transcript layer hard-cuts args at 600 chars, so a Write/Edit whose
   * `content` dwarfs the path arrives as unparseable JSON. The leading
   * `"file_path":"…"` survives that cut, so recover it rather than showing a
   * bare label.
   */
  it('recovers a subject by regex when oversized args arrive truncated', async () => {
    const ds = makeDs();
    const path = '/root/iserver/botmux/src/core/worker-pool.ts';
    const full = JSON.stringify({ file_path: path, content: 'x'.repeat(2000) });
    const truncated = full.slice(0, 600); // exactly what truncateForCot does
    expect(() => JSON.parse(truncated)).toThrow(); // precondition: really broken

    handleCotThinkingUpdate(ds, upd([
      { kind: 'tool_call', id: 'W', name: 'Write', args: truncated },
      { kind: 'tool_result', id: 'W', result: 'ok' },
      // A value cut mid-string must NOT be shown half-rendered.
      { kind: 'tool_call', id: 'W2', name: 'Write', args: '{"file_path":"/a/b/unterminat' },
      { kind: 'tool_result', id: 'W2', result: 'ok' },
    ]));
    await flush();
    const titleOf = (id: string): string =>
      pushedEvents().find(e => e.type === 'TOOL_CALL_START' && e.content.toolCallId === id)!.content.title;
    const bodyOf = (id: string): any =>
      JSON.parse(pushedEvents().find(e => e.type === 'TOOL_CALL_RESULT' && e.content.toolCallId === id)!.content.content);

    expect(titleOf('W')).toContain(path);
    expect(titleOf('W')).not.toContain('{');       // never the JSON fragment
    expect(bodyOf('W').language).toBe('typescript'); // recovery feeds detection too
    // Incomplete pair → no match → bare label, exactly as before.
    expect(titleOf('W2')).toBe('编辑文件');
    expect(bodyOf('W2').language).toBeUndefined();
  });

  it('keeps sub-agent and fetch style calls honest', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([
      // description/prompt are the only identifying fields a Task call has.
      { kind: 'tool_call', id: 'T', name: 'TaskCreate', args: JSON.stringify({ subject: '跑一遍回归', activeForm: '跑回归' }) },
      { kind: 'tool_result', id: 'T', result: 'created' },
      { kind: 'tool_call', id: 'A', name: 'Agent', args: JSON.stringify({ description: 'Find the auth flow', subagent_type: 'Explore' }) },
      { kind: 'tool_result', id: 'A', result: 'found' },
      // A .json URL must not label fetched prose as json.
      { kind: 'tool_call', id: 'F', name: 'WebFetch', args: JSON.stringify({ url: 'https://example.com/api/spec.json' }) },
      { kind: 'tool_result', id: 'F', result: 'The page describes…' },
      // execute_* is not a shell despite containing "exec".
      { kind: 'tool_call', id: 'S', name: 'execute_sql', args: JSON.stringify({ query: 'select 1' }) },
      { kind: 'tool_result', id: 'S', result: '1' },
    ]));
    await flush();
    const titleOf = (id: string): string =>
      pushedEvents().find(e => e.type === 'TOOL_CALL_START' && e.content.toolCallId === id)!.content.title;
    const bodyOf = (id: string): any =>
      JSON.parse(pushedEvents().find(e => e.type === 'TOOL_CALL_RESULT' && e.content.toolCallId === id)!.content.content);

    expect(titleOf('T')).toContain('跑一遍回归');
    expect(titleOf('A')).toContain('Find the auth flow');
    expect(bodyOf('F').language).toBeUndefined(); // not "json"
    expect(bodyOf('S').language).toBeUndefined(); // not "bash"
  });

  it('does not highlight search results by the pattern\'s extension', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([
      // A pattern ending in an extension says what to FIND; the result is a
      // match list, not a file of that type.
      { kind: 'tool_call', id: 'G', name: 'Grep', args: JSON.stringify({ pattern: 'readme\\.md' }) },
      { kind: 'tool_result', id: 'G', result: 'docs/readme.md:1:# Title' },
      { kind: 'tool_call', id: 'B', name: 'Glob', args: JSON.stringify({ pattern: 'src/**/*.ts' }) },
      { kind: 'tool_result', id: 'B', result: 'src/daemon.ts\nsrc/worker.ts' },
    ]));
    await flush();
    const bodyOf = (id: string): any =>
      JSON.parse(pushedEvents().find(e => e.type === 'TOOL_CALL_RESULT' && e.content.toolCallId === id)!.content.content);
    const titleOf = (id: string): string =>
      pushedEvents().find(e => e.type === 'TOOL_CALL_START' && e.content.toolCallId === id)!.content.title;
    expect(bodyOf('G').language).toBeUndefined(); // not "markdown"
    expect(bodyOf('B').language).toBeUndefined(); // not "typescript"
    // The pattern still shows in the title — only the highlight is suppressed.
    expect(titleOf('G')).toContain('readme');
    expect(titleOf('B')).toContain('src/**/*.ts');
  });

  it('bounds an overlong command so the title stays one readable line', async () => {
    const ds = makeDs();
    const long = `echo ${'x'.repeat(500)}`;
    handleCotThinkingUpdate(ds, upd([
      { kind: 'tool_call', id: 'L1', name: 'Bash', args: JSON.stringify({ command: long }) },
    ]));
    await flush();
    const title = pushedEvents().find(e => e.type === 'TOOL_CALL_START')!.content.title as string;
    expect(title.length).toBeLessThan(120);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toContain('echo xxx');
    // The untruncated args still go out on the wire — cheap, and a future
    // client may render them.
    const args = pushedEvents().find(e => e.type === 'TOOL_CALL_ARGS')!;
    expect(args.content.delta).toContain('x'.repeat(500));
  });

  it('coalesces bursts to the latest entry list (single in-flight pump)', async () => {
    const ds = makeDs();
    let release: () => void = () => {};
    request.mockImplementation(async (req: any) => {
      if (req.method === 'POST') return { code: 0, data: { cot_id: 'cot1', message_id: 'om_cot_msg1' } };
      if (req.data.events.some((e: any) => e.event_type === 'RUN_STARTED')) {
        // Block the prologue push; updates pile up meanwhile.
        return new Promise((r) => { release = () => r({ code: 0, data: {} }); });
      }
      return { code: 0, data: {} };
    });
    handleCotThinkingUpdate(ds, upd([think('v1')]));
    await flush();
    handleCotThinkingUpdate(ds, upd([think('v1'), think('v2')]));
    handleCotThinkingUpdate(ds, upd([think('v1'), think('v2'), think('v3')]));
    release();
    await flush();
    const deltas = pushedEvents().filter(e => e.type === 'REASONING_MESSAGE_CONTENT').map(e => e.content.delta);
    expect(deltas).toEqual(['v1', 'v2', 'v3']); // one batch, nothing pushed twice
    expect(request.mock.calls.filter(([req]) => req.method === 'PUT').length).toBe(2); // prologue + one segment batch
  });

  it('disables the turn after a create failure (thinking not displayed)', async () => {
    const ds = makeDs();
    request.mockRejectedValueOnce(new Error('99991672 missing scope'));
    expect(handleCotThinkingUpdate(ds, upd([think('step 1')]))).toBe(true); // creating (optimistic)
    await flush();
    expect(handleCotThinkingUpdate(ds, upd([think('step 1'), think('more')]))).toBe(false); // disabled
    // A NEW turn retries from scratch.
    expect(handleCotThinkingUpdate(ds, upd([think('fresh')], 'om_turn2'))).toBe(true);
    await flush();
    expect(request.mock.calls.filter(([req]) => req.method === 'POST' && req.url === '/open-apis/im/v1/message_cot').length).toBe(2);
  });

  it('does nothing when explicitly disabled or apiOnly; absent config means ON (default)', () => {
    const ds = makeDs();
    vi.mocked(getBot).mockReturnValue({ config: { thinkingCard: false } } as any);
    expect(handleCotThinkingUpdate(ds, upd([think('x')]))).toBe(false);
    vi.mocked(getBot).mockReturnValue({ config: { thinkingCard: true, apiOnly: true } } as any);
    expect(handleCotThinkingUpdate(ds, upd([think('x')]))).toBe(false);
    expect(request).not.toHaveBeenCalled();
    // Default ON: a bot that never touched the field streams CoT.
    vi.mocked(getBot).mockReturnValue({ config: {} } as any);
    expect(handleCotThinkingUpdate(ds, upd([think('x')]))).toBe(true);
  });

  it('cotForced (/cot show) overrides both switches for the session, but never apiOnly', () => {
    const ds = makeDs();
    ds.cotForced = true;
    vi.mocked(getBot).mockReturnValue({ config: { thinkingCard: false, noCotChats: ['oc_chat1'] } } as any);
    expect(handleCotThinkingUpdate(ds, upd([think('x')]))).toBe(true);
    vi.mocked(getBot).mockReturnValue({ config: { apiOnly: true } } as any);
    expect(handleCotThinkingUpdate(ds, upd([think('x')]))).toBe(false);
  });

  it('does nothing when the chat is muted via noCotChats (/cot off)', () => {
    const ds = makeDs();
    vi.mocked(getBot).mockReturnValue({ config: { thinkingCard: true, noCotChats: ['oc_chat1'] } } as any);
    expect(handleCotThinkingUpdate(ds, upd([think('x')]))).toBe(false);
    expect(request).not.toHaveBeenCalled();
    // A different chat with the same bot config stays enabled.
    const other = makeDs();
    other.chatId = 'oc_other';
    expect(handleCotThinkingUpdate(other, upd([think('x')]))).toBe(true);
  });
});

describe('finalizeCotMessage', () => {
  it('sends the terminal batch (RUN_FINISHED auto-completes) and swallows late updates', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    expect(finalizeCotMessage(ds, 'om_turn1', 'completed')).toBe(true);
    await flush();
    const types = pushedEvents().map(e => e.type);
    expect(types.slice(-2)).toEqual(['REASONING_END', 'RUN_FINISHED']);
    expect(pushedEvents().at(-1)!.content.status).toBe('done');
    // Late update for the settled turn: still owned (true), but no new pushes.
    const putCount = request.mock.calls.length;
    expect(handleCotThinkingUpdate(ds, upd([think('step 1'), think('late')]))).toBe(true);
    await flush();
    expect(request.mock.calls.length).toBe(putCount);
    // Repeat finalize is a no-op.
    finalizeCotMessage(ds, 'om_turn1', 'completed');
    await flush();
    expect(request.mock.calls.length).toBe(putCount);
  });

  it('maps non-completed terminals to interrupted', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    finalizeCotMessage(ds, 'om_turn1', 'cancelled');
    await flush();
    expect(pushedEvents().at(-1)!.content.status).toBe('interrupted');
  });

  it('returns false for unknown turns and disabled states', async () => {
    const ds = makeDs();
    expect(finalizeCotMessage(ds, 'om_never_seen', 'completed')).toBe(false);
    request.mockRejectedValueOnce(new Error('boom'));
    handleCotThinkingUpdate(ds, upd([think('x')]));
    await flush(); // create fails → disabled
    expect(finalizeCotMessage(ds, 'om_turn1', 'completed')).toBe(false);
  });

  it('falls back to explicit complete when the terminal batch fails', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    request.mockImplementation(async (req: any) => {
      if (req.method === 'PUT') throw new Error('COT already in terminal state');
      return { code: 0, data: {} };
    });
    finalizeCotMessage(ds, 'om_turn1', 'completed');
    await flush();
    const complete = request.mock.calls.find(([req]) => String(req.url).includes('/message_cot/complete/'));
    expect(complete).toBeTruthy();
    expect(complete![0].params).toEqual({ message_id: 'om_cot_msg1', reason: 'error' });
  });

  it('closes a bubble disabled mid-turn (push failure before terminal) at finalize', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush(); // created ok
    request.mockRejectedValueOnce(new Error('network blip'));
    handleCotThinkingUpdate(ds, upd([think('step 1'), think('step 2')]));
    await flush(); // push fails → disabled, no finishStatus
    expect(finalizeCotMessage(ds, 'om_turn1', 'completed')).toBe(false);
    await flush();
    const complete = request.mock.calls.find(([req]) => String(req.url).includes('/message_cot/complete/'));
    expect(complete).toBeTruthy();
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(false);
  });
});

describe('orphan markers & sweep (daemon restart mid-turn)', () => {
  it('writes a marker on create and removes it when the turn settles normally', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(true);
    finalizeCotMessage(ds, 'om_turn1', 'completed');
    await flush();
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(false);
  });

  it('sweep completes leftover bubbles and consumes markers (even broken ones)', async () => {
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'cot_prev.json'), JSON.stringify({ larkAppId: 'app1', cotId: 'cot_prev', messageId: 'om_prev' }));
    writeFileSync(join(orphanDir, 'broken.json'), 'not json');
    await sweepOrphanCotMessages('app1');
    const complete = request.mock.calls.find(([req]) => String(req.url).includes('/message_cot/complete/cot_prev'));
    expect(complete).toBeTruthy();
    expect(complete![0].params).toEqual({ message_id: 'om_prev', reason: 'done' });
    expect(readdirSync(orphanDir)).toEqual([]);
  });

  it('sweep leaves sibling bots\' markers alone (shared dataDir, per-bot daemons)', async () => {
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'cot_mine.json'), JSON.stringify({ larkAppId: 'app1', cotId: 'cot_mine', messageId: 'om_mine' }));
    writeFileSync(join(orphanDir, 'cot_theirs.json'), JSON.stringify({ larkAppId: 'app_other', cotId: 'cot_theirs', messageId: 'om_theirs' }));
    await sweepOrphanCotMessages('app1');
    // Own marker: closed and consumed. Sibling's: untouched on disk, no API
    // call — its own daemon must close it (this one has no client for it).
    expect(request.mock.calls.some(([req]) => String(req.url).includes('cot_mine'))).toBe(true);
    expect(request.mock.calls.some(([req]) => String(req.url).includes('cot_theirs'))).toBe(false);
    expect(readdirSync(orphanDir)).toEqual(['cot_theirs.json']);
  });

  it('sweep is a no-op without a marker directory', async () => {
    await expect(sweepOrphanCotMessages('app1')).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('sweep annotates the bubble as interrupted BEFORE completing it', async () => {
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'cot_prev.json'), JSON.stringify({ larkAppId: 'app1', cotId: 'cot_prev', messageId: 'om_prev' }));
    await sweepOrphanCotMessages('app1');
    // Order is forced by the API, not cosmetic preference: appending after a
    // complete is rejected with "COT already in terminal state", so a note
    // pushed afterwards would silently never render.
    const kinds = request.mock.calls.map(([req]) => req.method === 'PUT' ? 'note' : 'complete');
    expect(kinds).toEqual(['note', 'complete']);
    const note = pushedEvents();
    expect(note.some(e => e.type === 'REASONING_MESSAGE_CONTENT' && /重启/.test(e.content.delta))).toBe(true);
    expect(note.at(-1)!.type).toBe('RUN_FINISHED');
    expect(note.at(-1)!.content.status).toBe('interrupted');
  });

  it('sweep still completes the bubble when the interrupted note fails', async () => {
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'cot_prev.json'), JSON.stringify({ larkAppId: 'app1', cotId: 'cot_prev', messageId: 'om_prev' }));
    request.mockImplementation(async (req: any) => {
      if (req.method === 'PUT') throw new Error('append boom');
      return { code: 0, data: {} };
    });
    await sweepOrphanCotMessages('app1');
    // A failed note must never strand the bubble: an unannotated closed bubble
    // beats one spinning on「执行中」forever.
    expect(request.mock.calls.some(([req]) => String(req.url).includes('/message_cot/complete/cot_prev'))).toBe(true);
    expect(readdirSync(orphanDir)).toEqual([]);
  });
});

describe('settleCotMessageForShutdown (graceful daemon restart)', () => {
  it('annotates the live bubble as interrupted and clears its marker', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(true);
    await settleCotMessageForShutdown(ds);
    const evs = pushedEvents();
    expect(evs.some(e => e.type === 'REASONING_MESSAGE_CONTENT' && /重启/.test(e.content.delta))).toBe(true);
    expect(evs.at(-1)!.type).toBe('RUN_FINISHED');
    expect(evs.at(-1)!.content.status).toBe('interrupted');
    // Marker cleared → the next generation's sweep must not annotate it twice.
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(false);
  });

  it('is idempotent and never double-settles against abort/finalize', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    await settleCotMessageForShutdown(ds);
    const calls = request.mock.calls.length;
    await settleCotMessageForShutdown(ds);
    abortCotMessage(ds);
    finalizeCotMessage(ds, 'om_turn1', 'completed');
    await flush();
    expect(request.mock.calls.length).toBe(calls);
  });

  it('no-ops when the session never created a bubble', async () => {
    const ds = makeDs();
    await settleCotMessageForShutdown(ds);
    expect(request).not.toHaveBeenCalled();
  });

  it('leaves an already-finishing turn to its own pump (no second RUN_FINISHED)', async () => {
    // The pump may be parked on an await with its `!state.settled` check
    // already passed. Claiming the turn here would put a SECOND terminal batch
    // on the wire — the bubble would show two "finished" events.
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    finalizeCotMessage(ds, 'om_turn1', 'completed'); // sets finishStatus; pump in flight
    await settleCotMessageForShutdown(ds);           // shutdown fires into that window
    await flush();
    const terminal = request.mock.calls.filter(([req]) =>
      req.method === 'PUT' && req.data.events.some((e: any) => e.event_type === 'RUN_FINISHED'));
    expect(terminal.length).toBe(1);
    // The pump still owns cleanup, so nothing is left spinning.
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(false);
  });

  it('terminates a disabled bubble instead of appending to it', async () => {
    const ds = makeDs();
    request.mockImplementationOnce(async () => ({ code: 0, data: { cot_id: 'cot1', message_id: 'om_cot_msg1' } }))
      .mockImplementationOnce(async () => { throw new Error('prologue boom'); });
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    request.mockClear().mockImplementation(async () => ({ code: 0, data: {} }));
    await settleCotMessageForShutdown(ds);
    // Pushes are already failing for this turn — go straight to complete.
    expect(request.mock.calls.every(([req]) => req.method === 'POST')).toBe(true);
    expect(request.mock.calls.some(([req]) => String(req.url).includes('/message_cot/complete/'))).toBe(true);
  });
});

describe('abortCotMessage (worker died without turn_terminal)', () => {
  it('settles a live bubble as interrupted and clears its marker', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(true);
    abortCotMessage(ds);
    await flush();
    const last = pushedEvents().at(-1)!;
    expect(last.type).toBe('RUN_FINISHED');
    expect(last.content.status).toBe('interrupted');
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(false);
    // Idempotent: a repeat abort (or a late finalize) pushes nothing new.
    const calls = request.mock.calls.length;
    abortCotMessage(ds);
    finalizeCotMessage(ds, 'om_turn1', 'completed');
    await flush();
    expect(request.mock.calls.length).toBe(calls);
  });

  it('closes a disabled-but-created bubble via explicit complete', async () => {
    const ds = makeDs();
    handleCotThinkingUpdate(ds, upd([think('step 1')]));
    await flush();
    request.mockRejectedValueOnce(new Error('network blip'));
    handleCotThinkingUpdate(ds, upd([think('step 1'), think('step 2')]));
    await flush(); // push fails → disabled, bubble still open
    abortCotMessage(ds);
    await flush();
    const complete = request.mock.calls.find(([req]) => String(req.url).includes('/message_cot/complete/'));
    expect(complete).toBeTruthy();
    expect(existsSync(join(orphanDir, 'cot1.json'))).toBe(false);
  });

  it('is a no-op when the session has no live CoT state', () => {
    abortCotMessage(makeDs());
    expect(request).not.toHaveBeenCalled();
  });
});
