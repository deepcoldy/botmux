#!/usr/bin/env node
// 正式版（npm latest）发版闸：被打 tag 的 commit 能不能发成 latest。
//
// release.yml 里四处调用，规则和理由写在 preflight 同名步骤的注释里：
//   preflight 的「Guard — stable release must come from master」跑 `admit`：打完 tag 立刻判一次，
//     不放行就不必编译、不必等签名审批；
//   publish-gate 的同名步骤再跑一次 `admit`：在签名审批之后、任何包发布之前，按当时的
//     origin/master、release tag 和 npm 重新判定，并把判定用到的事实固定成 step 输出。审批
//     可能等好几天，这期间 tag 和已发布版本都可能变，所以以这一次为准；
//   binary-subpackages 的同名步骤跑 `recheck`：第一个 npm publish 之前，本版本的子包一个都还没发时
//     按此刻的事实再判一次（应对「Re-run failed jobs」只重跑它、不重跑 publish-gate 的情况），已经发了
//     一部分就沿用 publish-gate 的判定；
//   release 的同名步骤跑 `verify`：只按 publish-gate 固定下来的 SHA 复核同一组事实，不再
//     读 origin/master、npm 或 tag。同一次运行里在平台子包已经发到 npm 之后重读会移动的
//     ref，会翻转判定，版本号就此烧掉（issue #1150，v3.18.10）。
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
//      本版之间的每个正式版——不论它只有 tag（还在等签名审批的在途正式版、没发成的正式版），
//      还是已经发到 npm（被 npm-dist-tag 回滚掉的正式版）——对应 tag 的 commit。另外，npm 上只要
//      已经发布过版本号高于本版的正式版，② 就不成立（tag 被删了也一样）。
//   拿不到基线（npm 查询失败、latest 不是规范的 X.Y.Z、latest 不比本版旧、已发布过更高的
//   正式版、基线里某个版本的 tag 不存在）时只剩①，fail-closed。① 不读 npm：tip 包含了
//   所有从 master 发出去的版本。判定只看 commit 图、tag 和已发布版本，不看墙钟时间。
//
// 输出（追加到 $GITHUB_OUTPUT；没有该变量时打到 stdout）：
//   master_sha     判定时用的 origin/master SHA
//   ancestry_mode  contains-master | published-baseline
//   baseline_shas  ②用到的基线 commit，空格分隔；①时为空
//
// 用法：node .github/scripts/release-master-guard.mjs admit|verify|recheck
//   admit   读 env RELEASE_TAG（vX.Y.Z）、NPM_PACKAGE（默认 botmux）、PREFLIGHT_MODE / PREFLIGHT_MASTER
//           （publish-gate 与 recheck 传入 preflight 的输出，只用来给子分支 tag 找锚点）
//   verify  读 env PINNED_MODE、PINNED_MASTER、PINNED_BASELINE、PINNED_ANCHOR（来自 publish-gate 的输出）
//   recheck 另读 env SUBPACKAGE_PLATFORMS（发包循环用的同一份平台列表）
// 三种都要完整历史（actions/checkout 的 fetch-depth: 0）：浅克隆里祖先关系不全，直接拒绝。
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

/** Every version of `pkg` ever published to npm (any dist-tag, including ones `latest` was rolled back off). */
function readNpmPublished(pkg) {
  const r = run('npm', ['view', pkg, 'versions', '--json']);
  if (r.error || r.status !== 0) {
    const detail = r.error ? r.error.message : lastLine(r.stderr) || `exit ${r.status}`;
    return { error: `npm view ${pkg} versions failed: ${detail}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { error: `npm view ${pkg} versions did not print JSON` };
  }
  // npm prints a bare string instead of an array when there is exactly one version.
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0 || !list.every((v) => typeof v === 'string')) {
    return { error: `npm view ${pkg} versions printed an unexpected shape` };
  }
  return { versions: list.map((v) => v.trim()) };
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
 * published from, plus every stable version ranked between npm latest and this release —
 * whether it exists only as a tag or has been published to npm.
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

  // Why the published list as well as the tags: `latest` can be rolled back with
  // npm-dist-tag.yml, and a stable tag can be deleted by someone holding the ruleset
  // bypass. Then neither npm latest nor the tags show that users already had a newer
  // version — npm's own version list still does.
  const published = readNpmPublished(pkg);
  if (published.error) return { reason: published.error };
  const publishedStable = published.versions
    .map((text) => ({ text, version: parseVersion(text) }))
    .filter((p) => p.version);
  const above = publishedStable.filter((p) => compareVersions(p.version, self) > 0);
  if (above.length > 0) {
    const top = above.map((p) => p.text).sort((a, b) => compareVersions(parseVersion(a), parseVersion(b))).pop();
    return { reason: `npm already has stable version ${top} published, which ranks above this release` };
  }

  const wanted = new Map([[npm.version, 'npm latest']]);
  for (const t of tags) {
    if (compareVersions(t.version, latest) > 0 && compareVersions(t.version, self) < 0) {
      wanted.set(t.version.join('.'), 'stable tag between npm latest and this release');
    }
  }
  for (const p of publishedStable) {
    if (compareVersions(p.version, latest) > 0 && compareVersions(p.version, self) < 0) {
      wanted.set(p.version.join('.'), 'published to npm between npm latest and this release');
    }
  }
  const entries = [];
  for (const [version, role] of [...wanted].sort((a, b) => compareVersions(parseVersion(a[0]), parseVersion(b[0])))) {
    const tag = `v${version}`;
    const sha = tagCommit(tag);
    if (!sha) return { reason: `tag ${tag} (${role}) does not resolve to a commit` };
    entries.push({ tag, sha, role });
  }
  return { entries };
}

/**
 * Ancestry questions need the whole history: in a shallow clone the commit graph is cut at
 * the boundary, so "does HEAD contain X" is false for every X but HEAD itself. That can only
 * turn admissions into refusals, but it does so for every tag not on master's current tip —
 * so say why instead of refusing with a misleading reason.
 */
function refuseIfShallow() {
  if (git(['rev-parse', '--is-shallow-repository']) !== 'true') return null;
  return refuse([
    'REFUSING: this checkout is shallow, so the release guard cannot see which commits the tag contains.',
    'Fix: give the job\'s actions/checkout step `fetch-depth: 0`.',
  ]);
}

/**
 * The admission rule. `pin`: write the facts it was taken on as step outputs (preflight and
 * publish-gate do); recheck only needs the verdict.
 */
function admit({ pin = true } = {}) {
  const releaseTag = process.env.RELEASE_TAG;
  if (!releaseTag) {
    console.error('release-master-guard: RELEASE_TAG is required');
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

  const shallow = refuseIfShallow();
  if (shallow !== null) return shallow;
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
      `Fix: release this commit as a version above ${top}. Only if ${top} was created by mistake AND nothing of it is on npm yet (no botmux-* package at that version), cancel its Release run (it may still be waiting for signing approval), then delete the tag (needs the tag-ruleset bypass) and re-run this one.`,
      `Once any package of ${top} is on npm, never delete its tag: re-running that half-published release resumes it on the verdict it was admitted on, which cannot see a lower release published in between. Ship the fix as a version above ${top} instead.`,
    ]);
  }

  // ① The original rule. Checked before ② so a tag on the tip (or on a branch rebased onto
  // it) never depends on npm being reachable.
  if (isAncestor(master, head)) {
    console.log(`OK (contains-master): tagged commit ${short(head)} contains origin/master (${short(master)}).`);
    if (pin) setOutputs({ master_sha: master, ancestry_mode: 'contains-master', baseline_shas: '', anchor_sha: '' });
    return 0;
  }

  // Where HEAD meets master's own line. Normally HEAD itself, on master's first-parent chain.
  // For a tag that preflight admitted under ① — a child of the tip it saw, which the rules
  // allow — it is that tip: master moving on while the release waits for signing approval
  // must not turn the tag away (that is the whole point of ②). Only preflight's own pin can
  // name it, so a branch that never contained master's tip gets no anchor.
  let anchor = null;
  if (onFirstParentChain(head, master)) {
    anchor = head;
  } else {
    const admittedTip = process.env.PREFLIGHT_MODE === 'contains-master' ? (process.env.PREFLIGHT_MASTER || '').trim() : '';
    if (FULL_SHA.test(admittedTip) && isAncestor(admittedTip, head) && onFirstParentChain(admittedTip, master)) {
      anchor = admittedTip;
      console.log(`tagged commit ${short(head)} is a child of ${short(admittedTip)}, the master tip preflight admitted it on; that commit is still on master.`);
    }
  }
  if (!anchor) {
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

  if (pin) setOutputs({
    master_sha: master,
    ancestry_mode: 'published-baseline',
    baseline_shas: baseline.entries.map((e) => e.sha).join(' '),
    // Empty when the tagged commit is itself on master's first-parent chain.
    anchor_sha: anchor === head ? '' : anchor,
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
  const anchorPin = (process.env.PINNED_ANCHOR || '').trim();

  // Only a full SHA is a pin. A ref name (HEAD, origin/master) would quietly re-read a ref
  // that moves — the very thing this job must not do.
  if (!FULL_SHA.test(master)) {
    return refuse([
      `REFUSING: the admission pinned no master SHA (got "${master}"), so this job cannot re-check the same facts the release was admitted on.`,
      'Failing closed rather than re-reading a ref that may have moved since (issue #1150).',
    ]);
  }
  const shallow = refuseIfShallow();
  if (shallow !== null) return shallow;
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  ensureCommit(master);

  if (mode === 'contains-master') {
    if (!isAncestor(master, head)) {
      return refuse([
        `REFUSING: tagged commit ${short(head)} does not contain the master the release was admitted on (${short(master)}).`,
        'Stable (latest) releases must be tagged on master, or on a branch rebased onto the latest master.',
      ]);
    }
    console.log(`OK: tagged commit ${short(head)} contains the master the release was admitted on (${short(master)}).`);
    return 0;
  }

  if (mode === 'published-baseline') {
    if (baseline.length === 0 || !baseline.every((sha) => FULL_SHA.test(sha))) {
      return refuse([
        `REFUSING: the release was admitted against a published baseline, but no valid baseline commits were pinned (got "${baseline.join(' ')}").`,
        'Failing closed rather than re-deriving the baseline from npm or tags that may have moved since (issue #1150).',
      ]);
    }
    if (anchorPin && !FULL_SHA.test(anchorPin)) {
      return refuse([`REFUSING: the pinned anchor "${anchorPin}" is not a commit SHA (issue #1150).`]);
    }
    for (const sha of baseline) ensureCommit(sha);
    const anchor = anchorPin || head;
    if (anchorPin) {
      ensureCommit(anchorPin);
      if (!isAncestor(anchorPin, head)) {
        return refuse([`REFUSING: tagged commit ${short(head)} does not contain the pinned anchor ${short(anchorPin)}.`]);
      }
    }
    if (!onFirstParentChain(anchor, master)) {
      return refuse([`REFUSING: ${short(anchor)} is not on the first-parent history of the master the release was admitted on (${short(master)}).`]);
    }
    const missing = baseline.filter((sha) => !isAncestor(sha, head));
    if (missing.length > 0) {
      return refuse([
        `REFUSING: tagged commit ${short(head)} does not contain the published baseline the release was admitted on:`,
        ...missing.map((sha) => `  - ${short(sha)}`),
      ]);
    }
    console.log(`OK: tagged commit ${short(head)} is on the master the release was admitted on (${short(master)}) and contains its pinned baseline (${baseline.map(short).join(', ')}).`);
    return 0;
  }

  return refuse([
    `REFUSING: no recognised ancestry mode was pinned (got "${mode}").`,
    'Failing closed rather than guessing which rule admitted this release (issue #1150).',
  ]);
}

/**
 * binary-subpackages, right before its first publish. "Re-run failed jobs" re-runs this job
 * but NOT publish-gate when the gate succeeded and something between it and the first publish
 * failed — the run may then be days old. So when nothing of this version is on npm yet, take
 * the admission again on today's facts; once part of it is published, keep the pinned verdict
 * (re-judging then could refuse half a release and burn the version, issue #1150).
 */
function recheck() {
  const version = (process.env.RELEASE_TAG || '').replace(/^v/, '');
  const packages = (process.env.SUBPACKAGE_PLATFORMS || '').split(/\s+/).filter(Boolean).map((plat) => `botmux-${plat}`);
  if (!version || packages.length === 0) {
    console.error('release-master-guard recheck: RELEASE_TAG and SUBPACKAGE_PLATFORMS are required');
    return 2;
  }
  const published = [];
  const unknown = [];
  for (const name of packages) {
    const r = run('npm', ['view', `${name}@${version}`, 'version']);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0 && r.stdout.trim() === version) published.push(name);
    // An unpublished version answers E404, both for a known package ("No match found for
    // version") and an unknown one; an empty success is treated the same. Anything else —
    // timeouts, 5xx, auth — is an unknown.
    else if ((r.status === 0 && r.stdout.trim() === '') || (r.status !== 0 && /\bE404\b/.test(out))) continue;
    else unknown.push(`${name}: ${lastLine(out) || `exit ${r.status}`}`);
  }
  // One confirmed publish settles it: this is a resumed publish, whatever the others say.
  if (unknown.length > 0 && published.length === 0) {
    return refuse([
      `REFUSING: could not tell whether any subpackage of ${version} is already on npm:`,
      ...unknown.map((line) => `  - ${line}`),
      'Fix: re-run once npm is reachable.',
    ]);
  }
  if (published.length > 0) {
    console.log(`${published.join(', ')} @${version} already on npm: this is a resumed publish, so it keeps the verdict publish-gate pinned.`);
    return 0;
  }
  console.log(`nothing of ${version} is on npm yet: taking the admission again before the first publish.`);
  return admit({ pin: false });
}

const command = process.argv[2];
try {
  if (command === 'admit') process.exitCode = admit();
  else if (command === 'verify') process.exitCode = verify();
  else if (command === 'recheck') process.exitCode = recheck();
  else {
    console.error('usage: node .github/scripts/release-master-guard.mjs admit|verify|recheck');
    process.exitCode = 2;
  }
} catch (err) {
  refuse([`REFUSING: the release guard could not complete: ${err instanceof Error ? err.message : String(err)}`]);
  process.exitCode = 1;
}
