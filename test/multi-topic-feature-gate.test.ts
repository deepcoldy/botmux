import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { builtinSkillContent, builtinSkillEntries } from '../src/skills/injection-mode.js';
import { ensureSkills } from '../src/skills/installer.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

afterEach(() => vi.unstubAllEnvs());

describe('multi-topic orchestration feature gate', () => {
  it('removes botmux-orchestrate from prompt discovery and on-demand reads', () => {
    const enabled = builtinSkillEntries({ asksViaHook: false, multiTopicEnabled: true });
    const disabled = builtinSkillEntries({ asksViaHook: false, multiTopicEnabled: false });
    expect(enabled.map(entry => entry.name)).toContain('botmux-orchestrate');
    expect(disabled.map(entry => entry.name)).not.toContain('botmux-orchestrate');

    vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', 'false');
    expect(builtinSkillContent('botmux-orchestrate')).toBeUndefined();
    expect(builtinSkillContent('botmux-handoff')).toContain('name: botmux-handoff');
  });

  it('removes a previously installed native skill when disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-multi-topic-skill-'));
    try {
      vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', 'true');
      ensureSkills('claude-code', dir);
      expect(existsSync(join(dir, 'botmux-orchestrate', 'SKILL.md'))).toBe(true);

      vi.stubEnv('BOTMUX_MULTI_TOPIC_ENABLED', 'false');
      ensureSkills('claude-code', dir);
      expect(existsSync(join(dir, 'botmux-orchestrate'))).toBe(false);
      expect(existsSync(join(dir, 'botmux-handoff', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses new topic dispatches but does not block --into', () => {
    const env = { ...process.env, BOTMUX_MULTI_TOPIC_ENABLED: 'false' };
    const { command, prefixArgs } = tsRunnerPrefix();
    const cli = join(__dirname, '..', 'src', 'cli.ts');
    const blocked = spawnSync(command, [...prefixArgs, cli,
      'dispatch', '--title', 'new topic', '--bot', 'ou_test',
    ], { env, encoding: 'utf-8' });
    const blockedOutput = `${blocked.stdout ?? ''}${blocked.stderr ?? ''}`;
    expect(blocked.status).toBe(2);
    expect(blockedOutput).toContain('multi_topic_disabled');

    const append = spawnSync(command, [...prefixArgs, cli,
      'dispatch', '--into', 'om_root', '--bot', 'ou_test', '--brief', 'continue',
    ], { env, encoding: 'utf-8' });
    const appendOutput = `${append.stdout ?? ''}${append.stderr ?? ''}`;
    expect(appendOutput).not.toContain('multi_topic_disabled');
  });
});

// The daemon route that actually creates a new sub-project topic lives in the
// narrow untrusted-auth aperture: a sandboxed / read-isolated CLI holding its
// own session's rotating capability can POST directly, so the CLI-side gate
// above cannot be the only enforcement point. daemon.ts route handlers are
// closures over daemon state and cannot be booted in a unit test (the sibling
// report-relay routes use the same source-wiring assertion shape); the
// predicate itself is behavior-tested in global-config.test.ts. This pins the
// call site AND its ordering: authenticate the session first, then refuse with
// 409 before the daemon performs the authoritative seed send.
describe('daemon-side dispatch register gate wiring', () => {
  const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

  function registerHandlerPrefix(): string {
    const start = daemonSource.indexOf("ipcRoute('POST', DISPATCH_REPORT_REGISTER_ROUTE");
    expect(start).toBeGreaterThan(-1);
    // Slice ends exactly where the daemon performs the authoritative seed send
    // that creates the topic — anything asserted inside this slice provably
    // runs BEFORE a new topic can be created.
    const sendMarker = 'dispatchRoot = await sendMessage(';
    const end = daemonSource.indexOf(sendMarker, start);
    expect(end).toBeGreaterThan(start);
    return daemonSource.slice(start, end);
  }

  it('imports the multi-topic gate predicate', () => {
    expect(daemonSource).toContain('isMultiTopicOrchestrationEnabled');
  });

  it('refuses with 409 after session identity is verified and before the seed send', () => {
    const handler = registerHandlerPrefix();
    const identityCheck = handler.indexOf("error: 'session_identity_incomplete'");
    const gate = handler.indexOf('if (!isMultiTopicOrchestrationEnabled())');
    const refused = handler.indexOf("error: 'multi_topic_disabled'");
    const rejected409 = handler.indexOf('jsonRes(res, 409,');
    expect(identityCheck).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(identityCheck);
    expect(rejected409).toBeGreaterThan(gate);
    expect(refused).toBeGreaterThan(rejected409);
  });

  it('gates only new-topic creation: the --into path stays outside this route', () => {
    // The registration route hard-codes the new-topic branch; appending to an
    // existing topic takes the synchronous project-dispatch path in the CLI.
    const handler = registerHandlerPrefix();
    expect(handler).toContain('existingDispatch: false');
  });
});
