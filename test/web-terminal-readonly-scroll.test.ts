import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
const claudeAdapterSource = readFileSync(
  join(process.cwd(), 'src/adapters/cli/claude-code.ts'),
  'utf8',
);
const adapterTypesSource = readFileSync(
  join(process.cwd(), 'src/adapters/cli/types.ts'),
  'utf8',
);

function scriptBlock(startMarker: string): string {
  const start = workerSource.indexOf(startMarker);
  const end = workerSource.indexOf('</script>', start);
  expect(start).toBeGreaterThan(-1);
  return workerSource.slice(start, end);
}

describe('read-only web terminal wheel scrolling', () => {
  it('exposes readonlyWheelScroll as an opt-in adapter capability, on for Claude only', () => {
    expect(adapterTypesSource).toContain('readonly readonlyWheelScroll?: boolean;');
    // Claude family (claude-code + seed share this adapter) opts in.
    expect(claudeAdapterSource).toContain('readonlyWheelScroll: true,');
    // No OTHER shipped adapter turns it on.
    const others = [
      'codex', 'gemini', 'opencode', 'cursor', 'grok', 'pi', 'copilot',
      'kimi', 'aiden', 'coco', 'hermes', 'mira', 'mir', 'traex', 'riff',
      'genius', 'mtr', 'antigravity', 'kiro-cli', 'oh-my-pi', 'codex-app',
    ];
    for (const name of others) {
      const src = readFileSync(join(process.cwd(), `src/adapters/cli/${name}.ts`), 'utf8');
      expect(src, `${name} must not enable readonlyWheelScroll`).not.toContain('readonlyWheelScroll');
    }
  });

  it('only enables the capability on the shared relay path (not tmux/zellij attach)', () => {
    expect(workerSource).toContain(
      'const readonlyWheelScroll = cliAdapter?.readonlyWheelScroll === true\n'
      + '        && !(isTmuxMode && !isPipeMode);',
    );
    expect(workerSource).toContain(
      'getTerminalHtml(hasWrite, platformReadonly, loginUrl, forceRemoteScroll, localTerminalBackend, readonlyWheelScroll)',
    );
    expect(workerSource).toContain('var readonlyWheelScroll=${readonlyWheelScroll};');
  });

  it('read-only client sends a RESTRICTED scroll intent, never raw mouse bytes', () => {
    const wheelBlock = scriptBlock('// ── Wheel / touch scroll handling ──');
    // Under !hasToken + alt-screen + capability, the client emits {type:'scroll'}
    // carrying only a direction and a bounded line count — NOT an SGR byte string.
    expect(wheelBlock).toContain('if(readonlyWheelScroll&&ws_&&ws_.readyState===1&&px){');
    expect(wheelBlock).toContain("type:'scroll',dir:px<0?'up':'down',lines:_lines");
    expect(wheelBlock).toContain('var _lines=Math.max(1,Math.min(6,Math.round(Math.abs(px)/33)));');
    // The read-only branch must NOT reach _fwdScroll (which forwards raw SGR bytes).
    const roBranch = wheelBlock.slice(
      wheelBlock.indexOf('if(!hasToken){', wheelBlock.indexOf('_canScrollLocal(px)')),
    );
    const roOnly = roBranch.slice(0, roBranch.indexOf('_fwdScroll(px,_cellAt'));
    expect(roOnly).not.toContain('_fwdScroll');
  });

  it('server ignores scroll intent unless the adapter opted in', () => {
    // The 'scroll' handler is gated on the adapter capability and is NOT behind
    // authedClients (that is the whole point — read-only is allowed here), but a
    // non-opted-in CLI drops it entirely.
    expect(workerSource).toContain("} else if (msg.type === 'scroll') {");
    expect(workerSource).toContain('if (cliAdapter?.readonlyWheelScroll !== true) return;');
    expect(workerSource).toContain('const seq = buildReadonlyWheelSequence(msg.dir, msg.lines);');
    expect(workerSource).toContain('if (!seq) return;');
  });

  it('server synthesizes the wheel bytes — client cannot supply button/coord/keys', () => {
    // buildReadonlyWheelSequence hard-codes the button and a server-owned centre
    // coordinate, and clamps the line count. The client's message never reaches
    // backend.write() as raw bytes.
    const fn = workerSource.slice(
      workerSource.indexOf('function buildReadonlyWheelSequence'),
      workerSource.indexOf('function handleTermAction'),
    );
    expect(fn).toContain("if (dir !== 'up' && dir !== 'down') return '';");
    expect(fn).toContain('Math.max(1, Math.min(6, Math.floor(lines)))');
    expect(fn).toContain("const button = dir === 'up' ? 64 : 65;");
    expect(fn).toContain('const col = (cols >> 1) + 1;');
    expect(fn).toContain('const row = (rows >> 1) + 1;');
    // No client-provided coordinate or button is ever interpolated.
    expect(fn).not.toContain('msg.');
  });

  it('buildReadonlyWheelSequence behaves: clamps, fixes button, rejects garbage', () => {
    // Port the pure function and verify its guarantees directly.
    function build(dir: unknown, lines: unknown, cols = 80, rows = 24): string {
      if (dir !== 'up' && dir !== 'down') return '';
      const n = typeof lines === 'number' && Number.isFinite(lines)
        ? Math.max(1, Math.min(6, Math.floor(lines)))
        : 1;
      const col = (cols >> 1) + 1;
      const row = (rows >> 1) + 1;
      const button = dir === 'up' ? 64 : 65;
      const coord = `${col};${row}`;
      let seq = '';
      for (let i = 0; i < n; i++) seq += `\x1b[<${button};${coord}M`;
      return seq;
    }

    // Direction → fixed wheel button, server-centre coordinate (41;13 for 80x24).
    expect(build('up', 1)).toBe('\x1b[<64;41;13M');
    expect(build('down', 1)).toBe('\x1b[<65;41;13M');
    // Line count clamped to [1,6]; three ticks up.
    expect(build('up', 3)).toBe('\x1b[<64;41;13M'.repeat(3));
    expect(build('up', 999)).toBe('\x1b[<64;41;13M'.repeat(6)); // capped
    expect(build('up', 0)).toBe('\x1b[<64;41;13M'); // floored to 1
    // Garbage direction / non-numeric lines → nothing forwarded.
    expect(build('left', 3)).toBe('');
    expect(build('click', 3)).toBe('');
    expect(build('up', 'evil')).toBe('\x1b[<64;41;13M'); // non-number falls back to 1 tick, still pure wheel
    // Never contains a mouse-press (button 0) or release ('m') sequence.
    for (const dir of ['up', 'down'] as const) {
      const s = build(dir, 6);
      expect(s).not.toContain('\x1b[<0;'); // no left-click press
      expect(s).not.toContain('m'); // no SGR release
      expect(s.endsWith('M') || s === '').toBe(true);
    }
  });
});
