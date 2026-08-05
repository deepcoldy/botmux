import { getBot } from '../bot-registry.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { resolveCliRuntime, runtimePathOverride } from '../adapters/cli/runtime.js';
import { decorateResumeForWrapper } from '../setup/cli-selection.js';
import { buildSessionClosedCard } from '../im/lark/card-builder.js';
import { sessionAnchorId, type DaemonSession } from './types.js';
import type { Locale } from '../i18n/index.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function replaceResumeExecutable(command: string, executable: string): string {
  const rest = command.trim().replace(/^\S+/, '').trimStart();
  return rest ? `${shellQuote(executable)} ${rest}` : shellQuote(executable);
}

/**
 * Build the same "session closed" card `/close` emits for a session that is
 * about to be displaced (e.g. a mid-session `/repo` switch reuses the SAME
 * anchor for a fresh session). Without this trace the old context vanishes —
 * relay/adopt/resume all hit `anchor_occupied` once the new session holds the
 * anchor — so the card keeps it visible and carries the terminal
 * `claude --resume` command as the real recovery path.
 *
 * MUST be called BEFORE killWorker/closeSession: it reads the live session's
 * identity (sessionId, cliSessionId, title, workingDir, anchor) straight off
 * `ds`. Returns the card JSON; the caller decides how to deliver it.
 */
export function buildClosedSessionCard(ds: DaemonSession, locale: Locale): string {
  const botCfg = getBot(ds.larkAppId).config;
  const closedSessionId = ds.session.sessionId;
  const closedCliId = ds.session.cliId ?? botCfg.cliId;
  const mayInheritLiveRuntime = !ds.session.agentFrozen && closedCliId === botCfg.cliId;
  // Prefer the session snapshot on every closed/resume surface. A session
  // frozen by an older botmux may only carry cliPathOverride; migrate that
  // descriptor from the SESSION'S path here instead of borrowing today's bot
  // runtime (which may be another Codex distribution after a hot switch).
  const frozenRuntime = ds.session.cliRuntime ?? resolveCliRuntime({
    cliId: closedCliId,
    ...(ds.session.cliPathOverride
      ? { cliPathOverride: ds.session.cliPathOverride }
      : !mayInheritLiveRuntime
        ? {}
        : botCfg.cliRuntime
          ? { cliRuntime: botCfg.cliRuntime }
          : { cliPathOverride: botCfg.cliPathOverride }),
    context: 'closed session cliRuntime',
  });
  const frozenPath = runtimePathOverride(frozenRuntime);
  const frozenWrapper = ds.session.wrapperCli
    ?? (ds.session.agentFrozen ? undefined : botCfg.wrapperCli);
  const frozenModel = ds.session.model
    ?? (ds.session.agentFrozen ? undefined : botCfg.model);
  // `cliPathOverride` historically changed only the executable, never the
  // product copy. Preserve that contract for legacy snapshots; only an
  // explicitly configured runtime opts into a distinct display identity.
  const runtimeDisplayName = frozenRuntime?.source === 'configured'
    ? frozenRuntime.displayName
    : undefined;
  const cliResumeCommand = (() => {
    try {
      const adapter = createCliAdapterSync(closedCliId, frozenPath);
      const raw = adapter.buildResumeCommand?.({
        sessionId: closedSessionId,
        cliSessionId: ds.session.cliSessionId,
      }) ?? null;
      // ttadk 网关：resume 命令必须带 `-m <model> --skip-check`（模型取 bot.model），
      // 否则用户复制粘贴这条命令会卡在 ttadk 的交互式选模型菜单（CoCo 不带 -m）。
      if (!raw) return null;
      return frozenWrapper
        ? decorateResumeForWrapper(raw, frozenWrapper, { ttadkModel: frozenModel })
        : frozenPath
          ? replaceResumeExecutable(raw, frozenPath)
          : raw;
    } catch { return null; }
  })();
  return buildSessionClosedCard(
    closedSessionId,
    sessionAnchorId(ds),
    ds.session.title,
    closedCliId,
    ds.session.workingDir,
    cliResumeCommand,
    locale,
    runtimeDisplayName,
  );
}
