import { describe, expect, it } from 'vitest';

import {
  buildConnectorInstructionUpdateBody,
  buildConnectorKindOptions,
  replaceConnectorById,
} from '../src/dashboard/web/connectors-page.js';

describe('dashboard connector instruction editing', () => {
  it('keeps the legacy workflow kind visible but disabled in the create surface', () => {
    const options = buildConnectorKindOptions((key) => key);
    expect(options).toEqual([
      { value: 'turn', label: 'connectors.kindTurn' },
      {
        value: 'workflow',
        label: 'connectors.kindWorkflowRetiring',
        disabled: true,
      },
    ]);
  });

  it('updates only the prompt envelope and leaves secrets untouched', () => {
    const body = buildConnectorInstructionUpdateBody(
      { name: 'Prod alerts', promptEnvelope: { sourceName: 'alerts' } },
      'Summarize severity and notify oncall.',
    );

    expect(body).toEqual({
      promptEnvelope: {
        sourceName: 'alerts',
        instruction: 'Summarize severity and notify oncall.',
      },
    });
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('rotateSecret');
  });

  it('keeps clearing the instruction explicit', () => {
    expect(buildConnectorInstructionUpdateBody({ name: 'Prod alerts' }, '')).toEqual({
      promptEnvelope: {
        sourceName: 'Prod alerts',
        instruction: '',
      },
    });
  });
});

describe('dashboard connector list updates', () => {
  it('replaces the saved connector locally without disturbing list order', () => {
    const original = [
      { id: 'first', name: 'First', enabled: true },
      { id: 'second', name: 'Before edit', enabled: true },
    ];
    const updated = { id: 'second', name: 'After edit', enabled: false };

    const result = replaceConnectorById(original, updated);

    expect(result).toEqual([original[0], updated]);
    expect(result).not.toBe(original);
    expect(original[1].name).toBe('Before edit');
  });
});
