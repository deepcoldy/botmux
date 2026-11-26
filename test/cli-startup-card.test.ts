import { describe, expect, it } from 'vitest';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
function build(reason?: string) {
  return JSON.parse(buildStreamingCard('session', 'om_root', '', 'Task', '', 'interrupted', 'pi',
    'hidden', 'nonce', undefined, false, false, 'en', undefined, undefined, false, undefined,
    undefined, undefined, undefined, undefined, [], false, undefined, false, undefined, true, reason));
}
function controls(node: any): unknown[] {
  if (!node || typeof node !== 'object') return [];
  if (node.tag === 'button') return [node];
  return Object.values(node).flatMap(controls);
}
describe('startup failure card diagnosis', () => {
  it('renders a daemon-owned reason even when output is hidden, without changing callback semantics', () => {
    const reason = 'Startup failure (exit code 1); pending inputs stopped.';
    const before = build(); const after = build(reason);
    expect(JSON.stringify(after)).toContain(reason);
    expect(controls(after)).toEqual(controls(before));
    expect(after.header).toEqual(before.header);
  });
});
