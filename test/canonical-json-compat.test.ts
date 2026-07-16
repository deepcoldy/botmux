import { describe, expect, it } from 'vitest';

import { canonicalJsonStringify } from '../src/utils/canonical-json.js';
import {
  canonicalJsonStringify as legacyCanonicalJsonStringify,
  computeRevisionId,
  parseWorkflowDefinition,
} from '../src/workflows/definition.js';
import {
  v2RunArchiveId,
  type V2RunArchiveContent,
} from '../src/workflows/migration/v2-run-archive-schema.js';
import {
  canonicalJsonStringify as savedWorkflowCanonicalJsonStringify,
} from '../src/workflows/v3/library-schema.js';

describe('canonical JSON persisted hash compatibility', () => {
  it('pins canonical bytes and compatibility re-exports', () => {
    const value = {
      z: [3, { y: '雪', x: null }],
      a: { beta: false, alpha: 1 },
    };

    expect(legacyCanonicalJsonStringify).toBe(canonicalJsonStringify);
    expect(savedWorkflowCanonicalJsonStringify).toBe(canonicalJsonStringify);
    expect(canonicalJsonStringify(value)).toBe(
      '{"a":{"alpha":1,"beta":false},"z":[3,{"x":null,"y":"雪"}]}',
    );
  });

  it('pins the legacy definition revision id', () => {
    const definition = parseWorkflowDefinition({
      nodes: {
        finish: {
          type: 'subagent',
          bot: 'codex',
          prompt: 'ship',
          depends: ['prepare'],
        },
        prepare: {
          type: 'subagent',
          bot: 'claude-code',
          prompt: 'prepare',
          timeoutMs: 5_000,
        },
      },
      params: {
        topic: {
          description: 'Report topic',
          required: true,
          type: 'string',
        },
      },
      version: 3,
      workflowId: 'golden-migration',
    });

    expect(computeRevisionId(definition)).toBe(
      'sha256:af8c7348e4aab16a40fcde40f96ac4f818d90df731984c86d2a224f26ac08924',
    );
  });

  it('pins the v2 run archive content id', () => {
    const content: V2RunArchiveContent = {
      runs: [{
        runId: 'run-golden',
        rawRoot: 'runs/run-golden/raw',
        projectionPath: 'runs/run-golden/projection.json',
        projectionSha256: `sha256:${'1'.repeat(64)}`,
        presence: {
          workflowJson: true,
          chatBindingJson: false,
          attemptsDir: true,
          blobsDir: false,
        },
        missingOptional: ['chat-binding.json'],
        warnings: [],
        verdict: {
          status: 'succeeded',
          workflowId: 'golden-migration',
          revisionId: `sha256:${'2'.repeat(64)}`,
          lastSeq: 7,
          updatedAt: 1_700_000_000_000,
          dangling: {
            activities: 0,
            effectAttempted: 0,
            waits: 0,
            cancels: 0,
          },
          liveTerminalSidecars: 0,
        },
      }],
      residuals: [],
      payloadDirectories: ['runs/run-golden/raw'],
      payloadFiles: [{
        path: 'runs/run-golden/raw/events.ndjson',
        bytes: 12,
        sha256: `sha256:${'3'.repeat(64)}`,
      }],
    };

    expect(v2RunArchiveId(content)).toBe(
      'sha256:82843b763b80b07b2d055fefd06c642bd680a87ab05ae5a4036d2816ac91f589',
    );
  });
});
