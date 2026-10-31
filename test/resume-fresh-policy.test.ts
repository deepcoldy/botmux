/**
 * Resume-without-cliSessionId → fresh-session policy.
 *
 * Adapters whose buildArgs can only resume a PRECISE cliSessionId (cursor /
 * copilot — no --continue/latest fallback, which would risk loading a
 * SIBLING session's conversation) declare `resumeRequiresCliSessionId`.
 * Kimi / Gemini find their own session from the botmux id instead
 * (`resumeFindsOwnSession`); for them the receipt follows the same
 * `checkResumeTargetExists` probe the worker runs. This file covers:
 *
 *   1. `resumeStartsFresh` — the shared predicate upper layers (closed card,
 *      resume receipt) use to distinguish "route reactivated" from "CLI
 *      history restored".
 *   2. The closed-session card built for such a session warns that resume
 *      starts fresh instead of implying the CLI history is back. (The resume
 *      receipt variant is covered in card-handler-resume-receipt.test.ts; the
 *      worker's fresh-demotion wiring lives in spawnCli and has no unit seam.)
 *
 * Run: pnpm vitest run test/resume-fresh-policy.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumeStartsFresh } from '../src/services/resume-fresh-policy.js';
import { buildClosedSessionCard } from '../src/core/closed-session-card.js';
import { getCliDisplayName } from '../src/im/lark/card-builder.js';
import { t } from '../src/i18n/index.js';
import type { Session } from '../src/types.js';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex' } })),
}));

describe('resumeStartsFresh', () => {
  it('copilot / cursor without a persisted cliSessionId start fresh', () => {
    expect(resumeStartsFresh({ cliId: 'copilot' })).toBe(true);
    expect(resumeStartsFresh({ cliId: 'cursor' })).toBe(true);
  });

  it('kimi / gemini find their own session: fresh exactly when the same probe the worker runs finds none', () => {
    const root = mkdtempSync(join(tmpdir(), 'resume-fresh-'));
    const prev = { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
    try {
      process.env.KIMI_CODE_HOME = join(root, 'kimi');
      process.env.GEMINI_CLI_HOME = root;
      const work = join(root, 'work');
      mkdirSync(work, { recursive: true });
      const sid = '4c0a8f9e-1b2d-4e3f-8a5b-6c7d8e9f0a1b';
      // Nothing on disk yet: the receipt must say "starts fresh".
      expect(resumeStartsFresh({ cliId: 'kimi', sessionId: sid, workingDir: work })).toBe(true);
      expect(resumeStartsFresh({ cliId: 'gemini', sessionId: sid, workingDir: work })).toBe(true);
      // Kimi has the session (its prompt carries the botmux id): history is back.
      const kdir = join(root, 'kimi', 'sessions', 'wd_work_0', 'session_aaaa');
      mkdirSync(join(kdir, 'agents', 'main'), { recursive: true });
      writeFileSync(join(kdir, 'agents', 'main', 'wire.jsonl'), `{"type":"metadata","protocol_version":"1.4"}\n{"content":"<session_id>${sid}</session_id>"}\n`);
      writeFileSync(join(root, 'kimi', 'session_index.jsonl'), JSON.stringify({ sessionId: 'session_aaaa', sessionDir: kdir, workDir: work }) + '\n');
      expect(resumeStartsFresh({ cliId: 'kimi', sessionId: sid, workingDir: work })).toBe(false);
      // Gemini has a resumable file for it in this project.
      mkdirSync(join(root, '.gemini', 'tmp', 'work', 'chats'), { recursive: true });
      writeFileSync(join(root, '.gemini', 'projects.json'), JSON.stringify({ projects: { [work]: 'work' } }));
      writeFileSync(join(root, '.gemini', 'tmp', 'work', 'chats', `session-x-${sid.slice(0, 8)}.jsonl`),
        `${JSON.stringify({ sessionId: sid })}\n${JSON.stringify({ id: 'm0', type: 'user', content: [{ text: 'hello' }] })}\n`);
      expect(resumeStartsFresh({ cliId: 'gemini', sessionId: sid, workingDir: work })).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('copilot / kimi / cursor WITH a cliSessionId resume precisely (not fresh)', () => {
    expect(resumeStartsFresh({ cliId: 'copilot', cliSessionId: 'sess-1' })).toBe(false);
    expect(resumeStartsFresh({ cliId: 'kimi', cliSessionId: 'session_1' })).toBe(false);
    expect(resumeStartsFresh({ cliId: 'cursor', cliSessionId: 'chat-1' })).toBe(false);
  });

  it('adapters that can always resume (botmux sessionId is the CLI id) never start fresh', () => {
    expect(resumeStartsFresh({ cliId: 'claude-code' })).toBe(false);
    expect(resumeStartsFresh({ cliId: 'grok' })).toBe(false);
    expect(resumeStartsFresh({ cliId: 'hermes' })).toBe(false);
  });

  it('adapters that ignore resume entirely (gemini) are not flagged', () => {
    expect(resumeStartsFresh({ cliId: 'gemini' })).toBe(false);
  });

  it('missing cliId / unknown cliId → false (fail safe, no false "history lost" claim)', () => {
    expect(resumeStartsFresh({})).toBe(false);
    expect(resumeStartsFresh({ cliId: 'not-a-real-cli' })).toBe(false);
  });
});

// ─── Closed-session card ────────────────────────────────────────────────────
describe('closed-session card for a precise-id-only CLI', () => {
  const session = (cliSessionId?: string) => ({
    sessionId: 'botmux-session', rootMessageId: 'om_root', chatId: 'oc_chat', chatType: 'group',
    title: 'Topic', status: 'closed', createdAt: '2026-08-03T00:00:00.000Z', workingDir: '/repo',
    cliId: 'cursor', agentFrozen: true, larkAppId: 'app_test',
    ...(cliSessionId ? { cliSessionId } : {}),
  }) as unknown as Session;
  const markdown = (cardJson: string): string =>
    (JSON.parse(cardJson) as { elements: Array<{ tag: string; content?: string }> })
      .elements.find(e => e.tag === 'markdown')?.content ?? '';
  const freshNote = t('card.body.resume_starts_fresh', { cliName: getCliDisplayName('cursor') }, 'zh');

  it('warns that resume starts fresh when no cliSessionId was persisted', () => {
    expect(markdown(buildClosedSessionCard(session(), 'zh'))).toContain(freshNote);
  });

  it('prints the precise resume command instead when a cliSessionId exists', () => {
    const md = markdown(buildClosedSessionCard(session('chat-1'), 'zh'));
    expect(md).toContain('cursor-agent --resume chat-1');
    expect(md).not.toContain(freshNote);
  });
});
