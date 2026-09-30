import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const probes = vi.hoisted(() => ({
  cmdline: vi.fn<(pid: number) => string[]>(),
  identity: vi.fn<(pid: number) => string | undefined>(),
  procExecutables: new Map<string, string>(),
}));

vi.mock('../src/core/session-discovery.js', () => ({ readCmdline: probes.cmdline }));
vi.mock('../src/utils/process-identity.js', () => ({ readProcessStartIdentity: probes.identity }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((path: string) => actual.realpathSync(probes.procExecutables.get(path) ?? path)),
  };
});

import { isRestartableCodexHelper, type CodexProcess, type ProcessRow } from '../src/services/codex-session-upgrade.js';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let directory: string;
let running: CodexProcess;
let gateway: string;
let cliEntry: string;
let node: string;
let codeMode: string;

function fixture(path: string, text = ''): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function helper(executable: string, argv: string[], ppid = 100): ProcessRow {
  const row = { pid: 200, ppid, command: executable };
  probes.cmdline.mockReturnValue(argv);
  probes.procExecutables.set('/proc/200/exe', executable);
  return row;
}

function eligible(row: ProcessRow, tree: ProcessRow[] = [row]): boolean {
  return isRestartableCodexHelper(row, tree, [running], gateway);
}

function npmPlatformBinary(packageName: string, nestedDirectory = 'node_modules') {
  const owner = join(directory, 'npm-global', 'lib', 'node_modules', 'botmux');
  const platformRoot = join(owner, nestedDirectory, packageName);
  const binary = fixture(join(platformRoot, 'botmux'));
  const platformPackage = { name: packageName, version: '3.18.11' };
  const ownerPackage = {
    name: 'botmux', version: '3.18.11', optionalDependencies: { [packageName]: '3.18.11' },
  };
  const platformMetadata = fixture(join(platformRoot, 'package.json'), JSON.stringify(platformPackage));
  const ownerMetadata = fixture(join(owner, 'package.json'), JSON.stringify(ownerPackage));
  // The live leaf still executes its npm platform binary after the gateway
  // switches to a newly installed standalone release.
  const current = fixture(join(directory, 'current-release', 'botmux'));
  writeFileSync(gateway, `#!/bin/sh\nexec "${current}" "$@"\n`);
  return { binary, platformMetadata, platformPackage, ownerMetadata, ownerPackage };
}

beforeEach(() => {
  probes.cmdline.mockReset();
  probes.identity.mockReset().mockReturnValue('stable-start');
  probes.procExecutables.clear();
  vi.mocked(realpathSync).mockClear();
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-codex-helper-')));
  running = {
    pid: 100, started: 'codex-start', version: '0.146.0', fingerprint: 'running',
    path: fixture(join(directory, 'releases', '0.146.0', 'bin', 'codex')),
  };
  codeMode = fixture(join(dirname(running.path), 'codex-code-mode-host'));
  node = fixture(join(directory, 'node', 'bin', 'node'));
  cliEntry = fixture(join(directory, 'botmux', 'dist', 'cli.js'));
  gateway = fixture(join(directory, 'bin', 'botmux'), `#!/bin/sh\nexec node "${cliEntry}" "$@"\n`);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  rmSync(directory, { recursive: true, force: true });
});

describe.each(['darwin', 'linux'] as const)('restartable Codex leaf helpers on %s', platform => {
  beforeEach(() => Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform }));

  it('allows a code-mode leaf from its direct Codex parent release directory', () => {
    const row = helper(codeMode, [codeMode]);
    if (platform === 'linux') row.command = 'codex-code-mod'; // ps comm can be truncated; /proc is authoritative.
    expect(eligible(row)).toBe(true);
    expect(realpathSync).toHaveBeenCalledWith(platform === 'linux' ? '/proc/200/exe' : codeMode);
    expect(probes.identity.mock.calls).toEqual([[200], [200]]);
  });

  it('rejects a code-mode executable from another release or an unrelated parent', () => {
    const other = fixture(join(directory, 'releases', '0.153.4', 'bin', 'codex-code-mode-host'));
    expect(eligible(helper(other, [other]))).toBe(false);
    expect(eligible(helper(codeMode, [codeMode], 101))).toBe(false);
  });

  it.each([false, true])('rejects a known helper with children (grandchildren=%s)', grandchildren => {
    const row = helper(codeMode, [codeMode]);
    const child = { pid: 201, ppid: row.pid, command: node };
    const tree = [row, child, ...(grandchildren ? [{ pid: 202, ppid: child.pid, command: node }] : [])];
    expect(eligible(row, tree)).toBe(false);
    expect(probes.cmdline).not.toHaveBeenCalled();
  });

  it('allows the exact configured gateway executable with only mcp serve arguments', () => {
    expect(eligible(helper(gateway, [gateway, 'mcp', 'serve']))).toBe(true);
    const unrelated = fixture(join(directory, 'user', 'botmux'));
    expect(eligible(helper(unrelated, [unrelated, 'mcp', 'serve']))).toBe(false);
  });

  it('allows Node only for the exact CLI entry from the configured Botmux wrapper', () => {
    expect(eligible(helper(node, [node, cliEntry, 'mcp', 'serve']))).toBe(true);
    const otherEntry = fixture(join(directory, 'other-checkout', 'dist', 'cli.js'));
    expect(eligible(helper(node, [node, otherEntry, 'mcp', 'serve']))).toBe(false);
  });

  it('allows the exact standalone binary target from the configured two-line wrapper', () => {
    const binary = fixture(join(directory, 'binary release', 'botmux'));
    writeFileSync(gateway, `#!/bin/sh\nexec "${binary}" "$@"\n`);
    expect(eligible(helper(binary, [binary, 'mcp', 'serve']))).toBe(true);
    const oldBinary = fixture(join(directory, 'old-release', 'botmux'));
    expect(eligible(helper(oldBinary, [oldBinary, 'mcp', 'serve']))).toBe(false);
  });

  it.each(['x64', 'arm64'])('allows an old installed npm %s gateway leaf after the launcher changes release', arch => {
    const { binary } = npmPlatformBinary(`botmux-${platform}-${arch}`);
    const row = helper(binary, [binary, 'mcp', 'serve']);
    if (platform === 'linux') row.command = 'botmux';
    expect(eligible(row)).toBe(true);
    expect(realpathSync).toHaveBeenCalledWith(platform === 'linux' ? '/proc/200/exe' : binary);
  });

  it.each(['x64', 'arm64'])('accepts Linux %s musl packages and rejects a fabricated Darwin musl package', arch => {
    const { binary } = npmPlatformBinary(`botmux-${platform}-${arch}-musl`);
    expect(eligible(helper(binary, [binary, 'mcp', 'serve']))).toBe(platform === 'linux');
  });

  it('requires the old installed npm helper to be a direct Codex child with no children', () => {
    const { binary } = npmPlatformBinary(`botmux-${platform}-arm64`);
    expect(eligible(helper(binary, [binary, 'mcp', 'serve'], 101))).toBe(false);
    const row = helper(binary, [binary, 'mcp', 'serve']);
    expect(eligible(row, [row, { pid: 201, ppid: row.pid, command: node }])).toBe(false);
  });

  it.each(['extra', 'missing', 'different-command'])('rejects an old npm binary with %s argv', kind => {
    const { binary } = npmPlatformBinary(`botmux-${platform}-arm64`);
    const argv = kind === 'extra' ? [binary, 'mcp', 'serve', '--custom']
      : kind === 'missing' ? [binary, 'mcp'] : [binary, 'daemon', 'start'];
    expect(eligible(helper(binary, argv))).toBe(false);
  });

  it.each(['owner', 'platform'])('rejects missing %s package metadata', which => {
    const installed = npmPlatformBinary(`botmux-${platform}-arm64`);
    rmSync(which === 'owner' ? installed.ownerMetadata : installed.platformMetadata);
    expect(eligible(helper(installed.binary, [installed.binary, 'mcp', 'serve']))).toBe(false);
  });

  it.each(['platform-name', 'owner-name', 'owner-version', 'dependency-version', 'dependency-range', 'missing-dependency', 'malformed-json'] as const)('rejects npm metadata mismatch: %s', kind => {
    const installed = npmPlatformBinary(`botmux-${platform}-arm64`);
    const { platformPackage, ownerPackage } = installed;
    if (kind === 'platform-name') platformPackage.name = 'unrelated-platform-package';
    if (kind === 'owner-name') ownerPackage.name = 'unrelated-owner';
    if (kind === 'owner-version') ownerPackage.version = '3.18.12';
    if (kind === 'dependency-version') ownerPackage.optionalDependencies[platformPackage.name] = '3.18.12';
    if (kind === 'dependency-range') ownerPackage.optionalDependencies[platformPackage.name] = '^3.18.11';
    if (kind === 'missing-dependency') delete ownerPackage.optionalDependencies[platformPackage.name];
    writeFileSync(installed.platformMetadata, JSON.stringify(platformPackage));
    writeFileSync(installed.ownerMetadata, kind === 'malformed-json' ? '{' : JSON.stringify(ownerPackage));
    expect(eligible(helper(installed.binary, [installed.binary, 'mcp', 'serve']))).toBe(false);
  });

  it('rejects matching metadata placed outside the nested node_modules installation', () => {
    const { binary } = npmPlatformBinary(`botmux-${platform}-arm64`, 'arbitrary-folder');
    expect(eligible(helper(binary, [binary, 'mcp', 'serve']))).toBe(false);
  });

  it.each(['renamed-package', 'renamed-binary'])('rejects forged npm installation names: %s', kind => {
    const packageName = kind === 'renamed-package' ? `fake-botmux-${platform}-arm64` : `botmux-${platform}-arm64`;
    const installed = npmPlatformBinary(packageName);
    const binary = kind === 'renamed-binary'
      ? fixture(join(dirname(installed.binary), 'other-command')) : installed.binary;
    expect(eligible(helper(binary, [binary, 'mcp', 'serve']))).toBe(false);
  });

  it.skipIf(platform !== 'linux')('rejects a forged npm path in argv and ps when /proc identifies another executable', () => {
    const { binary } = npmPlatformBinary('botmux-linux-x64');
    const row = helper(binary, [binary, 'mcp', 'serve']);
    probes.procExecutables.set('/proc/200/exe', fixture(join(directory, 'user-command', 'botmux')));
    expect(eligible(row)).toBe(false);
    expect(realpathSync).toHaveBeenCalledWith('/proc/200/exe');
  });

  it.each(['extra-argument', 'extra-statement', 'prepended-statement', 'variable-command', 'command-substitution', 'backtick-substitution', 'escaped-path', 'relative-path', 'unquoted-command'] as const)('rejects a standalone wrapper with %s', kind => {
    const binary = fixture(join(directory, 'binary', 'botmux'));
    const wrappers: Record<typeof kind, string> = {
      'extra-argument': `#!/bin/sh\nexec "${binary}" --extra "$@"\n`,
      'extra-statement': `#!/bin/sh\nexec "${binary}" "$@"; echo unwanted\n`,
      'prepended-statement': `#!/bin/sh\necho unwanted\nexec "${binary}" "$@"\n`,
      'variable-command': '#!/bin/sh\nexec "$BOTMUX_BIN" "$@"\n',
      'command-substitution': '#!/bin/sh\nexec "/tmp/$(printf botmux)" "$@"\n',
      'backtick-substitution': '#!/bin/sh\nexec "/tmp/`printf botmux`" "$@"\n',
      'escaped-path': `#!/bin/sh\nexec "${directory}/binary/\\botmux" "$@"\n`,
      'relative-path': '#!/bin/sh\nexec "./botmux" "$@"\n',
      'unquoted-command': `#!/bin/sh\nexec ${binary} "$@"\n`,
    };
    writeFileSync(gateway, wrappers[kind]);
    expect(eligible(helper(binary, [binary, 'mcp', 'serve']))).toBe(false);
  });

  it.each(['node', 'npm', 'user-mcp', 'repl', 'extra-arg', 'code-mode-arg'] as const)('rejects unknown %s processes', kind => {
    const userMcp = fixture(join(directory, 'user', 'mcp.js'));
    const npm = fixture(join(directory, 'node', 'bin', 'npm'));
    const cases: Record<typeof kind, [string, string[]]> = {
      node: [node, [node]],
      npm: [npm, [npm, 'exec', 'mcp', 'serve']],
      'user-mcp': [node, [node, userMcp, 'mcp', 'serve']],
      repl: [node, [node, '--interactive']],
      'extra-arg': [node, [node, cliEntry, 'mcp', 'serve', '--custom']],
      'code-mode-arg': [codeMode, [codeMode, '--interactive']],
    };
    const [executable, argv] = cases[kind];
    expect(eligible(helper(executable, argv))).toBe(false);
  });

  it('rejects a missing or changed PID identity', () => {
    const row = helper(codeMode, [codeMode]);
    probes.identity.mockReturnValueOnce(undefined);
    expect(eligible(row)).toBe(false);
    probes.identity.mockReturnValueOnce('old-start').mockReturnValueOnce('new-start');
    expect(eligible(row)).toBe(false);
    probes.identity.mockReturnValueOnce('old-start').mockReturnValueOnce(undefined);
    expect(eligible(row)).toBe(false);
  });

  it('rejects unreadable command lines, executables, and wrapper identities', () => {
    expect(eligible(helper(codeMode, []))).toBe(false);
    const gone = join(directory, 'gone-code-mode-host');
    expect(eligible(helper(gone, [gone]))).toBe(false);
    writeFileSync(gateway, '#!/bin/sh\nnode arbitrary-script.js\n');
    expect(eligible(helper(node, [node, cliEntry, 'mcp', 'serve']))).toBe(false);
    rmSync(gateway);
    expect(eligible(helper(node, [node, cliEntry, 'mcp', 'serve']))).toBe(false);
  });
});
