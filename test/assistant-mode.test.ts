/**
 * 个人助理模式：纯函数 + 归属表。
 * Run: bun run test -- test/assistant-mode.test.ts ; bun test test/assistant-mode.test.ts
 */
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  removeTopLevelSymlinks,
  ASSISTANT_NO_REFRESH_TOKEN,
  assistantAttachmentsBucket,
  assistantUserHome,
  assistantWorkDir,
  isValidAssistantOpenId,
  resolveAssistantOwnerOpenId,
  stripRefreshToken,
  syncAssistantTemplate,
} from '../src/core/assistant-mode.js';
import {
  getAssistantOwner,
  listAssistantOwnerChats,
  markAssistantOwnerLeft,
  setAssistantOwner,
} from '../src/services/assistant-owner-store.js';

const OU_A = 'ou_' + 'a'.repeat(32);
const OU_B = 'ou_' + 'b'.repeat(32);

let tmp = '';
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'assistant-mode-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('open_id shape', () => {
  it('accepts ou_ + 32 hex, rejects everything that could escape a path', () => {
    expect(isValidAssistantOpenId(OU_A)).toBe(true);
    for (const bad of ['', 'ou_', 'ou_' + 'a'.repeat(31), 'ou_' + 'A'.repeat(32), '../x', 'ou_' + 'a'.repeat(32) + '/..', undefined, 42]) {
      expect(isValidAssistantOpenId(bad)).toBe(false);
    }
    expect(() => assistantUserHome('/h/bots/app', '../escape')).toThrow(/invalid owner/);
    expect(() => assistantAttachmentsBucket('/d', 'app', 'ou_x')).toThrow();
  });
  it('derives per-owner paths under BOT_HOME', () => {
    const home = assistantUserHome('/h/.botmux/bots/app', OU_A);
    expect(home).toBe(`/h/.botmux/bots/app/users/${OU_A}`);
    expect(assistantWorkDir(home)).toBe(`${home}/work`);
    expect(assistantAttachmentsBucket('/h/.botmux/data', 'app', OU_A)).toBe(`/h/.botmux/data/attachments/app/u/${OU_A}`);
  });
});

describe('stripRefreshToken', () => {
  it('replaces refreshToken, keeps everything else, passes non-oauth content through', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt-real', expiresAt: 1, scopes: ['x'] }, other: 1 });
    const out = JSON.parse(stripRefreshToken(raw));
    expect(out.claudeAiOauth.refreshToken).toBe(ASSISTANT_NO_REFRESH_TOKEN);
    expect(out.claudeAiOauth.accessToken).toBe('at');
    expect(out.claudeAiOauth.scopes).toEqual(['x']);
    expect(out.other).toBe(1);
    expect(stripRefreshToken('not json')).toBe('not json');
    expect(stripRefreshToken('{"foo":1}')).toBe('{"foo":1}');
  });
});

describe('syncAssistantTemplate', () => {
  it('overwrites template files, keeps user files, skips symlinks, errors on missing template', () => {
    const tpl = join(tmp, 'tpl'), work = join(tmp, 'work');
    mkdirSync(join(tpl, 'knowledge'), { recursive: true });
    writeFileSync(join(tpl, 'CLAUDE.md'), 'v1');
    writeFileSync(join(tpl, 'knowledge', 'a.md'), 'A');
    symlinkSync('/etc', join(tpl, 'evil'));
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'CLAUDE.md'), 'user-edited');
    writeFileSync(join(work, 'mine.txt'), 'keep');
    const r = syncAssistantTemplate(tpl, work);
    expect(r).toEqual({ copied: 2, skippedSymlinks: 1 });
    expect(readFileSync(join(work, 'CLAUDE.md'), 'utf-8')).toBe('v1');
    expect(readFileSync(join(work, 'knowledge', 'a.md'), 'utf-8')).toBe('A');
    expect(readFileSync(join(work, 'mine.txt'), 'utf-8')).toBe('keep');
    expect(() => statSync(join(work, 'evil'))).toThrow();
    expect(() => syncAssistantTemplate(join(tmp, 'nope'), work)).toThrow();
  });
});

describe('resolveAssistantOwnerOpenId', () => {
  it('p2p → sender; session group → its owner; group → stored record; left/invalid → null', () => {
    expect(resolveAssistantOwnerOpenId({ chatType: 'p2p', senderOpenId: OU_A })).toBe(OU_A);
    expect(resolveAssistantOwnerOpenId({ chatType: 'p2p', senderOpenId: 'bad' })).toBeNull();
    // 归属表优先于 session-group 固定 owner（表里的记录是认领/改绑/退群的结果）。
    expect(resolveAssistantOwnerOpenId({ chatType: 'group', sessionGroupOwnerOpenId: OU_B, stored: { openId: OU_A, since: '', how: 'bot-added' } })).toBe(OU_A);
    expect(resolveAssistantOwnerOpenId({ chatType: 'group', stored: { openId: OU_A, since: '', how: 'bot-added' } })).toBe(OU_A);
    expect(resolveAssistantOwnerOpenId({ chatType: 'group', stored: { openId: OU_A, since: '', how: 'bot-added', left: 'x' } })).toBeNull();
    expect(resolveAssistantOwnerOpenId({ chatType: 'group' })).toBeNull();
    // a group never falls back to the current sender
    expect(resolveAssistantOwnerOpenId({ chatType: 'group', senderOpenId: OU_A })).toBeNull();
  });
});

describe('assistant-owner-store', () => {
  it('set / get / left / list round-trip with 0600 file', () => {
    expect(getAssistantOwner(tmp, 'app', 'oc_1')).toBeUndefined();
    setAssistantOwner(tmp, 'app', 'oc_1', OU_A, 'bot-added', new Date(0));
    setAssistantOwner(tmp, 'app', 'oc_2', OU_A, 'claimed', new Date(0));
    setAssistantOwner(tmp, 'app', 'oc_3', OU_B, 'admin', new Date(0));
    expect(getAssistantOwner(tmp, 'app', 'oc_1')).toEqual({ openId: OU_A, since: new Date(0).toISOString(), how: 'bot-added' });
    expect(listAssistantOwnerChats(tmp, 'app', OU_A).sort()).toEqual(['oc_1', 'oc_2']);
    expect(markAssistantOwnerLeft(tmp, 'app', 'oc_1')).toBe(true);
    expect(markAssistantOwnerLeft(tmp, 'app', 'oc_1')).toBe(false);
    expect(getAssistantOwner(tmp, 'app', 'oc_1')?.left).toBeTruthy();
    expect(listAssistantOwnerChats(tmp, 'app', OU_A)).toEqual(['oc_2']);
    // another app's table is separate
    expect(getAssistantOwner(tmp, 'other', 'oc_1')).toBeUndefined();
    const mode = statSync(join(tmp, 'assistant-owners', 'app.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  it('rejects unsafe ids', () => {
    expect(() => setAssistantOwner(tmp, 'app', 'bad', OU_A, 'admin')).toThrow();
    expect(() => setAssistantOwner(tmp, 'app', 'oc_1', 'ou_bad', 'admin')).toThrow();
    expect(() => setAssistantOwner(tmp, '../x', 'oc_1', OU_A, 'admin')).toThrow();
    expect(getAssistantOwner(tmp, 'app', '../../etc')).toBeUndefined();
  });
  it('survives a corrupt file', () => {
    mkdirSync(join(tmp, 'assistant-owners'), { recursive: true });
    writeFileSync(join(tmp, 'assistant-owners', 'app.json'), '{garbage');
    expect(getAssistantOwner(tmp, 'app', 'oc_1')).toBeUndefined();
    setAssistantOwner(tmp, 'app', 'oc_1', OU_A, 'admin');
    expect(getAssistantOwner(tmp, 'app', 'oc_1')?.openId).toBe(OU_A);
  });
});

describe('syncAssistantTemplate — destination symlinks are never followed', () => {
  it('replaces a planted file symlink instead of writing through it', () => {
    const tpl = join(tmp, 'tpl'); const work = join(tmp, 'work'); const victim = join(tmp, 'victim.md');
    mkdirSync(tpl); mkdirSync(work);
    writeFileSync(join(tpl, 'CLAUDE.md'), 'template');
    writeFileSync(victim, 'A-private');
    symlinkSync(victim, join(work, 'CLAUDE.md'));
    syncAssistantTemplate(tpl, work);
    expect(readFileSync(victim, 'utf-8')).toBe('A-private');
    expect(lstatSync(join(work, 'CLAUDE.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(work, 'CLAUDE.md'), 'utf-8')).toBe('template');
  });
  it('replaces a planted directory symlink instead of writing into the target dir', () => {
    const tpl = join(tmp, 'tpl'); const work = join(tmp, 'work'); const victimDir = join(tmp, 'victim');
    mkdirSync(join(tpl, 'knowledge'), { recursive: true }); mkdirSync(work); mkdirSync(victimDir);
    writeFileSync(join(tpl, 'knowledge', 'k.md'), 'k');
    symlinkSync(victimDir, join(work, 'knowledge'));
    syncAssistantTemplate(tpl, work);
    expect(existsSync(join(victimDir, 'k.md'))).toBe(false);
    expect(lstatSync(join(work, 'knowledge')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(work, 'knowledge', 'k.md'), 'utf-8')).toBe('k');
  });
});

describe('resolveAssistantOwnerOpenId — store wins over session-group owner', () => {
  const A = 'ou_' + 'a'.repeat(32), B = 'ou_' + 'b'.repeat(32);
  it('a left record makes a /group session group unclaimed even though its creator is fixed', () => {
    expect(resolveAssistantOwnerOpenId({ chatType: 'group', sessionGroupOwnerOpenId: A, stored: { openId: A, since: 's', how: 'session-group', left: 'l' } })).toBeNull();
  });
  it('a claim after the creator left hands the group to the claimant', () => {
    expect(resolveAssistantOwnerOpenId({ chatType: 'group', sessionGroupOwnerOpenId: A, stored: { openId: B, since: 's', how: 'claimed' } })).toBe(B);
  });
  it('without a record the session-group creator still owns it', () => {
    expect(resolveAssistantOwnerOpenId({ chatType: 'group', sessionGroupOwnerOpenId: A })).toBe(A);
  });
});

describe('removeTopLevelSymlinks — owner-planted links in USER_HOME/claude', () => {
  it('unlinks top-level symlinks, keeps real files and dirs, reports what it removed', () => {
    const d = join(tmp, 'claude'); mkdirSync(d);
    writeFileSync(join(d, 'settings.json'), '{}');
    mkdirSync(join(d, 'projects'));
    writeFileSync(join(tmp, 'shared-cred.json'), 'SHARED');
    symlinkSync(join(tmp, 'shared-cred.json'), join(d, '.credentials.json'));
    symlinkSync(tmp, join(d, 'statsig'));
    expect(removeTopLevelSymlinks(d).sort()).toEqual(['.credentials.json', 'statsig']);
    expect(readdirSync(d).sort()).toEqual(['projects', 'settings.json']);
    expect(readFileSync(join(tmp, 'shared-cred.json'), 'utf-8')).toBe('SHARED');
  });
  it('missing dir → nothing; the dir itself being a symlink → throws (caller refuses spawn)', () => {
    expect(removeTopLevelSymlinks(join(tmp, 'nope'))).toEqual([]);
    mkdirSync(join(tmp, 'real')); symlinkSync(join(tmp, 'real'), join(tmp, 'claude'));
    expect(() => removeTopLevelSymlinks(join(tmp, 'claude'))).toThrow(/symlink/);
  });
});
