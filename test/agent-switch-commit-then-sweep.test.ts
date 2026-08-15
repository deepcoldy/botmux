/**
 * Concurrency behaviour of the agent-switch route, verified by RUNNING it.
 *
 * These replace a set of structure guards that matched source strings. Those were
 * shown to be theatre: adding a bare-write producer still passed, wrapping the
 * production call in `if (false)` still passed, and asserting "never decreases"
 * passed while the value was set to 0 next to a dead marker string. Nothing here
 * inspects source text — every case drives the real HTTP route with a real
 * concurrent writer and asserts observable state (disk, live config, sessions).
 *
 * The invariant under test is structural rather than defensive: the switch derives,
 * validates and writes inside ONE locked read-modify-write, and closes sessions
 * only AFTER that commit. There is no window in which a proposal derived from one
 * state can be committed against another, so the whole class of failures that
 * plagued the close-before-commit ordering — lost updates, a partially covered
 * identity axis, stale close targets, cross-process overwrites, ABA on a content
 * hash, read->close TOCTOU — cannot occur, including via writers that follow no
 * protocol at all (a hand-edited bots.json, or an older daemon).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import {
  agentSwitchCloseHook, setLarkAppId, startIpcServer, type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { sessionKey } from '../src/core/types.js';

let handle: IpcServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  workerPool.setActiveSessionsRegistry(new Map());
  sessionStore.init();
  __testOnly_resetBotRegistry();
});

interface Ctx {
  dir: string;
  configPath: string;
  appId: string;
  put: (body: unknown) => Promise<Response>;
  rows: () => any[];
}

async function withBot(
  initialRow: Record<string, unknown>,
  run: (ctx: Ctx) => Promise<void>,
  opts: { frozenCliId?: string; inRegistry?: boolean } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-cts-'));
  const configPath = join(dir, 'bots.json');
  const appId = `cts-${Math.random().toString(36).slice(2, 8)}`;
  const prevBotsConfig = process.env.BOTS_CONFIG;
  const prevDataDir = config.session.dataDir;
  try {
    process.env.BOTS_CONFIG = configPath;
    config.session.dataDir = join(dir, 'data');
    writeFileSync(configPath, JSON.stringify([
      { larkAppId: appId, larkAppSecret: 'secret', ...initialRow },
    ], null, 2));
    loadBotConfigs().forEach((c: any) => registerBot(c));
    sessionStore.init(appId);

    if (opts.frozenCliId) {
      const session = sessionStore.createSession('oc_cts', 'om_cts', 'cts', 'group');
      session.larkAppId = appId;
      session.cliId = opts.frozenCliId as any;
      // The wrapper/runtime axes are only compared for agentFrozen rows, so an
      // unfrozen fixture would make those assertions vacuous.
      session.agentFrozen = true;
      sessionStore.updateSession(session);
      if (opts.inRegistry !== false) {
        workerPool.setActiveSessionsRegistry(new Map([[sessionKey(session.rootMessageId, appId), {
          session, worker: null, workerPort: null, workerToken: null,
          larkAppId: appId, chatId: session.chatId, chatType: 'group', scope: 'thread',
          spawnedAt: Date.now(), cliVersion: 'test', lastMessageAt: Date.now(),
          hasHistory: true,
        } as any]]));
      }
    }
    setLarkAppId(appId);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });

    await run({
      dir,
      configPath,
      appId,
      put: (body) => fetch(`http://127.0.0.1:${handle!.port}/api/bot-agent`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      rows: () => JSON.parse(readFileSync(configPath, 'utf-8')),
    });
  } finally {
    if (prevBotsConfig === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = prevBotsConfig;
    config.session.dataDir = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Session ids the sweep actually closed, captured by wrapping the real hook. */
function captureSweep(): { calls: number; restore: () => void } {
  const original = agentSwitchCloseHook.run;
  const state = { calls: 0, restore: () => { agentSwitchCloseHook.run = original; } };
  agentSwitchCloseHook.run = async (...args: Parameters<typeof original>) => {
    state.calls++;
    return original(...args);
  };
  return state;
}

describe('agent switch — commit then sweep', () => {
  it('closes sessions only AFTER bots.json already holds the new agent', async () => {
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      // Observed at the moment the sweep runs.
      let diskAtSweep: any;
      let liveAtSweep: string | undefined;
      const original = agentSwitchCloseHook.run;
      agentSwitchCloseHook.run = async (...args: Parameters<typeof original>) => {
        diskAtSweep = JSON.parse(readFileSync(ctx.configPath, 'utf-8'))[0];
        liveAtSweep = getBot(ctx.appId).config.cliId;
        return original(...args);
      };
      try {
        const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
        expect(res.status).toBe(200);
      } finally {
        agentSwitchCloseHook.run = original;
      }

      // The ordering IS the fix: with the sweep after the commit there is no
      // window in which a close could be justified by anything but the truth.
      expect(diskAtSweep?.cliId, 'bots.json must already be committed').toBe('codex');
      expect(diskAtSweep?.model).toBe('new-model');
      expect(liveAtSweep, 'the live config must already be committed').toBe('codex');
    });
  });

  it('does not touch the config when a precondition fails', async () => {
    await withBot({ cliId: 'codex', model: 'old-model', reasoningEffort: 'ultra' }, async (ctx) => {
      const sweep = captureSweep();
      try {
        // gpt-5.4 does not support the persisted `ultra`.
        const res = await ctx.put({ cliId: 'codex', model: 'gpt-5.4' });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'reasoning_effort_not_supported_by_model' });
      } finally {
        sweep.restore();
      }
      expect(sweep.calls, 'a rejected switch must not sweep').toBe(0);
      expect(ctx.rows()[0]).toMatchObject({ model: 'old-model', reasoningEffort: 'ultra' });
      expect(getBot(ctx.appId).config.model).toBe('old-model');
    });
  });

  it('a HAND-EDITED bots.json between two switches is honoured, not overwritten blindly', async () => {
    // The decisive case for dropping the cooperative-counter design: this writer
    // follows no protocol at all — it is a plain file edit, exactly what the repo
    // documents as supported and what an older daemon would also produce.
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      expect((await ctx.put({ cliId: 'codex', model: 'm1' })).status).toBe(200);

      // Hand edit: swap the agent AND add a field the daemon never wrote.
      const rows = ctx.rows();
      rows[0].cliId = 'traex';
      rows[0].oncallChats = [{ chatId: 'oc_manual', workingDir: ctx.dir }];
      writeFileSync(ctx.configPath, JSON.stringify(rows, null, 2));

      // A model-only save from an old client must preserve what the human wrote
      // for every field it does not own.
      const res = await ctx.put({ cliId: 'traex', model: 'm2' });
      expect(res.status).toBe(200);
      const after = ctx.rows()[0];
      expect(after.cliId, "the human's agent choice must survive").toBe('traex');
      expect(after.model).toBe('m2');
      expect(after.oncallChats, 'unrelated hand-written fields must survive')
        .toMatchObject([{ chatId: 'oc_manual' }]);
    });
  });

  it('a writer landing during the sweep cannot make the sweep close a correct session', async () => {
    // A->B requested; an external writer commits C while the sweep is running. The
    // session is frozen on C. Because the sweep re-reads the committed authority
    // per session, C is not stale and must survive.
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      const original = agentSwitchCloseHook.run;
      agentSwitchCloseHook.run = async (...args: Parameters<typeof original>) => {
        // Plain file edit + live-config update, i.e. what another daemon's commit
        // looks like from this process's point of view.
        const rows = ctx.rows();
        rows[0].cliId = 'traex';
        writeFileSync(ctx.configPath, JSON.stringify(rows, null, 2));
        getBot(ctx.appId).config.cliId = 'traex' as any;
        return original(...args);
      };
      let sessionId: string;
      try {
        sessionId = sessionStore.listSessions()[0].sessionId;
        const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
        expect(res.status).toBe(200);
      } finally {
        agentSwitchCloseHook.run = original;
      }
      expect(
        sessionStore.getSession(sessionId!)!.status,
        'a session matching the committed authority must never be closed',
      ).toBe('active');
    }, { frozenCliId: 'traex' });
  });

  it('still closes a session the committed authority marks as stale', async () => {
    // The guard must not disable the feature it protects.
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      const sessionId = sessionStore.listSessions()[0].sessionId;
      const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ closedMismatchedSessions: 1 });
      expect(sessionStore.getSession(sessionId)!.status).toBe('closed');
    }, { frozenCliId: 'claude-code' });
  });

  it('sweeps a DURABLE-only row too (absent from the runtime registry)', async () => {
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      const sessionId = sessionStore.listSessions()[0].sessionId;
      const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
      expect(res.status).toBe(200);
      expect(
        sessionStore.getSession(sessionId)!.status,
        'the durable-row loop must run as well',
      ).toBe('closed');
    }, { frozenCliId: 'claude-code', inRegistry: false });
  });

  it('never leaves a partial write when the row disappears mid-request', async () => {
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      writeFileSync(ctx.configPath, JSON.stringify([
        { larkAppId: 'someone-else', larkAppSecret: 's', cliId: 'traex' },
      ], null, 2));
      const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
      expect(res.ok).toBe(false);
      expect(await res.json()).toMatchObject({ error: 'bot_not_in_config' });
      // The other bot's row must be untouched.
      expect(ctx.rows()).toHaveLength(1);
      expect(ctx.rows()[0].larkAppId).toBe('someone-else');
      expect(ctx.rows()[0].cliId).toBe('traex');
    });
  });

  it('derives the preserved runtime from the LOCKED row, not the live snapshot', async () => {
    // The proposal must be computed from the entry the same transaction writes.
    // Deriving it from `getBot().config` reintroduces the original divergence: the
    // live snapshot can already disagree with disk before the request arrives, and
    // a model-only save would then persist whatever that stale object said —
    // silently erasing a runtime/path that is on disk.
    await withBot({
      cliId: 'codex',
      model: 'old-model',
      cliPathOverride: '/opt/legacy/vendor-codex',
    }, async (ctx) => {
      // Drift the in-memory snapshot away from disk, as a partially-applied
      // reload or another code path can.
      delete (getBot(ctx.appId).config as any).cliPathOverride;

      // Old client: {cliId, model} only, so the path must be preserved from the
      // authority — which is the locked row, not the drifted snapshot.
      const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
      expect(res.status).toBe(200);
      expect(
        ctx.rows()[0].cliPathOverride,
        'the persisted path must be preserved from the locked row',
      ).toBe('/opt/legacy/vendor-codex');
      expect(await res.json()).toMatchObject({ cliPathOverride: '/opt/legacy/vendor-codex' });
    });
  });

  it('does not write a generation/fencing field into bots.json', async () => {
    // The cooperative counter was removed: it reset when a row was deleted and
    // recreated, was not stamped by hand edits or older daemons, and lost
    // monotonicity past 2^53. Its absence is asserted so it cannot creep back as a
    // trust anchor.
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      expect((await ctx.put({ cliId: 'codex', model: 'm1' })).status).toBe(200);
      const row = ctx.rows()[0];
      expect(Object.keys(row)).not.toContain('configGen');
      expect(existsSync(`${ctx.configPath}.agent-authority-lease.json`)).toBe(false);
    });
  });
});
