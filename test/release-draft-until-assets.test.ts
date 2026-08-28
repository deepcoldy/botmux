import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * The GitHub Release must never be publicly visible without its binaries attached.
 *
 * THE BUG THIS DEFENDS AGAINST, and it reached a user: `releases/latest/download/…`
 * starts resolving the moment a release is PUBLISHED, but the binaries are uploaded
 * by `attach-bun-binaries`, which cannot run until the release exists. On v3.18.0 the
 * gap was 72 seconds (published 09:11:58, assets attached 09:13:10) and install.sh
 * inside that window died with:
 *
 *   curl: (56) The requested URL returned error: 404
 *   botmux install: download failed: …/releases/latest/download/botmux-darwin-arm64
 *
 * The fix is to create the release as a DRAFT and publish it only after the assets
 * land. Measured against the real API: while draft, BOTH url shapes install.sh uses
 * (`latest/download/<asset>` and `download/<tag>/<asset>`) return 404 to an anonymous
 * client, and `latest` keeps serving the PREVIOUS release — so users get the old
 * version rather than an error. After publishing, the pinned-tag url returns 200.
 *
 * WHAT THESE TESTS ASSERT — the invariant, not the mechanism: "no public release
 * without binaries". Parsed as YAML (not text) because the claims are structural:
 * job dependencies, a boolean flag, and step ORDER.
 */

const RELEASE_YML = resolve(import.meta.dirname, '../.github/workflows/release.yml');
const doc = parseYaml(readFileSync(RELEASE_YML, 'utf-8')) as {
  jobs: Record<string, {
    if?: string;
    needs?: string | string[];
    steps?: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
  }>;
};
const jobs = doc.jobs;
const needsOf = (name: string) => {
  const n = jobs[name]?.needs;
  return Array.isArray(n) ? n : n ? [n] : [];
};
const runsOf = (name: string) => (jobs[name]?.steps ?? []).map((s) => s.run ?? '').join('\n');

/** Every asset install.sh can ask for: `botmux-<os>-<arch>` (+ `-musl` on musl hosts),
 *  each with a `.sha256` sibling. A missing one is a 404 for exactly those hosts. */
const INSTALL_SH_ASSETS = [
  'botmux-linux-x64',
  'botmux-linux-arm64',
  'botmux-linux-x64-musl',
  'botmux-linux-arm64-musl',
  'botmux-darwin-x64',
  'botmux-darwin-arm64',
];

describe('release.yml — no public Release without its binaries', () => {
  it('creates the Release as a DRAFT', () => {
    // A draft is invisible to `latest` and to anonymous downloads, which is what
    // closes the window. Publishing at creation time is the defect.
    const create = (jobs.release.steps ?? []).find((s) => (s.uses ?? '').includes('softprops'));
    expect(create, 'release job must create the GitHub Release').toBeDefined();
    expect(create!.with?.draft).toBe(true);
  });

  it('publishes only AFTER the binaries are attached', () => {
    expect(jobs['publish-github-release'], 'a separate publish job must exist').toBeDefined();
    expect(needsOf('publish-github-release')).toContain('attach-bun-binaries');
    expect(runsOf('publish-github-release')).toContain('--draft=false');
  });

  it('a FAILED upload leaves the Release a draft (fail-closed)', () => {
    // The direction that matters. Without the explicit success check, GitHub would
    // run this job even when the upload failed — publishing an assetless release,
    // i.e. reintroducing the 404 permanently instead of for 72 seconds. A draft
    // means `latest` keeps serving the previous version.
    expect(jobs['publish-github-release'].if ?? '')
      .toContain("needs.attach-bun-binaries.result == 'success'");
  });

  it('refuses to publish unless every install.sh asset is present', () => {
    const runs = runsOf('publish-github-release');
    for (const asset of INSTALL_SH_ASSETS) expect(runs).toContain(asset);
    expect(runs).toContain('.sha256');
    expect(runs).toMatch(/REFUSING to publish/);
  });

  it('verifies the assets BEFORE flipping the draft, not after', () => {
    // Order is the whole point: a check that runs after publishing cannot prevent
    // anything. Compare positions rather than trusting the step names.
    const steps = jobs['publish-github-release'].steps ?? [];
    const verify = steps.findIndex((s) => (s.run ?? '').includes('REFUSING to publish'));
    const publish = steps.findIndex((s) => (s.run ?? '').includes('--draft=false'));
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(verify);
  });

  it('no OTHER job publishes the Release', () => {
    // One publication point, or the ordering guarantee above is bypassable.
    for (const name of Object.keys(jobs)) {
      if (name === 'publish-github-release') continue;
      expect(runsOf(name), `${name} must not flip the draft`).not.toContain('--draft=false');
    }
  });

  it('macOS signing does NOT gate publication', () => {
    // Signing sits behind a human approval that can wait up to 30 days. If the
    // desktop jobs gated publication, the Release would stay a draft that whole
    // time — so the .dmg/.zip must keep attaching to an already-public Release.
    for (const name of ['attach-desktop-assets', 'refresh-desktop-assets']) {
      if (jobs[name]) expect(needsOf(name)).not.toContain('publish-github-release');
    }
  });
});
