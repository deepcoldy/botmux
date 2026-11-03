import { describe, expect, it } from 'vitest';

import {
  defaultConnectorLifecycleGroupName,
  renderConnectorLifecycleGroupName,
} from '../src/services/connector-lifecycle-group-name.js';
import type { ConnectorDefinition } from '../src/services/connector-store.js';

function connector(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
  return {
    id: 'conn_group_name',
    name: 'Alerts',
    enabled: true,
    verify: {
      type: 'token',
      secretRef: 'whsec_test',
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: { mode: 'new-group', kind: 'turn', botId: 'app1' },
    promptEnvelope: {
      sourceName: 'alerts',
      headerAllowlist: [],
      includeRawText: false,
      maxBodyBytes: 1024,
    },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: { dedupKey: '$.payload.id' },
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('connector lifecycle group names', () => {
  it('resolves payload-prefixed template paths from the webhook body root', () => {
    const name = renderConnectorLifecycleGroupName(
      connector({
        lifecycleGroupName: {
          mode: 'template',
          text: '告警 {{payload.name}} #{{$.payload.id}} 根={{name}}',
        },
      }),
      {
        name: 'ROOT_NAME',
        payload: { name: 'BUSINESS_TITLE', id: 'wi_1' },
      },
      { dedupKey: 'wi_1', requestId: 'req_1' },
    );

    expect(name).toBe('告警 BUSINESS_TITLE #wi_1 根=ROOT_NAME');
  });

  it('keeps the legacy UTF-16 budget without splitting emoji in default names', () => {
    const name = defaultConnectorLifecycleGroupName(connector(), '😀'.repeat(40));

    expect(name).toBe(`Alerts: ${'😀'.repeat(23)}...`);
    expect(name.length).toBeLessThanOrEqual(58);
  });
});
