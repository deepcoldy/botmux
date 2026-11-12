import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyFailure, RETRY_DELAYS_MS, runWithRetry } from '../scripts/ci-net-retry.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/ci-net-retry.mjs');

// 样本是真实输出：两条来自 #3193 的 CI 现场日志，其余是 bun 1.4.4 / npm 11 / pnpm 9.5.0 /
// electron install.js / curl 对着本地故障注入 registry（504、断开连接、404）时的报错原文。
const APT_DNS = "E: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/pool/main/b/bubblewrap/bubblewrap_0.9.0-1ubuntu0.3_amd64.deb Temporary failure resolving 'azure.archive.ubuntu.com'";
const TRANSIENT: Record<string, string> = {
  'apt 临时 DNS 失败（#3348 CI 原始日志）': APT_DNS,
  'electron postinstall 504（#3193 现场一）':
    'bun install v1.4.3 (c6da4a4d3)\nHTTPError: Response code 504 (Gateway Time-out)\n    at Request._onResponseBase (/home/runner/work/botmux/botmux/node_modules/got/dist/source/core/index.js:913:31)\nerror: postinstall script from "electron" exited with 1',
  'setup-bun 下载 504（#3193 现场二）': 'Unexpected HTTP response: 504\nWaiting 18 seconds before trying again\n##[error]Error: Unexpected HTTP response: 504',
  'bun tarball 504': 'bun install v1.4.4 (38afee6c8)\nerror: GET http://127.0.0.1:48761/fake-dep/-/fake-dep-1.0.0.tgz - 504',
  'bun 连接被断开': 'bun install v1.4.4 (38afee6c8)\nerror: ConnectionClosed downloading tarball fake-dep@1.0.0',
  'npm 504': 'npm error code E504\nnpm error 504 Gateway Time-out - GET http://127.0.0.1:48761/fake-dep',
  'npm 连接被断开': 'npm error network request to http://127.0.0.1:48761/fake-dep failed, reason: socket hang up',
  'pnpm 504': ' ERR_PNPM_FETCH_504  GET http://127.0.0.1:48761/fake-dep/-/fake-dep-1.0.0.tgz: Gateway Time-out - 504',
  'pnpm 连接被断开': ' ERR_PNPM_META_FETCH_FAIL  GET http://127.0.0.1:48761/fake-dep: request to http://127.0.0.1:48761/fake-dep failed, reason: socket hang up',
  'electron postinstall 连接被断开': 'RequestError: socket hang up',
  'curl 504': 'curl: (22) The requested URL returned error: 504',
  'curl 空响应': 'curl: (52) Empty reply from server',
  'curl 连不上': "curl: (7) Failed to connect to 127.0.0.1 port 48762 after 0 ms: Couldn't connect to server",
};

const DETERMINISTIC: Record<string, string> = {
  'bun lockfile 漂移':
    'bun install v1.4.4 (38afee6c8)\nerror: lockfile had changes, but lockfile is frozen\nnote: dependencies in package.json changed since bun.lock was saved: fake-dep was removed',
  'pnpm lockfile 漂移': ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
  'bun 404': 'bun install v1.4.4 (38afee6c8)\nerror: GET http://127.0.0.1:48761/fake-dep/-/fake-dep-1.0.0.tgz - 404',
  'npm 404': "npm error code E404\nnpm error 404  The requested resource 'fake-dep@1.0.0' could not be found or you do not have permission to access it.",
  'pnpm 404': ' ERR_PNPM_FETCH_404  GET http://127.0.0.1:48761/fake-dep: Not Found - 404',
  'electron postinstall 404': 'HTTPError: Response code 404 (Not Found)',
  'curl 404': 'curl: (22) The requested URL returned error: 404',
  'npm 版本不存在': 'npm error code ETARGET\nnpm error notarget No matching version found for fake-dep@9.9.9.',
  'npm peer 冲突': 'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree',
  // 同一份输出里既有网络抖动又有确定性错误：确定性错误说了算，重试也不会过。
  '404 与 504 混在一起':
    'error: GET https://registry.npmjs.org/a/-/a-1.0.0.tgz - 504\nerror: GET https://registry.npmjs.org/b/-/b-1.0.0.tgz - 404',
};

const UNKNOWN: Record<string, string> = {
  '编译失败': "gyp ERR! build error\nerror: install script from \"node-pty\" exited with 1",
  'DNS 查无此主机': 'curl: (6) Could not resolve host: registry.npmjs.invalid',
  '脚本语法错误': 'SyntaxError: Unexpected token',
  '无输出': '',
};

describe('classifyFailure', () => {
  it.each(Object.entries(TRANSIENT))('网络/网关类：%s', (_name, output) => {
    expect(classifyFailure(output).kind).toBe('transient');
  });
  it.each(Object.entries(DETERMINISTIC))('确定性：%s', (_name, output) => {
    expect(classifyFailure(output).kind).toBe('deterministic');
  });
  it.each(Object.entries(UNKNOWN))('识别不了的失败不归为网络类：%s', (_name, output) => {
    expect(classifyFailure(output).kind).toBe('unknown');
  });
});

type Attempt = { code: number; output: string; interrupted?: boolean };

function harness(results: Attempt[]) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const logs: Array<[string, string]> = [];
  const deps = {
    spawn: async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      const result = results[Math.min(calls.length - 1, results.length - 1)];
      return { interrupted: false, ...result };
    },
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: (level: string, message: string) => { logs.push([level, message]); },
  };
  return { deps, calls, sleeps, logs };
}

const GATEWAY_504 = { code: 1, output: TRANSIENT['bun tarball 504'] };

describe('runWithRetry', () => {
  it.each([true, false])('apt 临时解析失败有界重试，恢复=%s', async (recovers) => {
    const failed = { code: 100, output: APT_DNS };
    const h = harness(recovers ? [failed, { code: 0, output: '' }] : [failed]);
    const args = ['apt-get', '-o', 'APT::Update::Error-Mode=any', 'update'];
    await expect(runWithRetry('sudo', args, h.deps)).resolves.toBe(recovers ? 0 : 100);
    expect(h.calls).toEqual(Array.from({ length: recovers ? 2 : 5 }, () => ['sudo', ...args]));
    expect(h.sleeps).toEqual(recovers ? [10_000] : [...RETRY_DELAYS_MS]);
  });

  it.each([
    'E: Unable to locate package missing',
    "E: Package missing has no installation candidate",
    'E: Hash Sum mismatch',
    'NO_PUBKEY 1234567890ABCDEF',
    'EXPKEYSIG 1234567890ABCDEF',
    'BADSIG 1234567890ABCDEF',
    "E: The repository is not signed",
    "E: The repository does not have a Release file",
    "W: The following signatures couldn't be verified",
    'E: Could not open lock file (13: Permission denied)',
    'E: Failed to fetch https://example.invalid/pkg 403 Forbidden',
    'E: Failed to fetch https://example.invalid/pkg 404 Not Found',
    'E: Failed to fetch https://example.invalid/pkg 401 Unauthorized',
  ])('apt 确定性错误优先于同时出现的 DNS 失败：%s', async (error) => {
    const output = `${APT_DNS}\n${error}`;
    expect(classifyFailure(output).kind).toBe('deterministic');
    const h = harness([{ code: 100, output }, { code: 0, output: '' }]);
    await expect(runWithRetry('sudo', ['apt-get', 'update'], h.deps)).resolves.toBe(100);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('次数与间隔写死：最多 5 次，间隔 10s/20s/40s/80s', () => {
    expect(RETRY_DELAYS_MS).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(Object.isFrozen(RETRY_DELAYS_MS)).toBe(true);
  });

  it('一直 504：按退避试满 5 次后以最后一次的退出码失败', async () => {
    const h = harness([GATEWAY_504]);
    await expect(runWithRetry('bun', ['install', '--frozen-lockfile'], h.deps)).resolves.toBe(1);
    expect(h.calls).toHaveLength(5);
    expect(h.calls.every((c) => c.join(' ') === 'bun install --frozen-lockfile')).toBe(true);
    expect(h.sleeps).toEqual([10_000, 20_000, 40_000, 80_000]);
    expect(h.logs.map(([level]) => level)).toEqual(['warning', 'warning', 'warning', 'warning', 'error']);
  });

  it('504 两次后恢复：第 3 次成功，整体返回 0', async () => {
    const h = harness([GATEWAY_504, GATEWAY_504, { code: 0, output: '1 package installed' }]);
    await expect(runWithRetry('bun', ['install'], h.deps)).resolves.toBe(0);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([10_000, 20_000]);
    expect(h.logs.at(-1)?.[0]).toBe('notice');
  });

  it('首次就成功：不等待、不打日志', async () => {
    const h = harness([{ code: 0, output: '' }]);
    await expect(runWithRetry('bun', ['install'], h.deps)).resolves.toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it.each([
    ['bun lockfile 漂移', DETERMINISTIC['bun lockfile 漂移']],
    ['bun 404', DETERMINISTIC['bun 404']],
    ['404 与 504 混在一起', DETERMINISTIC['404 与 504 混在一起']],
    ['编译失败', UNKNOWN['编译失败']],
  ])('非网络类失败（%s）第一次就红，退出码原样传出', async (_name, output) => {
    const h = harness([{ code: 3, output }, { code: 0, output: '' }]);
    await expect(runWithRetry('bun', ['install'], h.deps)).resolves.toBe(3);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('先 504 后出现确定性错误：停在确定性错误那一次，不再重试', async () => {
    const h = harness([GATEWAY_504, { code: 1, output: DETERMINISTIC['bun lockfile 漂移'] }, { code: 0, output: '' }]);
    await expect(runWithRetry('bun', ['install'], h.deps)).resolves.toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([10_000]);
  });

  it('被信号打断（job 取消）时不重试，即使输出里有网络特征', async () => {
    const h = harness([{ ...GATEWAY_504, code: 130, interrupted: true }]);
    await expect(runWithRetry('bun', ['install'], h.deps)).resolves.toBe(130);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });
});

describe('CLI（真实子进程）', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const runCli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });

  it('成功时原样转发 stdout/stderr，退出码 0', () => {
    const r = runCli(process.execPath, '-e', 'console.log("out-line"); console.error("err-line")');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('out-line\n');
    expect(r.stderr).toBe('err-line\n');
  });

  it('lockfile 漂移只跑一次就以原退出码失败', () => {
    dir = mkdtempSync(join(tmpdir(), 'ci-net-retry-'));
    const counter = join(dir, 'attempts');
    const r = runCli(process.execPath, '-e', `
      require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x');
      console.error('error: lockfile had changes, but lockfile is frozen');
      process.exit(7);
    `);
    expect(r.status).toBe(7);
    expect(readFileSync(counter, 'utf8')).toBe('x');
    expect(r.stderr).toContain('确定性错误（lockfile had changes, but lockfile is frozen），不重试');
  });

  it('子进程被信号杀掉时按 128+信号值退出', () => {
    const r = runCli(process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")');
    expect(r.status).toBe(143);
  });

  it('命令不存在时退出 127 且不重试', () => {
    const r = runCli('ci-net-retry-no-such-command');
    expect(r.status).toBe(127);
    expect(r.stderr.match(/无法启动/g)).toHaveLength(1);
  });

  it('没有命令时打印用法并退出 2', () => {
    const r = runCli();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage:');
  });
});

// 源码结构护栏(K4)：workflow 里的安装步骤只在 GitHub runner 上执行，本地没有可调用的 seam。
// 守的是 #3193 的一致性：每个 workflow / 容器脚本里的依赖安装都经 scripts/ci-net-retry.mjs，
// Bun 都经带重试的 ./.github/actions/setup-bun 安装，electron postinstall 的下载在所有装依赖的
// 地方都被跳过。新增一个裸的 `bun install` 或 `oven-sh/setup-bun` 就会把这项修复悄悄退回去。
describe('workflow 安装步骤都带网络重试（#3193）', () => {
  const WORKFLOWS = readdirSync(join(ROOT, '.github/workflows'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => `.github/workflows/${f}`);
  const GLIBC_SH = 'scripts/build-linux-glibc-baseline.sh';
  const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  /** 去掉 `#` 注释，免得一句谈论安装命令的注释被当成命令。 */
  const code = (rel: string) => read(rel).split('\n').map((line) => line.replace(/(^|\s)#.*$/, '$1'));
  const INSTALL = /\b(?:bun (?:install|add|i)|npm (?:install|i|ci)|pnpm (?:install|add|i))(?=\s|$)/g;
  const RUNS_BUN_INSTALL = /\bbun install\b/;

  it('每一处 bun / npm / pnpm 安装都从 ci-net-retry.mjs 启动', () => {
    const bare: string[] = [];
    let seen = 0;
    for (const rel of [...WORKFLOWS, GLIBC_SH]) {
      code(rel).forEach((line, i) => {
        if (/^\s*echo\s/.test(line)) return;
        for (const m of line.matchAll(INSTALL)) {
          seen += 1;
          if (!line.slice(0, m.index).endsWith('ci-net-retry.mjs ')) bare.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(seen).toBeGreaterThan(20);
    expect(bare).toEqual([]);
  });

  it('Bun 只经带重试的本地 action 安装，该 action 的下载也走 ci-net-retry.mjs', () => {
    const USES_UPSTREAM = /uses:\s*oven-sh\/setup-bun/;
    const direct = WORKFLOWS.filter((rel) => code(rel).some((line) => USES_UPSTREAM.test(line)));
    expect(direct).toEqual([]);
    const users = WORKFLOWS.filter((rel) => code(rel).some((line) => line.includes('uses: ./.github/actions/setup-bun')));
    expect(users.length).toBeGreaterThanOrEqual(6);
    const action = code('.github/actions/setup-bun/action.yml').join('\n');
    expect(action).not.toMatch(USES_UPSTREAM);
    expect(action).toMatch(/ci-net-retry\.mjs" npm pack "@oven\/\$pkg@\$BUN_VERSION"/);
  });

  it('每个装依赖的 workflow 都在顶层跳过 electron 二进制下载，容器里也传进去', () => {
    const missing: string[] = [];
    for (const rel of WORKFLOWS) {
      const lines = code(rel);
      if (!lines.some((line) => RUNS_BUN_INSTALL.test(line))) continue;
      const env = lines.join('\n').match(/^env:\n((?: {2}.*\n|\s*\n)*)/m)?.[1] ?? '';
      if (!/^ {2}ELECTRON_SKIP_BINARY_DOWNLOAD: "1"$/m.test(env)) missing.push(rel);
      const text = lines.join('\n');
      for (const m of text.matchAll(/docker run\b[\s\S]*?(?=\n\s*[\w.:/-]+ sh -euc ')/g)) {
        if (!m[0].includes('-e ELECTRON_SKIP_BINARY_DOWNLOAD=1')) missing.push(`${rel}: docker run`);
      }
    }
    if (!code(GLIBC_SH).some((line) => line.includes('-e ELECTRON_SKIP_BINARY_DOWNLOAD=1'))) missing.push(GLIBC_SH);
    expect(missing).toEqual([]);
  });
});
