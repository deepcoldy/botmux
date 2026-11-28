import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import { invalidateCustomizationCache, setCustomizationEnabled, setPromptOverride } from '../src/services/customization-store.js';
import { WECOM_GATEWAY_LINE_FACTORY, WECOM_GATEWAY_LINE_KEYS, WECOM_GATEWAY_PROMPT_FRAGMENTS } from '../src/im/wecom/contract/prompt-fragments.js';

/**
 * The gateway's fixed <botmux_task> lines come from the WeCom customization
 * store under the gateway's data dir: an override written there (as the
 * Dashboard's WeCom tab does) is what the next admitted message carries. The Feishu store never
 * reaches the gateway, and the WeCom master switch turns every override off.
 */
let dataDir: string;
let prevDataDir: string | undefined;
const dirs: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wecom-lines-data-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  invalidateCustomizationCache();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  invalidateCustomizationCache();
  for (const d of [dataDir, ...dirs.splice(0)]) rmSync(d, { recursive: true, force: true });
});

type Scenario = { chatType: 'single' | 'group' };
const SCENARIOS: Record<string, Scenario> = {
  private: { chatType: 'single' },
  group: { chatType: 'group' },
};

/** Admit one message through a real bridge; the instruction it froze. */
async function admit(sc: Scenario): Promise<{ instruction: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'wecom-lines-')); dirs.push(dir);
  const core: WecomCore = {
    trigger: vi.fn(async () => ({ ok: true, triggerId: 't1', target: { kind: 'turn', sessionId: 's1' } })),
    result: vi.fn(async () => ({ ok: true, state: 'completed', output: { content: 'answer' } })),
    interrupt: vi.fn(async () => {}),
  };
  const bridge = new WecomBridge({
    botId: 'bot', stateFile: join(dir, 'state.json'), allowedUsers: ['alice'],
    transport: { reply: vi.fn(async () => {}), send: vi.fn(async () => {}) }, core,
    policy: () => ({ allowedUsers: ['alice'], disableStreamingCard: true }),
  } as any);
  const message: WecomInboundMessage = {
    messageId: 'm1', userId: 'alice', conversationId: sc.chatType === 'single' ? 'alice' : 'group-1', chatType: sc.chatType,
    text: 'hello', attachments: [], replyContext: { requestId: 'req-m1' },
  };
  await bridge.receive(message);
  await bridge.tick();
  const request = vi.mocked(core.trigger).mock.calls[0][0] as TriggerRequest;
  return { instruction: request.instruction ?? '' };
}

async function admitAll(): Promise<Record<string, { instruction: string }>> {
  const out: Record<string, { instruction: string }> = {};
  for (const [name, sc] of Object.entries(SCENARIOS)) out[name] = await admit(sc);
  return out;
}

/** Marker override for each gateway line. */
function writeMarkers(prefix: string, scope: 'wecom' | 'feishu'): void {
  for (const spec of WECOM_GATEWAY_PROMPT_FRAGMENTS) {
    setPromptOverride('zh', spec.key, `${prefix}:${spec.key}`, scope);
  }
}

describe('WeCom gateway lines through the WeCom customization store', () => {
  it('carries an override of every gateway line into the next admitted message', async () => {
    writeMarkers('WX', 'wecom');
    const got = await admitAll();
    const all = Object.values(got).map(r => r.instruction).join('\n');
    for (const key of WECOM_GATEWAY_LINE_KEYS) expect(all, key).toContain(`WX:${key}`);
    // Every turn carries the automatic-reply line, then the line of its audience.
    expect(got.private.instruction).toBe('WX:wecom.task.delivery_auto\n\nWX:wecom.task.channel_private');
    expect(got.group.instruction).toBe('WX:wecom.task.delivery_auto\n\nWX:wecom.task.channel_group');
  });

  it('without overrides, every turn starts with the factory automatic-reply line', async () => {
    const got = await admitAll();
    for (const name of Object.keys(SCENARIOS)) {
      expect(got[name].instruction.split('\n\n')[0], name).toBe(WECOM_GATEWAY_LINE_FACTORY['wecom.task.delivery_auto']);
    }
  });

  it('ignores the Feishu store, and the WeCom store once its master switch is off', async () => {
    const factory = await admitAll();
    writeMarkers('FS', 'feishu');
    invalidateCustomizationCache();
    expect(Object.values(await admitAll()).map(r => r.instruction).join('\n')).not.toContain('FS:');
    writeMarkers('WX', 'wecom');
    setCustomizationEnabled(false, 'wecom');
    invalidateCustomizationCache();
    const off = await admitAll();
    expect(Object.values(off).map(r => r.instruction).join('\n')).not.toContain('WX:');
    // Same lines as with an empty store.
    for (const name of Object.keys(SCENARIOS)) expect(off[name].instruction, name).toBe(factory[name].instruction);
  });
});
