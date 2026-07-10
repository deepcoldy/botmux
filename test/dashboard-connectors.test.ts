import { describe, expect, it } from 'vitest';

import { buildConnectorInstructionUpdateBody } from '../src/dashboard/web/connectors-page.js';

describe('dashboard connector instruction editing', () => {
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
