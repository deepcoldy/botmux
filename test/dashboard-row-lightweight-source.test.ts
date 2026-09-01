import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/core/dashboard-ipc-server.ts'), 'utf8');
const rowsSource = readFileSync(resolve(process.cwd(), 'src/core/dashboard-rows.ts'), 'utf8');

describe('dashboard bulk session snapshots', () => {
  it('uses lightweight rows for /api/sessions snapshots', () => {
    expect(source).toContain('const DASHBOARD_SNAPSHOT_ROW_OPTS = { lightweight: true } as const;');
    expect(source).toContain('composeRowFromActive(ds, DASHBOARD_SNAPSHOT_ROW_OPTS)');
    expect(source).toContain('composeRowFromPersistedActive(session, DASHBOARD_SNAPSHOT_ROW_OPTS)');
    expect(source).toContain('composeRowFromClosed(session, DASHBOARD_SNAPSHOT_ROW_OPTS)');
  });

  it('uses lightweight rows for /api/events replay snapshots', () => {
    expect(source).toContain('composeRowFromActive(ds, DASHBOARD_SNAPSHOT_ROW_OPTS) })}\\n\\n`);');
    expect(source).toContain('composeRowFromPersistedActive(s, DASHBOARD_SNAPSHOT_ROW_OPTS) })}\\n\\n`);');
    expect(source).toContain('composeRowFromClosed(s, DASHBOARD_SNAPSHOT_ROW_OPTS) })}\\n\\n`);');
  });

  it('keeps open todo extraction behind the lightweight guard', () => {
    const start = rowsSource.indexOf('export function composeRowFromActive');
    const end = rowsSource.indexOf('export function composeRowFromClosed');
    const activeComposer = rowsSource.slice(start, end);
    const guard = 'if (!opts.lightweight) {';
    const beforeGuard = activeComposer.slice(0, activeComposer.indexOf(guard));

    expect(activeComposer).toContain(guard);
    expect(activeComposer).toContain('row.openTodos = sessionOpenTodos(ds.session, ds.workingDir, opts.fresh);');
    expect(beforeGuard).not.toContain('sessionOpenTodos(');
  });
});
