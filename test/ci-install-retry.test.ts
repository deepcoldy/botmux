import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * CI 的依赖安装不能因为上游临时 5xx 让 job 零测试就红。
 *
 * 失败形状：`bun install` 里 electron 的 postinstall 拉二进制撞上网关 504，
 * 分片在安装这一步就退出，必需 check `test` 变红、挡住与之无关的 PR。
 * 这里守两条不变量：
 *   • ci.yml 的每个 `bun install`（含两处在 docker 里跑的）都经过
 *     scripts/ci-install-retry.sh：临时失败在后续尝试里恢复，真失败在第三次
 *     之后仍以原退出码让 job 变红。
 *   • ci.yml 不下载 electron 二进制：workflow 级 env 设置，docker run 用 `-e`
 *     透传（容器不继承宿主环境）。
 */

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/ci-install-retry.sh');

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function writeExecutable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** Runs the wrapper around a fake install that fails its first `failures`
 *  calls with `code`. `sleep` is replaced by a recorder so the backoff is
 *  observable without waiting for it. */
function runWrapper(failures: number, code = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-install-retry-'));
  scratch = dir;
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeExecutable(join(bin, 'sleep'), `#!/bin/sh\necho "$1" >> "${dir}/sleeps"\n`);
  writeExecutable(join(bin, 'fake-install'), [
    '#!/bin/sh',
    `n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 ))`,
    `echo "$n" > "${dir}/count"`,
    `printf '%s\\n' "$*" >> "${dir}/calls"`,
    `[ "$n" -gt ${failures} ] || exit ${code}`,
    '',
  ].join('\n'));
  const res = spawnSync('sh', [SCRIPT, 'fake-install', 'install', '--frozen-lockfile'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  const lines = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  return { status: res.status, stderr: res.stderr, calls: lines('calls'), sleeps: lines('sleeps') };
}

describe('scripts/ci-install-retry.sh', () => {
  it('runs the install once when it succeeds', () => {
    const r = runWrapper(0);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['install --frozen-lockfile']);
    expect(r.sleeps).toEqual([]);
  });

  it('retries a failed install with growing backoff and stops at the first success', () => {
    const r = runWrapper(2);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(Array(3).fill('install --frozen-lockfile'));
    expect(r.sleeps).toEqual(['15', '30']);
  });

  it('gives up after three attempts with the last exit status', () => {
    const r = runWrapper(99, 7);
    expect(r.status).toBe(7);
    expect(r.calls).toHaveLength(3);
    expect(r.sleeps).toEqual(['15', '30']);
    expect(r.stderr).toContain('giving up after 3 attempts (exit 7)');
  });

  it('refuses to run without a command', () => {
    expect(spawnSync('sh', [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });
});

type Workflow = {
  env?: Record<string, unknown>;
  jobs: Record<string, { steps?: Array<{ run?: unknown }> }>;
};
const CI = parseYaml(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as Workflow;
const GLIBC_BUILDER = readFileSync(join(ROOT, 'scripts/build-linux-glibc-baseline.sh'), 'utf8');

/** Shell lines with `#` comments removed, so prose about a command never counts as the command. */
const codeLines = (text: string) => text.split('\n').map(line => line.replace(/(^|\s)#.*$/, '$1'));

const runScripts = [
  ...Object.entries(CI.jobs).flatMap(([job, def]) =>
    (def.steps ?? []).flatMap(step => (typeof step.run === 'string' ? [{ where: job, code: codeLines(step.run) }] : []))),
  { where: 'build-linux-glibc-baseline.sh', code: codeLines(GLIBC_BUILDER) },
];

describe('ci.yml — dependency installs survive transient upstream failures', () => {
  it('routes every bun install through the retry wrapper, including the ones inside docker', () => {
    const installs = runScripts.flatMap(({ where, code }) =>
      code.filter(line => /\bbun install\b/.test(line)).map(line => ({ where, line: line.trim() })));
    expect(installs.map(i => i.where)).toEqual(expect.arrayContaining([
      'build', 'test', 'bun-test', 'bun-binary-musl', 'bun-binary-darwin', 'build-linux-glibc-baseline.sh',
    ]));
    for (const { where, line } of installs) {
      expect(line, where).toMatch(/(?:^|\s)sh scripts\/ci-install-retry\.sh bun install --frozen-lockfile$/);
    }
  });

  it('skips the Electron binary download, and passes that into every docker run', () => {
    expect(CI.env?.ELECTRON_SKIP_BINARY_DOWNLOAD).toBe('1');
    const dockerScripts = runScripts.map(({ where, code }) => ({ where, text: code.join('\n') }))
      .filter(({ text }) => /\bdocker run\b/.test(text));
    expect(dockerScripts.map(d => d.where)).toEqual(expect.arrayContaining(['bun-binary-musl', 'build-linux-glibc-baseline.sh']));
    for (const { where, text } of dockerScripts) {
      const runs = text.match(/\bdocker run\b/g)!.length;
      const passed = text.match(/-e ELECTRON_SKIP_BINARY_DOWNLOAD\b/g)?.length ?? 0;
      expect(passed, where).toBe(runs);
    }
  });
});
