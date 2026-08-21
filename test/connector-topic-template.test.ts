import { describe, expect, it, vi } from 'vitest';

import { renderConnectorTopicTemplate } from '../src/services/connector-topic-template.js';
import type { ConnectorDefinition } from '../src/services/connector-store.js';

function templateConnector(): ConnectorDefinition {
  return {
    id: 'conn_template',
    name: 'Meego development',
    enabled: true,
    verify: {
      type: 'token',
      secretRef: 'secret',
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_topic' },
    promptEnvelope: {
      sourceName: 'Meego',
      headerAllowlist: [],
      includeRawText: false,
      maxBodyBytes: 1024,
    },
    topicMessage: {
      mode: 'template',
      text: '{{mention owners}} {{mention watchers}}',
      extractors: {
        owners: { path: '$.owners', kind: 'mention' },
        watchers: { path: '$.watchers', kind: 'mention' },
        unused: { path: '$.privateReviewers', kind: 'mention' },
      },
    },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
  };
}

describe('connector trusted topic template', () => {
  it('caps mention extraction globally across aliases', async () => {
    const resolveIdentities = vi.fn(async (_botId: string, identities: string[]) => (
      new Map(identities.map((identity, index) => [identity, `ou_${index}`]))
    ));
    const owners = Array.from({ length: 15 }, (_, index) => `owner${index}@corp.com`);
    const watchers = Array.from({ length: 15 }, (_, index) => `watcher${index}@corp.com`);

    await renderConnectorTopicTemplate(
      templateConnector(),
      { owners, watchers, privateReviewers: ['private@corp.com'] },
      resolveIdentities,
    );

    expect(resolveIdentities).toHaveBeenCalledWith('app1', [...owners, ...watchers.slice(0, 5)]);
  });

  it('keeps complete owner/trigger mentions and labels with oversized display names', async () => {
    const connector = templateConnector();
    connector.topicMessage = {
      mode: 'template',
      text: 'Meego启动开发：{{title}} {{mention owner}}负责人 {{mention trigger}}触发人',
      extractors: {
        title: { path: '$.title', kind: 'text' },
        owner: { path: '$.owner', kind: 'mention', identityPath: '$.email', namePath: '$.name' },
        trigger: { path: '$.trigger', kind: 'mention', identityPath: '$.email', namePath: '$.name' },
      },
    };

    const message = await renderConnectorTopicTemplate(
      connector,
      {
        title: '重要需求'.repeat(100),
        owner: { email: 'owner@corp.com', name: '超长负责人'.repeat(80) },
        trigger: { email: 'trigger@corp.com', name: '超长触发人'.repeat(80) },
      },
      async () => new Map([
        ['owner@corp.com', 'ou_owner'],
        ['trigger@corp.com', 'ou_trigger'],
      ]),
    );

    expect(Array.from(message ?? '')).toHaveLength(200);
    expect(message).toContain('<at user_id="ou_owner">');
    expect(message).toContain('</at>负责人');
    expect(message).toContain('<at user_id="ou_trigger">');
    expect(message).toContain('</at>触发人');
    expect((message?.match(/<at /g) ?? [])).toHaveLength(2);
    expect((message?.match(/<\/at>/g) ?? [])).toHaveLength(2);
  });

  it('keeps a native mention when a template has an oversized static suffix', async () => {
    const connector = templateConnector();
    connector.topicMessage = {
      mode: 'template',
      text: `{{mention owners}}负责人${'补充说明'.repeat(44)}`,
      extractors: { owners: { path: '$.owner', kind: 'mention' } },
    };

    const message = await renderConnectorTopicTemplate(
      connector,
      { owner: 'owner@corp.com' },
      async () => new Map([['owner@corp.com', 'ou_owner']]),
    );

    expect(Array.from(message ?? '').length).toBeLessThanOrEqual(200);
    expect(message).toContain('<at user_id="ou_owner">owner@corp.com</at>负责人');
  });

  it.each([4, 20])(
    'keeps a prefix of %i resolved owners as complete native mentions',
    async ownerCount => {
      const connector = templateConnector();
      connector.topicMessage = {
        mode: 'template',
        text: '{{mention owners}}负责人',
        extractors: {
          owners: { path: '$.owners', kind: 'mention', identityPath: '$.email', namePath: '$.name' },
        },
      };
      const owners = Array.from({ length: ownerCount }, (_, index) => ({
        email: `owner${index + 1}@corp.com`,
        name: `Owner ${index + 1}`,
      }));
      const resolved = new Map(owners.map((owner, index) => [
        owner.email,
        `ou_${String(index + 1).padStart(2, '0')}${'a'.repeat(30)}`,
      ]));

      const message = await renderConnectorTopicTemplate(
        connector,
        { owners },
        async () => resolved,
      );

      expect(Array.from(message ?? '')).toHaveLength(191);
      expect(message).toBe(
        `${owners.slice(0, 3).map(owner => (
          `<at user_id="${resolved.get(owner.email)}">${owner.name}</at>`
        )).join(' ')}负责人`,
      );
      expect((message?.match(/<at /g) ?? [])).toHaveLength(3);
      expect(message).not.toContain('Owner 4');
    },
  );
});
