import {
  unavailableDashboardSummary,
  type DashboardSummary,
} from './dashboard-summary.js';

const ANONYMOUS_WINDOW_MS = 10_000;
const ANONYMOUS_MAX_REQUESTS = 5;

export type DashboardSummaryEndpointResult =
  | {
    status: 200;
    headers: { 'cache-control': 'no-store' };
    body: DashboardSummary;
  }
  | {
    status: 429;
    headers: { 'cache-control': 'no-store'; 'retry-after': string };
    body: { error: 'rate_limited'; retryAfterSeconds: number };
  }
  | {
    status: 503;
    headers: { 'cache-control': 'no-store' };
    body: ReturnType<typeof unavailableDashboardSummary>;
  };

export interface DashboardSummaryEndpoint {
  get(input: { authenticated: boolean }): Promise<DashboardSummaryEndpointResult>;
}

/**
 * Own the public summary request policy behind one small interface. The live
 * fleet loader is injected so callers and tests cross the same seam.
 */
export function createDashboardSummaryEndpoint(options: {
  load: () => Promise<DashboardSummary>;
  now?: () => number;
  onError?: (error: unknown) => void;
}): DashboardSummaryEndpoint {
  const now = options.now ?? Date.now;
  const anonymousAttempts: number[] = [];

  return {
    async get(input) {
      if (!input.authenticated) {
        const requestAt = now();
        while (
          anonymousAttempts.length > 0
          && requestAt - anonymousAttempts[0] >= ANONYMOUS_WINDOW_MS
        ) {
          anonymousAttempts.shift();
        }
        if (anonymousAttempts.length >= ANONYMOUS_MAX_REQUESTS) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((anonymousAttempts[0] + ANONYMOUS_WINDOW_MS - requestAt) / 1000),
          );
          return {
            status: 429,
            headers: {
              'cache-control': 'no-store',
              'retry-after': String(retryAfterSeconds),
            },
            body: { error: 'rate_limited', retryAfterSeconds },
          };
        }
        anonymousAttempts.push(requestAt);
      }

      try {
        return {
          status: 200,
          headers: { 'cache-control': 'no-store' },
          body: await options.load(),
        };
      } catch (error) {
        options.onError?.(error);
        return {
          status: 503,
          headers: { 'cache-control': 'no-store' },
          body: unavailableDashboardSummary(new Date(now())),
        };
      }
    },
  };
}
