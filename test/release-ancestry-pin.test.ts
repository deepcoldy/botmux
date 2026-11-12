import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';

/**
 * 正式版（npm latest）发版闸：preflight 判定能不能发，release job 只复核 preflight 固定下来的事实。
 * 规则与理由见 release.yml 里 preflight 的「Guard — stable release must come from master」。
 *
 * 这里不铉 YAML 的写法：每个用例都搭一个真实的 git 仓库（裸仓库当 origin）和一个假 npm，
 * 照 release.yml 里写的 `run` / `env` 执行两个 job 的守门步骤，并按 YAML 里的 `outputs` /
 * `needs.preflight.outputs.*` 把 preflight 的输出接到 release。两个 job 各自 clone 一份，
 * 对应 CI 里两台 runner 各自 checkout。
 *
 * WHAT BURNED v3.18.10 (issue #1150). `binary-subpackages` publishes the six
 * platform packages to npm BEFORE the `release` job runs — and it must, because the
 * main package declares OPTIONAL dependencies on them and npm treats an
 * unresolvable optional dep as a silent no-op, so publishing the main package first
 * installs a binary-less package without error. Both `preflight` and `release` then
 * ran the same "stable must contain the latest master" guard, and each did its own
 * `git fetch origin master`. Measured, all UTC:
 *
 *   09:53:46  preflight ancestry OK   (origin/master = 61620be7, the tag itself)
 *   09:56:22  six subpackages PUBLISHED to npm        <- irreversible
 *   09:57:47  def4275b (#1128) lands on master        <- inside the window
 *   09:58:33  release ancestry REFUSES (origin/master = def4275b)
 *
 * Same guard, same run, opposite verdicts, 4m47s apart; the tag never moved.
 * Recovery was impossible: re-tagging changes the code, so the rebuilt binaries hash
 * differently and `publish-npm-if-missing.mjs` correctly refuses to overwrite a
 * published version with different content. 3.18.10 is permanently a hollow version
 * on npm — six subpackages, no main package — and we skipped to 3.18.11.
 *
 * The published baseline the guard now also reads (npm `latest` + release tags) is
 * just as mobile as master, so the release side must re-check only what preflight
 * pinned — the #1150 cases below run the release step after master, npm and the
 * tags have all moved, with npm unreachable.
 */

const ROOT = resolve(import.meta.dirname, '..');
const GUARD_SCRIPT = '.github/scripts/release-master-guard.mjs';
const GUARD_NAME = 'Guard — stable release must come from master';

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}
interface WorkflowJob {
  needs?: string[];
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

const workflow = parseYaml(readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf-8')) as {
  jobs: Record<string, WorkflowJob>;
};

function guardStep(job: string): WorkflowStep {
  const step = (workflow.jobs[job]?.steps ?? []).find((s) => s.name === GUARD_NAME);
  if (!step?.run) throw new Error(`no runnable step named "${GUARD_NAME}" in job "${job}"`);
  return step;
}

interface ExprContext {
  github: Record<string, string>;
  steps?: Record<string, Record<string, string>>;
  needs?: Record<string, Record<string, string>>;
}

/**
 * Resolve the `${{ … }}` forms the guard wiring uses, with GitHub's semantics: a
 * missing output is the empty string, not an error. That is what makes a typo in
 * the wiring show up here — the release step then sees an empty pin and refuses.
 */
function expr(value: string, ctx: ExprContext): string {
  return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, path: string) => {
    const p = path.split('.');
    if (p[0] === 'github' && p.length === 2) return ctx.github[p[1]] ?? '';
    if (p[0] === 'steps' && p[2] === 'outputs' && p.length === 4) return ctx.steps?.[p[1]]?.[p[3]] ?? '';
    if (p[0] === 'needs' && p[2] === 'outputs' && p.length === 4) return ctx.needs?.[p[1]]?.[p[3]] ?? '';
    throw new Error(`unsupported expression in the guard wiring: ${path}`);
  });
}

function resolveEnv(env: Record<string, string> | undefined, ctx: ExprContext): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, expr(String(v), ctx)]));
}

interface StepResult {
  status: number | null;
  output: string;
  summary: string;
  /** What the step wrote to $GITHUB_OUTPUT. */
  stepOutputs: Record<string, string>;
}

interface Admission extends StepResult {
  /** preflight's job outputs, resolved through the YAML's `outputs:` map. */
  jobOutputs: Record<string, string>;
}

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fx of fixtures.splice(0)) rmSync(fx.root, { recursive: true, force: true });
});

/** origin（裸仓库）+ 开发者 clone + 假 npm。master 上的提交和 tag 都先在 dev 里做，再 push 到 origin。 */
class Fixture {
  readonly root = mkdtempSync(join(tmpdir(), 'release-guard-'));
  private readonly origin = join(this.root, 'origin.git');
  private readonly dev = join(this.root, 'dev');
  private readonly npmLog = join(this.root, 'npm-calls.log');
  private seq = 0;
  /** What `npm view botmux@latest version` prints; null = the npm call fails. */
  npmLatest: string | null = null;

  constructor() {
    fixtures.push(this);
    const fakeBin = join(this.root, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'npm'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_NPM_LOG"',
      'if [ "$1 $2 $3" = "view botmux@latest version" ] && [ -n "$FAKE_NPM_LATEST" ]; then',
      '  printf \'%s\\n\' "$FAKE_NPM_LATEST"; exit 0',
      'fi',
      'echo "npm error code E404" >&2; exit 1',
      '',
    ].join('\n'));
    chmodSync(join(fakeBin, 'npm'), 0o755);
    writeFileSync(join(this.root, 'gitconfig'), '');
    writeFileSync(this.npmLog, '');

    this.git(this.root, 'init', '-q', '--bare', this.origin);
    this.git(this.root, 'clone', '-q', this.origin, this.dev);
    this.git(this.dev, 'symbolic-ref', 'HEAD', 'refs/heads/master');
    // Every real tagged commit carries the guard script its release.yml calls.
    mkdirSync(dirname(join(this.dev, GUARD_SCRIPT)), { recursive: true });
    copyFileSync(join(ROOT, GUARD_SCRIPT), join(this.dev, GUARD_SCRIPT));
    this.git(this.dev, 'add', '.');
    this.git(this.dev, 'commit', '-q', '-m', 'root');
    this.git(this.dev, 'push', '-q', 'origin', 'HEAD:master');
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Nothing of the host's git/Actions/shell-startup state may leak into the fixture:
      // a CI runner's own GITHUB_OUTPUT, a session BASH_ENV that rewrites PATH, etc.
      if (v === undefined || k.startsWith('GIT_') || k.startsWith('GITHUB_') || k === 'BASH_ENV' || k === 'ENV') continue;
      env[k] = v;
    }
    return {
      ...env,
      PATH: `${join(this.root, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: this.root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(this.root, 'gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test',
      FAKE_NPM_LOG: this.npmLog,
      FAKE_NPM_LATEST: this.npmLatest ?? '',
      ...extra,
    };
  }

  git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, { cwd, env: this.env(), encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** A commit on master, pushed. */
  land(subject: string): string {
    this.git(this.dev, 'checkout', '-q', 'master');
    this.git(this.dev, 'commit', '-q', '--allow-empty', '-m', subject);
    this.git(this.dev, 'push', '-q', 'origin', 'HEAD:master');
    return this.git(this.dev, 'rev-parse', 'HEAD');
  }

  /** A commit on a side branch off `base`, never merged into master. */
  branchOff(base: string, subject: string): string {
    this.git(this.dev, 'checkout', '-q', '--detach', base);
    this.git(this.dev, 'commit', '-q', '--allow-empty', '-m', subject);
    const sha = this.git(this.dev, 'rev-parse', 'HEAD');
    this.git(this.dev, 'checkout', '-q', 'master');
    return sha;
  }

  /** Merge `sha` into master with a merge commit (GitHub's "Create a merge commit"), pushed. */
  mergeIntoMaster(sha: string, subject: string): string {
    this.git(this.dev, 'checkout', '-q', 'master');
    this.git(this.dev, 'merge', '-q', '--no-ff', '-m', subject, sha);
    this.git(this.dev, 'push', '-q', 'origin', 'HEAD:master');
    return this.git(this.dev, 'rev-parse', 'HEAD');
  }

  /** Annotated tag, pushed to origin (as `git push origin vX.Y.Z` would). */
  tag(name: string, sha: string): void {
    this.git(this.dev, 'tag', '-a', name, sha, '-m', name);
    this.git(this.dev, 'push', '-q', 'origin', `refs/tags/${name}`);
  }

  /** A fresh full clone detached at `sha` — what actions/checkout (fetch-depth: 0) gives each job. */
  checkout(sha: string): string {
    const dir = join(this.root, `job-${++this.seq}`);
    this.git(this.root, 'clone', '-q', this.origin, dir);
    this.git(dir, 'checkout', '-q', '--detach', sha);
    return dir;
  }

  npmCalls(): string[] {
    return readFileSync(this.npmLog, 'utf-8').split('\n').filter(Boolean);
  }

  runStep(job: string, cwd: string, ctx: ExprContext): StepResult {
    const step = guardStep(job);
    const outFile = join(this.root, `output-${++this.seq}`);
    const summaryFile = join(this.root, `summary-${this.seq}`);
    writeFileSync(outFile, '');
    writeFileSync(summaryFile, '');
    // GitHub runs `run:` as `bash --noprofile --norc -eo pipefail {0}`.
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run!], {
      cwd,
      env: this.env({ ...resolveEnv(step.env, ctx), GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: summaryFile }),
      encoding: 'utf-8',
    });
    const stepOutputs = Object.fromEntries(readFileSync(outFile, 'utf-8').split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }));
    return { status: r.status, output: `${r.stdout}${r.stderr}`, summary: readFileSync(summaryFile, 'utf-8'), stepOutputs };
  }

  /** preflight job: its own checkout of the tagged commit, then the guard step. */
  preflight(releaseTag: string, sha: string): Admission {
    const step = guardStep('preflight');
    const res = this.runStep('preflight', this.checkout(sha), { github: { ref_name: releaseTag } });
    const steps = { [step.id!]: res.stepOutputs, dist_tag: { tag: 'latest', prerelease: 'false' } };
    const jobOutputs = resolveEnv(workflow.jobs.preflight.outputs, { github: { ref_name: releaseTag }, steps });
    return { ...res, jobOutputs };
  }

  /** release job: a separate checkout of the same commit, fed preflight's outputs via `needs`. */
  release(releaseTag: string, sha: string, preflightOutputs: Record<string, string>): StepResult {
    return this.runStep('release', this.checkout(sha), {
      github: { ref_name: releaseTag },
      needs: { preflight: preflightOutputs },
    });
  }
}

describe('正式版发版闸 — preflight 的放行判定', () => {
  it('tag 在 master tip：按原规则放行，不依赖 npm', () => {
    const fx = new Fixture();
    const v1 = fx.land('feat: one');
    fx.tag('v1.0.0', v1);
    const tip = fx.land('feat: two');
    fx.tag('v1.1.0', tip);
    fx.npmLatest = null; // npm 不可用也不影响①

    const res = fx.preflight('v1.1.0', tip);
    expect(res.status, res.output).toBe(0);
    expect(res.jobOutputs).toEqual(expect.objectContaining({ master_sha: tip, ancestry_mode: 'contains-master', baseline_shas: '' }));
    expect(fx.npmCalls()).toEqual([]);
  });

  it('包含 master 的子分支（rebase 到最新 master 后打 tag）：仍放行', () => {
    const fx = new Fixture();
    const tip = fx.land('feat: one');
    const child = fx.branchOff(tip, 'fix: release-only touch');
    fx.tag('v1.0.0', child);

    const res = fx.preflight('v1.0.0', child);
    expect(res.status, res.output).toBe(0);
    expect(res.jobOutputs.ancestry_mode).toBe('contains-master');
    expect(res.jobOutputs.master_sha).toBe(tip);
  });

  it('tag 在 master 旧提交、包含已发布 latest：放行，固定基线，并列出没进这一版的 master 提交', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tagged = fx.land('fix: goes into 1.1.0');
    fx.tag('v1.1.0', tagged);
    const tip = fx.land('feat: merged after the tag (#9001)');

    const res = fx.preflight('v1.1.0', tagged);
    expect(res.status, res.output).toBe(0);
    expect(res.jobOutputs).toEqual(expect.objectContaining({
      master_sha: tip,
      ancestry_mode: 'published-baseline',
      baseline_shas: published,
    }));
    // 没带上的提交要让发版人看得到：它进下一版，不是被悄悄丢掉。
    expect(res.summary).toContain('feat: merged after the tag (#9001)');
    expect(res.summary).not.toContain('fix: goes into 1.1.0');
  });

  it('tag 在比已发布 latest 还旧的 master 提交上：拒绝', () => {
    const fx = new Fixture();
    const old = fx.land('feat: old');
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    fx.land('feat: later');
    fx.tag('v1.1.0', old);

    const res = fx.preflight('v1.1.0', old);
    expect(res.status, res.output).toBe(1);
    expect(res.output).toContain('v1.0.0');
    expect(res.jobOutputs.master_sha).toBe('');
  });

  it.each([
    // 分支从已发布版本拉出，包含 npm latest，但不在 master 上。
    ['包含已发布 latest 的分叉分支', 'published'],
    // v2.47.0 的形状：从更早的 master 拉出、连已发布的 latest 都不含。
    ['不含已发布 latest 的分叉分支（v2.47.0 的形状）', 'old'],
  ])('tag 在不含 master 的%s上：拒绝', (_name, from) => {
    const fx = new Fixture();
    const old = fx.land('feat: old');
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    fx.land('feat: merged to master later');
    const forked = fx.branchOff(from === 'published' ? published : old, 'feat: only on a personal branch');
    fx.tag('v1.1.0', forked);

    const res = fx.preflight('v1.1.0', forked);
    expect(res.status, res.output).toBe(1);
    expect(res.jobOutputs.master_sha).toBe('');
  });

  it('版本号介于 npm latest 与本版之间的正式版 tag（在途或被回滚）也算基线', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const older = fx.land('feat: b');
    const inFlight = fx.land('feat: c');
    const newer = fx.land('feat: d');
    fx.land('feat: e');
    // v1.1.0 已打 tag、还在等签名审批（或已发布又被回滚），npm latest 仍是 1.0.0。
    // 先建 preflight 的 clone 再推这个 tag：守门必须自己去 origin 读最新的 tag。
    const behindDir = fx.checkout(older);
    fx.tag('v1.1.0', inFlight);
    fx.tag('v1.2.0', older);
    const refused = fx.runStep('preflight', behindDir, { github: { ref_name: 'v1.2.0' } });
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain('v1.1.0');

    fx.tag('v1.2.1', newer);
    const admitted = fx.preflight('v1.2.1', newer);
    expect(admitted.status, admitted.output).toBe(0);
    expect(admitted.jobOutputs.ancestry_mode).toBe('published-baseline');
    // 刚才被拒的 v1.2.0 也在 1.0.0 与 1.2.1 之间，同样算进基线：多算只会更严。
    expect(admitted.jobOutputs.baseline_shas.split(' ').sort()).toEqual([published, inFlight, older].sort());
  });

  it('在途正式版打在包含 master 的子分支上：守门从 origin 读到它的 tag，拒绝不含它的旧提交', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const older = fx.land('feat: b');
    const tip = fx.land('feat: c');
    const child = fx.branchOff(tip, 'chore: release-only commit');
    // 本 job checkout 之后才推的在途 tag，而且不在 master 历史上：取 master 时不会顺带取到它。
    const dir = fx.checkout(older);
    fx.tag('v1.1.0', child);
    fx.tag('v1.2.0', older);

    const res = fx.runStep('preflight', dir, { github: { ref_name: 'v1.2.0' } });
    expect(res.status, res.output).toBe(1);
    expect(res.output).toContain('v1.1.0');
  });

  it('admit 在判定时从 origin 读 master：checkout 之后 master 前进，固定的是前进后的 tip', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tagged = fx.land('fix: for 1.1.0');
    fx.tag('v1.1.0', tagged);
    const dir = fx.checkout(tagged);
    const tip = fx.land('feat: merged after the job checked out');

    const res = fx.runStep('preflight', dir, { github: { ref_name: 'v1.1.0' } });
    expect(res.status, res.output).toBe(0);
    expect(res.stepOutputs).toEqual(expect.objectContaining({ master_sha: tip, ancestry_mode: 'published-baseline' }));
  });

  describe('正式版必须按版本号递增的顺序打 tag（两条放行都先过这一关）', () => {
    it('高版本在途时在 master tip 上打低版本热修：拒绝（先批低版本、再批高版本，latest 会缺热修）', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const a = fx.land('feat: for 1.2.0');
      fx.land('feat: merged after the tag');
      fx.tag('v1.2.0', a);
      expect(fx.preflight('v1.2.0', a).status).toBe(0); // 按②放行，在等签名审批
      const hotfix = fx.land('fix: urgent hotfix');
      fx.tag('v1.1.0', hotfix);

      const res = fx.preflight('v1.1.0', hotfix);
      expect(res.status, res.output).toBe(1);
      expect(res.output).toContain('v1.2.0');
      expect(res.jobOutputs.master_sha).toBe('');
    });

    it('npm latest 被回滚后，在旧提交上打比已发布版本低的号：拒绝', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const old = fx.land('feat: b');
      const fixed = fx.land('fix: shipped in 1.2.0');
      fx.tag('v1.2.0', fixed);
      fx.npmLatest = '1.0.0'; // npm-dist-tag 把 latest 回滚到 1.0.0
      fx.tag('v1.1.5', old);

      const res = fx.preflight('v1.1.5', old);
      expect(res.status, res.output).toBe(1);
      expect(res.output).toContain('v1.2.0');
      expect(res.jobOutputs.master_sha).toBe('');
    });

    it.each(['v1.1.0+hotfix', 'v01.1.0', 'v1.1.0.1'])('不是规范 vX.Y.Z 的 tag（%s）即使在 master tip 上也拒绝', (name) => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const tip = fx.land('fix: for the next release');
      fx.tag(name, tip);

      const res = fx.preflight(name, tip);
      expect(res.status, res.output).toBe(1);
      expect(res.jobOutputs.master_sha).toBe('');
    });

    it('仓库里还没有任何正式版 tag 时（首次发版 / 新 fork），不规范的 tag 在 master tip 上也拒绝', () => {
      // 没有任何正式版 tag 可比，拒绝只能来自对本版 tag 本身的检查。
      const fx = new Fixture();
      const tip = fx.land('feat: first release');
      fx.tag('v1.0.0+hotfix', tip);

      const res = fx.preflight('v1.0.0+hotfix', tip);
      expect(res.status, res.output).toBe(1);
      expect(res.jobOutputs.master_sha).toBe('');
    });
  });

  describe('「在 master 上」只认 master 的 first-parent 链', () => {
    it('用 merge commit 合进 master 的分支内部提交：合入前后都拒绝（Re-run 不会翻成放行）', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      // 贡献者分支从已发布版本拉出、包含 v1.0.0；中间的 WIP 提交从来不是 master 的状态。
      const wip = fx.branchOff(published, 'wip: half-done feature');
      fx.land('feat: meanwhile on master');
      fx.tag('v1.1.0', wip);

      const before = fx.preflight('v1.1.0', wip);
      expect(before.status, before.output).toBe(1);

      fx.mergeIntoMaster(wip, 'Merge pull request #9002');
      fx.land('feat: after the merge');
      const after = fx.preflight('v1.1.0', wip);
      expect(after.status, after.output).toBe(1);
      expect(after.jobOutputs.master_sha).toBe('');
    });

    it('master 主线上的 merge commit 本身：放行，release 复核也放行', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const feature = fx.branchOff(published, 'feat: branch work');
      const merge = fx.mergeIntoMaster(feature, 'Merge pull request #9003');
      fx.land('feat: after the merge');
      fx.tag('v1.1.0', merge);

      const admitted = fx.preflight('v1.1.0', merge);
      expect(admitted.status, admitted.output).toBe(0);
      expect(admitted.jobOutputs.ancestry_mode).toBe('published-baseline');
      const verified = fx.release('v1.1.0', merge, admitted.jobOutputs);
      expect(verified.status, verified.output).toBe(0);
    });
  });

  describe('拿不到已发布基线时回到严格规则', () => {
    const cases: Array<[string, string | null]> = [
      ['npm view 失败', null],
      ['npm latest 不是纯 X.Y.Z', '1.0.0-canary.3'],
      ['npm latest 对应的 tag 不存在', '1.0.5'],
      ['npm latest 不比本版旧', '1.1.0'],
    ];

    it.each(cases)('%s：tag 在 master 旧提交上被拒绝', (_name, npmLatest) => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const tagged = fx.land('fix: for 1.1.0');
      fx.tag('v1.1.0', tagged);
      fx.land('feat: merged after the tag');
      fx.npmLatest = npmLatest;

      const res = fx.preflight('v1.1.0', tagged);
      expect(res.status, res.output).toBe(1);
      expect(res.jobOutputs.master_sha).toBe('');
    });

    it.each(cases)('%s：tag 在 master tip 上仍放行', (_name, npmLatest) => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const tip = fx.land('fix: for 1.1.0');
      fx.tag('v1.1.0', tip);
      fx.npmLatest = npmLatest;

      const res = fx.preflight('v1.1.0', tip);
      expect(res.status, res.output).toBe(0);
      expect(res.jobOutputs.ancestry_mode).toBe('contains-master');
    });

    it('npm latest 与本版之间有正式版 tag 解析不到 commit：tag 在 master 旧提交上被拒绝', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const tagged = fx.land('fix: for 1.2.0');
      fx.land('feat: merged after the tag');
      // 指向 tree 而不是 commit 的 tag：基线里该有的一项算不出来。
      fx.git(fx.root, '--git-dir', join(fx.root, 'origin.git'), 'tag', 'v1.1.0', `${published}^{tree}`);
      fx.tag('v1.2.0', tagged);

      const res = fx.preflight('v1.2.0', tagged);
      expect(res.status, res.output).toBe(1);
      expect(res.jobOutputs.master_sha).toBe('');
    });
  });
});

describe('正式版发版闸 — release job 只复核 preflight 固定的事实（issue #1150）', () => {
  it('publishes the platform subpackages BEFORE the main release job', () => {
    // Not a preference — the ordering constraint is what makes the TOCTOU dangerous,
    // and it is load-bearing (optional deps are a silent npm no-op if missing). If a
    // future change inverts this, the pinning below stops being necessary and this
    // test should be revisited rather than deleted.
    expect(workflow.jobs['binary-subpackages']?.needs ?? []).not.toContain('release');
    expect(workflow.jobs.release?.needs ?? []).toContain('binary-subpackages');
  });

  it('两边的守门步骤挂在同一个条件上', () => {
    // 两个 `if:` 一旦分叉，要么正式版在没有固定值时复核（fail-closed，吵但安全），
    // 要么预发版固定了没人读的值（无害）。铉在一起，配对关系才不会惄悄变。
    expect(guardStep('preflight').if).toBe("steps.dist_tag.outputs.tag == 'latest'");
    expect(guardStep('release').if).toBe("steps.dist_tag.outputs.tag == 'latest'");
  });

  it('#1150 回归：tag 在 master tip 放行后 master 前进、npm 不可用，release 仍放行', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    const tip = fx.land('fix: for 1.1.0');
    fx.tag('v1.1.0', tip);
    fx.npmLatest = '1.0.0';

    const admitted = fx.preflight('v1.1.0', tip);
    expect(admitted.status, admitted.output).toBe(0);
    expect(admitted.jobOutputs.master_sha).toBe(tip);

    // 子包已发到 npm 之后：def4275b 那样的提交落到 master，npm 恰好也读不到。
    fx.land('fix: lands mid-release (#1128)');
    fx.npmLatest = null;
    const callsBefore = fx.npmCalls().length;

    const verified = fx.release('v1.1.0', tip, admitted.jobOutputs);
    expect(verified.status, verified.output).toBe(0);
    expect(fx.npmCalls().length).toBe(callsBefore);
    // 对照：此刻重新读 master/npm 做判定会得出相反的结论——这正是 release 不能重读的原因。
    expect(fx.preflight('v1.1.0', tip).status).toBe(1);
  });

  it('tag 在 master 旧提交按基线放行后，master 与 npm latest 都变了，release 仍按固定值放行', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tagged = fx.land('fix: for 1.1.0');
    fx.tag('v1.1.0', tagged);
    fx.land('feat: merged after the tag');

    const admitted = fx.preflight('v1.1.0', tagged);
    expect(admitted.status, admitted.output).toBe(0);
    expect(admitted.jobOutputs.ancestry_mode).toBe('published-baseline');

    // 运行中：master 继续前进；子包刚发完，npm latest 已经读到 1.1.0。
    fx.land('feat: merged mid-release');
    fx.npmLatest = '1.1.0';
    const callsBefore = fx.npmCalls().length;

    const verified = fx.release('v1.1.0', tagged, admitted.jobOutputs);
    expect(verified.status, verified.output).toBe(0);
    expect(fx.npmCalls().length).toBe(callsBefore);
    // 对照：重新推导基线会变成「npm latest 不比本版旧」→ 严格规则 → 拒绝。
    expect(fx.preflight('v1.1.0', tagged).status).toBe(1);
  });

  it.each([
    ['什么都没固定', {}],
    ['只有放行方式、没有 master', { ancestry_mode: 'contains-master' }],
    ['按基线放行但没有基线 commit', { ancestry_mode: 'published-baseline', master_sha: 'MASTER' }],
    ['不认识的放行方式', { ancestry_mode: 'whatever', master_sha: 'MASTER' }],
    ['固定的 master 在 origin 上取不到', { ancestry_mode: 'contains-master', master_sha: 'UNKNOWN' }],
    ['固定的基线在 origin 上取不到', { ancestry_mode: 'published-baseline', master_sha: 'MASTER', baseline_shas: 'UNKNOWN' }],
    // 只有完整 SHA 算固定值；ref 名会在复核时重新解析到它此刻指向的位置。
    ['固定的是 HEAD 而不是 SHA', { ancestry_mode: 'contains-master', master_sha: 'HEAD' }],
    ['固定的是 origin/master 而不是 SHA', { ancestry_mode: 'contains-master', master_sha: 'origin/master' }],
    ['基线里是 ref 名而不是 SHA', { ancestry_mode: 'published-baseline', master_sha: 'MASTER', baseline_shas: 'v1.0.0' }],
  ])('preflight 没固定到完整事实（%s）时 release fail-closed', (_name, pinned: Record<string, string>) => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tip = fx.land('fix: for 1.1.0');
    fx.tag('v1.1.0', tip);
    const placeholder: Record<string, string> = { MASTER: tip, UNKNOWN: 'deadbeef'.repeat(5) };
    const outputs = Object.fromEntries(Object.entries(pinned).map(([k, v]) => [k, placeholder[v] ?? v]));

    const res = fx.release('v1.1.0', tip, outputs);
    expect(res.status, res.output).toBe(1);
  });

  it('release 真的在复核：固定值不成立时拒绝，而不是照抄 preflight 的结论', () => {
    const fx = new Fixture();
    const old = fx.land('feat: old');
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    const later = fx.land('feat: later');

    const refusals: Array<[string, string, Record<string, string>]> = [
      ['tag 不含固定的 master', old, { ancestry_mode: 'contains-master', master_sha: later }],
      ['tag 不含固定的基线', old, { ancestry_mode: 'published-baseline', master_sha: later, baseline_shas: published }],
      ['tag 不在固定的 master 上', later, { ancestry_mode: 'published-baseline', master_sha: published, baseline_shas: old }],
    ];
    // 是 master 的祖先、但不在它的 first-parent 链上（merge 进来的分支提交）。
    const side = fx.branchOff(published, 'feat: branch work');
    const merge = fx.mergeIntoMaster(side, 'Merge pull request #9004');
    refusals.push(['tag 只是固定 master 的祖先、不在其 first-parent 链上', side, { ancestry_mode: 'published-baseline', master_sha: merge, baseline_shas: published }]);
    for (const [name, head, outputs] of refusals) {
      const res = fx.release('v1.1.0', head, outputs);
      expect(res.status, `${name}\n${res.output}`).toBe(1);
    }
    // 同一个仓库里成立的固定值照样放行，说明上面拒的是事实不成立，不是别的原因。
    const ok = fx.release('v1.1.0', published, { ancestry_mode: 'published-baseline', master_sha: later, baseline_shas: old });
    expect(ok.status, ok.output).toBe(0);
  });
});
