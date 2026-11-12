import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';

/**
 * 正式版（npm latest）发版闸：preflight 在打 tag 后立刻判一次；publish-gate 在签名审批之后、任何
 * 包发布之前再判一次并固定结论；release job 只复核 publish-gate 固定下来的事实。
 * 规则与理由见 release.yml 里 preflight 的「Guard — stable release must come from master」。
 *
 * 这里不钉 YAML 的写法：每个用例都搭一个真实的 git 仓库（裸仓库当 origin）和一个假 npm，
 * 照 release.yml 里写的 `run` / `env` 执行各 job 的守门步骤，并按 YAML 里的 `outputs` /
 * `needs.publish-gate.outputs.*` 把 publish-gate 的输出接到 release。每个 job 各自 clone 一份，
 * 对应 CI 里不同 runner 各自 checkout。
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
 * The published baseline the guard now also reads (npm `latest`, npm's version list,
 * release tags) is just as mobile as master, so the release side must re-check only
 * what publish-gate pinned — the #1150 cases below run the release step after master,
 * npm and the tags have all moved, with npm unreachable.
 */

const ROOT = resolve(import.meta.dirname, '..');
const GUARD_SCRIPT = '.github/scripts/release-master-guard.mjs';
const GUARD_NAME = 'Guard — stable release must come from master';

interface WorkflowStep {
  uses?: string;
  with?: Record<string, unknown>;
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}
interface WorkflowJob {
  needs?: string[];
  if?: string;
  env?: Record<string, string>;
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
  /** publish-gate's job outputs, resolved through the YAML's `outputs:` map. */
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
  /**
   * What `npm view botmux versions --json` lists. null = just npm latest (or a failing
   * call when npmLatest is null too); 'fail' = the call fails.
   */
  npmPublished: string[] | 'fail' | null = null;
  /**
   * When set, guard steps run with a `git` shim that prints this instead of a number for
   * `rev-list --first-parent --count` (everything else goes to the real git).
   */
  firstParentCountOverride: string | null = null;
  /** `<name>` entries the fake npm reports as published for `npm view <name>@<version> version`. */
  subpackagesOnNpm: string[] = [];
  /** A subpackage whose `npm view <name>@<version> version` exits 0 but prints something else. */
  subpackagesOddOutput: string | null = null;
  /** When true, `npm view <subpackage>@<version>` fails with a network error. */
  subpackagesNpmDown: boolean | string[] = false;

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
      'if [ "$1 $2 $3 $4" = "view botmux versions --json" ] && [ -n "$FAKE_NPM_VERSIONS" ]; then',
      '  printf \'%s\\n\' "$FAKE_NPM_VERSIONS"; exit 0',
      'fi',
      // Subpackages: `npm view botmux-<plat>@<v> version` prints <v> when published, else E404.
      'if [ "$1" = view ] && [ "$3" = version ]; then',
      '  case "$2" in botmux-*@*)',
      '    pkg="${2%@*}"; ver="${2##*@}"',
      '    case " $FAKE_NPM_SUBPKG_DOWN " in *" ALL "*|*" $pkg "*) echo "npm error code ETIMEDOUT" >&2; exit 1;; esac',
      '    [ "$pkg" = "$FAKE_NPM_SUBPKG_ODD" ] && { printf "%s\\n" "0.0.0-unrelated"; exit 0; }',
      '    case " $FAKE_NPM_SUBPKGS " in *" $pkg "*) printf "%s\\n" "$ver"; exit 0;; esac',
      '    echo "npm error code E404" >&2; exit 1;;',
      '  esac',
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
      FAKE_NPM_VERSIONS: this.npmVersionsJson(),
      FAKE_NPM_SUBPKGS: this.subpackagesOnNpm.join(' '),
      FAKE_NPM_SUBPKG_ODD: this.subpackagesOddOutput ?? '',
      FAKE_NPM_SUBPKG_DOWN: this.subpackagesNpmDown === true ? 'ALL' : (this.subpackagesNpmDown || []).join(' '),
      ...extra,
    };
  }

  /** Raw text `npm view botmux versions --json` prints, overriding npmPublished. */
  npmVersionsOverride: string | null = null;

  private npmVersionsJson(): string {
    if (this.npmVersionsOverride !== null) return this.npmVersionsOverride;
    if (this.npmPublished === 'fail') return '';
    if (this.npmPublished) return JSON.stringify(this.npmPublished, null, 2);
    return this.npmLatest ? JSON.stringify([this.npmLatest], null, 2) : '';
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

  /** Delete a tag on origin (what someone holding the tag-ruleset bypass can do). */
  deleteTag(name: string): void {
    this.git(this.dev, 'push', '-q', 'origin', `:refs/tags/${name}`);
    this.git(this.dev, 'tag', '-d', name);
  }

  /** A fresh full clone detached at `sha` — what actions/checkout with fetch-depth: 0 gives a job. */
  checkout(sha: string): string {
    const dir = join(this.root, `job-${++this.seq}`);
    this.git(this.root, 'clone', '-q', this.origin, dir);
    this.git(dir, 'checkout', '-q', '--detach', sha);
    return dir;
  }

  /**
   * What `job`'s own actions/checkout step gives it for tag `tag`: a full clone with
   * `fetch-depth: 0`, otherwise the depth-1 tag fetch CI runs by default (copied from a real
   * release log: `fetch --no-tags --prune --depth=1 origin +refs/tags/<t>:refs/tags/<t>`).
   */
  jobCheckout(job: string, tag: string): string {
    const checkoutStep = (workflow.jobs[job]?.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    if (!checkoutStep) throw new Error(`job ${job} has no checkout step`);
    if (String(checkoutStep.with?.['fetch-depth'] ?? '1') === '0') {
      return this.checkout(this.git(this.root, '--git-dir', this.origin, 'rev-parse', `refs/tags/${tag}^{commit}`));
    }
    const dir = join(this.root, `job-${++this.seq}`);
    mkdirSync(dir);
    this.git(dir, 'init', '-q');
    this.git(dir, 'remote', 'add', 'origin', this.origin);
    this.git(dir, 'fetch', '-q', '--no-tags', '--prune', '--depth=1', 'origin', `+refs/tags/${tag}:refs/tags/${tag}`);
    this.git(dir, 'checkout', '-q', '--force', `refs/tags/${tag}`);
    return dir;
  }

  private gitShim(countOutput: string): string {
    const dir = join(this.root, 'git-shim');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout.trim();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'git'), [
      '#!/bin/sh',
      'fp=; c=',
      'for a in "$@"; do [ "$a" = "--first-parent" ] && fp=1; [ "$a" = "--count" ] && c=1; done',
      `if [ "$1" = rev-list ] && [ -n "$fp" ] && [ -n "$c" ]; then printf '%s\\n' '${countOutput}'; exit 0; fi`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));
    chmodSync(join(dir, 'git'), 0o755);
    return dir;
  }

  private tagCheckout(job: string, tag: string, sha: string): string {
    const tagged = spawnSync('git', ['--git-dir', this.origin, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
      env: this.env(), encoding: 'utf-8',
    }).stdout.trim();
    if (tagged === sha) return this.jobCheckout(job, tag);
    return this.checkout(sha);
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
    const shim = this.firstParentCountOverride === null ? {} : { PATH: `${this.gitShim(this.firstParentCountOverride)}:${this.env().PATH}` };
    // GitHub runs `run:` as `bash --noprofile --norc -eo pipefail {0}`.
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run!], {
      cwd,
      env: this.env({
        ...resolveEnv(workflow.jobs[job]?.env, ctx),
        ...resolveEnv(step.env, ctx),
        GITHUB_OUTPUT: outFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        ...shim,
      }),
      encoding: 'utf-8',
    });
    const stepOutputs = Object.fromEntries(readFileSync(outFile, 'utf-8').split('\n').filter(Boolean).map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }));
    return { status: r.status, output: `${r.stdout}${r.stderr}`, summary: readFileSync(summaryFile, 'utf-8'), stepOutputs };
  }

  /** preflight job alone: its own checkout of the tagged commit, the guard step, its job outputs. */
  preflight(releaseTag: string, sha: string): Admission {
    const step = guardStep('preflight');
    const res = this.runStep('preflight', this.tagCheckout('preflight', releaseTag, sha), { github: { ref_name: releaseTag } });
    const jobOutputs = resolveEnv(workflow.jobs.preflight.outputs, {
      github: { ref_name: releaseTag },
      steps: { [step.id!]: res.stepOutputs, dist_tag: { tag: 'latest', prerelease: 'false' } },
    });
    return { ...res, jobOutputs };
  }

  /**
   * publish-gate job (after signing approval, before any publish): its own checkout, the
   * guard step, and the job outputs `release` will read, resolved through the YAML.
   */
  gate(releaseTag: string, sha: string, preflightOutputs: Record<string, string> = {}): Admission {
    const step = guardStep('publish-gate');
    const res = this.runStep('publish-gate', this.tagCheckout('publish-gate', releaseTag, sha), {
      github: { ref_name: releaseTag },
      needs: { preflight: { tag: 'latest', ...preflightOutputs } },
    });
    const jobOutputs = resolveEnv(workflow.jobs['publish-gate'].outputs, {
      github: { ref_name: releaseTag },
      steps: { [step.id!]: res.stepOutputs },
    });
    return { ...res, jobOutputs };
  }

  /**
   * Both admissions on the same facts — preflight right after the push and publish-gate
   * right after approval, with nothing changed in between. They run the same rule, so
   * they must agree; the gate's result is the one `release` is held to.
   */
  admit(releaseTag: string, sha: string): Admission {
    const early = this.preflight(releaseTag, sha);
    const binding = this.gate(releaseTag, sha, early.jobOutputs);
    expect(binding.status, `preflight and publish-gate disagree\n--- preflight\n${early.output}\n--- publish-gate\n${binding.output}`)
      .toBe(early.status);
    return binding;
  }

  /**
   * binary-subpackages' guard step, right before its first publish: its own checkout, fed
   * preflight's outputs. `onNpm` = subpackages of this version already published.
   */
  subpackagesGuard(releaseTag: string, sha: string, preflightOutputs: Record<string, string>, onNpm: string[] = []): StepResult {
    this.subpackagesOnNpm = onNpm;
    return this.runStep('binary-subpackages', this.tagCheckout('binary-subpackages', releaseTag, sha), {
      github: { ref_name: releaseTag },
      needs: { preflight: { tag: 'latest', ...preflightOutputs } },
    });
  }

  /** release job: a separate checkout of the same commit, fed publish-gate's outputs via `needs`. */
  release(releaseTag: string, sha: string, gateOutputs: Record<string, string>): StepResult {
    return this.runStep('release', this.tagCheckout('release', releaseTag, sha), {
      github: { ref_name: releaseTag },
      needs: { 'publish-gate': gateOutputs },
    });
  }
}

describe('正式版发版闸 — 放行判定（preflight 与 publish-gate 跑同一套）', () => {
  it('tag 在 master tip：按原规则放行，不依赖 npm', () => {
    const fx = new Fixture();
    const v1 = fx.land('feat: one');
    fx.tag('v1.0.0', v1);
    const tip = fx.land('feat: two');
    fx.tag('v1.1.0', tip);
    fx.npmLatest = null; // npm 不可用也不影响①

    const res = fx.admit('v1.1.0', tip);
    expect(res.status, res.output).toBe(0);
    expect(res.jobOutputs).toEqual(expect.objectContaining({ master_sha: tip, ancestry_mode: 'contains-master', baseline_shas: '' }));
    expect(fx.npmCalls()).toEqual([]);
  });

  it('包含 master 的子分支（rebase 到最新 master 后打 tag）：仍放行', () => {
    const fx = new Fixture();
    const tip = fx.land('feat: one');
    const child = fx.branchOff(tip, 'fix: release-only touch');
    fx.tag('v1.0.0', child);

    const res = fx.admit('v1.0.0', child);
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

    const res = fx.admit('v1.1.0', tagged);
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

    const res = fx.admit('v1.1.0', old);
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

    const res = fx.admit('v1.1.0', forked);
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
    // 先建 job 的 clone 再推这个 tag：守门必须自己去 origin 读最新的 tag。
    const behindDir = fx.checkout(older);
    fx.tag('v1.1.0', inFlight);
    fx.tag('v1.2.0', older);
    const refused = fx.runStep('publish-gate', behindDir, { github: { ref_name: 'v1.2.0' } });
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain('v1.1.0');

    fx.tag('v1.2.1', newer);
    const admitted = fx.admit('v1.2.1', newer);
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

    const res = fx.runStep('publish-gate', dir, { github: { ref_name: 'v1.2.0' } });
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

    const res = fx.runStep('publish-gate', dir, { github: { ref_name: 'v1.1.0' } });
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

      const res = fx.admit('v1.1.0', hotfix);
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
      fx.npmPublished = ['1.0.0', '1.2.0'];
      fx.tag('v1.1.5', old);

      const res = fx.admit('v1.1.5', old);
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

      const res = fx.admit(name, tip);
      expect(res.status, res.output).toBe(1);
      expect(res.jobOutputs.master_sha).toBe('');
    });

    it('仓库里还没有任何正式版 tag 时（首次发版 / 新 fork），不规范的 tag 在 master tip 上也拒绝', () => {
      // 没有任何正式版 tag 可比，拒绝只能来自对本版 tag 本身的检查。
      const fx = new Fixture();
      const tip = fx.land('feat: first release');
      fx.tag('v1.0.0+hotfix', tip);

      const res = fx.admit('v1.0.0+hotfix', tip);
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

      const before = fx.admit('v1.1.0', wip);
      expect(before.status, before.output).toBe(1);

      fx.mergeIntoMaster(wip, 'Merge pull request #9002');
      fx.land('feat: after the merge');
      const after = fx.admit('v1.1.0', wip);
      expect(after.status, after.output).toBe(1);
      expect(after.jobOutputs.master_sha).toBe('');
    });

    it('first-parent 计数不是数字时拒绝，而不是把它当成 revision 拼进去', () => {
      // 拼成 tip~1^2 恰好指向 merge 进来的分支提交；不校验的话它会被当成 first-parent 链上的提交。
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const side = fx.branchOff(published, 'wip: branch commit');
      fx.mergeIntoMaster(side, 'Merge pull request #9005');
      fx.land('feat: tip');
      fx.tag('v1.1.0', side);
      fx.firstParentCountOverride = '1^2';

      const res = fx.admit('v1.1.0', side);
      expect(res.status, res.output).toBe(1);
      expect(res.jobOutputs.master_sha).toBe('');
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

      const admitted = fx.admit('v1.1.0', merge);
      expect(admitted.status, admitted.output).toBe(0);
      expect(admitted.jobOutputs.ancestry_mode).toBe('published-baseline');
      const verified = fx.release('v1.1.0', merge, admitted.jobOutputs);
      expect(verified.status, verified.output).toBe(0);
    });
  });

  describe('npm 已发布版本列表：tag 被删、latest 被回滚也看得见', () => {
    // v1.2.0（含修复 A）已发布；有绕过权限的人删了 v1.2.0 这个 tag，又把 latest 回滚到 1.0.0。
    // latest 和 tag 都看不出用户拿到过 1.2.0，只有 npm 的版本列表还记着。
    function rolledBackWithDeletedTag() {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const old = fx.land('feat: b');
      const fixA = fx.land('fix: A, shipped in 1.2.0');
      fx.tag('v1.2.0', fixA);
      fx.deleteTag('v1.2.0');
      const tip = fx.land('feat: later');
      fx.npmLatest = '1.0.0';
      fx.npmPublished = ['1.0.0', '1.2.0'];
      return { fx, old, fixA, tip };
    }

    it('在旧提交上打比已发布版本低的号：拒绝', () => {
      const { fx, old } = rolledBackWithDeletedTag();
      fx.tag('v1.1.5', old);
      const res = fx.admit('v1.1.5', old);
      expect(res.status, res.output).toBe(1);
      expect(res.output).toContain('1.2.0');
      expect(res.jobOutputs.master_sha).toBe('');
    });

    it('在旧提交上打更高的号、但不含已发布的 1.2.0：拒绝（它的 tag 没了，基线建不起来）', () => {
      const { fx, old } = rolledBackWithDeletedTag();
      fx.tag('v1.3.0', old);
      const res = fx.admit('v1.3.0', old);
      expect(res.status, res.output).toBe(1);
      expect(res.output).toContain('v1.2.0');
      expect(res.jobOutputs.master_sha).toBe('');
    });

    it('在 master tip 上打更高的号：按①放行（tip 包含所有从 master 发出去的版本）', () => {
      const { fx, tip, fixA } = rolledBackWithDeletedTag();
      fx.tag('v1.3.0', tip);
      const res = fx.admit('v1.3.0', tip);
      expect(res.status, res.output).toBe(0);
      expect(res.jobOutputs.ancestry_mode).toBe('contains-master');
      expect(fx.git(fx.root, '--git-dir', join(fx.root, 'origin.git'), 'merge-base', '--is-ancestor', fixA, tip)).toBe('');
    });

    it('低于 npm latest 的已发布版本不进基线（它们未必还有 tag）', () => {
      // 真实仓库里 npm 上有大量早期版本，很多没有对应 tag；把它们算进来会拒掉所有 ② 发版。
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const tagged = fx.land('fix: for 1.1.0');
      fx.land('feat: later');
      fx.npmLatest = '1.0.0';
      fx.npmPublished = ['0.8.0', '0.9.0', '0.9.1', '1.0.0'];
      fx.tag('v1.1.0', tagged);
      const res = fx.admit('v1.1.0', tagged);
      expect(res.status, res.output).toBe(0);
      expect(res.jobOutputs.baseline_shas).toBe(published);
    });

    it('npm 只有一个版本时打印的是裸字符串，照样识别', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const tagged = fx.land('fix: for 1.1.0');
      fx.land('feat: later');
      fx.npmLatest = '1.0.0';
      fx.npmPublished = null;
      fx.tag('v1.1.0', tagged);
      fx.npmVersionsOverride = '"1.0.0"';
      const res = fx.admit('v1.1.0', tagged);
      expect(res.status, res.output).toBe(0);
      fx.npmVersionsOverride = '"1.2.0"';
      expect(fx.admit('v1.1.0', tagged).status).toBe(1);
    });

    it('已发布版本的 tag 都在时，介于 latest 与本版之间的已发布版本算进基线', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const fixA = fx.land('fix: A, shipped in 1.2.0');
      fx.tag('v1.2.0', fixA);
      const tagged = fx.land('feat: for 1.3.0');
      fx.land('feat: later');
      fx.npmLatest = '1.0.0'; // 回滚过
      fx.npmPublished = ['1.0.0', '1.2.0'];
      fx.tag('v1.3.0', tagged);

      const res = fx.admit('v1.3.0', tagged);
      expect(res.status, res.output).toBe(0);
      expect(res.jobOutputs.baseline_shas.split(' ').sort()).toEqual([published, fixA].sort());
    });
  });

  describe('拿不到已发布基线时回到严格规则', () => {
    const cases: Array<[string, string | null, Fixture['npmPublished']]> = [
      ['npm view 失败', null, null],
      ['npm latest 不是纯 X.Y.Z', '1.0.0-canary.3', null],
      ['npm latest 对应的 tag 不存在', '1.0.5', null],
      ['npm latest 不比本版旧', '1.1.0', null],
      ['npm 版本列表读不到', '1.0.0', 'fail'],
    ];

    it.each(cases)('%s：tag 在 master 旧提交上被拒绝', (_name, npmLatest, npmPublished) => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const tagged = fx.land('fix: for 1.1.0');
      fx.tag('v1.1.0', tagged);
      fx.land('feat: merged after the tag');
      fx.npmLatest = npmLatest;
      fx.npmPublished = npmPublished;

      const res = fx.admit('v1.1.0', tagged);
      expect(res.status, res.output).toBe(1);
      expect(res.jobOutputs.master_sha).toBe('');
    });

    it.each(cases)('%s：tag 在 master tip 上仍放行', (_name, npmLatest, npmPublished) => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      const tip = fx.land('fix: for 1.1.0');
      fx.tag('v1.1.0', tip);
      fx.npmLatest = npmLatest;
      fx.npmPublished = npmPublished;

      const res = fx.admit('v1.1.0', tip);
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

      const res = fx.admit('v1.2.0', tagged);
      expect(res.status, res.output).toBe(1);
      expect(res.jobOutputs.master_sha).toBe('');
    });
  });
});

describe('正式版发版闸 — release job 只复核 publish-gate 固定的事实（issue #1150）', () => {
  it('publishes the platform subpackages BEFORE the main release job', () => {
    // Not a preference — the ordering constraint is what makes the TOCTOU dangerous,
    // and it is load-bearing (optional deps are a silent npm no-op if missing). If a
    // future change inverts this, the pinning below stops being necessary and this
    // test should be revisited rather than deleted.
    expect(workflow.jobs['binary-subpackages']?.needs ?? []).not.toContain('release');
    expect(workflow.jobs.release?.needs ?? []).toContain('binary-subpackages');
  });

  it('publish-gate 是第一个发包 job 之前的最后一道：发包 job 的每个前置 job 都在它之前', () => {
    // 否则「Re-run failed jobs」在那个前置 job 失败后只重跑它和它的下游，publish-gate 不重跑，发包沿用
    // 几天前的判定。从 needs 图算，不铉具体名字。
    const ancestors = (job: string, seen = new Set<string>()): Set<string> => {
      for (const need of workflow.jobs[job]?.needs ?? []) {
        if (!seen.has(need)) { seen.add(need); ancestors(need, seen); }
      }
      return seen;
    };
    const gate = ancestors('publish-gate');
    for (const publisher of ['binary-subpackages', 'release']) {
      const upstream = ancestors(publisher);
      expect(upstream.has('publish-gate'), publisher).toBe(true);
      const notBeforeGate = [...upstream].filter((job) => job !== 'publish-gate' && !gate.has(job) && !ancestors(job).has('publish-gate'));
      expect(notBeforeGate, `${publisher}: prerequisites that do not run before publish-gate`).toEqual([]);
    }
  });

  it('用 always()/!cancelled() 跳出隐式检查的 job，逐个重申每个前置 job 的 result', () => {
    // 漏掉一个，那个前置 job 失败后本 job 照样会跑——对发包 job 来说就是在失败之后发包。
    const optedOut = Object.entries(workflow.jobs)
      .filter(([, job]) => /\b(always|cancelled)\(\)/.test(String(job.if ?? '')));
    expect(optedOut.length).toBeGreaterThan(0);
    for (const [name, job] of optedOut) {
      for (const need of job.needs ?? []) {
        expect(String(job.if), `${name}.if must check needs.${need}.result`).toContain(`needs.${need}.result`);
      }
    }
  });

  it('没有状态函数的隐式 success() 不会把正常发版连带跳过', () => {
    // 隐式 success() 在任一传递前置 job 被跳过时不成立。预发版会跳过签名 job；它下游的 job
    // 若没有 always()/!cancelled() 等状态函数，就会在子包发出去之后被跳过。
    const statusFn = /\b(always|cancelled|failure|success)\(\)/;
    const downstream = (from: string): string[] => Object.entries(workflow.jobs)
      .filter(([, job]) => (job.needs ?? []).includes(from))
      .flatMap(([name]) => [name, ...downstream(name)]);
    const implicit = [...new Set(downstream('sign-darwin-binaries'))]
      .filter((name) => !statusFn.test(String(workflow.jobs[name]?.if ?? '')));
    expect(implicit).toEqual([]);
  });

  it('publish-gate 在签名审批之后、第一个包发布之前；它没过，什么都不发', () => {
    // 顺序和门控是这次重判有效的前提：放在审批前就等于没重判；放在子包发布之后就回到 #1150。
    // binary-subpackages 用 !cancelled() 放过「预发版跳过签名」，所以必须显式要求 gate 成功，
    // 否则 gate 拒绝后它照样会发子包。
    const jobs = workflow.jobs;
    expect(jobs['publish-gate']?.needs ?? []).toContain('sign-darwin-binaries');
    expect(jobs['publish-gate']?.if ?? '').toContain("needs.sign-darwin-binaries.result == 'success'");
    expect(jobs['sign-darwin-binaries']?.needs ?? []).not.toContain('publish-gate');
    expect(jobs['binary-subpackages']?.needs ?? []).toContain('publish-gate');
    expect(jobs['binary-subpackages']?.if ?? '').toContain("needs.publish-gate.result == 'success'");
    expect(jobs.release?.needs ?? []).toContain('publish-gate');
    // 发布路径上只有这两个 job 执行 npm publish，都在 gate 之后。
    const publishers = Object.entries(jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) => /publish-npm-if-missing.mjs/.test(step.run ?? '')))
      .map(([name]) => name)
      .sort();
    expect(publishers).toEqual(['binary-subpackages', 'release']);
  });

  it('四处守门步骤都在正式版上跑（预发版不跑）', () => {
    // 一旦分叉，要么正式版在没有固定值时复核（fail-closed，吵但安全），要么正式版悄悄漏掉一次判定。
    expect(guardStep('preflight').if).toBe("steps.dist_tag.outputs.tag == 'latest'");
    expect(guardStep('publish-gate').if).toBe("needs.preflight.outputs.tag == 'latest'");
    expect(guardStep('binary-subpackages').if).toBe("needs.preflight.outputs.tag == 'latest'");
    expect(guardStep('release').if).toBe("steps.dist_tag.outputs.tag == 'latest'");
  });

  it('publish-gate 及其下游的 job 都以 !cancelled() 开头：Cancel 拦得住，预发版也不会被连带跳过', () => {
    // GitHub 在 Cancel 时重算 if，仍为 true 的 job 继续跑：always() 和 !failure() 在取消后都是 true，
    // 会照样发包；只写 success()（或不写）又会在预发版跳过签名 job 时把发包连带跳过。
    // 唯一同时满足两边的写法是 !cancelled() 打头。
    const downstream = (from: string): string[] => Object.entries(workflow.jobs)
      .filter(([, job]) => (job.needs ?? []).includes(from))
      .flatMap(([name]) => [name, ...downstream(name)]);
    const jobs = [...new Set(['publish-gate', ...downstream('publish-gate')])];
    expect(jobs).toEqual(expect.arrayContaining(['binary-subpackages', 'release', 'attach-bun-binaries', 'publish-github-release']));
    for (const name of jobs) {
      const cond = String(workflow.jobs[name]?.if ?? '').replace(/^\s*\$\{\{\s*/, '').replace(/\s*\}\}\s*$/, '').trim();
      expect(cond, name).toMatch(/^!cancelled\(\)\s*&&/);
      expect(cond, name).not.toMatch(/\b(always|failure)\(\)|(?<!!cancelled\(\)[\s\S]*)\bsuccess\(\)/);
    }
  });

  it('binary-subpackages 的守门步骤在第一个发包步骤之前，发包循环只用同一份平台列表', () => {
    const steps = workflow.jobs['binary-subpackages']?.steps ?? [];
    const guardAt = steps.findIndex((s) => s.name === GUARD_NAME);
    const firstPublish = steps.findIndex((s) => /publish-npm-if-missing\.mjs/.test(s.run ?? ''));
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(firstPublish).toBeGreaterThan(guardAt);
    // 守门按 SUBPACKAGE_PLATFORMS 查「有没有已发布」；发包循环若另写一份列表，两边会漂移。
    const platforms = String(workflow.jobs['binary-subpackages']?.env?.SUBPACKAGE_PLATFORMS ?? '').split(/\s+/).filter(Boolean);
    expect(platforms.length).toBeGreaterThan(0);
    for (const step of steps.filter((s) => /publish-npm-if-missing\.mjs/.test(s.run ?? ''))) {
      expect(step.run).toContain('$SUBPACKAGE_PLATFORMS');
      for (const plat of platforms) expect(step.run, plat).not.toMatch(new RegExp(`\\b${plat.replace(/[-]/g, '\\-')}\\b`));
    }
  });

  it('签名审批期间删掉高版本 tag、发了低版本热修、再在同一提交重建：批准旧运行后 publish-gate 拒绝', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const a = fx.land('feat: for 1.2.0');
    fx.tag('v1.2.0', a);
    const hotfix = fx.land('fix: urgent hotfix');
    // run#1：v1.2.0 的 preflight 按②放行，之后停在签名审批上。
    const run1Preflight = fx.preflight('v1.2.0', a);
    expect(run1Preflight.status, run1Preflight.output).toBe(0);

    // 热修 v1.1.0 先被「已有更高版本 tag」拦下；删掉 v1.2.0（run#1 没取消）后 v1.1.0 发布。
    fx.tag('v1.1.0', hotfix);
    expect(fx.admit('v1.1.0', hotfix).status).toBe(1);
    fx.deleteTag('v1.2.0');
    const hotfixRun = fx.admit('v1.1.0', hotfix);
    expect(hotfixRun.status, hotfixRun.output).toBe(0);
    expect(fx.release('v1.1.0', hotfix, hotfixRun.jobOutputs).status).toBe(0);
    fx.npmLatest = '1.1.0';
    fx.npmPublished = ['1.0.0', '1.1.0'];

    // 在同一提交 A 上重建 v1.2.0，然后批准 run#1：它的 publish-gate 按此刻的事实重判。
    fx.tag('v1.2.0', a);
    const run1Gate = fx.gate('v1.2.0', a);
    expect(run1Gate.status, run1Gate.output).toBe(1);
    expect(run1Gate.output).toContain('v1.1.0');
    expect(run1Gate.jobOutputs.master_sha).toBe('');
    // 对照：只用 preflight 当时的判定，这次会把不含热修的 1.2.0 发出去——这就是要审批后重判的原因。
    expect(fx.release('v1.2.0', a, run1Preflight.stepOutputs).status).toBe(0);
  });

  it('preflight 的 master 不是完整 SHA 时不给锚点（ref 名会解析到它此刻指向的位置）', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tip = fx.land('fix: for 1.1.0');
    const child = fx.branchOff(tip, 'chore: release-only commit');
    fx.tag('v1.1.0', child);
    fx.land('feat: merged while waiting for approval');
    fx.tag('anchor-ref', tip);
    expect(fx.gate('v1.1.0', child, { ancestry_mode: 'contains-master', master_sha: 'anchor-ref' }).status).toBe(1);
    expect(fx.gate('v1.1.0', child, { ancestry_mode: 'contains-master', master_sha: tip }).status).toBe(0);
  });

  it('锚点必须在 master 的 first-parent 链上：merge 进来的分支提交不算', () => {
    // 基线和先决条件都成立，只有锚点这一条能拒。
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const merged = fx.branchOff(published, 'feat: merged branch work');
    fx.mergeIntoMaster(merged, 'Merge pull request #9006');
    fx.land('feat: later');
    const onMerged = fx.branchOff(merged, 'chore: tag on top of a merged branch commit');
    fx.tag('v1.1.0', onMerged);
    const res = fx.gate('v1.1.0', onMerged, { ancestry_mode: 'contains-master', master_sha: merged });
    expect(res.status, res.output).toBe(1);
    expect(res.jobOutputs.master_sha).toBe('');
  });

  it('守门在浅克隆里直接拒绝并说明原因，而不是拿不全的祖先关系给出误导的理由', () => {
    // 默认的 actions/checkout 只拉 tag 那一个提交：「包含」全都判成否，不在 tip 上的 tag 一律被拒。
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tagged = fx.land('fix: for 1.1.0');
    fx.tag('v1.1.0', tagged);
    fx.land('feat: merged after the tag');
    const dir = join(fx.root, 'shallow-job');
    mkdirSync(dir);
    fx.git(dir, 'init', '-q');
    fx.git(dir, 'remote', 'add', 'origin', join(fx.root, 'origin.git'));
    fx.git(dir, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', '+refs/tags/v1.1.0:refs/tags/v1.1.0');
    fx.git(dir, 'checkout', '-q', '--force', 'refs/tags/v1.1.0');
    expect(fx.git(dir, 'rev-parse', '--is-shallow-repository')).toBe('true');
    for (const job of ['publish-gate', 'release'] as const) {
      const res = fx.runStep(job, dir, {
        github: { ref_name: 'v1.1.0' },
        needs: { preflight: { tag: 'latest' }, 'publish-gate': { ancestry_mode: 'contains-master', master_sha: tagged } },
      });
      expect(res.status, res.output).toBe(1);
      expect(res.output, job).toContain('shallow');
    }
  });

  it('打在包含 master 的子分支上的 tag：审批期间 master 前进，仍按 preflight 当时的 tip 放行，release 复核也放行', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tip = fx.land('fix: for 1.1.0');
    const child = fx.branchOff(tip, 'chore: release-only commit');
    fx.tag('v1.1.0', child);
    const early = fx.preflight('v1.1.0', child);
    expect(early.jobOutputs).toEqual(expect.objectContaining({ ancestry_mode: 'contains-master', master_sha: tip }));

    fx.land('feat: merged while waiting for approval');
    const binding = fx.gate('v1.1.0', child, early.jobOutputs);
    expect(binding.status, binding.output).toBe(0);
    expect(binding.jobOutputs).toEqual(expect.objectContaining({ ancestry_mode: 'published-baseline', anchor_sha: tip }));
    expect(fx.release('v1.1.0', child, binding.jobOutputs).status).toBe(0);
    // 没有 preflight 的固定值就没有锚点：同一个子分支 tag 被拒。
    expect(fx.gate('v1.1.0', child).status).toBe(1);
  });

  it('子分支锚点不能帮不含已发布基线的 tag 过关，也不能拿别的提交当锚点', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    const tip = fx.land('feat: b');
    const child = fx.branchOff(tip, 'chore: release-only commit');
    fx.tag('v1.2.0', child);
    fx.npmLatest = '1.0.0';
    const early = fx.preflight('v1.2.0', child);
    expect(early.status, early.output).toBe(0);
    // 审批期间发了 1.1.0（tag 在更新的 master 提交上）：子分支不含它，拒绝。
    const hotfix = fx.land('fix: hotfix');
    fx.deleteTag('v1.2.0');
    fx.tag('v1.1.0', hotfix);
    fx.npmLatest = '1.1.0';
    fx.npmPublished = ['1.0.0', '1.1.0'];
    fx.tag('v1.2.0', child);
    const refused = fx.gate('v1.2.0', child, early.jobOutputs);
    expect(refused.status, refused.output).toBe(1);
    // 假造的锚点：preflight 的 master 换成不是本 tag 祖先的 master 提交，不算。
    const forged = fx.gate('v1.2.0', child, { ancestry_mode: 'contains-master', master_sha: hotfix });
    expect(forged.status, forged.output).toBe(1);
  });

  it('锚点只给 preflight 按①放行、且是本 tag 祖先的 master 提交；release 复核时也要求锚点是本 tag 的祖先', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    // 从已发布版本拉出的个人分支：包含基线，但从没包含过 master 的 tip。
    const side = fx.branchOff(published, 'feat: personal branch');
    const tip = fx.land('feat: tip');
    fx.land('feat: later');
    fx.tag('v1.1.0', side);
    // preflight 不是按①放行的，就不给锚点。
    expect(fx.gate('v1.1.0', side, { ancestry_mode: 'published-baseline', master_sha: published }).status).toBe(1);
    // 所谓「锚点」不是本 tag 的祖先，也不给。
    expect(fx.gate('v1.1.0', side, { ancestry_mode: 'contains-master', master_sha: tip }).status).toBe(1);
    // release 复核：固定的锚点不是本 tag 的祖先，拒绝。
    const res = fx.release('v1.1.0', side, { ancestry_mode: 'published-baseline', master_sha: tip, baseline_shas: published, anchor_sha: tip });
    expect(res.status, res.output).toBe(1);
    // 锁点是本 tag 的祖先、但只是 merge 进 master 的分支提交（不在 first-parent 链上），不给。
    const merged = fx.branchOff(published, 'feat: merged branch work');
    fx.mergeIntoMaster(merged, 'Merge pull request #9006');
    const onMerged = fx.branchOff(merged, 'chore: tag on top of a merged branch commit');
    fx.tag('v1.1.2', onMerged);
    expect(fx.gate('v1.1.2', onMerged, { ancestry_mode: 'contains-master', master_sha: merged }).status).toBe(1);
    // 固定的锚点不是完整 SHA（这里是一个解析得到真锚点的 ref 名）：拒绝，不去解析 ref。
    const child = fx.branchOff(tip, 'chore: release-only commit');
    fx.tag('v1.1.1', child); // 只为把这个提交推到 origin，让 job 的 clone 拿得到
    fx.tag('anchor-ref', tip);
    const garbled = fx.release('v1.1.1', child, { ancestry_mode: 'published-baseline', master_sha: tip, baseline_shas: published, anchor_sha: 'anchor-ref' });
    expect(garbled.status, garbled.output).toBe(1);
    // 同样的固定值配上真正包含锚点的 tag 就放行，说明上面拒的是「不含锚点」。
    const ok = fx.release('v1.1.0', child, { ancestry_mode: 'published-baseline', master_sha: tip, baseline_shas: published, anchor_sha: tip });
    expect(ok.status, ok.output).toBe(0);
  });

  describe('binary-subpackages 在第一个 publish 前重判（应对只重跑失败 job 的情况）', () => {
    // publish-gate 放行后子包 job 在发包前失败；几天后「Re-run failed jobs」只重跑它。
    function gateThenFactsChange() {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const a = fx.land('feat: for 1.2.0');
      fx.tag('v1.2.0', a);
      const hotfix = fx.land('fix: hotfix');
      const admitted = fx.admit('v1.2.0', a);
      expect(admitted.status, admitted.output).toBe(0);
      const preflightOutputs = fx.preflight('v1.2.0', a).jobOutputs;
      // 删掉 v1.2.0、热修 v1.1.0 发布、在同一提交重建 v1.2.0。
      fx.deleteTag('v1.2.0');
      fx.tag('v1.1.0', hotfix);
      fx.npmLatest = '1.1.0';
      fx.npmPublished = ['1.0.0', '1.1.0'];
      fx.tag('v1.2.0', a);
      return { fx, a, admitted, preflightOutputs };
    }

    it('本版本的子包一个都没发：按此刻的事实重判，拒绝', () => {
      const { fx, a, admitted, preflightOutputs } = gateThenFactsChange();
      const res = fx.subpackagesGuard('v1.2.0', a, preflightOutputs, []);
      expect(res.status, res.output).toBe(1);
      expect(res.output).toContain('v1.1.0');
      // 对照：release 只复核 publish-gate 的旧固定值，它自己拦不住——所以必须在发包前拦。
      expect(fx.release('v1.2.0', a, admitted.jobOutputs).status).toBe(0);
    });

    it('已经发了一部分：是中断后的续发，沿用 publish-gate 的判定（不烧版本号）', () => {
      const { fx, a, preflightOutputs } = gateThenFactsChange();
      const res = fx.subpackagesGuard('v1.2.0', a, preflightOutputs, ['botmux-linux-x64']);
      expect(res.status, res.output).toBe(0);
      expect(fx.npmCalls().some((call) => call.startsWith('view botmux@latest'))).toBe(true);
    });

    it('查不清楚子包有没有发：fail-closed（即使重判本身会放行）', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const tagged = fx.land('fix: for 1.1.0');
      fx.tag('v1.1.0', tagged);
      const early = fx.preflight('v1.1.0', tagged);
      expect(fx.subpackagesGuard('v1.1.0', tagged, early.jobOutputs, []).status).toBe(0);
      fx.subpackagesNpmDown = true;
      const res = fx.subpackagesGuard('v1.1.0', tagged, early.jobOutputs, []);
      expect(res.status, res.output).toBe(1);
    });

    it('子分支 tag、审批期间 master 前进：子包 job 里的重判也按 preflight 当时的 tip 放行', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const tip = fx.land('fix: for 1.1.0');
      const child = fx.branchOff(tip, 'chore: release-only commit');
      fx.tag('v1.1.0', child);
      const early = fx.preflight('v1.1.0', child);
      fx.land('feat: merged while waiting for approval');
      const res = fx.subpackagesGuard('v1.1.0', child, early.jobOutputs, []);
      expect(res.status, res.output).toBe(0);
    });

    it('npm 退出 0 但没打印这个版本号，不算已发布', () => {
      // 只认「打印出的正是这个版本号」，别的输出一律不当作已发布——否则会误判成续发、跳过重判。
      const { fx, a, preflightOutputs } = gateThenFactsChange();
      fx.subpackagesOddOutput = 'botmux-linux-x64';
      const res = fx.subpackagesGuard('v1.2.0', a, preflightOutputs, []);
      expect(res.status, res.output).toBe(1);
    });

    it('只有最后一个平台的子包已发：同样算续发（每个平台都要查到）', () => {
      const { fx, a, preflightOutputs } = gateThenFactsChange();
      const res = fx.subpackagesGuard('v1.2.0', a, preflightOutputs, ['botmux-darwin-arm64']);
      expect(res.status, res.output).toBe(0);
    });

    it('已确认有子包发了、另一个查不清：仍按续发沿用判定', () => {
      const { fx, a, preflightOutputs } = gateThenFactsChange();
      fx.subpackagesNpmDown = ['botmux-darwin-arm64'];
      const res = fx.subpackagesGuard('v1.2.0', a, preflightOutputs, ['botmux-linux-x64']);
      expect(res.status, res.output).toBe(0);
    });

    it('已知局限：已部分发布后删 tag、发低版本热修、同一提交重建再续发，续发沿用原判定', () => {
      // 这时重判只能拒掉半个版本、烧掉版本号；所以选择沿用原判定，靠「有包上了 npm 就别删 tag」的
      // 提示挡住（见 publish-gate 的 KNOWN LIMIT 注释）。改变这个取舍时这条要跟着改。
      const { fx, a, preflightOutputs } = gateThenFactsChange();
      const res = fx.subpackagesGuard('v1.2.0', a, preflightOutputs, ['botmux-linux-x64']);
      expect(res.status, res.output).toBe(0);
      expect(res.output).toContain('resumed publish');
    });

    it('正常发版：事实没变，重判放行', () => {
      const fx = new Fixture();
      const published = fx.land('feat: shipped in 1.0.0');
      fx.tag('v1.0.0', published);
      fx.npmLatest = '1.0.0';
      const tagged = fx.land('fix: for 1.1.0');
      fx.tag('v1.1.0', tagged);
      fx.land('feat: merged after the tag');
      const early = fx.preflight('v1.1.0', tagged);
      const res = fx.subpackagesGuard('v1.1.0', tagged, early.jobOutputs, []);
      expect(res.status, res.output).toBe(0);
    });
  });

  it('签名审批期间 master 继续前进：preflight 按①放行的 tag，审批后按②照样放行', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tip = fx.land('fix: for 1.1.0');
    fx.tag('v1.1.0', tip);
    const early = fx.preflight('v1.1.0', tip);
    expect(early.stepOutputs.ancestry_mode).toBe('contains-master');

    fx.land('feat: merged while waiting for approval');
    const binding = fx.gate('v1.1.0', tip);
    expect(binding.status, binding.output).toBe(0);
    expect(binding.jobOutputs.ancestry_mode).toBe('published-baseline');
    expect(fx.release('v1.1.0', tip, binding.jobOutputs).status).toBe(0);
  });

  it('#1150 回归：tag 在 master tip 放行后 master 前进、npm 不可用，release 仍放行', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    const tip = fx.land('fix: for 1.1.0');
    fx.tag('v1.1.0', tip);
    fx.npmLatest = '1.0.0';

    const admitted = fx.admit('v1.1.0', tip);
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
    expect(fx.admit('v1.1.0', tip).status).toBe(1);
  });

  it('tag 在 master 旧提交按基线放行后，master 与 npm latest 都变了，release 仍按固定值放行', () => {
    const fx = new Fixture();
    const published = fx.land('feat: shipped in 1.0.0');
    fx.tag('v1.0.0', published);
    fx.npmLatest = '1.0.0';
    const tagged = fx.land('fix: for 1.1.0');
    fx.tag('v1.1.0', tagged);
    fx.land('feat: merged after the tag');

    const admitted = fx.admit('v1.1.0', tagged);
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
    expect(fx.admit('v1.1.0', tagged).status).toBe(1);
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
  ])('放行时没固定到完整事实（%s）时 release fail-closed', (_name, pinned: Record<string, string>) => {
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
