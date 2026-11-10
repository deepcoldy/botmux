import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeFeedbackHook } from '../src/services/feedback-hook-config.js';
import { bindFeedbackAnswerWorktree, resolveFeedbackAnswerCommand } from '../src/services/feedback-answer-worktree.js';
import { runFeedbackHook } from '../src/services/feedback-hook-runner.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'feedback-worktree-')));
  directories.push(directory);
  const repository = join(directory, 'repository');
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git('init', '-q');
  mkdirSync(join(repository, 'assets'));
  writeFileSync(join(repository, 'assets/callback.py'), 'first');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
  const worktree = join(directory, 'answer');
  git('worktree', 'add', '-qb', 'answer', worktree);
  const hook = normalizeFeedbackHook({
    id: 'hook', version: 1, protocolVersion: 1, hostId: 'host',
    command: ['/usr/bin/python3', '/old/callback.py'], cwd: repository,
    allowedBotAppIds: ['app'], allowedChatIds: ['chat'], allowedActionIds: ['help'],
    timeoutMs: 1000, concurrency: 1, envRefs: {}, enabled: true,
    answerWorktree: { script: 'assets/callback.py', repositoryRoots: [repository] },
  });
  return { directory, repository, worktree, hook, git };
}

describe('feedback answer worktree execution binding', () => {
  it('uses native answer cwd instead of the session startup directory', () => {
    const data = fixture();
    const binding = bindFeedbackAnswerWorktree({
      sessionId: 'session', turnId: 'turn', cliId: 'traex', nativeSessionId: 'native',
      workingDir: data.repository, nativeWorkingDir: data.worktree,
    }, data.hook.answerWorktree!);
    const resolved = resolveFeedbackAnswerCommand(data.hook, binding, 'session', 'turn');
    expect(resolved.cwd).toBe(data.worktree);
    expect(resolved.command).toEqual(['/usr/bin/python3', join(data.worktree, 'assets/callback.py')]);
    expect(resolved.execution.scriptHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('reads updated script bytes on the next execution while preserving the answer directory', () => {
    const data = fixture();
    const binding = bindFeedbackAnswerWorktree({
      sessionId: 'session', turnId: 'turn', cliId: 'codex', workingDir: data.worktree,
    }, data.hook.answerWorktree!);
    const first = resolveFeedbackAnswerCommand(data.hook, binding, 'session', 'turn');
    writeFileSync(join(data.worktree, 'assets/callback.py'), 'second');
    const second = resolveFeedbackAnswerCommand(data.hook, binding, 'session', 'turn');
    expect(second.execution.scriptHash).not.toBe(first.execution.scriptHash);
    expect(second.cwd).toBe(data.worktree);
  });
  it('launches the actual callback from each answer worktree with its updated version', async () => {
    const data = fixture();
    const second = join(data.directory, 'second-answer');
    data.git('worktree', 'add', '-qb', 'second-answer', second);
    const script = (value: string) => `import json,sys\nrequest=json.load(sys.stdin)\nprint(json.dumps({"schemaVersion":1,"executionId":request["executionId"],"outcome":"succeeded","publicMessage":"${value}","receiptRefs":["message:test"]}))\n`;
    writeFileSync(join(data.worktree, 'assets/callback.py'), script('first'));
    writeFileSync(join(second, 'assets/callback.py'), script('second'));
    const event = { schemaVersion: 1 as const, executionId: 'execution', eventId: 'event', idempotencyKey: 'key',
      type: 'action.requested' as const, bot: { appId: 'app' }, scope: { chatId: 'chat' }, action: { id: 'help' } };
    const run = async (directory: string) => {
      const binding = bindFeedbackAnswerWorktree({
        sessionId: 'session', turnId: 'turn', cliId: 'codex', workingDir: directory,
      }, data.hook.answerWorktree!);
      const resolved = resolveFeedbackAnswerCommand(data.hook, binding, 'session', 'turn');
      const { answerWorktree, ...registration } = data.hook;
      return runFeedbackHook({ hook: { ...registration, command: resolved.command, cwd: resolved.cwd },
        event, hostId: 'host', env: {} });
    };
    expect((await run(data.worktree)).publicMessage).toBe('first');
    expect((await run(second)).publicMessage).toBe('second');
    writeFileSync(join(second, 'assets/callback.py'), script('updated'));
    expect((await run(second)).publicMessage).toBe('updated');
  });
  it('refuses missing native cwd rather than falling back to the startup checkout', () => {
    const data = fixture();
    expect(() => bindFeedbackAnswerWorktree({
      sessionId: 'session', turnId: 'turn', cliId: 'traex', workingDir: data.repository,
    }, data.hook.answerWorktree!)).toThrow(/native/);
  });
  it('rejects another answer identity and a removed worktree', () => {
    const data = fixture();
    const binding = bindFeedbackAnswerWorktree({
      sessionId: 'session', turnId: 'turn', cliId: 'codex', workingDir: data.worktree,
    }, data.hook.answerWorktree!);
    expect(() => resolveFeedbackAnswerCommand(data.hook, binding, 'other', 'turn')).toThrow(/identity/);
    data.git('worktree', 'remove', data.worktree);
    expect(() => resolveFeedbackAnswerCommand(data.hook, binding, 'session', 'turn')).toThrow();
  });
  it('refuses scripts resolving outside the authorized worktree', () => {
    const data = fixture();
    const binding = bindFeedbackAnswerWorktree({
      sessionId: 'session', turnId: 'turn', cliId: 'codex', workingDir: data.worktree,
    }, data.hook.answerWorktree!);
    rmSync(join(data.worktree, 'assets/callback.py'));
    symlinkSync(join(data.repository, 'assets/callback.py'), join(data.worktree, 'assets/callback.py'));
    expect(() => resolveFeedbackAnswerCommand(data.hook, binding, 'session', 'turn')).toThrow(/script/);
  });
  it('rejects replacement Git metadata at the same authorized paths', () => {
    const data = fixture();
    const binding = bindFeedbackAnswerWorktree({
      sessionId: 'session', turnId: 'turn', workingDir: data.worktree,
    }, data.hook.answerWorktree!);
    const displaced = join(data.directory, 'old-metadata');
    renameSync(join(data.repository, '.git'), displaced);
    data.git('init', '-q');
    data.git('add', '.');
    data.git('-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'foreign');
    const replacement = join(data.directory, 'replacement', 'answer');
    data.git('worktree', 'add', '-qb', 'replacement', replacement);
    writeFileSync(join(data.worktree, '.git'), readFileSync(join(replacement, '.git')));
    rmSync(replacement, { recursive: true, force: true });
    data.git('worktree', 'repair', data.worktree);
    expect(() => resolveFeedbackAnswerCommand(data.hook, binding, 'session', 'turn')).toThrow(/identity/);
  });
  it('matches a valid repository even when a different allowed directory is unavailable', () => {
    const data = fixture();
    const registration = { ...data.hook, answerWorktree: {
      ...data.hook.answerWorktree!, repositoryRoots: [join(data.directory, 'removed'), data.repository],
    } };
    const binding = bindFeedbackAnswerWorktree({
      sessionId: 'session', turnId: 'turn', workingDir: data.worktree,
    });
    expect(resolveFeedbackAnswerCommand(registration, binding, 'session', 'turn').cwd).toBe(data.worktree);
  });
  it.each(['../callback.py', '/callback.py', 'assets/../callback.py', 'assets//callback.py'])(
    'rejects an unsafe configured script path %s', script => {
      const data = fixture();
      expect(() => normalizeFeedbackHook({ ...data.hook, answerWorktree: {
        script, repositoryRoots: [data.repository],
      } })).toThrow(/answerWorktree/);
    },
  );
});
