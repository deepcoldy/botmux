import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake group description shared by the read (larkGet) and write (chat.update) paths.
let description = '';
const update = vi.fn(async ({ data }: { data: { description: string } }) => { description = data.description; return { code: 0 }; });
vi.mock('../src/bot-registry.js', () => ({ getBotClient: () => ({ im: { v1: { chat: { update } } } }) }));
vi.mock('../src/im/lark/client.js', () => ({ larkGet: async () => ({ code: 0, data: { description } }) }));

const { writeSecretaryMarker } = await import('../src/services/group-secretary-marker.js');

describe('writeSecretaryMarker conditional write', () => {
  beforeEach(() => { description = '项目群'; update.mockClear(); });

  it('writes when the marker is still what the caller saw', async () => {
    expect(await writeSecretaryMarker('cli_me', 'oc_1', 'cli_me', { expect: null })).toEqual({ ok: true });
    expect(description).toBe('项目群\n[botmux:secretary=cli_me]');
  });

  it('does not overwrite a marker another machine wrote in the meantime', async () => {
    description = '项目群\n[botmux:secretary=cli_remote]';
    expect(await writeSecretaryMarker('cli_me', 'oc_1', 'cli_me', { expect: null })).toEqual({ ok: false, reason: 'marker_changed', previous: 'cli_remote' });
    expect(update).not.toHaveBeenCalled();
    expect(description).toBe('项目群\n[botmux:secretary=cli_remote]');
  });

  it('a rollback only removes its own marker', async () => {
    description = '项目群\n[botmux:secretary=cli_remote]';
    expect((await writeSecretaryMarker('cli_me', 'oc_1', null, { expect: 'cli_me' })).ok).toBe(false);
    expect(description).toContain('cli_remote');
  });

  it('without expect it stays an unconditional write (takeover / off)', async () => {
    description = '项目群\n[botmux:secretary=cli_remote]';
    expect(await writeSecretaryMarker('cli_me', 'oc_1', 'cli_me')).toEqual({ ok: true, previous: 'cli_remote' });
    expect(description).toBe('项目群\n[botmux:secretary=cli_me]');
  });
});
