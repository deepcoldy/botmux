/**
 * Deny-mask cleanup manifest trust-boundary regression (2026-07-24 review).
 *
 * The manifest records the host mountpoints the worker pre-created so bwrap
 * could bind an empty deny mask over them; teardown reclaims those (rmdir/unlink
 * if still empty). The exploit codex(sg) built: with a custom
 * SESSION_DATA_DIR inside a RW-bound project, the sandboxed CLI could rewrite
 * `mask-mounts.json` to point at arbitrary victim paths, and cleanup would
 * delete any empty dir / zero-byte file on the host.
 *
 * Defenses under test (Linux only — mask lifecycle is Linux/bwrap):
 *  - entries carry (dev, ino) captured at creation; cleanup removes ONLY when
 *    the on-disk inode still matches → a swapped/forged path is refused even if
 *    it currently is an empty dir / zero-byte file;
 *  - symlink entries are refused (no following);
 *  - `..` / non-absolute paths refused;
 *  - dirs removed with rmdir (ENOTEMPTY kept), files unlink only when empty;
 *  - multi-level pre-create records EACH created ancestor so cleanup reclaims
 *    all of them, not just the leaf.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __testOnly_maskMounts } from '../src/adapters/backend/sandbox.js';

const { MASK_MANIFEST_NAME, createMaskMount, writeMaskManifest, reclaimMaskMounts, reclaimMaskEntries } = __testOnly_maskMounts;
const linux = process.platform === 'linux';
const d = linux ? describe : describe.skip;

// createMaskMount now pushes into a caller-owned sink (returns void); this
// helper keeps the older "return the created entries" ergonomics for tests.
function create(leaf: string, kind: 'dir' | 'file' = 'dir') {
  const sink: any[] = [];
  createMaskMount(leaf, kind, sink);
  return sink;
}

d('deny-mask manifest lifecycle', () => {
  let root: string;
  const sessionRoot = () => join(root, 'sessionRoot');
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mask-mani-')); mkdirSync(sessionRoot(), { recursive: true }); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('createMaskMount records EACH created ancestor (multi-level), deepest first', () => {
    const leaf = join(root, 'proj/new/a/b'); // none of new/a/b exist
    mkdirSync(join(root, 'proj'), { recursive: true });
    const created = create(leaf, 'dir');
    expect(created.map(e => e.path)).toEqual([
      join(root, 'proj/new/a/b'),
      join(root, 'proj/new/a'),
      join(root, 'proj/new'),
    ]);
    for (const e of created) { expect(existsSync(e.path)).toBe(true); expect(typeof e.dev).toBe('number'); expect(typeof e.ino).toBe('number'); }
  });

  it('createMaskMount records nothing for a pre-existing leaf (never our cleanup target)', () => {
    const leaf = join(root, 'exists');
    mkdirSync(leaf);
    expect(create(leaf, 'dir')).toEqual([]);
  });

  it('reclaim removes the empty mounts we created (leaf + ancestors), keeps a non-empty one', () => {
    const created = create(join(root, 'proj/x/y'), 'dir');
    // host writes into the leaf during the session
    writeFileSync(join(root, 'proj/x/y/hostdata'), 'z');
    expect(writeMaskManifest(sessionRoot(), created)).toBe(true);
    reclaimMaskMounts(sessionRoot());
    expect(existsSync(join(root, 'proj/x/y'))).toBe(true);  // non-empty → kept
    // ancestors are still non-empty (contain x/y) → also kept, never rm -rf
    expect(existsSync(join(root, 'proj/x'))).toBe(true);
  });

  it('reclaim removes a fully-empty multi-level chain', () => {
    const created = create(join(root, 'proj/p/q/r'), 'dir');
    expect(writeMaskManifest(sessionRoot(), created)).toBe(true);
    reclaimMaskMounts(sessionRoot());
    expect(existsSync(join(root, 'proj/p/q/r'))).toBe(false);
    expect(existsSync(join(root, 'proj/p/q'))).toBe(false);
    expect(existsSync(join(root, 'proj/p'))).toBe(false);
  });

  it('EXPLOIT: a tampered manifest pointing at a pre-existing empty victim is REFUSED (dev+ino mismatch)', () => {
    // victim exists on the host, was NOT created by us
    const victimDir = join(root, 'victim-dir');
    const victimFile = join(root, 'victim-file');
    mkdirSync(victimDir);
    writeFileSync(victimFile, ''); // zero-byte
    // attacker writes a manifest with forged entries (guessing/omitting ino, or
    // stealing a real-but-different ino)
    const forged = [
      { path: victimDir, kind: 'dir', dev: 999999, ino: 999999 },
      { path: victimFile, kind: 'file', dev: 999999, ino: 999999 },
      { path: victimDir, kind: 'dir' }, // no dev/ino at all
    ];
    writeFileSync(join(sessionRoot(), MASK_MANIFEST_NAME), JSON.stringify(forged));
    reclaimMaskMounts(sessionRoot());
    expect(existsSync(victimDir)).toBe(true);  // NOT deleted (inode mismatch / missing)
    expect(existsSync(victimFile)).toBe(true);
  });

  it('reuse race: inode recheck refuses a DIFFERENT-inode object recreated at the same path', () => {
    // dev+ino identity defeats the "our mount removed, a foreign object appears
    // at the same path" case WHENEVER the new object has a different inode. (An
    // OS that immediately reuses the freed inode number is a narrower residual
    // race; the primary defense is that mask paths live under sessionRoot, which
    // is unwritable in-sandbox — see sandbox-mask-mounts.e2e.) Force a distinct
    // inode by creating a sibling first so the freed number isn't reused.
    const created = create(join(root, 'proj/z'), 'dir');
    expect(writeMaskManifest(sessionRoot(), created)).toBe(true);
    const recorded = created[0]!;
    // simulate a foreign object at the same path with a definitely-different ino
    // by rewriting the manifest's recorded ino to a value the on-disk object
    // cannot match (the object itself is unchanged).
    writeFileSync(join(sessionRoot(), MASK_MANIFEST_NAME), JSON.stringify([{ ...recorded, ino: recorded.ino + 987654321 }]));
    reclaimMaskMounts(sessionRoot());
    expect(existsSync(join(root, 'proj/z'))).toBe(true); // ino mismatch → left untouched
  });

  it('refuses symlink / .. / non-absolute entries', () => {
    const realDir = join(root, 'real');
    mkdirSync(realDir);
    const link = join(root, 'link');
    symlinkSync(realDir, link);
    const st = lstatSync(link);
    const manifest = [
      { path: link, kind: 'dir', dev: st.dev, ino: st.ino }, // symlink → refused
      { path: join(root, '../escape'), kind: 'dir', dev: 1, ino: 1 },
      { path: 'relative/path', kind: 'dir', dev: 1, ino: 1 },
    ];
    writeFileSync(join(sessionRoot(), MASK_MANIFEST_NAME), JSON.stringify(manifest));
    reclaimMaskMounts(sessionRoot());
    expect(existsSync(link)).toBe(true);
    expect(existsSync(realDir)).toBe(true);
  });

  // ── fault injection: rollback must reclaim from the IN-MEMORY accumulator,
  // NOT the manifest (which may never have been written on a failure path). ──

  it('FAIL-CLOSED: leaf create throws mid-chain → created ancestors are in the sink and reclaimed (no residue)', () => {
    // A too-long leaf name makes the leaf write/mkdir throw AFTER its ancestors
    // were created. The sink must already hold those ancestors so rollback can
    // remove them — mirrors prepareDirectSandbox's try/catch → rollback path.
    mkdirSync(join(root, 'base'), { recursive: true });
    const parent = join(root, 'base/created-parent');
    const badLeaf = join(parent, 'x'.repeat(300)); // ENAMETOOLONG on the leaf
    const sink: any[] = [];
    let threw = false;
    try { createMaskMount(badLeaf, 'dir', sink); } catch { threw = true; }
    expect(threw).toBe(true);
    // the parent WAS created and IS recorded in the sink (immediate push)
    expect(existsSync(parent)).toBe(true);
    expect(sink.some(e => e.path === parent)).toBe(true);
    // rollback path: reclaim from the in-memory sink (manifest was never written)
    reclaimMaskEntries(sink);
    expect(existsSync(parent)).toBe(false); // reclaimed — no permanent residue
  });

  it('FAIL-CLOSED: manifest write fails → reclaim from the in-memory list clears all created targets', () => {
    // writeMaskManifest to a nonexistent parent dir returns false; the created
    // mountpoints must still be reclaimed from the accumulator, not leaked.
    const created = create(join(root, 'proj/m/n'), 'dir');
    expect(created.length).toBeGreaterThan(0);
    const badSessionRoot = join(root, 'does/not/exist');
    expect(writeMaskManifest(badSessionRoot, created)).toBe(false);
    // manifest read would find nothing → must use the in-memory list
    reclaimMaskEntries(created);
    expect(existsSync(join(root, 'proj/m/n'))).toBe(false);
    expect(existsSync(join(root, 'proj/m'))).toBe(false);
  });
});
