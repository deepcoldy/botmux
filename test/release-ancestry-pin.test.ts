import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';

/**
 * The release pipeline must never re-derive its admission decision from a MUTABLE
 * ref after it has already published something irreversible.
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
 * WHAT THESE TESTS DEFEND: not the YAML's shape, but the claim "the release job's
 * admission decision is the one preflight already made". Each assertion below
 * corresponds to a regression that would silently restore the version-burning
 * behaviour while every other check stays green:
 *   • release re-reads origin/master        -> the original TOCTOU, verbatim
 *   • preflight stops pinning the SHA       -> nothing for release to check against
 *   • release stops failing closed on empty -> a missing pin silently admits
 *
 * Note the asymmetry that makes this worth pinning in a test: the failure is
 * invisible in CI (no workflow linting exists in this repo) and shows up only on a
 * real tag push, at which point a version number is already gone.
 */

const RELEASE_PATH = resolve(import.meta.dirname, '../.github/workflows/release.yml');
const RELEASE = readFileSync(RELEASE_PATH, 'utf-8');

/**
 * Strip `#` comments so a claim can never be satisfied by prose ABOUT the claim.
 * This file's own guard comments quote `origin/master` and `git fetch origin master`
 * repeatedly while explaining the bug; without stripping, the "does not re-read"
 * assertion would be satisfied by the very comment warning against re-reading.
 */
const stripComments = (yaml: string): string => yaml
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
  .join('\n');

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  jobs: Record<string, { outputs?: Record<string, string>; steps?: WorkflowStep[] }>;
}

const workflow = parseYaml(RELEASE) as Workflow;

const GUARD_NAME = 'Guard — stable release must contain the latest master';

function guardStep(job: string): WorkflowStep {
  const steps = workflow.jobs[job]?.steps ?? [];
  const step = steps.find((s) => s.name === GUARD_NAME);
  if (!step) throw new Error(`no step named "${GUARD_NAME}" in job "${job}"`);
  return step;
}

describe('release pipeline — the ancestry verdict must be immutable within a run', () => {
  it('publishes the platform subpackages BEFORE the main release job', () => {
    // Not a preference — the ordering constraint is what makes the TOCTOU dangerous,
    // and it is load-bearing (optional deps are a silent npm no-op if missing). If a
    // future change inverts this, the pinning below stops being necessary and this
    // test should be revisited rather than deleted.
    const subpackages = (workflow.jobs['binary-subpackages'] as { needs?: string[] })?.needs ?? [];
    const release = (workflow.jobs.release as { needs?: string[] })?.needs ?? [];
    expect(subpackages).not.toContain('release');
    expect(release).toContain('binary-subpackages');
  });

  it('preflight pins the exact origin/master SHA its guard validated', () => {
    const step = guardStep('preflight');
    expect(step.id).toBe('master_ancestry');
    // The pin has to be the resolved SHA, written to the step's output.
    expect(stripComments(step.run ?? '')).toMatch(/master_sha=\$\(git rev-parse origin\/master\)/);
    expect(workflow.jobs.preflight?.outputs?.master_sha)
      .toBe('${{ steps.master_ancestry.outputs.master_sha }}');
  });

  it('release verifies the pinned SHA and never re-reads origin/master', () => {
    const step = guardStep('release');
    expect(step.env?.PINNED_MASTER).toBe('${{ needs.preflight.outputs.master_sha }}');

    const body = stripComments(step.run ?? '');
    // The decisive assertion: the ancestry check must be against the pinned value.
    expect(body).toMatch(/git merge-base --is-ancestor "\$PINNED_MASTER" HEAD/);
    // …and must not consult the live ref. `git fetch origin master` and
    // `merge-base … origin/master` are the two shapes that reintroduce the bug.
    expect(body).not.toMatch(/git fetch origin master\b/);
    expect(body).not.toMatch(/--is-ancestor origin\/master/);
  });

  it('release fails closed when preflight pinned nothing', () => {
    // An empty pin must stop the release, NOT fall back to reading the live ref.
    // Without this, a refactor that drops the preflight output would restore the
    // original behaviour silently.
    const body = stripComments(guardStep('release').run ?? '');
    expect(body).toMatch(/if \[ -z "\$PINNED_MASTER" \]; then/);
    const failClosed = body.slice(body.indexOf('if [ -z "$PINNED_MASTER" ]'));
    expect(failClosed).toMatch(/exit 1/);
  });

  it('both sides of the pin are gated on the same condition', () => {
    // If these two `if:`s ever diverge, either a stable release runs the check with
    // no pin (fails closed — noisy but safe), or a prerelease pins a SHA nothing
    // reads (harmless). Pinning them together keeps the pairing honest.
    expect(guardStep('preflight').if).toBe("steps.dist_tag.outputs.tag == 'latest'");
    expect(guardStep('release').if).toBe("steps.dist_tag.outputs.tag == 'latest'");
  });
});
