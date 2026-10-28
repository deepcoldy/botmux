import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { publishTurnFinished, turnFinishedSenderOpenId } from '../src/core/turn-finished-event.js';
import { createDashboardEventsStream } from '../src/dashboard/events-sse.js';
import { projectSessionEventForAudience } from '../src/dashboard/public-redact.js';
import type { Session } from '../src/types.js';

function session(extra: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1',
    ownerOpenId: 'ou_owner',
    creatorOpenId: 'ou_creator',
    lastCallerOpenId: 'ou_last',
    ...extra,
  } as Session;
}

describe('turn.finished', () => {
  it('uses the reply-target sender and does not fall back to the owner', () => {
    const withSender = session({
      replyTargets: {
        om_turn: { senderOpenId: 'ou_clicker', participants: [{ openId: 'ou_clicker', isBot: false }], updatedAt: 't' },
      },
    });
    expect(turnFinishedSenderOpenId(withSender, 'om_turn')).toBe('ou_clicker');
    expect(turnFinishedSenderOpenId(session(), 'om_turn')).toBeUndefined();
  });

  it('publishes success and error once per turn attempt on the hook bus and SSE bus', () => {
    const seen: Array<{ type: string; body: Record<string, unknown> }> = [];
    const off = dashboardEventBus.subscribe(event => {
      if (event.type === 'turn.finished') seen.push({ type: event.type, body: event.body as Record<string, unknown> });
    });
    const ds = {
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      session: session({
        sessionId: 'sess-finished',
        replyTargets: {
          om_ok: { senderOpenId: 'ou_sender', participants: [{ openId: 'ou_sender', isBot: false }], updatedAt: 't' },
        },
      }),
    };
    try {
      expect(publishTurnFinished(ds, { turnId: 'om_ok', status: 'completed' })).toBe(true);
      expect(publishTurnFinished(ds, { turnId: 'om_ok', status: 'failed' })).toBe(false);
      expect(publishTurnFinished(ds, { turnId: 'om_bad', status: 'cancelled', dispatchAttempt: 2 })).toBe(true);
      expect(publishTurnFinished(ds, { turnId: 'om_bad', status: 'ambiguous', dispatchAttempt: 3 })).toBe(true);
    } finally {
      off();
    }
    expect(seen.map(event => event.body)).toEqual([
      {
        sessionId: 'sess-finished',
        turnId: 'om_ok',
        status: 'success',
        terminalStatus: 'completed',
        larkAppId: 'cli_app',
        chatId: 'oc_chat',
        senderOpenId: 'ou_sender',
      },
      {
        sessionId: 'sess-finished',
        turnId: 'om_bad',
        status: 'error',
        terminalStatus: 'cancelled',
        larkAppId: 'cli_app',
        chatId: 'oc_chat',
        dispatchAttempt: 2,
      },
      {
        sessionId: 'sess-finished',
        turnId: 'om_bad',
        status: 'error',
        terminalStatus: 'ambiguous',
        larkAppId: 'cli_app',
        chatId: 'oc_chat',
        dispatchAttempt: 3,
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain('ou_owner');
  });

  it('prefers a frozen ledger sender over the live reply target', () => {
    const ds = {
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      session: session({
        sessionId: 'sess-frozen',
        replyTargets: {
          om_steer: { senderOpenId: 'ou_live', participants: [{ openId: 'ou_live', isBot: false }], updatedAt: 't' },
        },
      }),
    };
    const seen: Array<Record<string, unknown>> = [];
    const off = dashboardEventBus.subscribe(event => {
      if (event.type === 'turn.finished') seen.push(event.body as Record<string, unknown>);
    });
    try {
      expect(publishTurnFinished(ds, {
        turnId: 'om_steer',
        dispatchAttempt: 1,
        status: 'completed',
        senderOpenId: 'ou_frozen',
      })).toBe(true);
    } finally {
      off();
    }
    expect(seen[0]?.senderOpenId).toBe('ou_frozen');
  });

  it('runs the user hook for an ordinary session and skips it for a VC receiver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turn-finished-hook-'));
    const script = join(root, 'hook.js');
    const markerDir = join(root, 'markers');
    writeFileSync(script, `
      const fs = require('fs');
      const chunks = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const turnId = JSON.parse(body).turnId;
        fs.mkdirSync(${JSON.stringify(markerDir)}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(markerDir)} + '/' + turnId, body);
      });
    `);
    const hooksFile = join(root, 'hooks.json');
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    writeFileSync(hooksFile, JSON.stringify([
      { event: 'turn.finished', command, timeoutMs: 5000 },
    ]));
    const previous = process.env.BOTMUX_HOOKS_FILE;
    process.env.BOTMUX_HOOKS_FILE = hooksFile;
    const seen: string[] = [];
    const off = dashboardEventBus.subscribe(event => {
      if (event.type === 'turn.finished') seen.push(String((event.body as { turnId?: string }).turnId));
    });
    try {
      const ordinary = {
        larkAppId: 'cli_app',
        chatId: 'oc_chat',
        session: session({
          sessionId: 'sess-hook',
          replyTargets: {
            om_hook: { senderOpenId: 'ou_sender', participants: [{ openId: 'ou_sender', isBot: false }], updatedAt: 't' },
          },
        }),
      };
      expect(publishTurnFinished(ordinary, { turnId: 'om_hook', status: 'completed' })).toBe(true);
      const started = Date.now();
      let ordinaryBody = '';
      while (Date.now() - started < 4000) {
        try {
          ordinaryBody = readFileSync(join(markerDir, 'om_hook'), 'utf8');
          break;
        } catch { /* hook still running */ }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(ordinaryBody).toContain('"event":"turn.finished"');
      expect(ordinaryBody).toContain('ou_sender');
      const elapsed = Date.now() - started;

      const vc = {
        larkAppId: 'cli_app',
        chatId: 'oc_meeting',
        session: session({
          sessionId: 'sess-vc',
          vcMeetingReceiver: {
            listenerAppId: 'listener',
            meetingId: 'meeting',
            memberId: 'member',
            memberEpoch: 1,
          },
          replyTargets: {
            om_vc: { senderOpenId: 'ou_from_meeting', participants: [{ openId: 'ou_from_meeting', isBot: false }], updatedAt: 't' },
          },
        }),
      };
      expect(publishTurnFinished(vc, { turnId: 'om_vc', status: 'completed' })).toBe(true);
      await new Promise(resolve => setTimeout(resolve, Math.max(elapsed, 200) + 300));
      expect(() => readFileSync(join(markerDir, 'om_vc'), 'utf8')).toThrow();
      expect(seen).toEqual(['om_hook', 'om_vc']);
    } finally {
      off();
      if (previous === undefined) delete process.env.BOTMUX_HOOKS_FILE;
      else process.env.BOTMUX_HOOKS_FILE = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not write turn.finished onto anonymous or workbench dashboard streams', () => {
    const payload = {
      sessionId: 's1',
      turnId: 'om_x',
      status: 'success',
      terminalStatus: 'completed',
      larkAppId: 'cli_a',
      chatId: 'oc_c',
      senderOpenId: 'ou_someone',
    };
    const management = projectSessionEventForAudience('turn.finished', payload, 'management');
    expect(management).toBe(payload);
    for (const audience of ['anonymous', 'workbench'] as const) {
      const projected = projectSessionEventForAudience('turn.finished', payload, audience) as Record<string, unknown>;
      expect(projected).not.toHaveProperty('senderOpenId');
      expect(projected).not.toHaveProperty('chatId');
      expect(projected.turnId).toBe('om_x');
      expect(JSON.stringify(projected)).not.toContain('ou_someone');
      expect(JSON.stringify(projected)).not.toContain('oc_c');

      const chunks: string[] = [];
      const res = {
        writableEnded: false,
        write(chunk: string) { chunks.push(chunk); return true; },
        end() { this.writableEnded = true; },
      };
      const stream = createDashboardEventsStream({
        res: res as never,
        authSessionId: audience === 'anonymous' ? null : 'auth-session',
        audience,
        isAuthSessionLive: () => true,
      });
      expect(stream.write('turn.finished', { larkAppId: 'cli_a', body: payload })).toBe(false);
      expect(chunks).toEqual([]);
      expect(stream.write('heartbeat', { ts: 1 })).toBe(true);
      expect(chunks.join('')).toContain('heartbeat');
      expect(chunks.join('')).not.toContain('ou_someone');
    }
  });
});
