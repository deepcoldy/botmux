import { describe, expect, it } from 'vitest';

import { assertSavedWorkflowTemplateBindings } from '../src/workflows/v3/template-bindings.js';

describe('Saved Workflow template binding policy', () => {
  it('rejects parameter markers in humanGate prompts', () => {
    expect(() => assertSavedWorkflowTemplateBindings({
      nodes: [{
        id: 'deploy',
        type: 'goal',
        goal: 'Prepare deployment for ${params.environment}',
        depends: [],
        inputs: [],
        humanGate: { prompt: 'Approve deployment to ${params.environment}?' },
      }],
    }, {
      environment: { type: 'string', required: true },
    }, [])).toThrow(/structural\/safety field dagTemplate\.nodes\[0\]\.humanGate\.prompt/);
  });

  it('continues to allow declared markers in worker-only goal text', () => {
    expect(() => assertSavedWorkflowTemplateBindings({
      nodes: [{
        id: 'report',
        type: 'goal',
        goal: 'Write ${params.topic} for ${context.chatId}',
        depends: [],
        inputs: [],
      }],
    }, {
      topic: { type: 'string', required: true },
    }, ['chatId'])).not.toThrow();
  });
});
