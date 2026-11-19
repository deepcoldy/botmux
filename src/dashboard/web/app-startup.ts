export interface DashboardStartupTasks {
  route: () => Promise<void>;
  bootstrap: () => Promise<void>;
  afterNextPaint: (task: () => void) => void;
  optional: () => void;
  onBotsChanged: (listener: () => void) => void;
  reloadNameMaps: () => void;
  onBootstrapError: (error: unknown) => void;
}

/** Start independent page/shell work before waiting for global snapshots. */
export async function runDashboardStartup(tasks: DashboardStartupTasks): Promise<void> {
  // A routed page may start the memoized name read immediately, so the
  // invalidation listener must already exist before that page is mounted.
  tasks.onBotsChanged(tasks.reloadNameMaps);
  const firstRoute = tasks.route();
  // Scheduling is deliberately independent of bootstrap: optional schedules
  // may hang after the session snapshot has already made the page useful.
  tasks.afterNextPaint(tasks.optional);
  try {
    await tasks.bootstrap();
  } catch (error) {
    tasks.onBootstrapError(error);
  }
  await firstRoute;
}
