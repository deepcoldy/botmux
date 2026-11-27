/** Only replace the static HTML asset. All auth, CSRF and API routing execute
 * the real Dashboard with the caller's disposable HOME and empty bot registry. */
(globalThis as Record<string, unknown>).__BOTMUX_DASHBOARD_ASSETS__ = {
  'index.html': process.env.BOTMUX_ONBOARDING_TEST_INDEX,
};
await import('../../src/index-dashboard.js');
