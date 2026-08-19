#!/usr/bin/env bash
# Mutation kill harness for mojo-containment.
#
# Each mutation reverts ONE production rule to its fail-open form. A rule that is
# genuinely pinned makes the suite go red; a mutation that leaves it green means
# the rule is only asserted in comments, not in behaviour.
#
# Two anti-false-positive guards, both learned the hard way:
#   * npm/npx write their cache and logs to the ROOT partition by default. When
#     that is full, vitest never starts and exits non-zero -- which looks exactly
#     like a killed mutation. Cache is redirected to /tmp and every RED verdict is
#     screened for ENOSPC.
#   * a mutation run proves nothing unless the BASELINE is green afterwards, so
#     the run ends by restoring and re-running. If that final run is red, every
#     KILLED verdict above it is void.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

export npm_config_cache=/tmp/npm-cache
export npm_config_logs_dir=/tmp/npm-logs

SRC=src/core/mojo-containment.ts
VITEST=./node_modules/.bin/vitest
TESTS=(test/mojo-containment.test.ts test/mojo-containment-cross-generation.test.ts)
LOG=/tmp/mut-containment.log
TSCLOG=/tmp/mut-containment-tsc.log
RESULT=0

# Refuse to run against a dirty tree: `git checkout --` below would silently
# revert uncommitted work and every result would be measured against the wrong
# baseline.
if ! git diff --quiet -- "$SRC" || ! git diff --cached --quiet -- "$SRC"; then
  echo "ERROR: $SRC has uncommitted changes; commit first or results are meaningless"
  exit 1
fi

BAK=$(mktemp /tmp/containment-src.XXXXXX)
cp "$SRC" "$BAK"

# Criterion 7: prove the restore actually happened, rather than assuming the trap
# ran. A checksum snapshot of every file this harness can touch is taken up front
# and re-verified at the end; `git status` alone would miss a file restored to the
# wrong content (e.g. from a stale backup).
SNAP=$(mktemp /tmp/containment-snap.XXXXXX)
sha256sum "$SRC" "${TESTS[@]}" > "$SNAP" 2>/dev/null

# Restore on ANY exit, including a signal.
#
# Without this a run killed part-way (a harness timeout, Ctrl-C, SIGTERM) left the
# mutated source in place. That is the worst possible residue: a live mutation
# produces BOTH false KILLs and false GREENs for whoever runs next, and it is
# invisible unless someone happens to diff the file. Reproduced deliberately:
# `timeout -s TERM 12 ./scripts/mutation-containment.sh` used to leave
# `src/core/mojo-containment.ts` modified and a stray backup in /tmp.
#
# `git checkout --` rather than the backup copy, because by the time a trap runs the
# backup may itself be gone; the tree is the authority. Guarded by the dirty-tree
# check above, so this can only ever discard mutations this script introduced.
restore_src() {
  local rc=$?
  git checkout -- "$SRC" 2>/dev/null || cp "$BAK" "$SRC" 2>/dev/null || true
  rm -f "$BAK" 2>/dev/null || true
  return $rc
}
trap restore_src EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

echo "== disk before =="; df -h / | tail -1

run_suite() {   # 0 = green
  $VITEST run "${TESTS[@]}" >"$LOG" 2>&1
}

# Type-check status, kept as DIAGNOSTIC INFORMATION rather than as a verdict.
#
# Read this before "fixing" it to gate on tsc: a failing tsc must NOT by itself
# void a mutation, and measurement says so. vitest transpiles with esbuild, which
# STRIPS types without checking them, so a type error does not stop a single test
# from running. Meanwhile a mutation's whole job is to make the code wrong, and an
# inserted early `return` routinely makes later code unreachable or narrows a union
# differently -- so TS complains about mutations that are perfectly valid at
# runtime.
#
# Measured on this suite: 7 of 28 mutations fail tsc yet kill named tests, e.g.
#   M12 -> TS2339 Property cgroupPath does not exist ... AND
#          x "a non-ENOENT read failure on cgroup.procs fails closed"
#   M22 -> tsc FAIL, 7 named failures
#   M26 -> tsc FAIL, 4 named failures
# Gating on tsc would have discarded all seven as INVALID and under-reported the
# suite's real strength.
#
# What actually distinguishes a false kill is whether any test EXECUTED, which
# `named_failure` measures directly -- see there.
type_checks() {
  ./node_modules/.bin/tsc --noEmit -p tsconfig.json >"$TSCLOG" 2>&1
}

# Did at least one NAMED test fail?
#
# THIS is the real discriminator for a false kill. A mutation that breaks SYNTAX
# fails in vitest's transform stage, before any test runs, and reports
#   Test Files  1 failed
#   Tests       no tests
# which is red while proving nothing. A genuine kill always names the test it broke.
named_failure() {
  # ANSI-strip FIRST. vitest colourises the summary, so `Tests  2 failed` is really
  # `Tests ^[[22m ^[[1m^[[31m2 failed`. An anchored pattern like `Tests +[0-9]+ failed`
  # matches NOTHING against that, which turns every real kill into a false VOID --
  # both ProcTree and Fencing hit exactly this. A false VOID is nastier than a false
  # KILL because it masquerades as rigour.
  #
  # This harness happened to be immune (its pattern was unanchored, and the escapes
  # sit before the digits, verified against real output), but relying on that is
  # luck, so the stripping is now explicit.
  local plain
  plain=$(sed -r 's/\x1b\[[0-9;]*m//g' "$LOG")
  # Require a NAMED failing test line, not just the summary: a transform-stage
  # failure prints `Test Files 1 failed` with `Tests no tests`, and matching the
  # summary alone would read that as a kill.
  printf '%s' "$plain" | grep -qE '^[[:space:]]*(×|✗|FAIL)' \
    && printf '%s' "$plain" | grep -qE 'Tests[[:space:]]+[0-9]+ failed' \
    && ! printf '%s' "$plain" | grep -q 'no tests'
}

echo "== baseline (must be GREEN before we trust anything) =="
if run_suite; then
  echo "baseline: GREEN"
else
  echo "baseline: RED -- aborting, nothing below would be meaningful"
  grep -qi 'ENOSPC\|no space left' "$LOG" && echo "  (ENOSPC detected: this is the disk, not the code)"
  cp "$BAK" "$SRC"; exit 1
fi

run_mutation() {
  local name="$1"; shift
  cp "$BAK" "$SRC"
  "$@"
  if git diff --quiet -- "$SRC"; then
    echo "NO-OP     $name  <-- mutation did not apply; harness bug"
    RESULT=1
    cp "$BAK" "$SRC"
    return
  fi
  local tsc_state=pass
  type_checks || tsc_state=fail
  if run_suite; then
    echo "SURVIVED  $name  <-- rule is NOT pinned by a test"
    RESULT=1
  elif grep -qi 'ENOSPC\|no space left' "$LOG"; then
    echo "VOID      $name  <-- RED but ENOSPC: disk, not a real kill"
    RESULT=1
  # Red must name a failing TEST, not merely a failing suite. If nothing executed,
  # the anchor broke the parse: report it as INVALID (a harness bug to fix) and show
  # the compiler's first complaint, which is almost always the cause.
  elif ! named_failure; then
    if [ "$tsc_state" = fail ]; then
      echo "INVALID   $name  <-- no test executed; anchor breaks the parse ($(head -1 "$TSCLOG" | cut -c1-60))"
    else
      echo "VOID      $name  <-- suite-level red with no named failing test"
    fi
    RESULT=1
  else
    # A genuine kill. `tsc:type-only` is advisory: the mutation is intentionally
    # invalid code, so a type complaint here is expected and is NOT a defect.
    if [ "$tsc_state" = fail ]; then
      echo "killed    $name  ($(grep -oE '[0-9]+ failed' "$LOG" | head -1), tsc:type-only)"
    else
      echo "killed    $name  ($(grep -oE '[0-9]+ failed' "$LOG" | head -1))"
    fi
  fi
  cp "$BAK" "$SRC"
}

# ── original 12: durability, proof, inheritance, identity ────────────────────
run_mutation "M1 unreadable store reads as empty" \
  perl -0pi -e "s/throw new MojoContainmentUnavailableError\(\n            \`cannot read mojo containment store/return { version: 1, sessions: {} }; throw new MojoContainmentUnavailableError(\n            \`cannot read mojo containment store/" "$SRC"

run_mutation "M2 release accepts an unproven verdict" \
  perl -0pi -e "s/if \(!verdict\.proven\) \{/if (false) {/" "$SRC"

run_mutation "M3 failed scan treated as empty" \
  perl -0pi -e "s/if \(!evidence\.scanned\) \{/if (false) {/" "$SRC"

run_mutation "M4 weak handle self-proves without a scan" \
  perl -0pi -e "s/if \(!opts\.scan\) \{/if (opts.scan === undefined \&\& false) {/" "$SRC"

run_mutation "M5 root pid gone counts as proof" \
  perl -0pi -e "s/    const evidence = opts\.scan\(handle\);/    if (readProcStartTime(handle.rootPid, { procRoot: opts.procRoot }) === null) return { proven: true, handle };\n    const evidence = opts.scan(handle);/" "$SRC"

run_mutation "M6 inheritance rewrites tree identity" \
  perl -0pi -e "s/inherited = before\.map\(h => \(\{ \.\.\.h, generation: nextGeneration \}\)\);/inherited = before.map(h => ({ ...h, generation: nextGeneration, ...(h.kind === 'tree-identity' ? { rootPid: 0, startTime: 0 } : {}) }));/" "$SRC"

run_mutation "M7 inheritance drops outstanding handles" \
  perl -0pi -e "s/        if \(before\.length === 0\) return;/        if (before.length >= 0) { delete data.sessions[sessionId]; writeStrict(data, dataDir); return; }/" "$SRC"

run_mutation "M8 pid reuse ignored (no starttime check)" \
  perl -0pi -e "s/    return startTime !== null \&\& startTime === handle\.startTime;/    return startTime !== null;/" "$SRC"

run_mutation "M9 unreadable boot id ages the tree out" \
  perl -0pi -e "s/        return \{ proven: false, handle, reason: 'boot id unreadable; cannot age out the recorded tree' \};/        return { proven: true, handle };/" "$SRC"

run_mutation "M10 malformed handle silently filtered" \
  perl -0pi -e "s/        sessions\[sessionId\] = list\.map\(item => parseHandle\(item, path, sessionId\)\);/        sessions[sessionId] = list.flatMap(item => { try { return [parseHandle(item, path, sessionId)]; } catch { return []; } });/" "$SRC"

run_mutation "M11 any cgroup member count reads as quiescent" \
  perl -0pi -e "s/        if \(pids\.length === 0\) return \{ proven: true, handle \};/        if (pids.length >= 0) return { proven: true, handle };/" "$SRC"

run_mutation "M12 unreadable cgroup.procs reads as quiescent" \
  perl -0pi -e "s/            return \{\n                proven: false,\n                handle,\n                reason: \`cannot read \\\$\{handle\.cgroupPath\}/            return { proven: true, handle }; return {\n                proven: false,\n                handle,\n                reason: \`cannot read \\\${handle.cgroupPath}/" "$SRC"

# ── zombie semantics ────────────────────────────────────────────────────────
run_mutation "M13 executing members no longer block (all discounted)" \
  perl -0pi -e "s/            executing\.push\(pid\);/            zombies.push(pid);/" "$SRC"

run_mutation "M14 unreadable state treated as a zombie (fail-open)" \
  perl -0pi -e "s/        return \(err as NodeJS\.ErrnoException\)\.code === 'ENOENT' \? 'gone' : 'unreadable';/        return 'gone';/" "$SRC"

run_mutation "M15 every state classified as zombie" \
  perl -0pi -e "s/    return state === 'Z' \? 'zombie' : 'running';/    return 'zombie';/" "$SRC"

run_mutation "M16 zombie-only cgroup still blocks (the wedge Fencing reported)" \
  perl -0pi -e "s/            if \(liveness === 'zombie'\) \{ zombies\.push\(pid\); continue; \}/            if (liveness === 'zombie') { executing.push(pid); continue; }/" "$SRC"

# ── boundaryProof provenance ────────────────────────────────────────────────
run_mutation "M17 weak handle mints a boundary proof" \
  perl -0pi -e "s/    \/\/ Proven as far as a weak handle can prove anything — diagnostic only\.\n    return \{ kind: 'diagnostic-clean', boundaryProof: false \};/    return { kind: 'contained-proven', boundaryProof: true };/" "$SRC"

run_mutation "M18 unproven verdict maps to a clean kind" \
  perl -0pi -e "s/    if \\(!verdict\\.proven\\) \\{/    if (!verdict.proven) { return { kind: 'diagnostic-clean', boundaryProof: false }; }\\n    if (!verdict.proven) {/" "$SRC"

run_mutation "M19 empty handle set claims containment" \
  perl -0pi -e "s/    if \(handles\.length === 0\) return \{ kind: 'diagnostic-clean', boundaryProof: false \};/    if (handles.length === 0) return { kind: 'contained-proven', boundaryProof: true };/" "$SRC"

run_mutation "M20 one weak handle no longer downgrades the session" \
  perl -0pi -e "s/        if \(handle\.kind !== 'cgroup'\) allStrong = false;/        void handle;/" "$SRC"

run_mutation "M21 session ignores an unproven handle" \
  perl -0pi -e "s/        if \(!verdict\.proven\) return containmentQuiescence\(verdict\);/        if (!verdict.proven) continue;/" "$SRC"

# ── unprovable hosts must still keep the blocker (ruling (a) prerequisite) ──
run_mutation "M22 barren host mints nothing (blocker dropped)" \
  perl -0pi -e "s/    if \\(bootId === null \\|\\| startTime === null\\) \\{/    if (false) {/" "$SRC"

run_mutation "M23 unprovable handle can be proven quiescent" \
  perl -0pi -e "s/    if \\(handle\\.kind === 'unprovable'\\) \\{\\n        \\/\\/ By construction/    if (handle.kind === 'unprovable') { return { proven: true, handle }; }\\n    if (handle.kind === 'unprovable') {\\n        \\/\\/ By construction/" "$SRC"

run_mutation "M24 unprovable maps to a clean kind instead of unsupported-platform" \
  perl -0pi -e "s/        if \\(verdict\\.handle\\.kind === 'unprovable'\\) \\{\\n            return \\{ kind: 'unsupported-platform', boundaryProof: false, platform: verdict\\.handle\\.platform \\};\\n        \\}//" "$SRC"

run_mutation "M25 the proven fallthrough mints a boundary proof" \
  perl -0pi -e "s/    return \\{ kind: 'diagnostic-clean', boundaryProof: false \\};\\n\\}/    return { kind: 'contained-proven', boundaryProof: true };\\n}/" "$SRC"

run_mutation "M26 unprovable handle silently dropped by the store parser" \
  perl -0pi -e "s/    if \\(h\\.kind === 'unprovable'\\) \\{/    if (h.kind === 'unprovable' \\&\\& false) {/" "$SRC"

# ── a cgroup that cannot be reclaimed must be reported ──────────────────────
run_mutation "M27 rmdir failure silently swallowed again" \
  perl -0pi -e "s/            if \\(code !== 'ENOENT'\\) \\{/            if (false) {/" "$SRC"

run_mutation "M28 warns even on ENOENT (cries wolf on the healthy path)" \
  perl -0pi -e "s/            if \\(code !== 'ENOENT'\\) \\{/            if (true) {/" "$SRC"

# ── restore and PROVE the baseline is green again ───────────────────────────
cp "$BAK" "$SRC"
rm -f "$BAK"
if ! git diff --quiet -- "$SRC"; then
  echo "ERROR: $SRC was not restored byte-identically"
  RESULT=1
fi
echo "== restored baseline (this is what makes every KILLED above trustworthy) =="
if run_suite; then
  echo "restored: GREEN"
else
  echo "restored: RED -- ALL results above are VOID"
  grep -qi 'ENOSPC\|no space left' "$LOG" && echo "  (ENOSPC detected)"
  RESULT=1
fi
echo "== disk after =="; df -h / | tail -1
# Criterion 6: nothing left behind. The trap covers the signal path, but assert it
# explicitly so the run's own output carries the evidence.
if [ -n "$(git status --porcelain)" ]; then
  echo "DIRTY TREE after the run -- possible unreverted mutation:"
  git status --porcelain
  RESULT=1
else
  echo "porcelain: EMPTY (no residue)"
fi
if ls /tmp/containment-src.* >/dev/null 2>&1; then
  echo "stray backup files left in /tmp"; RESULT=1
else
  echo "backups: none left"
fi
if sha256sum -c "$SNAP" >/dev/null 2>&1; then
  echo "restore verified: sha256 matches the pre-run snapshot for $(wc -l < "$SNAP") file(s)"
else
  echo "RESTORE NOT VERIFIED -- sha256 differs from the pre-run snapshot:"
  sha256sum -c "$SNAP" 2>&1 | grep -v ': OK$' | head
  RESULT=1
fi
rm -f "$SNAP"
exit $RESULT
