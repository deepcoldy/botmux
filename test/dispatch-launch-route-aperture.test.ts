import { describe, expect, it } from 'vitest';

import { routeHasNarrowUntrustedAuth } from '../src/core/dashboard-ipc-server.js';

describe('dispatch launch IPC narrow authentication aperture', () => {
  const id = `dl_${'a'.repeat(32)}`;

  it('allows only GET/POST under the dedicated signed route prefix', () => {
    expect(routeHasNarrowUntrustedAuth('POST', `/__dispatch-launch-ipc/v1/operations/${id}/prepare`)).toBe(true);
    expect(routeHasNarrowUntrustedAuth('GET', `/__dispatch-launch-ipc/v1/operations/${id}`)).toBe(true);
    expect(routeHasNarrowUntrustedAuth('DELETE', `/__dispatch-launch-ipc/v1/operations/${id}`)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', `/__dispatch-launch-ipc/v1/operations/${id}`)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('GET', `/__dispatch-launch-ipc/v1/operations/${id}/prepare`)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', `/__dispatch-launch-ipc/v1/operations/${id}/unknown`)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', '/__dispatch-launch-ipc/v1/operations/not-an-id/prepare')).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', '/__dispatch-launch-ipc/v1/not-operations/x')).toBe(false);
  });
});
