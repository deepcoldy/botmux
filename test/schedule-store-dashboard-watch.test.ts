import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

it('reconciles real filesystem notifications after local writes and early reads', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'schedule-watch-'));
  const source = `
    import assert from 'node:assert/strict';
    import { writeFileSync, renameSync } from 'node:fs';
    import * as store from './src/services/schedule-store.ts';
    import { dashboardEventBus } from './src/core/dashboard-events.ts';
    import { Aggregator } from './src/dashboard/aggregator.ts';
    const app = 'cli_schedule_watch_test';
    store.setScheduleScope(app);
    const task = store.createTask({
      id: 'task', name: 'Report', schedule: '0 12 * * *',
      parsed: { kind: 'cron', expr: '0 12 * * *', display: 'daily' },
      prompt: 'Public news', workingDir: process.env.SESSION_DATA_DIR,
      chatId: 'oc_test', larkAppId: app,
    });
    const agg = new Aggregator();
    agg.hydrateSchedules(app, store.listTasks());
    store.startExternalWriteWatcher();
    dashboardEventBus.subscribe(event => agg.applyEvent(app, JSON.parse(JSON.stringify(event))));
    async function until(predicate) {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'dashboard did not converge');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    store.removeTask(task.id);
    await until(() => agg.getSchedules().length === 0);
    store.createTask({ ...task, id: 'next' });
    await until(() => agg.getSchedules().length === 1);
    const file = store.scheduleFilePathFor(app);
    writeFileSync(file + '.test', '{}');
    renameSync(file + '.test', file);
    assert.equal(store.listTasks().length, 0);
    await until(() => agg.getSchedules().length === 0);
    console.log('WATCHER_OK');
  `;
  try {
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(source, {
        env: { ...process.env, SESSION_DATA_DIR: join(scratch, 'data') },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
      });
      let output = '';
      child.stdout?.on('data', chunk => { output += chunk; });
      child.stderr?.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    expect(result.output).toContain('WATCHER_OK');
    expect(result.code).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
