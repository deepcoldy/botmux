import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Re-import the adapter so we exercise the real builder. The submit-
// verification helpers are private to antigravity.ts (intentionally —
// they hardcode HISTORY_PATH inside ~/.gemini), so this suite re-implements
// the same regex/marker contract on a temp file. If antigravity.ts changes
// the marker shape, this test will drift and fail loudly.

import { createAntigravityAdapter } from '../src/adapters/cli/antigravity.js';

/**
 * Mirror of antigravity.ts's private `historyMarker`. Must stay in sync —
 * the e2e test against real agy is the source of truth, but this suite
 * runs in milliseconds so we keep an isolated copy here for fast feedback
 * and to catch encoding regressions without spawning agy.
 */
function jsonEncodedPrefix(content: string): string {
  return JSON.stringify(content.slice(0, 40))
    .slice(1, -1)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

describe('antigravity history.jsonl marker contract', () => {
  it('JSON-encodes literal newline so multi-line submits match', () => {
    const marker = jsonEncodedPrefix('line1\nline2');
    expect(marker).toBe('line1\\nline2');
  });

  it('truncates at 40 chars to bound disk reads', () => {
    const long = 'a'.repeat(80);
    const marker = jsonEncodedPrefix(long);
    expect(marker.length).toBe(40);
  });

  it('HTML-escapes < > & to match agy\'s Go json.Marshal output', () => {
    // botmux always wraps user text in <user_message> / <botmux_routing>
    // tags; agy's history.jsonl encodes those as \u003c / \u003e. The
    // marker must match that encoding, otherwise EVERY botmux prompt
    // would trigger a false-positive "submit not confirmed" warning.
    const marker = jsonEncodedPrefix('<user_message>\n你好');
    expect(marker).toBe('\\u003cuser_message\\u003e\\n你好');
    expect(marker).not.toContain('<');
    expect(marker).not.toContain('>');
  });

  it('matches a real-world agy history line containing a botmux prompt', () => {
    // Verbatim shape produced by agy 1.0 — `<` already encoded as \u003c.
    const onDiskLine = '{"display":"\\u003cuser_message\\u003e\\n示例你好\\n\\u003c/user_message\\u003e","timestamp":1779347235804,"workspace":"/Users/example"}';
    const marker = jsonEncodedPrefix('<user_message>\n示例你好\n</user_message>');
    expect(onDiskLine.includes(`"display":"${marker}`)).toBe(true);
  });

  it('temp-file delta-scan finds appended display lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agyhist-'));
    const path = join(dir, 'history.jsonl');
    writeFileSync(path, '{"display":"earlier","timestamp":1,"workspace":"/x"}\n');
    const baseSize = statSync(path).size;
    const userText = 'alpha\nbeta gamma';
    appendFileSync(
      path,
      `{"display":${JSON.stringify(userText)},"timestamp":2,"workspace":"/x"}\n`,
    );
    const marker = jsonEncodedPrefix(userText);
    // Read delta past baseSize and assert our marker is present in raw bytes.
    const after = require('node:fs').readFileSync(path).slice(baseSize).toString();
    expect(after.includes(`"display":"${marker}`)).toBe(true);
  });

  it('does NOT match when only an unrelated line was appended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agyhist-'));
    const path = join(dir, 'history.jsonl');
    writeFileSync(path, '{"display":"earlier","timestamp":1,"workspace":"/x"}\n');
    const baseSize = statSync(path).size;
    appendFileSync(path, '{"display":"someone-else","timestamp":2,"workspace":"/x"}\n');
    const marker = jsonEncodedPrefix('alpha\nbeta');
    const after = require('node:fs').readFileSync(path).slice(baseSize).toString();
    expect(after.includes(`"display":"${marker}`)).toBe(false);
  });
});

describe('antigravity adapter — high-level invariants', () => {
  it('id property is stable', () => {
    const a = createAntigravityAdapter('/usr/local/bin/agy');
    expect(a.id).toBe('antigravity');
  });

  it('declares altScreen so xterm renderer takes its TUI snapshot path', () => {
    const a = createAntigravityAdapter('/usr/local/bin/agy');
    expect(a.altScreen).toBe(true);
  });

  it('omits readyPattern/completionPattern (uses idle-detector quiescence)', () => {
    const a = createAntigravityAdapter('/usr/local/bin/agy');
    expect(a.readyPattern).toBeUndefined();
    expect(a.completionPattern).toBeUndefined();
  });

  it('exposes systemHints (BOTMUX_SHELL_HINTS) for /botmux-* skill routing', () => {
    const a = createAntigravityAdapter('/usr/local/bin/agy');
    // BOTMUX_SHELL_HINTS is a non-empty array of routing hint lines.
    expect(Array.isArray(a.systemHints)).toBe(true);
    expect(a.systemHints!.length).toBeGreaterThan(0);
  });
});
