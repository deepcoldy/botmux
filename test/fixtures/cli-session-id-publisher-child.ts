import { readFileSync } from 'node:fs';
import { publishCliSessionIdToDaemon } from '../../src/core/cli-session-id-publisher.js';
import type { WorkerToDaemon } from '../../src/types.js';

let staleProjection: Record<string, { riffParentTaskId?: string }> | undefined;

process.on('message', (message: any) => {
  if (message?.type === 'load') {
    staleProjection = JSON.parse(readFileSync(message.path, 'utf8'));
    process.send?.({
      type: 'loaded',
      riffParentTaskId: staleProjection?.[message.sessionId]?.riffParentTaskId,
    });
    return;
  }
  if (message?.type !== 'publish') return;
  let publishedMessage: WorkerToDaemon | undefined;
  const initConfig: { cliSessionId?: string } = {};
  const published = publishCliSessionIdToDaemon({
    cliSessionId: message.cliSessionId,
    sessionId: message.sessionId,
    initConfig,
    turnId: message.turnId,
    dispatchAttempt: message.dispatchAttempt,
    send: value => { publishedMessage = value; },
  });
  process.send?.({
    type: 'published',
    published,
    publishedMessage,
    initCliSessionId: initConfig.cliSessionId,
  });
});
