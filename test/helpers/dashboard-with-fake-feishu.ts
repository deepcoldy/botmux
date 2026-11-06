/**
 * Boots the real Dashboard entry with Feishu's two H5 login endpoints answered
 * in-process, so a test can mint real H5 sessions through the real exchange
 * route. Every other non-loopback fetch is refused: the process can never
 * reach a real Feishu (or anything else) by accident.
 *
 * Env: BOTMUX_TEST_FAKE_FEISHU_CODES = JSON { code: { open_id, union_id? } },
 *      BOTMUX_TEST_DASHBOARD_ENTRY   = absolute path of src/index-dashboard.ts.
 */

const realFetch = globalThis.fetch;
const codes: Record<string, { open_id: string; union_id?: string }> =
  JSON.parse(process.env.BOTMUX_TEST_FAKE_FEISHU_CODES ?? '{}');

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/open-apis/auth/v3/app_access_token/internal') return json({ code: 0, app_access_token: 'fake-app-token' });
  if (url.pathname === '/open-apis/authen/v1/access_token') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { code?: string };
    const who = body.code ? codes[body.code] : undefined;
    return who ? json({ code: 0, data: who }) : json({ code: 20003, msg: 'bad code' });
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  throw new Error(`test dashboard refused an external fetch to ${url.host}`);
}) as typeof fetch;

await import(process.env.BOTMUX_TEST_DASHBOARD_ENTRY!);
