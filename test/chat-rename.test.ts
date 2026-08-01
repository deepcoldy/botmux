import { describe, expect, it } from 'vitest';
import {
  CHAT_NAME_MAX_CODE_POINTS,
  ChatRenameCooldown,
  ChatRenameSerialQueue,
  normalizeLarkChatName,
} from '../src/core/chat-rename.js';
import { BUILTIN_SKILLS } from '../src/skills/definitions.js';

describe('chat rename', () => {
  it('normalizes valid names and preserves Unicode', () => {
    expect(normalizeLarkChatName('  支付排障｜待验证  ')).toEqual({
      ok: true,
      name: '支付排障｜待验证',
    });
  });

  it('rejects empty, control, invisible and overlong names', () => {
    expect(normalizeLarkChatName('   ')).toEqual({ ok: false, error: 'invalid_chat_name' });
    expect(normalizeLarkChatName('bad\nname')).toEqual({ ok: false, error: 'invalid_chat_name' });
    expect(normalizeLarkChatName('bad\u200bname')).toEqual({ ok: false, error: 'invalid_chat_name' });
    expect(normalizeLarkChatName('名'.repeat(CHAT_NAME_MAX_CODE_POINTS + 1))).toEqual({
      ok: false,
      error: 'invalid_chat_name',
    });
  });

  it('rejects Unicode line/paragraph separators and BOM mid-name (FR-5)', () => {
    // Original class trimmed these only at the edges; FR-5 requires rejecting
    // line breaks and invisible format controls anywhere in the name.
    expect(normalizeLarkChatName('a\u2028b')).toEqual({ ok: false, error: 'invalid_chat_name' });
    expect(normalizeLarkChatName('a\u2029b')).toEqual({ ok: false, error: 'invalid_chat_name' });
    expect(normalizeLarkChatName('a\ufeffb')).toEqual({ ok: false, error: 'invalid_chat_name' });
  });

  it('applies a per-key proactive cooldown with retry metadata', () => {
    const cooldown = new ChatRenameCooldown(60_000);
    expect(cooldown.check('app:chat', 100_000)).toEqual({ ok: true });
    cooldown.record('app:chat', 100_000);
    expect(cooldown.check('app:chat', 110_000)).toEqual({
      ok: false,
      retryAfterSeconds: 50,
    });
    expect(cooldown.check('other:chat', 110_000)).toEqual({ ok: true });
    expect(cooldown.check('app:chat', 160_000)).toEqual({ ok: true });
  });

  it('serializes the complete rename transaction per bot/chat key', async () => {
    const queue = new ChatRenameSerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const first = queue.run('app:chat', async () => {
      events.push('first:start');
      markFirstStarted();
      await firstGate;
      events.push('first:end');
    });
    await firstStarted;
    const second = queue.run('app:chat', async () => {
      events.push('second:start');
      events.push('second:end');
    });
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('ships an on-demand built-in Skill with the scoped CLI contract', () => {
    const skill = BUILTIN_SKILLS.find(item => item.name === 'botmux-chat-rename');
    expect(skill?.content).toContain('botmux chat rename');
    expect(skill?.content).toContain('--proactive');
    expect(skill?.content).toContain('只能修改当前会话所在群');
  });
});
