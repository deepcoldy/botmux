import { describe, expect, it } from 'vitest';
import { orcaReplyContent } from '../src/services/orca-runner.js';
import { MAX_REMOTE_RUNNER_OUTBOUND_MESSAGE_BYTES as limit, parseRemoteRunnerEventLine,
  REMOTE_RUNNER_PROTOCOL, REMOTE_RUNNER_PROTOCOL_VERSION } from '../src/adapters/backend/remote-runner-protocol.js';

describe('Orca final reply wire limits', () => {
  it.each(['a'.repeat(limit), 'a'.repeat(limit + 1), '中文🙂'.repeat(limit), '', ' \n\t'])(
    'emits a nonempty parseable final reply (%#)', input => {
      const content = orcaReplyContent(input);
      const event = parseRemoteRunnerEventLine(JSON.stringify({ protocol: REMOTE_RUNNER_PROTOCOL,
        version: REMOTE_RUNNER_PROTOCOL_VERSION, type: 'outbound_message', operationId: 'operation',
        turnId: 'turn', generation: 1, content, responseKind: 'final', mention: 'requester' }));
      expect(event).toMatchObject({ type: 'outbound_message', content });
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(limit);
      expect(content.trim()).not.toBe('');
      if (Buffer.byteLength(input) > limit) expect(content).toContain('Reply truncated');
      else if (input.trim()) expect(content).toBe(input);
    },
  );
});
