import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
    expect(envSetup).toContain('engineEnv.BOTMUX_OWNER_OPEN_ID = cfg.ownerOpenId;');
    expect(envSetup).not.toContain('BOTMUX_LARK_APP_SECRET');
  });

  it('dispatches TRAE rollouts to the dedicated task_complete reader', () => {
    const start = workerSource.indexOf('function structuredBridgeIngestPath');
    const end = workerSource.indexOf('\n}\n', start);
    const body = workerSource.slice(start, end);

    expect(body).toContain('if (structuredBridgeIsCodex()) return drainCodexRollout(path, offset);');
    expect(body).toContain('if (structuredBridgeIsTraex()) return drainTraexRollout(path, offset);');
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
  });


  it('follows the adopted TRAE pid so direct local /new rotation is observable', () => {
    expect(workerSource).toContain('maybeFollowTraexSessionRotationViaPid();');
    const start = workerSource.indexOf('function maybeFollowTraexSessionRotationViaPid');
    const end = workerSource.indexOf('\n}\n', start);
    const follower = workerSource.slice(start, end);

    expect(follower).toContain('findTraexRolloutByPid(pid)');
    expect(follower).toContain('persistCliSessionId(observed.cliSessionId);');
    expect(follower).toContain('codexBridgeNotifyCliSessionId(observed.cliSessionId);');
  });

  it('does not silently swallow completed TRAE turns whose final text is empty', () => {
    const start = workerSource.indexOf('function emitReadyCodexTurns');
    const end = workerSource.indexOf('\n}\n\nfunction stopCodexBridge', start);
    const body = workerSource.slice(start, end);

    expect(body).toContain('shouldEmitEmptyCompletedBridgeFallback');
    expect(body).toContain('emptyCompletedBridgeFallbackContent()');
    expect(body).not.toContain('if (!turn.finalText) continue;');
  });
});
