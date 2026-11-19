import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { projectAuthorityPaths } from '../src/services/project-authority-paths.js';
import {
  buildCredentialIsolationRules, buildSeatbeltProfile,
} from '../src/adapters/cli/read-isolation.js';
import {
  accessForPath, buildFsPolicy, compileToBwrap, type FsPolicyContext,
} from '../src/adapters/cli/fs-policy.js';
import { buildCredentialOnlySandboxArgs } from '../src/adapters/backend/sandbox.js';

const HOME = '/home/project-fixture', DATA = `${HOME}/.botmux/data`;
const paths = projectAuthorityPaths(DATA);
const leaves = paths.map(path => `${path}/host-authority.json`);

function policyContext(platform: 'linux' | 'darwin', dataDir = DATA): FsPolicyContext {
  const denyPaths = projectAuthorityPaths(dataDir);
  return {
    platform, homeDir: HOME, botmuxHome: `${HOME}/.botmux`, sessionDataDir: dataDir,
    sessionId: 'project-session', currentAppId: 'cli_project_self',
    botHome: `${HOME}/.botmux/bots/cli_project_self`,
    workingDir: HOME, redirectedCliData: true,
    // Explicit deeper grants must not reopen host journals or ownership proof.
    userPaths: { readWrite: denyPaths.map(path => `${path}/host-authority.json`) },
    mandatoryDenyPaths: denyPaths, hostOnlyDenyPaths: denyPaths,
  };
}

describe('project authority directory isolation', () => {
  it.each(['/home/project-fixture/.botmux/data/', '/srv/custom-project-state', '/data'])(
    'derives all authority under the exact configured data directory %s', dataDir => {
      expect(projectAuthorityPaths(dataDir)).toEqual([
        join(dataDir, '.dashboard-secret.project-attachments'),
        join(dataDir, '.dashboard-secret.project-source-grants'),
        join(dataDir, '.dashboard-secret.project-imports'),
      ]);
    },
  );

  it('makes nested authority read/write-denied in credential-only Seatbelt with no transcript deny', () => {
    const rules = buildCredentialIsolationRules({
      homeDir: HOME, botmuxHome: `${HOME}/.botmux`,
    }, paths);
    const profile = buildSeatbeltProfile(
      rules.denyPaths, [], [], [], rules.denyRegexes, undefined, rules,
    );
    for (const path of paths) {
      expect(rules.denyPaths).toContain(path);
      expect(rules.denyWritePaths).toContain(path);
      expect(profile).toContain(`(deny file-read* (subpath "${path}"))`);
      expect(profile).toContain(`(deny file-write* (subpath "${path}"))`);
      expect(rules.denyRegexes.some(pattern => new RegExp(pattern).test(`${path}.tmp`))).toBe(true);
    }
    expect(rules.denyPaths.some(path => `${DATA}/sessions-cli_self.db`.startsWith(`${path}/`))).toBe(false);
  });

  it('masks all nested directories even when absent at credential-only Linux launch', () => {
    // The pure mount-plan builder must not existence-filter these directories:
    // a later host-created grant/journal cannot become visible in this pane.
    const args = buildCredentialOnlySandboxArgs({
      hideDirectories: paths, hideFiles: [], workingDir: '/workspace',
      cliBin: '/usr/bin/true', cliArgs: [],
    });
    for (const path of paths) {
      const index = args.indexOf(path);
      expect(args[index - 1]).toBe('--tmpfs');
      expect(index).toBeGreaterThan(args.indexOf('--dev'));
    }
    expect(args).not.toContain(`${DATA}/sessions-cli_self.db`);
  });

  it('keeps custom data authority outside Home explicitly denied in credential-only policy', () => {
    const custom = projectAuthorityPaths('/srv/custom-project-state');
    const rules = buildCredentialIsolationRules({
      homeDir: HOME, botmuxHome: `${HOME}/.botmux`,
    }, custom);
    // Generic protectedPaths deliberately accepts Home entries only. The
    // worker must append daemon-frozen external authority, not depend on it.
    rules.denyPaths.push(...custom);
    rules.denyWritePaths.push(...custom);
    const profile = buildSeatbeltProfile(
      rules.denyPaths, [], [], [], rules.denyRegexes, undefined, rules,
    );
    for (const path of custom) {
      expect(profile).toContain(`(deny file-read* (subpath "${path}"))`);
      expect(profile).toContain(`(deny file-write* (subpath "${path}"))`);
    }
  });

  it.each(['linux', 'darwin'] as const)(
    'full %s policy denies journals despite wider working directory and deeper user grants', platform => {
      const policy = buildFsPolicy(policyContext(platform));
      for (const leaf of leaves) expect(accessForPath(policy.rules, leaf).access).toBe('deny');
      expect(accessForPath(policy.rules, `${HOME}/project/source.ts`).access).toBe('readWrite');
    },
  );

  it.each(['linux', 'darwin'] as const)(
    'full %s policy preserves host-only denies in a custom state directory', platform => {
      const dataDir = '/srv/custom-project-state';
      const context = policyContext(platform, dataDir);
      context.userPaths!.readWrite!.push(dataDir);
      const policy = buildFsPolicy(context);
      for (const path of projectAuthorityPaths(dataDir)) {
        expect(accessForPath(policy.rules, `${path}/grant.json`).access).toBe('deny');
      }
    },
  );

  it('full Linux compilation supplies read-only empty masks for all future journal mountpoints', () => {
    const dataDir = '/srv/custom-project-state';
    const context = policyContext('linux', dataDir);
    context.userPaths!.readWrite!.push(dataDir);
    const compiled = compileToBwrap(buildFsPolicy(context), {
      emptyDir: '/sandbox-empty', emptiesDir: '/sandbox-empty-files', chdir: HOME,
    });
    for (const path of projectAuthorityPaths(dataDir)) {
      expect(compiled.maskMounts).toContainEqual({ path, kind: 'dir' });
      const index = compiled.args.indexOf(path);
      expect(compiled.args.slice(index - 2, index)).toEqual(['--ro-bind', '/sandbox-empty']);
    }
  });
});
