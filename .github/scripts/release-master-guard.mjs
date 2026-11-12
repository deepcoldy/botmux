#!/usr/bin/env node
// 正式版（npm latest）发版闸：被打 tag 的 commit 能不能发成 latest。
//
// release.yml 里两处调用，规则和理由写在 preflight 同名步骤的注释里：
//   preflight 的「Guard — stable release must come from master」跑 `admit`：读 origin/master、
//     release tag 和 npm latest，判定按哪条放行，并把判定用到的事实固定成 step 输出；
//   release 的同名步骤跑 `verify`：只按 preflight 固定下来的 SHA 复核同一组事实，不再读
//     origin/master、npm 或 tag。同一次运行里重读会移动的 ref，会在平台子包已经发到 npm
//     之后翻转判定，版本号就此烧掉（issue #1150，v3.18.10）。
//
// 先决条件（不满足直接拒绝，下面两条放行都要先过这一关）：
//   release tag 是规范的 vX.Y.Z，且 origin 上没有版本号更高的正式版 tag。即正式版必须按版本号
//   递增的顺序打 tag——这条以前只有本地 pre-push hook 在查（可以不启用、--no-verify 可绕、
//   网页建 tag 不经过）。先打高版本、后打低版本时，低版本的改动不一定在高版本里：两个都批准
//   后 latest 最终是缺了低版本改动的高版本；用 npm-dist-tag 回滚后在旧提交上打一个比已发布
//   版本低的号，也会让 latest 缺已发布的改动。
//
// 放行条件，任一成立即可：
//   ① contains-master：HEAD 包含 origin/master。即在 master tip 上打 tag，或在 rebase 到
//      最新 master 的子分支上打 tag。这是原来的规则。
//   ② published-baseline：HEAD 在 origin/master 的 first-parent 链上（tip、tip~1、tip~2……，
//      可以不是 tip；用 merge commit 合进来的分支内部提交不算），并且包含「已发布基线」
//      里的每个 commit。基线 = npm latest 版本对应 tag 的 commit，加上版本号介于 npm latest 与
//      本版之间的每个正式版 tag 的 commit（还在等签名审批的在途正式版、没发成的正式版 tag——
//      算进来只会更严）。
//   拿不到基线（npm 查询失败、latest 不是规范的 X.Y.Z、latest 不比本版旧、对应 tag 不存在）时
//   只剩①，fail-closed。判定只看 commit 图和已发布版本，不看墙钟时间。
//
// 输出（追加到 $GITHUB_OUTPUT；没有该变量时打到 stdout）：
//   master_sha     判定时用的 origin/master SHA
//   ancestry_mode  contains-master | published-baseline
//   baseline_shas  ②用到的基线 commit，空格分隔；①时为空
//
// 用法：node .github/scripts/release-master-guard.mjs admit|verify
//   admit   读 env RELEASE_TAG（vX.Y.Z）、NPM_PACKAGE（默认 botmux）
//   verify  读 env PINNED_MODE、PINNED_MASTER、PINNED_BASELINE（来自 preflight 的输出）
// 退出码：0 放行；1 拒绝（含任何意外错误，fail-closed）；2 用法错误。
//
// 行为测试：test/release-ancestry-pin.test.ts（真实 git 仓库 + 假 npm，执行 workflow 步骤本身）。

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// Canonical X.Y.Z only: no leading zeros, no build metadata, no fourth component. `npm version`
// silently drops `+build`, so a tag like v1.1.0+hotfix would publish the subpackages as 1.1.0
// and then die in inject-optional-binaries — a burned version.
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DEFERRED_LIST_LIMIT = 50;

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 });
}

function lastLine(text) {
  return (text || '').trim().split('\n').filter(Boolean).pop() || '';
}

function git(args) {
  const r = run('git', args);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${lastLine(r.stderr)}`);
  }
  return r.stdout.trim();
}

/** stdout on success, null on any failure — for lookups whose absence is an answer, not an error. */
function gitMaybe(args) {
  const r = run('git', args);
  return r.status === 0 ? r.stdout.trim() : null;
}

function isAncestor(ancestor, descendant) {
  const r = run('git', ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  // Anything else (missing object, corrupt repo) is not a "no" — it is an unknown, so it
  // must not be folded into either verdict. The top-level handler turns it into a refusal.
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant} failed (exit ${r.status}): ${lastLine(r.stderr)}`);
}

/**
 * Whether `commit` is on `tip`'s first-parent chain: tip, tip~1, tip~2, … — master's own line,
 * as opposed to commits of a branch that a merge commit brought in. (Not exactly "every state
 * master was in": a multi-commit rebase-merge puts its intermediate commits on the chain too.
 * Those still have to contain the published baseline; see the guard comment in release.yml.)
 * Bounded: counts the first-parent walk from tip down to commit, then checks tip~n is commit,
 * so the output stays one line however far back commit is.
 */
function onFirstParentChain(commit, tip) {
  if (commit === tip) return true;
  const n = git(['rev-list', '--first-parent', '--count', `${commit}..${tip}`]);
  if (!/^\d+$/.test(n)) throw new Error(`git rev-list --count printed "${n}", not a count`);
  return gitMaybe(['rev-parse', '--verify', '--quiet', `${tip}~${n}^{commit}`]) === commit;
}

const short = (sha) => sha.slice(0, 9);

function parseVersion(text) {
  const m = STABLE_VERSION.exec(text);
  return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function setOutputs(values) {
  const body = `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, body);
  else process.stdout.write(body);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function refuse(lines) {
  console.log(`::error::${lines[0]}`);
  for (const line of lines.slice(1)) console.log(line);
  summary(['### Stable release refused', '', ...lines.map((l) => `    ${l}`)].join('\n'));
  return 1;
}

function readNpmLatest(pkg) {
  const r = run('npm', ['view', `${pkg}@latest`, 'version']);
  if (r.error || r.status !== 0) {
    const detail = r.error ? r.error.message : lastLine(r.stderr) || `exit ${r.status}`;
    return { error: `npm view ${pkg}@latest version failed: ${detail}` };
  }
  return { version: r.stdout.trim() };
}

function tagCommit(name) {
  return gitMaybe(['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`]);
}

/** Every canonical stable tag (as read from origin by admit), with its parsed version. */
function stableTags() {
  return git(['tag', '--list', 'v*'])
    .split('\n')
    .map((name) => ({ name, version: parseVersion(name.slice(1)) }))
    .filter((t) => t.version)
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * The commits every stable release from here on must contain: the tag npm `latest` was
 * published from, plus every stable tag ranked between npm latest and this release.
 *
 * Why the in-between tags: a stable release waits for a manual Developer ID signing
 * approval before anything reaches npm, often for hours. Throughout that wait npm
 * `latest` still names the previous version, so a second stable tag pushed on an
 * OLDER master commit would contain npm latest and pass — and once both are approved,
 * the higher version number ships without the lower one's changes. (Tags ranked ABOVE
 * this release never reach here: admit refuses them up front.)
 *
 * Returns { entries } or { reason } when the baseline cannot be established.
 */
function resolveBaseline(self, tags, pkg) {
  const npm = readNpmLatest(pkg);
  if (npm.error) return { reason: npm.error };
  const latest = parseVersion(npm.version);
  if (!latest) return { reason: `npm latest "${npm.version}" is not a canonical X.Y.Z version` };
  if (compareVersions(latest, self) >= 0) {
    return { reason: `npm latest ${npm.version} is not older than this release` };
  }

  const latestTag = `v${npm.version}`;
  const latestSha = tagCommit(latestTag);
  if (!latestSha) return { reason: `tag ${latestTag} (npm latest) does not exist` };
  const entries = [{ tag: latestTag, sha: latestSha, role: 'npm latest' }];

  for (const t of tags) {
    if (compareVersions(t.version, latest) <= 0 || compareVersions(t.version, self) >= 0) continue;
    const sha = tagCommit(t.name);
    if (!sha) return { reason: `tag ${t.name} does not resolve to a commit` };
    entries.push({ tag: t.name, sha, role: 'stable tag between npm latest and this release' });
  }
  return { entries };
}

function admit() {
  const releaseTag = process.env.RELEASE_TAG;
  if (!releaseTag) {
    console.error('release-master-guard admit: RELEASE_TAG is required');
    return 2;
  }
  const pkg = process.env.NPM_PACKAGE || 'botmux';

  const self = releaseTag.startsWith('v') ? parseVersion(releaseTag.slice(1)) : null;
  if (!self) {
    return refuse([
      `REFUSING: ${releaseTag} is not a canonical stable tag (vX.Y.Z, no leading zeros, no suffix).`,
      'Fix: tag the release as plain vX.Y.Z — or use a -canary/-beta/-rc suffix for a prerelease.',
    ]);
  }

  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  git(['fetch', '--quiet', 'origin', '+refs/heads/master:refs/remotes/origin/master']);
  const master = git(['rev-parse', '--verify', 'refs/remotes/origin/master^{commit}']);
  // The checkout already carries tags, but the ones that matter most are the newest: a stable
  // tag pushed moments ago, possibly after this run started. Read them from origin now.
  // Forced, so a tag the maintainer moved since the checkout is seen where it points now.
  git(['fetch', '--quiet', 'origin', '+refs/tags/v*:refs/tags/v*']);
  const tags = stableTags();

  const higher = tags.filter((t) => compareVersions(t.version, self) > 0);
  if (higher.length > 0) {
    const top = higher[higher.length - 1].name;
    return refuse([
      `REFUSING: stable tag ${top} already exists, and it ranks above ${releaseTag}.`,
      'Stable versions must be tagged in increasing order: a lower version tagged later may carry changes the higher one lacks, and publishing the higher one after it would drop them from latest.',
      `Fix: release this commit as a version above ${top}. If ${top} was created by mistake, FIRST cancel its Release run (a stable run may still be waiting for signing approval, and approving it later would publish ${top} on the facts it was admitted on), then delete the tag (needs the tag-ruleset bypass) and re-run this one.`,
    ]);
  }

  // ① The original rule. Checked before ② so a tag on the tip (or on a branch rebased onto
  // it) never depends on npm being reachable.
  if (isAncestor(master, head)) {
    console.log(`OK (contains-master): tagged commit ${short(head)} contains origin/master (${short(master)}).`);
    setOutputs({ master_sha: master, ancestry_mode: 'contains-master', baseline_shas: '' });
    return 0;
  }

  if (!onFirstParentChain(head, master)) {
    return refuse([
      `REFUSING: tagged commit ${short(head)} neither contains the latest origin/master (${short(master)}) nor is on master's first-parent history.`,
      'Stable (latest) releases must be tagged on master, or on a branch rebased onto the latest master. A commit that only reached master through a merge commit is a branch commit, not a state master was in.',
      `Fix: tag a commit on master (e.g. the current tip ${short(master)}), or rebase/merge onto origin/master and re-tag — or use a -canary/-beta/-rc suffix to publish off-master for testing.`,
    ]);
  }

  // ② On master but behind its tip: admissible only against an established baseline.
  const baseline = resolveBaseline(self, tags, pkg);
  if (baseline.reason) {
    return refuse([
      `REFUSING: tagged commit ${short(head)} is on master but does not contain the latest origin/master (${short(master)}), and the published baseline could not be established: ${baseline.reason}.`,
      'Without that baseline only the strict rule applies: the tagged commit must contain origin/master.',
      `Fix: re-run this job once npm and the release tags are reachable, or re-tag on the current master tip (${short(master)}).`,
    ]);
  }

  const missing = baseline.entries.filter((e) => !isAncestor(e.sha, head));
  if (missing.length > 0) {
    // A missing baseline commit that master itself lacks (a stable tag on a side branch, or
    // npm latest published from one) cannot be contained by ANY older master commit, so the
    // only way forward is rule ① — say so instead of suggesting an older commit.
    const offMaster = missing.filter((e) => !isAncestor(e.sha, master));
    const fix = offMaster.length > 0
      ? `Fix: ${offMaster.map((e) => e.tag).join(', ')} ${offMaster.length > 1 ? 'are' : 'is'} not on master, so no older master commit can contain ${offMaster.length > 1 ? 'them' : 'it'}; re-tag on the current master tip (${short(master)}), which is admitted by containing origin/master.`
      : `Fix: re-tag on a master commit that contains ${missing.map((e) => e.tag).join(', ')} — e.g. the current master tip (${short(master)}).`;
    return refuse([
      `REFUSING: tagged commit ${short(head)} is on master but older than stable release(s) users already have or are about to get:`,
      ...missing.map((e) => `  - ${e.tag} (${short(e.sha)}, ${e.role}) is not contained`),
      'Publishing it as latest would ship less than an earlier stable release.',
      fix,
    ]);
  }

  const described = baseline.entries.map((e) => `${e.tag} (${short(e.sha)}, ${e.role})`);
  const deferredCount = Number(git(['rev-list', '--count', `${head}..${master}`]));
  const deferred = git(['log', `--max-count=${DEFERRED_LIST_LIMIT}`, '--format=%h %s', `${head}..${master}`])
    .split('\n')
    .filter(Boolean);
  const more = deferredCount > deferred.length ? [`… and ${deferredCount - deferred.length} more`] : [];

  console.log(`OK (published-baseline): tagged commit ${short(head)} is on master (origin/master = ${short(master)}) and contains the published baseline:`);
  for (const line of described) console.log(`  - ${line}`);
  console.log(`${deferredCount} later master commit(s) are NOT in this release; they ship in the next one:`);
  for (const line of [...deferred, ...more]) console.log(`  ${line}`);
  summary([
    '### Stable release admitted on a master commit behind the tip',
    '',
    `Tagged commit \`${short(head)}\` is on master (\`${short(master)}\` at admission) and contains the published baseline:`,
    '',
    ...described.map((line) => `- ${line}`),
    '',
    `${deferredCount} later master commit(s) are not in this release and ship in the next one:`,
    '',
    ...[...deferred, ...more].map((line) => `- ${line}`),
  ].join('\n'));

  setOutputs({
    master_sha: master,
    ancestry_mode: 'published-baseline',
    baseline_shas: baseline.entries.map((e) => e.sha).join(' '),
  });
  return 0;
}

/** Make sure a pinned commit is present locally. Fetching an exact SHA reads no moving ref. */
function ensureCommit(sha) {
  if (gitMaybe(['cat-file', '-e', `${sha}^{commit}`]) !== null) return;
  git(['fetch', '--quiet', 'origin', sha]);
  git(['cat-file', '-e', `${sha}^{commit}`]);
}

function verify() {
  const mode = (process.env.PINNED_MODE || '').trim();
  const master = (process.env.PINNED_MASTER || '').trim();
  const baseline = (process.env.PINNED_BASELINE || '').split(/\s+/).filter(Boolean);

  // Only a full SHA is a pin. A ref name (HEAD, origin/master) would quietly re-read a ref
  // that moves — the very thing this job must not do.
  if (!FULL_SHA.test(master)) {
    return refuse([
      `REFUSING: preflight pinned no master SHA (got "${master}"), so this job cannot re-check the same facts preflight admitted.`,
      'Failing closed rather than re-reading a ref that may have moved since (issue #1150).',
    ]);
  }
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  ensureCommit(master);

  if (mode === 'contains-master') {
    if (!isAncestor(master, head)) {
      return refuse([
        `REFUSING: tagged commit ${short(head)} does not contain the master preflight admitted (${short(master)}).`,
        'Stable (latest) releases must be tagged on master, or on a branch rebased onto the latest master.',
      ]);
    }
    console.log(`OK: tagged commit ${short(head)} contains the master preflight admitted (${short(master)}).`);
    return 0;
  }

  if (mode === 'published-baseline') {
    if (baseline.length === 0 || !baseline.every((sha) => FULL_SHA.test(sha))) {
      return refuse([
        `REFUSING: preflight admitted against a published baseline but pinned no valid baseline commits (got "${baseline.join(' ')}").`,
        'Failing closed rather than re-deriving the baseline from npm or tags that may have moved since (issue #1150).',
      ]);
    }
    for (const sha of baseline) ensureCommit(sha);
    if (!onFirstParentChain(head, master)) {
      return refuse([`REFUSING: tagged commit ${short(head)} is not on the first-parent history of the master preflight admitted (${short(master)}).`]);
    }
    const missing = baseline.filter((sha) => !isAncestor(sha, head));
    if (missing.length > 0) {
      return refuse([
        `REFUSING: tagged commit ${short(head)} does not contain the published baseline preflight pinned:`,
        ...missing.map((sha) => `  - ${short(sha)}`),
      ]);
    }
    console.log(`OK: tagged commit ${short(head)} is on the master preflight admitted (${short(master)}) and contains its pinned baseline (${baseline.map(short).join(', ')}).`);
    return 0;
  }

  return refuse([
    `REFUSING: preflight pinned no recognised ancestry mode (got "${mode}").`,
    'Failing closed rather than guessing which rule admitted this release (issue #1150).',
  ]);
}

const command = process.argv[2];
try {
  if (command === 'admit') process.exitCode = admit();
  else if (command === 'verify') process.exitCode = verify();
  else {
    console.error('usage: node .github/scripts/release-master-guard.mjs admit|verify');
    process.exitCode = 2;
  }
} catch (err) {
  refuse([`REFUSING: the release guard could not complete: ${err instanceof Error ? err.message : String(err)}`]);
  process.exitCode = 1;
}
