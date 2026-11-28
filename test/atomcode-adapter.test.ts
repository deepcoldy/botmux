import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAtomcodeAdapter } from '../src/adapters/cli/atomcode.js';
import { createCliAdapterSync, rawCliExecutable } from '../src/adapters/cli/registry.js';
import { CLI_DISPLAY_NAMES } from '../src/adapters/cli/display-names.js';
import { CLI_ID_CHOICES, resolveCliId } from '../src/setup/bot-config-editor.js';
import { resolveCliSelection } from '../src/setup/cli-selection.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-atomcode-adapter-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AtomCode CLI adapter', () => {
  it('registers stable id, display name, executable, and setup choice #37', () => {
    expect(CLI_DISPLAY_NAMES.atomcode).toBe('AtomCode');
    expect(rawCliExecutable('atomcode')).toBe('atomcode');
    expect(CLI_ID_CHOICES['37']).toBe('atomcode');
    expect(resolveCliId('37')).toBe('atomcode');
    expect(resolveCliId('atomcode')).toBe('atomcode');
    expect(resolveCliSelection('atomcode').cliId).toBe('atomcode');
    const adapter = createCliAdapterSync('atomcode', '/bin/true');
    expect(adapter.id).toBe('atomcode');
    expect(adapter.runnerFramedInput).toBe(true);
    expect(adapter.reliableTurnTerminal).toBe(true);
  });

  it('builds runner args with ATOMCODE_HOME data dir, model, effort, permission, and turn budget', () => {
    const dir = makeTempDir();
    const dataDir = join(dir, 'atomcode-home');
    const adapter = createAtomcodeAdapter('/bin/true');
    const args = adapter.buildArgs({
      sessionId: 'sess-1',
      resume: true,
      resumeSessionId: 'acp-uuid-1',
      workingDir: dir,
      model: 'codingplan/glm-5',
      reasoningEffort: 'high',
      disableCliBypass: true,
      turnTimeoutMs: 120_000,
      env: { ATOMCODE_HOME: dataDir },
    });

    expect(args[args.indexOf('--atomcode-bin') + 1]).toBe(realpathSync('/bin/true'));
    expect(args[args.indexOf('--data-dir') + 1]).toBe(realpathSync(dataDir));
    expect(args[args.indexOf('--cwd') + 1]).toBe(dir);
    expect(args[args.indexOf('--native-session-id') + 1]).toBe('acp-uuid-1');
    expect(args[args.indexOf('--model') + 1]).toBe('codingplan/glm-5');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(args[args.indexOf('--permission') + 1]).toBe('smart');
    expect(args[args.indexOf('--turn-timeout-ms') + 1]).toBe('120000');
    expect(adapter.authPaths).toEqual([realpathSync(dataDir)]);
    expect(adapter.skillsDir).toBe(join(realpathSync(dataDir), 'skills'));
    expect(adapter.sandboxExtraExecPaths?.()).toHaveLength(1);
  });

  it('canonicalizes symlinked ATOMCODE_HOME for bwrap sandbox compatibility', () => {
    const dir = makeTempDir();
    const realHome = join(dir, 'real-home');
    const linkHome = join(dir, 'link-home');
    mkdirSync(realHome, { recursive: true });
    symlinkSync(realHome, linkHome);
    const adapter = createAtomcodeAdapter('/bin/true');
    const args = adapter.buildArgs({
      sessionId: 'sess-symlink',
      resume: false,
      workingDir: dir,
      env: { ATOMCODE_HOME: join(linkHome, '.atomcode') },
    });
    const canonical = realpathSync(join(realHome, '.atomcode'));
    expect(args[args.indexOf('--data-dir') + 1]).toBe(canonical);
    expect(adapter.authPaths).toEqual([canonical]);
  });

  it('rejects session fork on resume', () => {
    const adapter = createAtomcodeAdapter('/bin/true');
    expect(() => adapter.buildArgs({
      sessionId: 'sess-1',
      resume: true,
      resumeSessionId: 'acp-uuid-1',
      forkSession: true,
    })).toThrow(/does not support session forks/);
  });

  it('formats resume command by stripping the ACP wire prefix', () => {
    const adapter = createAtomcodeAdapter('/bin/true');
    expect(adapter.buildResumeCommand?.({ sessionId: 's1', cliSessionId: undefined })).toBeNull();
    expect(adapter.buildResumeCommand?.({ sessionId: 's1', cliSessionId: 'acp-abc-123' }))
      .toBe("atomcode resume 'abc-123'");
    expect(adapter.buildResumeCommand?.({ sessionId: 's1', cliSessionId: 'raw-456' }))
      .toBe("atomcode resume 'raw-456'");
  });

  it('exports only the resolved custom data home for local resume', () => {
    const adapter = createAtomcodeAdapter('/bin/true');
    expect(adapter.buildResumeCommandEnv?.({
      env: { HOME: '/tmp/home', ATOMCODE_HOME: '~/custom', SECRET_TOKEN: 'do-not-export' },
    })).toEqual({ ATOMCODE_HOME: '/tmp/home/custom' });

    vi.stubEnv('ATOMCODE_HOME', undefined);
    expect(adapter.buildResumeCommandEnv?.({ env: { SECRET_TOKEN: 'do-not-export' } })).toBeUndefined();
  });

  it('encodes ::botmux-atomcode: framed messages and detects models from config.toml', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'config.toml'), `
[models.fast]
account = "a"
model = "m-fast"

[providers.smart]
type = "openai"
model = "m-smart"
`);
    const adapter = createAtomcodeAdapter('/bin/true');
    expect(await adapter.detectModels?.({ env: { ATOMCODE_HOME: dir } })).toEqual(['fast', 'smart']);

    const writes: string[] = [];
    const pty = { write: vi.fn((chunk: string) => { writes.push(chunk); return true; }) };
    const result = await adapter.writeInput(pty as never, 'hello world', { turnId: 't-1', dispatchAttempt: 2 });
    expect(result).toMatchObject({ submitted: true });
    const rawLine = writes.join('').trim();
    expect(rawLine.startsWith('::botmux-atomcode:')).toBe(true);
    const decoded = JSON.parse(Buffer.from(rawLine.slice('::botmux-atomcode:'.length), 'base64').toString('utf8'));
    expect(decoded).toEqual({
      type: 'message',
      content: 'hello world',
      replyTurnId: 't-1',
      replyDispatchAttempt: 2,
    });
  });
});
