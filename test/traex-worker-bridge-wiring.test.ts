import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('TRAE worker structured-bridge wiring', () => {
  it('gives the RPC app-server the non-secret Lark route required by botmux ask', () => {
    const start = workerSource.indexOf('async function engageCodexRpc');
    const end = workerSource.indexOf('engine = new CodexRpcEngine', start);
    const envSetup = workerSource.slice(start, end);

    expect(envSetup).toContain('engineEnv.BOTMUX_SESSION_ID = cfg.sessionId;');
    expect(envSetup).toContain('engineEnv.BOTMUX_CHAT_ID = cfg.chatId;');
    expect(envSetup).toContain('engineEnv.BOTMUX_LARK_APP_ID = cfg.larkAppId;');
    expect(envSetup).toContain('engineEnv.BOTMUX_ROOT_MESSAGE_ID = cfg.rootMessageId;');
    expect(envSetup).toContain("engineEnv.BOTMUX_SESSION_SCOPE = cfg.rootMessageId?.startsWith('om_') ? 'thread' : 'chat';");
    expect(envSetup).toContain('applySessionOwnerEnv(engineEnv, cfg.ownerOpenId);');
    expect(envSetup).not.toContain('BOTMUX_LARK_APP_SECRET');
  });

  it('dispatches TRAE rollouts to the dedicated task_complete reader', () => {
    const start = workerSource.indexOf('function structuredBridgeIngestPath');
    const end = workerSource.indexOf('\n}\n', start);
    const body = workerSource.slice(start, end);

    expect(body).toContain('if (structuredBridgeIsCodex()) return drainCodexRollout(path, offset);');
    // adoptMode is threaded into the TRAE drainer so it does not synthesise a
    // bare sentinel in adopt mode (where transcript text is posted verbatim).
    expect(body).toContain('if (structuredBridgeIsTraex())');
    expect(body).toContain('drainTraexRollout(path, offset, { adoptMode:');
  });

  it('publishes the latest TRAE runtime on attach and incremental ingest', () => {
    const attachStart = workerSource.indexOf('function codexBridgeAttach');
    const attachEnd = workerSource.indexOf('function codexBridgeDetachFile', attachStart);
    const attach = workerSource.slice(attachStart, attachEnd);
    // Baseline modes seed from a bounded backward read; fresh-empty/split-live
    // are excluded so split-live does not re-scan the file it just drained.
    expect(attach).toContain('publishActiveRuntime(readLatestTraexRuntime(rolloutPath))');
    expect(attach).toMatch(/mode !== 'fresh-empty'\s*&&\s*mode !== 'split-live'[\s\S]*?publishActiveRuntime\(readLatestTraexRuntime/);
    // split-live reuses its own drain result rather than a second full scan.
    // Bound the block to the actual `split-live` success branch (up to the
    // `else if (mode === 'split-live')` degraded branch) instead of a fixed
    // char window, so unrelated code inserted ahead of the TRAE publish (e.g.
    // the sibling Codex runtime block) can't push the assertion out of range.
    const splitStart = attach.indexOf("mode === 'split-live' && existsSync");
    const splitEnd = attach.indexOf("} else if (mode === 'split-live')", splitStart);
    expect(splitStart).toBeGreaterThanOrEqual(0);
    expect(splitEnd).toBeGreaterThan(splitStart);
    const splitBlock = attach.slice(splitStart, splitEnd);
    expect(splitBlock).toContain('publishActiveRuntime({');
    expect(splitBlock).toContain('model: traex.latestModel');
    expect(splitBlock).not.toContain('readLatestTraexRuntime');

    const ingestStart = workerSource.indexOf('function codexBridgeIngest');
    const ingestEnd = workerSource.indexOf('function codexBridgeMarkPendingTurn', ingestStart);
    const ingest = workerSource.slice(ingestStart, ingestEnd);
    expect(ingest).toContain('publishActiveRuntime({');
    expect(ingest).toContain('reasoningEffort: traex.latestReasoningEffort ?? publishedActiveRuntime.reasoningEffort');
  });

  it('drains the retired rollout before reattaching a newly verified TRAE session', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('function maybeFollowGrokSessionRotationViaPid', start);
    const notify = workerSource.slice(start, end);
    const traexStart = notify.indexOf('if (structuredBridgeIsTraex())');
    const traexEnd = notify.indexOf('// Grok', traexStart);
    const traex = notify.slice(traexStart, traexEnd);

    expect(traexStart).toBeGreaterThanOrEqual(0);
    expect(traex).toContain("resolveFileBridgePath('traex', { sessionId: cliSessionId })");
    expect(traex.indexOf('codexBridgeIngest();')).toBeLessThan(traex.indexOf('codexBridgeDetachFile();'));
    expect(traex.indexOf('codexBridgeDetachFile();')).toBeLessThan(traex.indexOf("codexBridgeAttach(next, 'fresh-empty');"));
    expect(traex).toContain('codexBridgePendingSessionId = cliSessionId;');
  });

  it('gates the history-derived TRAE re-attach on pid-fd ownership (foreign sibling id refused)', () => {
    // history.jsonl is a global file shared by every TRAE pane under one
    // TRAE_HOME; a sibling pane's identical text (e.g. a bare adopt-mode reply
    // with no unique <session_id>) can surface a foreign id. The rotation branch
    // must refuse to re-attach the bridge to an id THIS pid does not own, and
    // the ownership check must run BEFORE the bridge is detached/re-attached.
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('function maybeFollowGrokSessionRotationViaPid', start);
    const notify = workerSource.slice(start, end);
    const traexStart = notify.indexOf('if (structuredBridgeIsTraex())');
    const traex = notify.slice(traexStart, notify.indexOf('// Grok', traexStart));

    expect(traex).toContain('traexHistorySidOwnedByCurrentPid(cliSessionId)');
    // Gate must precede the detach/re-attach so an unowned id keeps the binding.
    expect(traex.indexOf('traexHistorySidOwnedByCurrentPid(cliSessionId)'))
      .toBeLessThan(traex.indexOf('codexBridgeDetachFile();'));
    expect(traex).toContain('refusing history-only re-attach');
  });

  it('resolves the observed TRAE pid from backend.cliPid → child pid → adopt-pending pid', () => {
    const start = workerSource.indexOf('function currentTraexObservedPid');
    const end = workerSource.indexOf('\n}\n', start);
    const body = workerSource.slice(start, end);

    expect(body).toContain('.cliPid');
    expect(body).toContain('backend?.getChildPid?.()');
    expect(body).toContain('codexAdoptPendingPid');
  });

  it('gates the ownership decision through the pure fail-closed predicate', () => {
    const start = workerSource.indexOf('function traexHistorySidOwnedByCurrentPid');
    const end = workerSource.indexOf('\n}\n', start);
    const body = workerSource.slice(start, end);

    expect(body).toContain('currentTraexObservedPid()');
    expect(body).toContain('findTraexRolloutSetByPid(pid)');
    expect(body).toContain('traexHistorySidIsOwned(cliSessionId, ownedRollouts)');
  });

  it('wires fresh-managed TRAE cliPid so writeInput can prove submit ownership', () => {
    // Without this, backend.cliPid is unset for a normal TRAE PTY/tmux session
    // and the ownership gate can never admit the session id (only adopt mode,
    // via adoptCliPid, would). Both the sync and async(zellij) wiring sites must
    // include traex alongside grok.
    const matches = workerSource.match(/claudeDataDir \|\| cfg\.cliId === 'grok' \|\| cfg\.cliId === 'traex'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(workerSource.match(/codexAdoptPendingPid = wiredPid;/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('gates the TRAE INITIAL bridge attach on pid-fd ownership (adopt mode)', () => {
    // The initial-attach path (no prior rollout bound) must refuse a foreign
    // shared-history sid, mirroring the codex initial-attach gate. Fail closed:
    // keep the poller armed rather than pinning an unverified sid.
    expect(workerSource).toContain('TRAE initial-attach refused for unverified session');
    const idx = workerSource.indexOf('TRAE initial-attach refused');
    const ctx = workerSource.slice(workerSource.lastIndexOf('if (structuredBridgeIsTraex()', idx), idx + 200);
    expect(ctx).toContain("lastInitConfig?.adoptMode && currentTraexObservedPid()");
    expect(ctx).toContain('traexHistorySidOwnedByCurrentPid(cliSessionId)');
  });

  it('gates the TRAE adopt poller attach on resolved-rollout ownership', () => {
    // The 1s poller resolves a pending sid to a rollout path (sessionId-first),
    // so a shared-TRAE_HOME sibling sid would resolve to a foreign rollout.
    // attachOk must verify the resolved rollout's sid is pid-owned before
    // attaching (and before it persists the discovered sid for traex).
    expect(workerSource).toContain('traexAttachGated');
    const idx = workerSource.indexOf('const codexAttachGated');
    const ctx = workerSource.slice(idx, idx + 700);
    expect(ctx).toContain("structuredBridgeIsTraex() && lastInitConfig?.adoptMode");
    expect(ctx).toContain('traexHistorySidOwnedByCurrentPid(sid)');
  });

  it('resolves the real traex leaf under an outer bwrap supervisor (sandbox pid)', () => {
    // Under the file sandbox / credential-only bwrap, getChildPid() is the bwrap
    // supervisor, not traex. resolveTraexOwnershipPid BFS-descends to the leaf so
    // the ownership gate can admit the id; gated on outerBwrapActive (sandbox OR
    // credential-only bwrap, since both produce an outer supervisor).
    const start = workerSource.indexOf('function resolveTraexOwnershipPid');
    const body = workerSource.slice(start, workerSource.indexOf('\n}\n', start));
    expect(body).toContain("findLaunchedCliPid(candidatePid, 'traex')");
    expect(workerSource).toContain('const outerBwrapActive = sandboxRequested || credentialOnlyBwrap;');
  });

  it('drives the sandbox leaf resolver as a BOUNDED RETRY (leaf may not be forked yet)', () => {
    // One-shot resolution loses the common case where bwrap has not exec'd traex
    // at wire time. startTraexSandboxPidResolve reuses scheduleWrapperRealCliPid
    // (the same bounded-retry + stale-backend guard as the wrapperCli resolver),
    // and both the sync and zellij-async wiring sites kick it.
    const start = workerSource.indexOf('const startTraexSandboxPidResolve');
    const body = workerSource.slice(start, start + 900);
    expect(body).toContain('scheduleWrapperRealCliPid(launcherPid');
    expect(body).toContain("findLaunchedCliPid(lp, 'traex')");
    const kicks = workerSource.match(/if \(cfg\.cliId === 'traex' && outerBwrapActive\) startTraexSandboxPidResolve\(/g) ?? [];
    expect(kicks.length).toBeGreaterThanOrEqual(2);
  });


  it('follows the adopted TRAE pid so direct local /new rotation is observable', () => {
    expect(workerSource).toContain('maybeFollowTraexSessionRotationViaPid();');
    const start = workerSource.indexOf('function maybeFollowTraexSessionRotationViaPid');
    const end = workerSource.indexOf('\n}\n', start);
    const follower = workerSource.slice(start, end);

    expect(follower).toContain('findTraexRolloutByPid(pid, currentSid)');
    expect(follower).toContain('persistCliSessionId(observed.cliSessionId);');
    expect(follower).toContain('codexBridgeNotifyCliSessionId(observed.cliSessionId);');
  });

  it('does not silently swallow completed TRAE turns whose final text is empty', () => {
    const start = workerSource.indexOf('function emitReadyCodexTurns');
    const end = workerSource.indexOf('\n}\n\nfunction stopCodexBridge', start);
    const body = workerSource.slice(start, end);

    // The empty-completed fallback is still wired — now via the extracted
    // structuredFallbackKind decision, whose 'empty_completed' branch posts
    // emptyCompletedBridgeFallbackContent().
    expect(body).toContain('structuredFallbackKind');
    expect(body).toContain('emptyCompletedBridgeFallbackContent()');
    expect(body).not.toContain('if (!turn.finalText) continue;');
  });
});
