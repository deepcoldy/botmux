import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { OncallGroupStore } from '../src/services/oncall-group-store.js';
import { projectGroupContextCard } from '../src/im/lark/group-context-card.js';
import { setGroupContextSettings } from '../src/services/group-context-settings-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { bindGroupContextDelivery, confirmGroupContextDelivery, getDeliveredGroupContextSeqs, writePreparedGroupContext } from '../src/services/group-context-delivery-store.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';
import { DEFAULT_BRAND_LABEL } from '../src/im/lark/md-card.js';
import {
  shouldEmitEmptyCompletedBridgeFallback,
  type BridgeSendMarker,
} from '../src/services/bridge-fallback-gate.js';
import MarkdownIt from 'markdown-it';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const key = { larkAppId: 'cli_test', sessionId: 'sid_reply', turnId: 'om_turn' };
const presentation = { showProcess: true, showToolResults: true, canStop: true };

describe('real CLI send into a running reply card', () => {
  it.each([
    {
      name: 'Pi current-session --mention',
      cliId: 'pi',
      sendArgs: ['--mention', 'ou_reviewer:ReviewBot'],
      deliveryKind: 'current_session_send',
    },
    {
      name: 'Grok top-level detour',
      cliId: 'grok',
      sendArgs: ['--no-mention', '--top-level'],
      deliveryKind: 'detoured_send',
    },
  ] as const)('records $name as exact empty-final reply evidence', ({ cliId, sendArgs, deliveryKind }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-visible-reply-marker-'));
    const dataDir = join(root, 'data');
    const turnId = `om_${cliId}_visible_reply`;
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: key.sessionId,
        turnId,
      }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId,
        larkAppSecret: 'test-secret',
        cliId,
        replyCardMode: 'legacy',
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        sessionId: key.sessionId,
        status: 'active',
        cliId,
        larkAppId: key.larkAppId,
        chatId: 'oc_test',
        rootMessageId: 'om_root',
        scope: 'thread',
        chatType: 'group',
        workingDir: root,
      } });
      const result = spawnSyncTsScript(
        fixture,
        ['send', ...sendArgs, 'Visible result already delivered.'],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: {
            PATH: process.env.PATH,
            HOME: root,
            SESSION_DATA_DIR: dataDir,
            BOTS_CONFIG: join(root, 'bots.json'),
            BOTMUX_SESSION_ID: key.sessionId,
            BOTMUX_LARK_APP_ID: key.larkAppId,
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(result.status, String(result.stderr)).toBe(0);
      const markerPath = join(dataDir, 'turn-sends', `${key.sessionId}.jsonl`);
      const markers = readFileSync(markerPath, 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as BridgeSendMarker);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        sessionId: key.sessionId,
        turnId,
        deliveryKind,
        targetChatId: 'oc_test',
        messageId: 'om_separate_message',
      });
      expect(shouldEmitEmptyCompletedBridgeFallback({
        sessionId: key.sessionId,
        turnId,
        markTimeMs: undefined,
        isLocal: false,
        finalText: '',
        terminalStatus: 'completed',
      }, undefined, markers, false)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);

  it.each([
    ['table', '| A | B |\n| --- | --- |\n| 1 | 2 |', 'table'],
    ['image', '![Preview](img_v3_footer_test)', 'column_set'],
    ['chart', '```vega-lite\n{"data":{"values":[{"d":"a","v":1}]},"mark":"bar","encoding":{"x":{"field":"d"},"y":{"field":"v"}}}\n```', 'chart'],
    ['titled chart', '```vega-lite\n{"title":"Sales","data":{"values":[{"d":"a","v":1}]},"mark":"bar","encoding":{"x":{"field":"d"},"y":{"field":"v"}}}\n```', 'chart'],
  ])('keeps a pure %s final free of Footer while retaining group-context purpose', (_kind, content, tag) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-footer-carrier-'));
    const dataDir = join(root, 'data');
    try {
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId: 'codex',
        replyCardMode: 'legacy', replyFooterEnabled: false,
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        sessionId: key.sessionId, status: 'active', cliId: 'codex', larkAppId: key.larkAppId,
        chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
      } });
      const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'final', '--image-mode', 'medium', content], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const captured = String(result.stdout).split('\n').find(line => line.startsWith('CAPTURE_REPLY='));
      expect(captured).toBeDefined();
      const raw = JSON.parse(captured!.slice('CAPTURE_REPLY='.length)).body.content;
      const card = JSON.parse(raw);
      expect(card.body.elements.map((element: any) => element.tag)).toEqual([tag]);
      expect(raw).not.toContain('botmux_reply_footer');
      const projected = projectGroupContextCard(raw);
      expect(projected?.kind).toBe('conversation');
      if (projected?.kind !== 'conversation') throw new Error('Missing group-context message purpose');
      expect(projected.turnReply).toBe(false);
      expect(projected.content).not.toContain('\u2063');
      if (_kind === 'image') expect(projected.content).toContain('img_v3_footer_test');
      else if (tag === 'chart') {
        expect(card.body.elements[0].chart_spec.data.values).toEqual([{ d: 'a', v: 1 }]);
        expect(projected.content).toContain('"c1":1');
      } else expect(projected.content).toContain('"c0":"1"');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each<{ cliId: string; configuredCliId: string; frozenCliId?: string; mode?: 'legacy' | 'unified'; layout?: 'result'; footerOff?: boolean }>([
    { cliId: 'codex', configuredCliId: 'codex', footerOff: true },
    { cliId: 'claude-code', configuredCliId: 'claude-code', footerOff: true },
    { cliId: 'codex', configuredCliId: 'codex', mode: 'unified', footerOff: true },
    { cliId: 'cursor', configuredCliId: 'cursor' },
    { cliId: 'minimax', configuredCliId: 'minimax' },
    { cliId: 'codex', configuredCliId: 'codex' },
    { cliId: 'traex', configuredCliId: 'traex' },
    { cliId: 'claude-code', configuredCliId: 'claude-code' },
    { cliId: 'codex', configuredCliId: 'codex', layout: 'result' },
    { cliId: 'codex', configuredCliId: 'minimax' },
    { cliId: 'minimax', configuredCliId: 'codex' },
    { cliId: 'minimax', configuredCliId: 'minimax', frozenCliId: 'codex' },
    { cliId: 'codex', configuredCliId: 'codex', frozenCliId: 'minimax' },
    ...['minimax', 'traex', 'codex', 'claude-code'].map(cliId => ({ cliId, configuredCliId: cliId, mode: 'unified' as const })),
  ])('repairs reply fences for $cliId (default $configuredCliId, launch $frozenCliId, mode $mode, layout $layout)', ({ cliId, configuredCliId, frozenCliId, mode = 'legacy', layout, footerOff }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-reply-markdown-'));
    const dataDir = join(root, 'data');
    const runtime = cliId === 'cursor'
      ? { model: 'claude-opus-5-5-high-fast' }
      : { model: 'selected-model', reasoningEffort: 'high' };
    const content = [ ...(layout ? ['# 依赖检查完成', ''] : []), '实际进程：```plain_text', '123 update', '└ 456 download', '```', '', '配置： ```JSON', '{\"workingDir\":\"/workspace\"}', '```', '', '执行： ```bash', 'echo ready', '```', '', '**请选择：**', '1. 保持下载', '2. 清理残留'].join('\n');
    try {
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId: configuredCliId, replyCardMode: mode, ...(footerOff ? { replyFooterEnabled: false } : {}),
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        sessionId: key.sessionId, status: 'active', cliId, cliSessionId: 'native_reply', ...runtime,
        larkAppId: key.larkAppId, chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
        ...(frozenCliId ? { cliLaunchSnapshot: {
          version: 1, state: 'resolved', entryId: 'fixture', cliId: frozenCliId, cliRuntime: null,
          cliPathOverride: null, wrapperCli: null, model: null, reasoningEffort: null, launchShell: null, startupCommands: [],
        } } : {}),
      } });
      const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'final', ...(layout ? ['--layout', layout] : []), content], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(requests).toHaveLength(1);
      const card = JSON.parse(requests[0].body.content);
      const markdown = card.body.elements.filter((e: any) => e.tag === 'markdown').map((e: any) => e.content).join('\n');
      if (layout) {
        expect(card.header.title.content).toBe('结果 · 依赖检查完成');
        expect(markdown).not.toContain('# 依赖检查完成');
      }
      const code = new MarkdownIt().parse(markdown, {}).find(token => token.type === 'fence')!;
      expect(code.content).toBe('123 update\n└ 456 download\n');
      const blocks = new MarkdownIt().parse(markdown, {}).filter(token => token.type === 'fence');
      expect(blocks.map(b => b.info.toLowerCase())).toEqual(['plain_text', 'json', 'bash']);
      expect(blocks[2].content).toBe('echo ready\n');
      expect(markdown).toContain('**请选择：**');
      const footer = card.body.elements.find((e: any) => e.element_id === 'botmux_reply_footer');
      if (footerOff) {
        expect(footer).toBeUndefined();
        expect(card.body.elements.some((e: any) => e.tag === 'hr')).toBe(false);
      } else {
        expect(footer.content).toContain(`**${runtime.model}**`);
        if (runtime.reasoningEffort) expect(footer.content).toContain('high');
      }
      const store = openDatabaseSyncOrThrow(join(dataDir, 'session-stores', key.larkAppId, 'sessions.db'), { readOnly: true });
      try {
        const row = store.prepare('SELECT row FROM sessions WHERE session_id = ?').get(key.sessionId) as { row: string };
        expect(JSON.parse(row.row).cliId).toBe(cliId);
      } finally { store.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each<{
    cliId: string; args: string[]; senderIsBot: boolean | undefined; merged: boolean;
    sandbox?: boolean; sandboxEnv?: NodeJS.ProcessEnv; reserveCard?: boolean; oncall?: boolean;
    responseKind?: 'progress' | 'final' | 'auxiliary' | null;
  }>([
    { cliId: 'claude-code', args: ['--mention-back'], senderIsBot: false, merged: true },
    { cliId: 'codex', args: ['--mention-back'], senderIsBot: false, merged: true },
    { cliId: 'grok', args: ['--mention-back'], senderIsBot: false, merged: true },
    { cliId: 'grok', args: ['--no-mention'], senderIsBot: false, merged: true, responseKind: 'progress' },
    { cliId: 'grok', args: ['--no-mention'], senderIsBot: false, merged: false, sandbox: true },
    { cliId: 'claude-code', args: ['--mention', 'ou_requester'], senderIsBot: false, merged: true },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: true },
    { cliId: 'claude-code', args: ['--mention', 'ou_other'], senderIsBot: false, merged: false },
    { cliId: 'claude-code', args: ['--mention-back'], senderIsBot: true, merged: false },
    { cliId: 'claude-code', args: ['--mention-back'], senderIsBot: undefined, merged: false },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, sandbox: true },
    { cliId: 'codex', args: ['--no-mention'], senderIsBot: false, merged: false, sandbox: true },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, sandboxEnv: { BOTMUX_READ_ISOLATION: '1' } },
    { cliId: 'codex', args: ['--no-mention'], senderIsBot: false, merged: false, sandboxEnv: { BOTMUX_SANDBOX: '1' } },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, sandbox: true, reserveCard: false },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: true, oncall: true },
    { cliId: 'codex', args: ['--no-mention'], senderIsBot: false, merged: true, oncall: true },
    { cliId: 'claude-code', args: ['--mention', 'ou_other'], senderIsBot: false, merged: false, oncall: true },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, reserveCard: false, responseKind: 'progress' },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, reserveCard: false, responseKind: 'auxiliary' },
    { cliId: 'claude-code', args: ['--no-mention'], senderIsBot: false, merged: false, reserveCard: false, responseKind: null },
  ])('$cliId $args senderIsBot=$senderIsBot merged=$merged sandbox=$sandbox env=$sandboxEnv reserved=$reserveCard oncall=$oncall kind=$responseKind', async ({ cliId, args, senderIsBot, merged, sandbox, sandboxEnv, reserveCard = true, oncall = false, responseKind = 'final' }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-reply-'));
    const dataDir = join(root, 'data');
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: key.sessionId, turnId: key.turnId,
      }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId, replyCardMode: 'unified',
        oncallGroup: { enabled: oncall, chatIds: ['oc_test'] },
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        ...key, status: 'active', cliId, cliSessionId: 'native_reply', workerGeneration: 1, sandbox, chatId: 'oc_test', rootMessageId: 'om_root',
        scope: 'thread', chatType: 'group', workingDir: root,
        replyTargets: { [key.turnId]: { updatedAt: new Date().toISOString(), senderOpenId: 'ou_requester',
          participants: [{ openId: 'ou_requester', isBot: senderIsBot }] } },
        turnReplyContexts: { [key.turnId]: { target: { mode: 'thread', rootMessageId: 'om_root' },
          replyTargetSenderOpenId: 'ou_requester', replyTargetSenderIsBot: senderIsBot } },
      } });
      await setGroupContextSettings('oc_test', { enabled: true }, dataDir);
      const binding = { appId: key.larkAppId, chatId: 'oc_test', sessionId: key.sessionId, turnId: key.turnId, workerGeneration: 1,
        epoch: groupContextEpoch(key.sessionId, 'native_reply', cliId, key.turnId) };
      writePreparedGroupContext({ ...binding, createdAt: Date.now(), body: '', includedSeqs: [], throughSeq: 0, incomplete: false }, dataDir);
      bindGroupContextDelivery(binding, dataDir);
      const store = new TurnReplyCardStore(dataDir);
      const send = vi.fn(async () => 'om_original_card');
      const patch = vi.fn(async () => {});
      const io = { send, patch, beforeEffect: () => {}, isWithdrawn: () => false,
        render: (record: Parameters<typeof buildTurnReplyCard>[0]) => buildTurnReplyCard(record, presentation) };
      if (reserveCard) {
        await store.prepare(key, { mode: 'unified', chatId: 'oc_test', rootId: 'om_root' });
        await store.update(key, { kind: 'start' }, io);
        await store.update(key, { kind: 'tools', tools: [{ id: 'tool1', name: 'Read', subject: 'README.md' }] }, io);
      }
      const result = spawnSyncTsScript(fixture, ['send', ...args, ...(responseKind ? ['--response-kind', responseKind] : []), 'Hello! 这是完整答复。'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId, ...sandboxEnv },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(requests).toHaveLength(1);
      const cardContent = requests[0].body?.content ?? '';
      if (responseKind === 'final') {
        expect(cardContent).toContain(DEFAULT_BRAND_LABEL);
      } else {
        expect(cardContent).not.toContain(DEFAULT_BRAND_LABEL);
      }
      expect(getDeliveredGroupContextSeqs(binding.appId, binding.chatId, binding.sessionId, binding.epoch, dataDir)).toEqual([]);
      expect(confirmGroupContextDelivery(binding, dataDir)).toBe(true);
      if (responseKind !== 'progress') {
        const journal = openDatabaseSyncOrThrow(join(dataDir, 'group-context', `${key.larkAppId}.sqlite`));
        try {
          const published = journal.prepare('SELECT seq FROM messages WHERE message_id = ? ORDER BY revision DESC LIMIT 1')
            .get(merged ? 'om_original_card' : 'om_separate_message') as { seq: number };
          expect(published).toBeDefined();
          expect(getDeliveredGroupContextSeqs(binding.appId, binding.chatId, binding.sessionId, binding.epoch, dataDir)).toEqual([published.seq]);
          expect(getDeliveredGroupContextSeqs(binding.appId, binding.chatId, binding.sessionId, 'another-native', dataDir)).toEqual([]);
        } finally { journal.close(); }
      } else expect(getDeliveredGroupContextSeqs(binding.appId, binding.chatId, binding.sessionId, binding.epoch, dataDir)).toEqual([]);
      if (!merged && responseKind !== null) {
        expect(projectGroupContextCard(requests[0].body.content)?.kind).toBe(responseKind === 'progress' ? 'runtime' : 'conversation');
        const purposeMarker = '\u2063'.repeat(responseKind === 'progress' ? 12 : 13);
        expect(requests[0].body.content).toContain(purposeMarker);
        const sentCard = JSON.parse(requests[0].body.content);
        if (responseKind === 'progress' || responseKind === 'auxiliary') {
          expect(sentCard.body.elements.some((element: any) =>
            element.tag === 'markdown' && typeof element.content === 'string'
            && element.content.endsWith(purposeMarker))).toBe(true);
        }
        expect(sentCard.body.elements.filter((element: any) =>
          element.tag === 'markdown' && typeof element.content === 'string'
          && element.content.replace(/<[^>]+>/g, '').replace(/\u2063/g, '').trim() === '')).toEqual([]);
      } else if (responseKind === null) {
        expect(requests[0].body.content).not.toContain('\u2063'.repeat(12));
      }
      expect(requests[0].body.content.includes('oncall_group_create')).toBe(oncall);
      const oncallSource = new OncallGroupStore(dataDir).findSource(key.larkAppId, merged ? 'om_original_card' : 'om_separate_message');
      if (oncall) expect(oncallSource).toMatchObject({ chatId: 'oc_test', questionId: key.turnId, answer: 'Hello! 这是完整答复。' });
      else expect(oncallSource).toBeUndefined();
      if (merged) {
        expect(requests[0]).toMatchObject({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_original_card' });
        expect(requests[0].body.content).toContain('Hello! 这是完整答复。');
        if (responseKind === 'progress') {
          expect(store.read(key)?.progress).toContain('Hello! 这是完整答复。');
          expect(store.read(key)?.finalDelivered).not.toBe(true);
          expect(send).toHaveBeenCalledTimes(1);
          return;
        }
        const journal = openDatabaseSyncOrThrow(join(dataDir, 'group-context', `${key.larkAppId}.sqlite`));
        try {
          const published = journal.prepare('SELECT text, card_content_version FROM messages WHERE message_id = ? ORDER BY revision DESC LIMIT 1').get('om_original_card') as { text: string; card_content_version: number };
          expect(published).toMatchObject({ card_content_version: 1 });
          expect(published.text).toContain('Hello! 这是完整答复。');
          expect(published.text).not.toMatch(/README\.md|处理中|执行过程/);
        } finally { journal.close(); }
        await store.update(key, { kind: 'terminal', phase: 'completed', durationMs: 1200 }, io);
        expect(send).toHaveBeenCalledTimes(1);
        expect(store.read(key)).toMatchObject({ messageId: 'om_original_card', finalDelivered: true, phase: 'completed' });
        expect(store.read(key)?.lastCard).toContain('README.md');
        expect(store.read(key)?.lastCard).not.toContain('本轮没有提供最终答复');
        expect(store.read(key)?.lastCard?.includes('oncall_group_create')).toBe(oncall);
        const markers = readFileSync(join(dataDir, 'turn-sends', `${key.sessionId}.jsonl`), 'utf8');
        expect(JSON.parse(markers.trim())).toMatchObject({
          messageId: 'om_original_card',
          replyCardResponseKind: 'final',
          terminalCarrier: 'standard_reply_card',
        });
      } else {
        expect(requests[0].method).toBe('POST');
        expect(requests[0].body.content).toContain('Hello! 这是完整答复。');
        expect(store.read(key)?.finalDelivered).not.toBe(true);
        const markers = readFileSync(join(dataDir, 'turn-sends', `${key.sessionId}.jsonl`), 'utf8');
        expect(JSON.parse(markers.trim())).not.toHaveProperty('replyCardResponseKind');
        expect(JSON.parse(markers.trim())).toMatchObject({ terminalCarrier: 'standard_reply_card' });
        if (!reserveCard) expect(store.read(key)).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);

  it.each([
    ['isolated (no host secret): hands the row to the daemon', false],
    // A CLI's own sandbox (e.g. a workspace-write policy) can deny the store
    // write while the host secret stays readable: the row must still reach
    // the daemon instead of being dropped.
    ['host secret readable (CLI-own sandbox): still hands the row to the daemon', true],
  ])('when the feedback store cannot be opened — %s', (_label, hostSecret) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-index-'));
    const dataDir = join(root, 'data');
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: key.sessionId,
        turnId: key.turnId,
      }));
      // A directory where the database file belongs: the open fails exactly
      // like a sandbox deny, without depending on the host's sandbox.
      mkdirSync(join(dataDir, 'botmux-feedback.sqlite'));
      if (hostSecret) {
        mkdirSync(join(root, '.botmux'), { recursive: true, mode: 0o700 });
        writeFileSync(join(root, '.botmux', '.dashboard-secret'), 'host-secret', { mode: 0o600 });
      }
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId,
        larkAppSecret: 'test-secret',
        cliId: 'claude-code',
        replyCardMode: 'unified',
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        ...key,
        status: 'active',
        cliId: 'claude-code',
        chatId: 'oc_test',
        rootMessageId: 'om_root',
        scope: 'thread',
        chatType: 'group',
        workingDir: root,
        replyTargets: { [key.turnId]: {
          updatedAt: new Date().toISOString(),
          senderOpenId: 'ou_requester',
          participants: [{ openId: 'ou_requester', isBot: false }],
        } },
        turnReplyContexts: { [key.turnId]: {
          target: { mode: 'thread', rootMessageId: 'om_root' },
          replyTargetSenderOpenId: 'ou_requester',
          replyTargetSenderIsBot: false,
        } },
      } });

      const result = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--response-kind', 'final', 'Indexed final',
      ], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId,
          BOTMUX_TURN_ID: key.turnId,
          BOTMUX_LARK_APP_ID: key.larkAppId,
          BOTMUX_COORDINATION_MODE: 'primary',
          BOTMUX_DAEMON_IPC_PORT: '7951',
          BOTMUX_TEST_DURABLE_SEND: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });

      expect(result.status, String(result.stderr)).toBe(0);
      const requests = String(result.stdout).split('\n')
        .filter(line => line.startsWith('CAPTURE_DURABLE='))
        .map(line => JSON.parse(line.slice('CAPTURE_DURABLE='.length)));
      const posts = requests.filter(r => r.method === 'POST');
      expect(posts[0]).toMatchObject({ path: `/api/sessions/${key.sessionId}/durable-send` });
      {
        expect(posts).toHaveLength(2);
        expect(posts[1]).toMatchObject({
          method: 'POST',
          path: `/api/sessions/${key.sessionId}/turn-delivery`,
          body: { messageId: 'om_durable_message' },
        });
        expect(posts[1].body.content).toContain('Indexed final');
        // The turn this CLI answered, so the daemon refuses rather than
        // indexing under a turn it has since moved on to.
        expect(posts[1].body.expectedTurnId).toBe(key.turnId);
        // Correlation fields are the daemon's to derive, never the CLI's.
        for (const field of ['turnId', 'sessionId', 'chatId', 'botAppId', 'policy']) {
          expect(posts[1].body).not.toHaveProperty(field);
        }
        expect(String(result.stderr)).not.toContain('turn delivery indexing failed');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);

  it('routes a primary-mode final through daemon durable IPC without direct Lark delivery or card PATCH', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-durable-'));
    const dataDir = join(root, 'data');
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: key.sessionId,
        turnId: key.turnId,
      }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId,
        larkAppSecret: 'test-secret',
        cliId: 'claude-code',
        replyCardMode: 'unified',
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        ...key,
        status: 'active',
        cliId: 'claude-code',
        chatId: 'oc_test',
        rootMessageId: 'om_root',
        scope: 'thread',
        chatType: 'group',
        workingDir: root,
        replyTargets: { [key.turnId]: {
          updatedAt: new Date().toISOString(),
          senderOpenId: 'ou_requester',
          participants: [{ openId: 'ou_requester', isBot: false }],
        } },
        turnReplyContexts: { [key.turnId]: {
          target: { mode: 'thread', rootMessageId: 'om_root' },
          replyTargetSenderOpenId: 'ou_requester',
          replyTargetSenderIsBot: false,
        } },
      } });

      const result = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--response-kind', 'final', 'Durable final',
      ], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId,
          BOTMUX_TURN_ID: key.turnId,
          BOTMUX_LARK_APP_ID: key.larkAppId,
          BOTMUX_COORDINATION_MODE: 'primary',
          BOTMUX_DAEMON_IPC_PORT: '7951',
          BOTMUX_TEST_DURABLE_SEND: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });

      expect(result.status, String(result.stderr)).toBe(0);
      expect(String(result.stdout)).not.toContain('CAPTURE_REPLY=');
      const requests = String(result.stdout).split('\n')
        .filter(line => line.startsWith('CAPTURE_DURABLE='))
        .map(line => JSON.parse(line.slice('CAPTURE_DURABLE='.length)));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: 'POST',
        path: `/api/sessions/${key.sessionId}/durable-send`,
        body: {
          turnId: key.turnId,
          target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
          msgType: 'interactive',
          providerUuid: expect.stringMatching(/^dps_/),
        },
      });
      expect(requests[0].body.content).toContain('Durable final');
      expect(String(result.stdout)).toContain('"messageId":"om_durable_message"');

      const attachment = join(root, 'attachment.txt');
      writeFileSync(attachment, 'must not upload');
      const blocked = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--response-kind', 'auxiliary', '--files', attachment,
        'Unsupported multi-effect send',
      ], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId,
          BOTMUX_TURN_ID: key.turnId,
          BOTMUX_LARK_APP_ID: key.larkAppId,
          BOTMUX_COORDINATION_MODE: 'primary',
          BOTMUX_DAEMON_IPC_PORT: '7951',
          BOTMUX_TEST_DURABLE_SEND: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(blocked.status).toBe(2);
      expect(String(blocked.stderr)).toContain('durable primary 当前只支持单条文本/卡片消息');
      expect(String(blocked.stdout)).not.toContain('CAPTURE_DURABLE=');
      expect(String(blocked.stdout)).not.toContain('CAPTURE_REPLY=');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);

  it('top-level send includes brand footer as a standalone card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-toplevel-'));
    const dataDir = join(root, 'data');
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
        sessionId: key.sessionId, turnId: key.turnId,
      }));
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId: 'claude-code',
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        ...key, status: 'active', cliId: 'claude-code', cliSessionId: 'native_reply', workerGeneration: 1,
        chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
      } });

      const result = spawnSyncTsScript(fixture, [
        'send', '--no-mention', '--top-level', 'Top level announcement',
      ], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          HOME: root,
          SESSION_DATA_DIR: dataDir,
          BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId,
          BOTMUX_TURN_ID: key.turnId,
          BOTMUX_LARK_APP_ID: key.larkAppId,
        },
        encoding: 'utf8',
        timeout: 30_000,
      });

      expect(result.status, String(result.stderr)).toBe(0);
      const requests = String(result.stdout).split('\n')
        .filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(requests).toHaveLength(1);
      expect(requests[0].body?.content).toContain(DEFAULT_BRAND_LABEL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Riff footer host policy in a warm sandbox', () => {
  it.each([
    { disk: {}, env: '{"replyFooterEnabled":false}', hidden: true },
    { disk: { replyFooterEnabled: true }, env: '{"replyFooterEnabled":false}', hidden: true },
    { disk: { replyFooterEnabled: false }, env: '{}', hidden: false },
    { disk: { replyFooterEnabled: false }, env: '{invalid', hidden: false },
  ])('honors host policy $env instead of stale disk $disk', ({ disk, env, hidden }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-riff-footer-'));
    try {
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId, larkAppSecret: 'stale-secret', cliId: 'riff', ...disk,
      }]));
      const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'final', 'BODY'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: join(root, 'data'), BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_LARK_APP_ID: key.larkAppId, BOTMUX_LARK_APP_SECRET: 'host-secret',
          BOTMUX_SESSION_ID: key.sessionId, BOTMUX_CHAT_ID: 'oc_test', BOTMUX_ROOT_MESSAGE_ID: 'om_root',
          BOTMUX_TURN_ID: key.turnId, BOTMUX_REPLY_FOOTER: env },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(requests).toHaveLength(1);
      const card = JSON.parse(requests[0].body.content);
      expect(JSON.stringify(card)).toContain('BODY');
      expect(card.body.elements.some((e: any) => e.element_id === 'botmux_reply_footer')).toBe(!hidden);
      expect(card.body.elements.some((e: any) => e.tag === 'hr')).toBe(!hidden);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


describe('normal CLI send reply rendering snapshot', () => {
  it.each([false, true])('uses measured timing independently of usage and footer master=%s', (hidden) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-send-render-'));
    const dataDir = join(root, 'data');
    try {
      mkdirSync(join(root, '.botmux'), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, '.botmux', '.dashboard-secret'), 'host-secret', { mode: 0o600 });
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{ larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId: 'codex', usageDisplay: 'off' }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        sessionId: key.sessionId, status: 'active', cliId: 'codex', larkAppId: key.larkAppId,
        chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
      } });
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: key.sessionId, turnId: key.turnId }));
      const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'final', 'TIMED BODY'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId,
          BOTMUX_DAEMON_IPC_PORT: '7951', BOTMUX_TEST_REPLY_RENDER_SNAPSHOT: JSON.stringify({
            usage: { context: null, tokens: null }, footerPreferences: { replyFooterEnabled: !hidden },
            consoleUrl: 'https://m-example.botmux.example/',
            timing: { executionDurationMs: 5000, waitingDurationMs: 2000, executionInProgress: true },
          }) }, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      expect(String(result.stdout)).toContain('CAPTURE_RENDER_QUERY=?turnId=om_turn');
      const captured = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(captured).toHaveLength(1);
      const card = captured[0].body.content;
      expect(card).toContain('TIMED BODY');
      expect(card.includes('执行至回复 5.0')).toBe(!hidden);
      expect(card.includes('等待 2.0')).toBe(!hidden);
      expect(card.includes('执行至回复')).toBe(!hidden);
      expect(card.includes('botmux_reply_footer')).toBe(!hidden);
      expect(card.includes('](https://m-example.botmux.example/)')).toBe(!hidden);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('CLI local fallback snapshot selects the host console entry', () => {
  // No BOTMUX_DAEMON_IPC_PORT and an empty data dir means the daemon IPC route
  // is unreachable, so the CLI builds the render snapshot itself — the second
  // production generation point that must carry consoleUrl.
  const consoleEntry = 'https://m-mtest.console.example.com/';
  it.each([
    { name: 'remote on + bound', remoteAccess: true, bound: true, linked: true },
    { name: 'remote on + unbound', remoteAccess: true, bound: false, linked: false },
    { name: 'remote off + bound', remoteAccess: false, bound: true, linked: false },
  ])('$name', ({ remoteAccess, bound, linked }) => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-local-console-'));
    const dataDir = join(root, 'data');
    try {
      mkdirSync(join(root, '.botmux'), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, '.botmux', 'config.json'), JSON.stringify({ remoteAccess }), { mode: 0o600 });
      if (bound) {
        writeFileSync(join(root, '.botmux', 'platform.json'), JSON.stringify({
          platformUrl: 'https://console.example.com', machineId: 'mtest', machineToken: 'tok',
        }), { mode: 0o600 });
      }
      writeFileSync(join(root, 'bots.json'), JSON.stringify([{
        larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
      }]));
      seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
        sessionId: key.sessionId, status: 'active', cliId: 'codex', larkAppId: key.larkAppId,
        chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
      } });
      const result = spawnSyncTsScript(fixture, ['send', '--no-mention', '--response-kind', 'final', 'LOCAL FALLBACK BODY'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
          BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      // The daemon snapshot route was unreachable: nothing should have answered it.
      expect(String(result.stdout)).not.toContain('CAPTURE_RENDER_QUERY=');
      const captured = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
        .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
      expect(captured).toHaveLength(1);
      const card = captured[0].body.content as string;
      expect(card).toContain('LOCAL FALLBACK BODY');
      expect(card).toContain(DEFAULT_BRAND_LABEL);
      expect(card.includes(`](${consoleEntry})`)).toBe(linked);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 35_000);
});
