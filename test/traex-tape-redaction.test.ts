import xtermHeadless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import {
  createTapeRedactor,
  isIdleRepaintChunk,
  measureReplayCells,
  parseGreetingName,
  secretTokens,
  stripAnsi,
  type TapeSecrets,
} from '../scripts/traex-tape-redaction.js';

const { Terminal } = xtermHeadless;

const base = {
  osUser: 'root',
  homeDir: '/home/tapeuser',
  workDir: '/tmp/traex-tape-abc',
  modelNames: ['Secret-Model'],
};

async function redactorFor(accountName: string, overrides: Partial<TapeSecrets> = {}) {
  const secrets = { ...base, accountName, ...overrides };
  const cellWidth = await measureReplayCells([...secretTokens(secrets), ...secrets.modelNames]);
  return createTapeRedactor(secrets, cellWidth);
}

/** Cursor column after rendering `text` in the worker's headless xterm. */
async function cursorAfter(text: string): Promise<number> {
  const term = new Terminal({ cols: 160, rows: 4, allowProposedApi: true });
  await new Promise<void>(resolve => term.write(text, resolve));
  const x = term.buffer.active.cursorX;
  term.dispose();
  return x;
}

describe('TraeX tape redaction', () => {
  it('reads the display name only from a complete greeting row', () => {
    expect(parseGreetingName('│ Hello, alice.dev                             │')).toBe('alice.dev');
    expect(parseGreetingName('│ Good afternoon, Alice Smith              │')).toBe('Alice Smith');
    // Cursor-addressed repaint butting the next row's border against this one.
    expect(parseGreetingName('│ Hello, Alice      ││                       │')).toBe('Alice');
    expect(parseGreetingName(stripAnsi('│ Hello, \x1b[1mAlice\x1b[0m   │'))).toBe('Alice');
    // Chunk ended mid-name: no closing border yet.
    expect(parseGreetingName('│ Hello, Al')).toBeUndefined();
  });

  it('refuses ASCII name parts or personal OS logins too short to redact safely', () => {
    expect(() => secretTokens({ accountName: 'Al Smith', osUser: 'root' })).toThrow(/"Al" is too short/);
    expect(() => secretTokens({ accountName: 'Alice', osUser: 'ab' })).toThrow(/"ab" is too short/);
  });

  it('redacts names wherever they occur: prose, CJK, compound handles, any case', async () => {
    const redactor = await redactorFor('Alice Smith');
    const tape = redactor.redact({
      prompts: ['ask Alice about /home/tapeuser/x'],
      data: [
        '│ Hello, Alice Smith │\x1b[1A',
        '请Alice确认，smith也看一下',
        'mail Alice-Smith@example.org or alice_smith or ALICE.SMITH',
        'Secret-Model; /tmp/traex-tape-abc/f',
      ],
    });
    expect(tape.prompts[0]).toBe('ask tape- about {{HOME}}/x');
    expect(tape.data).toEqual([
      '│ Hello, tape-user-- │\x1b[1A',
      '请tape-确认，tape-也看一下',
      'mail tape--tape-@example.org or tape-_tape- or tape-.tape-',
      'tape-model--; {{CWD}}/f',
    ]);
    expect(() => redactor.assertClean(tape)).not.toThrow();
  });

  it('resolves the matching rule with the regex\'s own Unicode case folding', async () => {
    // /iu folds "ſ" (long s) to "s": the recorded "Smith" matches token "ſmith".
    const redactor = await redactorFor('Alice ſmith');
    const out = redactor.redact({ text: 'hi Smith' }).text;
    expect(out).not.toMatch(/smith/i);
    expect(out.startsWith('hi tape-')).toBe(true);
  });

  it('keeps replay cursor columns identical for wide names (CJK, emoji)', async () => {
    for (const name of ['张三', 'Alice 😀']) {
      const redactor = await redactorFor(name);
      const row = `\x1b[H│ Hello, ${name} │ next`;
      const redacted = redactor.redact({ data: row }).data;
      expect(redacted).not.toContain(name);
      expect(await cursorAfter(redacted), name).toBe(await cursorAfter(row));
    }
  });

  it('preserves control sequences byte-for-byte and redacts only text', async () => {
    const redactor = await redactorFor('Mac Alice');
    // "Mac" must not match across the CSI final byte ("\x1b[32m" + "Access").
    expect(redactor.redact({ data: '\x1b[32mAccess granted to Mac' }).data).toBe('\x1b[32mAccess granted to tap');
    // OSC payloads (window titles) are text.
    expect(redactor.redact({ data: '\x1b]0;Alice | tmp\x07' }).data).toBe('\x1b]0;tape- | tmp\x07');
  });

  it('tokenizes the PTY stream across chunk boundaries', async () => {
    const redactor = await redactorFor('Mac Alice');
    const tape = redactor.redactTape({
      events: [
        { t: 1, kind: 'pty', data: '\x1b[3' },
        { t: 2, kind: 'pty', data: '2mAccess Ali' },
        { t: 3, kind: 'pty', data: 'ce here' },
        { t: 4, kind: 'rollout', record: { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'hi Alice' } } },
      ],
    });
    // Split CSI untouched; split name replaced, placed in the chunk it began in.
    expect(tape.events.map(e => (e as { data?: string }).data)).toEqual(['\x1b[3', '2mAccess tape-', ' here', undefined]);
    expect((tape.events[3] as any).record.payload.last_agent_message).toBe('hi tape-');
    expect(() => redactor.assertCleanTape(tape)).not.toThrow();
  });

  it('classifies idle repaints independently of chunking', () => {
    const eyes = '\x1b7\x1b[3;5H\x1b[38;5;2m\x1b[1m◆\x1b[0m\x1b[3;7H\x1b[38;5;2m\x1b[1m◆\x1b[0m\x1b8\x1b[?2026l';
    expect(isIdleRepaintChunk(eyes)).toBe(true);
    expect(isIdleRepaintChunk('\x1b7\x1b[3;5H◆')).toBe(true);
    expect(isIdleRepaintChunk('\x1b[3;7H◆\x1b8')).toBe(true);
    expect(isIdleRepaintChunk('\x1b[?2026h\x1b[?25l\x1b[39m\x1b[49m\x1b[0m\x1b[25;1H\x1b[0 q\x1b[27;3H\x1b[?25h')).toBe(true);
    expect(isIdleRepaintChunk('\x1b]0;⠼ task | tmp\x07')).toBe(true);
    // Real screen activity.
    expect(isIdleRepaintChunk('\x1b[?2026h\x1b[23;1H\x1b[J')).toBe(false);
    expect(isIdleRepaintChunk('\x1b[26;1H\x1b[2K')).toBe(false);
    expect(isIdleRepaintChunk('\x1bM\x1bM\r\n')).toBe(false);
    expect(isIdleRepaintChunk('\x1b[26;1H      ')).toBe(false);
    expect(isIdleRepaintChunk(`\x1b[25;1H${'─'.repeat(40)}`)).toBe(false);
    expect(isIdleRepaintChunk('Working…')).toBe(false);
  });

  it('never rewrites property names; one carrying a name fails the final check', async () => {
    const redactor = await redactorFor('Alice');
    const tape = redactor.redact({ payload: { error: { Alice: 'endpoint failed' } } });
    expect(Object.keys(tape.payload.error)).toEqual(['Alice']);
    expect(() => redactor.assertClean(tape)).toThrow(/"Alice"/);
  });

  it('rewrites only free-text fields; a secret colliding with an enum refuses the recording', async () => {
    const redactor = await redactorFor('Fin Smith');
    const record = {
      kind: 'rollout',
      record: {
        type: 'history_mutation',
        payload: {
          display_completions: [{ item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'Fin Smith ok' }] } }],
        },
      },
    };
    const out = redactor.redact(record);
    const item = out.record.payload.display_completions[0]!.item;
    // The enum the worker bridge keys on is never rewritten …
    expect(item.phase).toBe('final_answer');
    expect(item.content[0]!.text).toBe('tape-user ok');
    // … so the collision is caught by the final check instead.
    expect(() => redactor.assertClean(out)).toThrow(/"Fin"/);
  });

  it('fails the final check on a name split by style codes in the raw stream', async () => {
    const redactor = await redactorFor('Alice');
    // Within one chunk and across chunks alike.
    const one = redactor.redactTape({ events: [{ kind: 'pty', data: 'hi Ali\x1b[0mce' }] });
    expect(one.events[0]!.data).toBe('hi Ali\x1b[0mce');
    expect(() => redactor.assertCleanTape(one)).toThrow(/"Alice"/);
    const split = redactor.redactTape({ events: [{ kind: 'pty', data: 'hi Ali\x1b[0' }, { kind: 'pty', data: 'mce' }] });
    expect(() => redactor.assertCleanTape(split)).toThrow(/"Alice"/);
  });

  it('treats a personal OS login as a secret and a shared service account as not', async () => {
    const personal = await redactorFor('Alice', { osUser: 'alicedev', homeDir: '/home/alicedev' });
    const tape = personal.redact({ text: ['/home/alicedev/x', 'login alicedev_ci'] });
    expect(tape.text).toEqual(['{{HOME}}/x', 'login tape-use_ci']);
    expect(() => personal.assertClean(tape)).not.toThrow();
    expect(() => personal.assertClean({ v: 'by ALICEDEV' })).toThrow(/"alicedev"/);

    const shared = await redactorFor('Alice', { homeDir: '/root' });
    expect(() => shared.assertClean({ root_turn_id: 'x', v: 'logged in as root' })).not.toThrow();
    expect(shared.redact({ cwd: '/root/iserver' }).cwd).toBe('{{HOME}}/iserver');
  });
});
