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
import { rmwBotEntry } from '../src/services/config-store.js';

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

  // A CROSS-PROCESS writer commits during the sweep.
  //
  // Crucially this does NOT hand-sync `getBot().config`: another daemon writing
  // bots.json cannot touch this process's memory, and an earlier version of this
  // test did sync it by hand — which hid a real bug, because the sweep was judging
  // closes by that in-memory mirror. Removing the one manual line turned it red.
  // So the writer here only does what a real one can: a locked write to disk.
  const sweepRaceCase = (label: string, inRegistry: boolean) => {
    it(label, async () => {
      await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
        const sessionId = sessionStore.listSessions()[0].sessionId;
        const original = agentSwitchCloseHook.run;
        agentSwitchCloseHook.run = async (...args: Parameters<typeof original>) => {
          // Real locked read-modify-write, i.e. exactly what another daemon does.
          // Deliberately no getBot() update: it is another process.
          await rmwBotEntry(ctx.appId, (entry: any) => {
            entry.cliId = 'traex';
            return { write: true, result: null };
          });
          return original(...args);
        };
        try {
          const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
          expect(res.status).toBe(200);
        } finally {
          agentSwitchCloseHook.run = original;
        }

        // Disk is C; the session is frozen on C, so C endorses it. Closing it would
        // be the unrecoverable error, and no response code could undo it.
        expect(ctx.rows()[0].cliId, 'the other writer must have won on disk').toBe('traex');
        expect(
          sessionStore.getSession(sessionId)!.status,
          'a session the DURABLE authority endorses must never be closed',
        ).toBe('active');
      }, { frozenCliId: 'traex', inRegistry });
    });
  };
  sweepRaceCase(
    'a cross-process commit during the sweep does not close a now-correct session (registry)',
    true,
  );
  sweepRaceCase(
    'a cross-process commit during the sweep does not close a now-correct session (durable-only)',
    false,
  );

  it('stops the whole sweep once disk diverges, rather than closing more rows', async () => {
    // "Miss rather than mis-close": with the authority no longer matching what we
    // committed, no remaining row may be closed either — the newer writer's own
    // sweep and armCliMismatchResweep converge instead.
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      // A second stale session, so there IS a remaining row after the first.
      const extra = sessionStore.createSession('oc_extra', 'om_extra', 'extra', 'group');
      extra.larkAppId = ctx.appId;
      extra.cliId = 'claude-code' as any;
      extra.agentFrozen = true;
      sessionStore.updateSession(extra);

      const original = agentSwitchCloseHook.run;
      agentSwitchCloseHook.run = async (...args: Parameters<typeof original>) => {
        await rmwBotEntry(ctx.appId, (entry: any) => {
          entry.cliId = 'traex';
          return { write: true, result: null };
        });
        return original(...args);
      };
      try {
        const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ closedMismatchedSessions: 0 });
      } finally {
        agentSwitchCloseHook.run = original;
      }
      // Both rows survive: stale relative to what WE wrote, but we no longer own
      // the authority, so we close nothing.
      for (const row of sessionStore.listSessions()) {
        expect(row.status, `${row.sessionId} must be left to the newer writer`).toBe('active');
      }
    }, { frozenCliId: 'claude-code' });
  });

  it('stops the sweep when the durable authority cannot be read', async () => {
    await withBot({ cliId: 'claude-code', model: 'old-model' }, async (ctx) => {
      const sessionId = sessionStore.listSessions()[0].sessionId;
      const original = agentSwitchCloseHook.run;
      agentSwitchCloseHook.run = async (...args: Parameters<typeof original>) => {
        // Corrupt the file after the commit: the sweep can no longer prove that a
        // close is justified.
        writeFileSync(ctx.configPath, '{ not json');
        return original(...args);
      };
      try {
        const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ closedMismatchedFailed: 1 });
      } finally {
        agentSwitchCloseHook.run = original;
      }
      expect(
        sessionStore.getSession(sessionId)!.status,
        'an unreadable authority must not license a close',
      ).toBe('active');
    }, { frozenCliId: 'claude-code' });
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

  it('mirrors the COMMITTED readIsolation into the live config, not a re-derivation', async () => {
    // The live mirror was only written when the transaction CLEARED the flag, so a
    // row that legitimately kept `true` could leave this process reporting/serving
    // `false` until a full refetch.
    await withBot({ cliId: 'claude-code', model: 'old-model', readIsolation: true }, async (ctx) => {
      // Drift the mirror away from disk, which is what a partially applied reload
      // or another code path can leave behind.
      (getBot(ctx.appId).config as any).readIsolation = false;

      const res = await ctx.put({ cliId: 'claude-code', model: 'new-model' });
      expect(res.status).toBe(200);
      // Disk still enforces it…
      expect(ctx.rows()[0].readIsolation).toBe(true);
      // …so both the live config and the response must say so.
      expect(
        getBot(ctx.appId).config.readIsolation,
        'the live mirror must follow the committed entry',
      ).toBe(true);
      expect(await res.json()).toMatchObject({ readIsolation: true });
    });
  });

  it('mirrors the COMMITTED backendType into the live config, not a re-derivation', async () => {
    // The old code decided the live value from the pre-request `bot.config`, so a
    // manual non-remote override that only existed on disk was dropped from the
    // mirror while the entry kept it.
    await withBot({ cliId: 'claude-code', model: 'old-model', backendType: 'tmux' }, async (ctx) => {
      delete (getBot(ctx.appId).config as any).backendType;

      const res = await ctx.put({ cliId: 'codex', model: 'new-model' });
      expect(res.status).toBe(200);
      // A manual, non-remote override must survive an agent switch…
      expect(ctx.rows()[0].backendType).toBe('tmux');
      // …and the mirror must agree with it.
      expect(
        getBot(ctx.appId).config.backendType,
        'the live mirror must follow the committed entry',
      ).toBe('tmux');
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
