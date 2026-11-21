/**
 * What a stuck card may repeat from the terminal: only the tail of a page
 * classifyStuckPage recognises, with the page's free-form value rows
 * (Command / Source / Matcher, and their wrapped continuations) masked and
 * credential-shaped values masked anywhere else. Exercised on real hook
 * detail captures (test/fixtures/stuck-pages) both through the pure
 * redactStuckPageTail and through the worker's real shareableStuckScreenTail.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { classifyStuckPage } from '../src/utils/stuck-detector.js';
import { redactStuckPageTail, stuckScreenTail } from '../src/core/stuck-page-catalog.js';
import { screenMayShowCredential } from '../src/core/cli-startup-blocker.js';
import { diagnoseSubmitFailure } from '../src/services/submit-failure-diagnosis.js';

const page = (name: string) => readFileSync(join(process.cwd(), 'test/fixtures/stuck-pages', name), 'utf-8');

/** Detail pages with a Command (and Source) row, and the chrome that must survive. */
const DETAIL_PAGES = [
  {
    name: 'codex-0.164.0-sessionstart-detail-l2.txt',
    command: 'echo kiro-sessionstart',
    chrome: ['SessionStart hooks', '1 hook needs review before it can run.', 'Trust     New hook - review required', 't trust · esc back'],
  },
  {
    name: 'codex-0.164.0-two-hooks-pretooluse-detail-l2.txt',
    command: 'echo kiro-ptu',
    chrome: ['PreToolUse hooks', '1 hook needs review before it can run.', 'Trust     New hook - review required', 't trust · esc back'],
  },
  {
    name: 'traex-0.213.1-sessionstart-detail-l2.txt',
    command: 'echo hi',
    chrome: ['SessionStart hooks', '1 hook needs review before it can run.', 'Trust     New hook - review required', 't trust  |  esc go back'],
  },
  {
    name: 'traex-0.213.1-pretooluse-detail-l2.txt',
    command: 'node "__PLUGIN_DIR__/ai_contribution_sdk_hook.js"',
    chrome: ['PreToolUse hooks', '1 hook needs review before it can run.', 'Trust     New hook - review required', 't trust  |  esc go back'],
  },
] as const;

/** A hook command quoting a secret, and the substrings that must not leave. */
const SECRETS = [
  { label: 'Bearer JWT', text: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJraXJvIn0.c2lnbmF0dXJlLWtpcm8" https://hooks.example/n', leaks: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJraXJvIn0', 'c2lnbmF0dXJlLWtpcm8'] },
  { label: 'ghp_ token', text: 'GH_TOKEN_VALUE ghp_kiroFAKE0123456789abcdefghijklmn gh api /user', leaks: ['kiroFAKE0123456789abcdefghijklmn'] },
  { label: 'AKIA key', text: 'aws configure set aws_access_key_id AKIAKIROFAKE00000000', leaks: ['AKIAKIROFAKE00000000', 'KIROFAKE00000000'] },
  { label: 'password=', text: './deploy.sh password=hunter2-kiro --yes', leaks: ['hunter2-kiro'] },
  { label: 'postgres URL', text: 'psql postgres://alice:s3cret-kiro@db.internal:5432/app -c "select 1"', leaks: ['s3cret-kiro'] },
  { label: 'sk- key', text: 'OPENAI=sk-kiroFAKE0000000000 ./notify.sh', leaks: ['kiroFAKE0000000000'] },
] as const;

/** A literal token in no recognisable shape: only the row masking stops it. */
const UNSHAPED = { label: 'unshaped literal', text: 'curl -d kiro-unshaped-7f3a9c https://hooks.example/notify', leaks: ['kiro-unshaped-7f3a9c'] };

/** The worker's real outbound-tail functions, on a given CLI. */
function shareable(cliId: CliId): (screen: string) => string {
  const scope: Record<string, any> = {
    cliAdapter: createCliAdapterSync(cliId),
    classifyStuckPage,
    stuckScreenTail,
    redactStuckPageTail,
    screenMayShowCredential,
    diagnoseSubmitFailure,
  };
  for (const name of ['adapterRendersCodexFamilyStuckPages', 'screenShowsCredentialPage', 'shareableStuckScreenTail']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  return scope.shareableStuckScreenTail;
}

function inCommandRow(raw: string, command: string, secret: string): string {
  expect(raw).toContain(`Command   ${command}`);
  return raw.replace(`Command   ${command}`, `Command   ${secret}`);
}

function inNonRowLine(raw: string, secret: string): string {
  const line = '1 hook needs review before it can run.';
  expect(raw).toContain(line);
  return raw.replace(line, `${line} ${secret}`);
}

const expectNoLeak = (out: string, leaks: readonly string[]) => {
  for (const leak of leaks) expect(out).not.toContain(leak);
};

describe('redactStuckPageTail on real hook detail pages', () => {
  describe.each(DETAIL_PAGES)('$name', ({ name, command, chrome }) => {
    const raw = page(name);

    it.each([...SECRETS, UNSHAPED])('masks a $label in the Command row, keeping the page chrome', ({ text, leaks }) => {
      const screen = inCommandRow(raw, command, text);
      const out = redactStuckPageTail(stuckScreenTail(screen));
      expectNoLeak(out, leaks);
      expect(out).toMatch(/^\s*Command {3}‹hidden›$/m);
      for (const line of chrome) expect(out).toContain(line);
    });

    it.each(SECRETS)('masks a $label on a non-row line, keeping the page chrome', ({ text, leaks }) => {
      const out = redactStuckPageTail(stuckScreenTail(inNonRowLine(raw, text)));
      expectNoLeak(out, leaks);
      for (const line of chrome) expect(out).toContain(line);
    });

    it('masks the Source row and leaves the fixed rows as drawn', () => {
      const out = redactStuckPageTail(stuckScreenTail(raw));
      expect(out).toMatch(/^\s*Source {4}‹hidden›$/m);
      expect(out).not.toContain(command);
      for (const label of ['Event', 'Mode', 'Timeout', 'Trust']) {
        const row = stuckScreenTail(raw).split('\n').find(r => new RegExp(`^\\s*${label}\\s{2,}`).test(r));
        expect(row).toBeDefined();
        expect(out.split('\n')).toContain(row);
      }
    });
  });

  it('masks a wrapped Command value on its unlabelled continuation rows, up to the next labelled row', () => {
    const raw = page('codex-0.164.0-sessionstart-detail-l2.txt');
    const screen = raw.replace('  Command   echo kiro-sessionstart', [
      '  Command   curl -sS https://hooks.example/notify -d',
      '            kiro-wrapped-secret-91ab',
    ].join('\n'));
    const out = redactStuckPageTail(stuckScreenTail(screen));
    expect(out).not.toContain('kiro-wrapped-secret-91ab');
    expect(out).toContain('Mode      Sync');
    expect(out).toContain('Trust     New hook - review required');
  });

  it('masks user names in home paths and leaves other paths alone', () => {
    expect(redactStuckPageTail('  Source    User config - /home/alice/.codex/hooks.json'))
      .toBe('  Source    ‹hidden›');
    expect(redactStuckPageTail('  cwd /home/alice/repo · /Users/bob/x · /tmp/repo'))
      .toBe('  cwd /home/~/repo · /Users/~/x · /tmp/repo');
  });
});

describe('shareableStuckScreenTail (worker) never lets a secret out', () => {
  describe.each(DETAIL_PAGES)('$name', ({ name, command, chrome }) => {
    const raw = page(name);
    const tail = shareable('codex');

    it.each([...SECRETS, UNSHAPED])('$label in the Command row', ({ text, leaks }) => {
      const screen = inCommandRow(raw, command, text);
      expect(classifyStuckPage(screen)).toBe('hook review level 2');
      const out = tail(screen);
      expectNoLeak(out, leaks);
      // A credential-looking page sends nothing at all; any other page keeps
      // its chrome.
      if (screenMayShowCredential(screen)) expect(out).toBe('');
      else for (const line of chrome) expect(out).toContain(line);
    });

    it.each(SECRETS)('$label on a non-row line', ({ text, leaks }) => {
      const screen = inNonRowLine(raw, text);
      expect(classifyStuckPage(screen)).toBe('hook review level 2');
      const out = tail(screen);
      expectNoLeak(out, leaks);
      if (screenMayShowCredential(screen)) expect(out).toBe('');
      else for (const line of chrome) expect(out).toContain(line);
    });
  });

  it('a long wrapped Command value whose label falls above the tail window stays masked', () => {
    const raw = page('codex-0.164.0-sessionstart-detail-l2.txt');
    const continuation = Array.from({ length: 14 }, (_, i) => `            --flag-${i} kiro-wrap-leak-${i}`);
    const screen = raw.replace('  Command   echo kiro-sessionstart', ['  Command   ./hook.sh', ...continuation].join('\n'));
    expect(classifyStuckPage(screen)).toBe('hook review level 2');
    // Bounded first, the window starts below the Command label.
    expect(stuckScreenTail(screen)).not.toContain('Command');
    const out = shareable('codex')(screen);
    expect(out).not.toMatch(/kiro-wrap-leak/);
    expect(out).toContain('Trust     New hook - review required');
    expect(out).toContain('t trust · esc back');
  });

  it('sends nothing for a screen that is not a recognised page, nor for a CLI without the declaration', () => {
    const shell = '$ cat .env\nGITHUB_PAT=kiro-plain-7781\nDB=postgres://u:kiro-pw@h/db\n$ ';
    expect(shareable('codex')(shell)).toBe('');
    expect(shareable('codex')(page('codex-0.164.0-startup-menu-after-esc.txt'))).toBe('');
    expect(shareable('claude-code')(page('codex-0.164.0-sessionstart-detail-l2.txt'))).toBe('');
  });
});
