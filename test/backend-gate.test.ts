import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decideBackendGate,
  backendGateUserMessage,
  backendSandboxCompatibilityUserMessage,
} from '../src/adapters/backend/session-backend-selector.js';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('decideBackendGate (PTY 退役 hard gate)', () => {
  it('always spawns when PTY is explicitly requested (escape hatch), even if "unavailable"', () => {
    expect(
      decideBackendGate({ requested: 'pty', available: false, hasExistingSession: false }),
    ).toEqual({ action: 'spawn' });
  });

  it('spawns tmux when the functional probe passes', () => {
    expect(
      decideBackendGate({ requested: 'tmux', available: true, hasExistingSession: false }),
    ).toEqual({ action: 'spawn' });
  });

  it('GATES tmux when probe fails and no live session exists (no silent PTY fallback)', () => {
    const d = decideBackendGate({ requested: 'tmux', available: false, hasExistingSession: false });
    expect(d.action).toBe('gate');
  });

  it('reattaches a live tmux session despite a transient probe failure (PR#249 exemption)', () => {
    expect(
      decideBackendGate({ requested: 'tmux', available: false, hasExistingSession: true }),
    ).toEqual({ action: 'spawn' });
  });

  it('gates herdr / zellij / zmx when unavailable instead of degrading to PTY', () => {
    expect(decideBackendGate({ requested: 'herdr', available: false, hasExistingSession: false }).action).toBe('gate');
    expect(decideBackendGate({ requested: 'zellij', available: false, hasExistingSession: false }).action).toBe('gate');
    expect(decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: false }).action).toBe('gate');
  });

  it('keeps the generic existing-session exemption available for transient probes', () => {
    expect(
      decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: true }),
    ).toEqual({ action: 'spawn' });
  });

  /**
   * Regression: `hasSession()` is `probeSession() === 'exists'`, so it answers
   * `false` both for "no such session" and for "the probe got no answer".
   * Under host load the zellij existence check (`list-sessions`, needs a
   * fork+exec) can be killed by its own timeout; the functional probe then
   * spawns a background session and times out under the same pressure, and a
   * session whose pane was alive the whole time got gated with
   * "zellij 不可用".
   */
  it('does NOT gate zellij when the existence check itself got no answer', () => {
    expect(
      decideBackendGate({
        requested: 'zellij',
        available: false,
        hasExistingSession: false,
        existingSessionUnknown: true,
      }),
    ).toEqual({ action: 'spawn' });
  });

  it('still gates zellij when the session is PROVABLY absent and the probe failed', () => {
    // The guard must keep its teeth: an authoritative "no such session" plus a
    // failed capability probe is the real "zellij is broken" case.
    expect(
      decideBackendGate({
        requested: 'zellij',
        available: false,
        hasExistingSession: false,
        existingSessionUnknown: false,
      }).action,
    ).toBe('gate');
  });

  it('still gates ZMX on an indeterminate ownership probe (opposite asymmetry, unchanged)', () => {
    // ZMX deliberately gates when ownership/protocol cannot be established —
    // adopting someone else's session is the worse outcome there. It never sets
    // existingSessionUnknown, so the zellij/tmux exemption must not reach it.
    expect(
      decideBackendGate({ requested: 'zmx', available: false, hasExistingSession: false }).action,
    ).toBe('gate');
  });

  it('gates on an indeterminate zellij probe ONLY via the explicit flag, not via available=false', () => {
    // Sanity: the exemption is opt-in per call site. A caller that never sets
    // the flag keeps the old fail-closed behaviour.
    expect(
      decideBackendGate({ requested: 'zellij', available: false, hasExistingSession: false }).action,
    ).toBe('gate');
  });

  it('requires the ZMX protocol version before considering a managed live session', () => {
    const start = workerSource.indexOf("} else if (effectiveBackend === 'zmx') {");
    const end = workerSource.indexOf("} else if (effectiveBackend === 'herdr')", start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(gate.indexOf('probeZmxVersion()')).toBeLessThan(gate.indexOf('probeOwnedZmxSession('));
    expect(gate).toContain("resolvedZmxSessionProbe = 'unknown'");
    expect(gate).toContain('hasExistingSession = false');
    // ZMX must NOT opt into the indeterminate-existence exemption: an unproven
    // ownership/protocol result has to keep gating.
    expect(gate).not.toContain('existingSessionUnknown = true');
  });

  it('wires the zellij gate through the tri-state probe, not the boolean hasSession', () => {
    const start = workerSource.indexOf("} else if (effectiveBackend === 'zellij') {");
    const end = workerSource.indexOf("} else if (effectiveBackend === 'zmx')", start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(gate).toContain('ZellijBackend.probeSession(ZellijBackend.sessionName(cfg.sessionId))');
    expect(gate).not.toContain('ZellijBackend.hasSession(');
    // The capability probe runs ONLY on an authoritative 'missing'; an
    // indeterminate answer must not fall through into it and then gate.
    expect(gate).toContain("if (probeState === 'missing')");
    expect(gate).toContain('existingSessionUnknown');
  });

  /**
   * F2 regression: `probeSession` collapses a load-timeout AND a
   * missing/unrunnable binary (ENOENT/EACCES) into the same 'unknown'. Only the
   * load-timeout may take the spawn-instead-of-gate exemption; a genuinely
   * absent zellij must still gate to the actionable install card rather than
   * fall through and crash node-pty with `execvp failed`. The split MUST use a
   * fork-free PATH check (`locateExecutable`), because a fork-based re-probe
   * (`--version` / `isAvailable()`) would time out under the very host load
   * that produced the 'unknown' in the first place.
   */
  it('splits an indeterminate zellij probe by a fork-free PATH check (ENOENT gates, load-timeout spawns)', () => {
    const start = workerSource.indexOf("} else if (effectiveBackend === 'zellij') {");
    const end = workerSource.indexOf("} else if (effectiveBackend === 'zmx')", start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Split happens inside the indeterminate branch, keyed on binary presence.
    const unknownBranch = gate.indexOf('existingSessionUnknown');
    const pathCheck = gate.indexOf("locateExecutable('zellij'");
    expect(pathCheck).toBeGreaterThan(unknownBranch);
    // Absent binary: revoke the exemption AND fail the availability, so
    // decideBackendGate reaches its terminal `gate` arm with the install reason.
    expect(gate).toContain('existingSessionUnknown = false');
    expect(gate).toContain("reason = 'zellij 二进制不在 PATH 上'");
  });

  it('freezes the zellij existence probe and threads it into selectSessionBackend for reattach', () => {
    // F1 wiring: the gate records its tri-state answer once and the selector
    // consumes it (biasing 'unknown' toward reattach), instead of the selector
    // re-running a load-fragile live probe that would fresh-spawn into a
    // collision under sustained load.
    expect(workerSource).toContain('let resolvedZellijSessionProbe: SessionProbe | undefined;');
    expect(workerSource).toContain('resolvedZellijSessionProbe = probeState;');
    // Selector wiring: zellij reattaches on exists OR unknown, cold-spawns only
    // on an authoritative missing.
    const selectCall = workerSource.indexOf('const selectBackend = () => selectSessionBackend({');
    const selectEnd = workerSource.indexOf('let selectedBackend = selectBackend();', selectCall);
    const selectBlock = workerSource.slice(selectCall, selectEnd);
    expect(selectBlock).toContain("effectiveBackend === 'zellij'");
    expect(selectBlock).toContain("resolvedZellijSessionProbe !== undefined && resolvedZellijSessionProbe !== 'missing'");
  });

  it('resets the frozen zellij probe to missing after every post-kill re-selection', () => {
    // Both persistent teardown gates must refresh the frozen zellij probe so a
    // re-selection cold-spawns a fresh pane rather than reattaching to the one
    // they just killed — but each gate's own strictness differs:
    //  - read-isolation already throws unless the post-kill probe proved
    //    'missing', so by then the pane is known gone → assign 'missing'.
    //  - mcp-gateway only rejects a PROVEN-LIVE pane, so 'unknown' still
    //    reaches its reset and must fail closed to 'missing' explicitly.
    // Both post-kill resets are keyed off `postKillProbe`; every one of them
    // must end at 'missing' so a teardown never leaves a reattachable state.
    const postKillResets = (workerSource.match(/resolvedZellijSessionProbe = [^;\n]+;/g) ?? [])
      .filter(r => r.includes('postKillProbe') || r === "resolvedZellijSessionProbe = 'missing';");
    // 3 = read-isolation confirmPaneGone + mcp-gateway + the not-installed gate
    // (all three converge on 'missing'); the two teardown ones are the point.
    expect(postKillResets.length).toBeGreaterThanOrEqual(2);
    for (const reset of postKillResets) {
      expect(reset).toContain("'missing'");
    }
    // The laxer gate keeps its explicit fail-closed on an unproven answer.
    expect(workerSource).toContain("resolvedZellijSessionProbe = postKillProbe === 'exists' ? 'exists' : 'missing';");
    // And the stricter read-isolation gate records the proven-gone pane.
    const confirmGone = workerSource.indexOf('confirmPaneGone: () => {');
    const confirmGoneEnd = workerSource.indexOf('clearProvenanceVerified: () => {', confirmGone);
    expect(confirmGone).toBeGreaterThan(-1);
    expect(workerSource.slice(confirmGone, confirmGoneEnd))
      .toContain("resolvedZellijSessionProbe = 'missing';");
  });

  it('fails closed on an indeterminate zellij pane in the mcp-gateway gate (no silent reattach to a possibly-dead host)', () => {
    // The pre-spawn bias reattaches zellij on 'unknown', but an MCP-gateway pane
    // must not: reattaching binds the CLI to a relay socket that cannot survive
    // this worker, and the gate only cold-resumes on a proven 'exists'. So an
    // unverifiable zellij pane here must refuse, exactly like zmx.
    const start = workerSource.indexOf('if (cliAdapter.mcpGateway && mcpRuntimeManifest?.entries.length');
    const end = workerSource.indexOf('// The plugin set is stable only', start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(gate).toContain("if (effectiveBackendType === 'zellij' && paneProbe === 'unknown')");
    // It must throw (refuse), not fall through into a reattach.
    const zellijUnknown = gate.indexOf("effectiveBackendType === 'zellij' && paneProbe === 'unknown'");
    const nextThrow = gate.indexOf('throw new Error', zellijUnknown);
    expect(nextThrow).toBeGreaterThan(zellijUnknown);
  });
});

describe('backendGateUserMessage', () => {
  it('includes the reason, an install hint, and the explicit PTY escape hatch', () => {
    const msg = backendGateUserMessage('tmux', 'tmux 二进制不在 PATH 上');
    expect(msg).toContain('tmux 不可用');
    expect(msg).toContain('tmux 二进制不在 PATH 上');
    expect(msg).toContain('brew install tmux');
    expect(msg).toContain('BACKEND_TYPE=pty');
  });

  it('includes the supported ZMX version floor and an actionable install hint', () => {
    const msg = backendGateUserMessage('zmx', 'zmx 二进制不在 PATH 上');
    expect(msg).toContain('zmx >= 0.7.0');
    expect(msg).toContain('client leadership');
    // The hint must tell the user how to actually install it, not to wait for
    // an unreleased upstream build (0.7.0 has shipped).
    expect(msg).toContain('brew install neurosnap/tap/zmx');
    expect(msg).not.toContain('等待');
  });
});

describe('persistent-backend filesystem-isolation gate', () => {
  it('formats an actionable startup error before failing closed', () => {
    const msg = backendSandboxCompatibilityUserMessage(
      'backend "zmx" does not support file/read isolation',
    );
    expect(msg).toContain('backend "zmx"');
    expect(msg).toContain('拒绝启动');
    expect(msg).toContain('tmux');
    expect(msg).toContain('pty');
    expect(msg).toContain('sandbox');
    expect(msg).toContain('readIsolation');
  });

  it('gates on the unified effective isolation before selecting or mutating a backend', () => {
    const start = workerSource.indexOf('const sandboxRequested =');
    const end = workerSource.indexOf('const fullIsolationCoversCredentials =', start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(gate).toContain('backendSandboxCompatibilityError({');
    expect(gate).toContain('fileSandboxRequested: sandboxRequested');
    // readIsolation is already folded into sandboxRequested on every host.
    expect(gate).toContain('effectiveReadIsolationRequested: false');
    expect(gate).not.toContain('effectiveReadIsolationRequested: cfg.readIsolation');
    expect(gate).not.toContain("type: 'user_notify'");
    const compatibilityCheck = gate.indexOf('backendSandboxCompatibilityError({');
    const failure = gate.indexOf('throw new Error');
    expect(compatibilityCheck).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(compatibilityCheck);
    expect(gate).toContain(
      'throw new Error(backendSandboxCompatibilityUserMessage(backendIsolationGate))',
    );
    expect(workerSource.indexOf('const selectBackend =', start)).toBeGreaterThan(end);
  });
});

describe('persistent backend cold-restart ordering', () => {
  it('retires an incompatible recorded Herdr agent before selecting, stamping, or spawning its replacement', () => {
    const reuseDecision = workerSource.indexOf('const reuseRecordedHerdrTarget =');
    const retirement = workerSource.indexOf(
      'retireSupersededRecordedHerdrTarget({',
      reuseDecision,
    );
    const selection = workerSource.indexOf(
      'const selectBackend = () => selectSessionBackend({',
      retirement,
    );
    const stamp = workerSource.indexOf(
      'cfg.persistentBackendTarget = selectedBackend.persistentBackendTarget;',
      selection,
    );
    const spawn = workerSource.indexOf('backend.spawn(', stamp);
    const gate = workerSource.slice(reuseDecision, selection);

    expect(reuseDecision).toBeGreaterThan(-1);
    expect(retirement).toBeGreaterThan(reuseDecision);
    expect(selection).toBeGreaterThan(retirement);
    expect(stamp).toBeGreaterThan(selection);
    expect(spawn).toBeGreaterThan(stamp);
    expect(gate).toContain("effectiveBackend === 'herdr'");
    expect(gate).toContain('persistentBackendTarget: cfg.persistentBackendTarget');
    expect(gate).toContain('ownershipScope: isolationRuntimeDataDir');
    expect(gate).toContain('reuseRecordedHerdrTarget');
  });

  // The backend is selected once up-front and RE-selected through the
  // `selectBackend()` thunk after any gate kills a stale pane. The invariant is
  // no longer "select last" but "never keep a selection made against a pane that
  // was just destroyed" — a stale `isReattach: true` would reattach the new
  // backend to the pane the gate had removed.
  it('re-selects the backend after every gate that kills a stale persistent pane', () => {
    const thunk = workerSource.indexOf('const selectBackend = () => selectSessionBackend({');
    expect(thunk).toBeGreaterThan(-1);

    // Each `killPersistentBackendTarget` / `ZmxBackend.killManagedSession` gate
    // must be followed by a re-selection before the backend is used. The
    // read-isolation kill now lives in the migrationEffects closures; the mcp gate
    // is still inline.
    const gates = [
      workerSource.indexOf('const migrationEffects: PersistentPaneMigrationEffects = {'),
      workerSource.indexOf('if (cliAdapter.mcpGateway && mcpRuntimeManifest?.entries.length'),
    ];
    for (const gate of gates) {
      expect(gate).toBeGreaterThan(-1);
      const reselect = workerSource.indexOf('selectedBackend = selectBackend();', gate);
      expect(reselect).toBeGreaterThan(gate);
      // ...and the re-selection must refresh the reattach decision too.
      expect(
        workerSource.indexOf('willReattachPersistent = selectedBackend.isReattach === true;', gate),
      ).toBeGreaterThan(gate);
    }
  });

  it('fails closed on an uncertain MCP pane and refreshes the cached ZMX probe after killing it', () => {
    const start = workerSource.indexOf(
      'if (cliAdapter.mcpGateway && mcpRuntimeManifest?.entries.length',
    );
    const end = workerSource.indexOf('// The plugin set is stable only', start);
    const gate = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // ZMX ownership is verified against the frozen PID; other backends go
    // through the exact recorded target (Herdr may own an agent, not a session).
    expect(gate).toContain('probeOwnedZmxSession(');
    expect(gate).toContain('probePersistentBackendTarget(');
    expect(gate).toContain("paneProbe === 'unknown'");
    expect(gate).toContain('shouldRejectPersistentPostKillProbe(');
    expect(gate).toContain("effectiveBackendType === 'zmx'");
    expect(gate).toContain('resolvedZmxSessionProbe = postKillProbe');
  });

  it('read-isolation gate fail-closes on an inconclusive probe for EVERY backend; mcp-gateway keeps its ZMX-scoped semantics', () => {
    const readIsolationStart = workerSource.indexOf(
      "if (persistentSessionName && effectiveBackendType !== 'pty' && persistentPaneGuardApplies) {",
    );
    const readIsolationEnd = workerSource.indexOf('let willReattachPersistent', readIsolationStart);
    const mcpStart = workerSource.indexOf(
      'if (cliAdapter.mcpGateway && mcpRuntimeManifest?.entries.length',
    );
    const mcpEnd = workerSource.indexOf('// The plugin set is stable only', mcpStart);
    const readIsolationGate = workerSource.slice(readIsolationStart, readIsolationEnd);
    const mcpGate = workerSource.slice(mcpStart, mcpEnd);

    expect(readIsolationStart).toBeGreaterThan(-1);
    expect(readIsolationEnd).toBeGreaterThan(readIsolationStart);
    expect(mcpStart).toBeGreaterThan(-1);
    expect(mcpEnd).toBeGreaterThan(mcpStart);

    // ── read-isolation gate (this PR): liveness is TRI-STATE. `unknown` is routed
    //    through the state machine (refuse-inconclusive-probe) for ALL backends, so
    //    the OLD ZMX-only early `unknown` throw is GONE, and the post-kill confirm
    //    requires an authoritative `missing` (NOT the ZMX-scoped shared helper). ──
    expect(readIsolationGate).not.toContain(
      "if (effectiveBackendType === 'zmx' && paneProbe === 'unknown')",
    );
    expect(readIsolationGate).toContain('paneProbe,'); // passed tri-state into the state machine
    expect(readIsolationGate).toContain("postKillProbe !== 'missing'");
    expect(readIsolationGate).not.toContain('shouldRejectPersistentPostKillProbe(');
    expect(readIsolationGate).toContain('refuseInconclusiveProbe:');

    // ── mcp-gateway gate (pre-existing, unchanged): still ZMX-scoped unknown +
    //    shared helper. Not in scope for the no-transport tri-state fix. ──
    expect(mcpGate).toContain("if (effectiveBackendType === 'zmx' && paneProbe === 'unknown')");
    expect(mcpGate).toContain('shouldRejectPersistentPostKillProbe(');
  });

  it('verifies read-isolation teardown against the exact captured backend target', () => {
    const start = workerSource.indexOf('const staleSessionName = persistentSessionName;');
    const end = workerSource.indexOf('let willReattachPersistent', start);
    const gate = workerSource.slice(start, end);
    const capture = gate.indexOf(
      'const stalePersistentTarget = selectedBackend.persistentBackendTarget;',
    );
    const kill = gate.indexOf(
      'killPersistentBackendTarget(stalePersistentTarget, cfg.sessionId)',
    );
    const postKillProbe = gate.indexOf(
      'probePersistentBackendTarget(stalePersistentTarget)',
      kill,
    );
    const reselect = gate.indexOf('selectedBackend = selectBackend();');

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(kill).toBeGreaterThan(capture);
    expect(postKillProbe).toBeGreaterThan(kill);
    expect(reselect).toBeGreaterThan(postKillProbe);
  });

  it('refreshes the frozen ZMX probe before read-isolation re-selects the backend', () => {
    const start = workerSource.indexOf('const migrationEffects: PersistentPaneMigrationEffects = {');
    const end = workerSource.indexOf('let willReattachPersistent', start);
    const gate = workerSource.slice(start, end);
    const postKillProbe = gate.indexOf('const postKillProbe =');
    const frozenProbeRefresh = gate.indexOf('resolvedZmxSessionProbe = postKillProbe', postKillProbe);
    const reselect = gate.indexOf('selectedBackend = selectBackend();');

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(postKillProbe).toBeGreaterThanOrEqual(0);
    expect(frozenProbeRefresh).toBeGreaterThan(postKillProbe);
    expect(reselect).toBeGreaterThan(frozenProbeRefresh);
  });
});

describe('ZMX observer crash cleanup', () => {
  it('detaches zmx tail from the synchronous worker exit hook without destroying the session', () => {
    const start = workerSource.indexOf("process.on('exit'");
    const end = workerSource.indexOf("process.on('uncaughtException'", start);
    const exitHook = workerSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(exitHook).toContain('backend instanceof ZmxBackend');
    expect(exitHook).toContain('backend.kill()');
    expect(exitHook).not.toContain('destroySession');
  });
});

describe('live-only observer screen rebase', () => {
  it('renders authoritative history without driving startup keys from an uncertain viewport', () => {
    const handlerStart = workerSource.indexOf('function onBackendScreenResync(');
    const handlerEnd = workerSource.indexOf('function releaseRawInputRestartGate', handlerStart);
    const handler = workerSource.slice(handlerStart, handlerEnd);
    const registration = workerSource.indexOf('backend.onScreenResync?.(');

    expect(handlerStart).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(handlerStart);
    expect(handler).toContain('const revision = ++backendScreenRevision');
    expect(handler).toContain('const observedScreenBackend = backend');
    expect(handler).toContain('lastPtyActivityAtMs = now');
    expect(handler).toContain('await nextRenderer.writeAndFlush(snapshot)');
    expect(handler).toContain('backendScreenRevision !== revision');
    expect(handler).toContain('backend !== observedScreenBackend');
    expect(handler).toContain('renderer !== nextRenderer');
    expect(handler).toContain("const visibleSnapshot = nextRenderer?.rawSnapshot() ?? ''");
    expect(handler).toContain('lastAnalyzerSnapshot = visibleSnapshot');
    expect(handler).toContain('idleDetector?.reset()');
    expect(handler).not.toContain('idleDetector.feed(');
    expect(handler).toContain('workflowTranscript = snapshot.slice');
    expect(handler).not.toContain('handleVisibleStartupInteraction(visibleSnapshot)');
    expect(handler).not.toContain('handleVisibleStartupInteraction(snapshot)');
    expect(handler).toContain('function scheduleBackendScreenResync(');
    expect(handler).toContain('onBackendScreenResync(snapshot).catch');
    expect(workerSource.slice(registration, registration + 400))
      .toContain('scheduleBackendScreenResync(snapshot');
    const seedStart = workerSource.indexOf('function seedBackendScreen(');
    const seedEnd = workerSource.indexOf('function captureBackendScreen(', seedStart);
    expect(workerSource.slice(seedStart, seedEnd))
      .toContain('scheduleBackendScreenResync(initial, source)');
  });

  it('shares update and trust dialog handling with incremental PTY output', () => {
    const helperStart = workerSource.indexOf('function handleVisibleStartupInteraction(');
    // Use the next stable declaration as the end delimiter (not a comment,
    // which changes when runner CLIs are added to the OSC set).
    const helperEnd = workerSource.indexOf('const APP_RUNNER_OSC_CLI_IDS', helperStart);
    const helper = workerSource.slice(helperStart, helperEnd);
    const ptyStart = workerSource.indexOf('function onPtyData(');
    const ptyEnd = workerSource.indexOf('function onBackendScreenResync(', ptyStart);
    const ptyHandler = workerSource.slice(ptyStart, ptyEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain('dismissAidenCodexUpdateDialog(data)');
    expect(helper).toContain('TRUST_DIALOG_PATTERN.test(stripped)');
    expect(helper).toContain("sendSpecialKeys('Enter')");
    expect(ptyHandler).toContain('handleVisibleStartupInteraction(data)');
  });

  it('fails closed on ZMX screen-derived key automation when geometry is unknown', () => {
    const stuckStart = workerSource.indexOf('function startStuckDetector(');
    const stuckEnd = workerSource.indexOf('function stopStuckDetector(', stuckStart);
    const pickerStart = workerSource.indexOf('async function driveCocoPicker(');
    const pickerEnd = workerSource.indexOf('/** Synchronously read the latest', pickerStart);
    const keyStart = workerSource.indexOf("case 'tui_keys':");
    const keyEnd = workerSource.indexOf("case 'coco_drive_picker':", keyStart);
    const busyStart = workerSource.indexOf('function probeBusyPatternIdle(');
    const busyEnd = workerSource.indexOf('function scheduleBusyPatternIdleProbe(', busyStart);

    expect(workerSource.slice(stuckStart, stuckEnd))
      .toContain('if (!backendScreenEvidenceIsAuthoritativeForMutation()) return false');
    expect(workerSource.slice(pickerStart, pickerEnd))
      .toContain('if (!backendScreenEvidenceIsAuthoritativeForMutation())');
    expect(workerSource.slice(pickerStart, pickerEnd))
      .toContain("type: 'user_notify'");
    expect(workerSource.slice(keyStart, keyEnd))
      .toContain('if (!backendScreenEvidenceIsAuthoritativeForMutation())');
    expect(workerSource.slice(keyStart, keyEnd))
      .toContain("type: 'stuck_warning_expired'");
    expect(workerSource.slice(busyStart, busyEnd))
      .toContain('if (!backendScreenEvidenceIsAuthoritativeForMutation())');
    expect(workerSource).toContain('function classifyScreenUsageLimit(');
    expect(workerSource).toContain('...classifyScreenUsageLimit(usageLimitContent, status)');
  });
});
