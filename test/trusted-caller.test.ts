import { describe, expect, it, vi } from 'vitest';
import { buildTrustedCallerWithUnionFallback } from '../src/utils/trusted-caller.js';

describe('trusted caller', () => {
  it('uses the event union_id when Lark already stamped it', async () => {
    const resolve = vi.fn();

    const caller = await buildTrustedCallerWithUnionFallback(
      'cli_app',
      'ou_user',
      'on_event_user',
      resolve,
    );

    expect(caller).toEqual({
      requestUserOpenId: 'ou_user',
      requestUserUnionId: 'on_event_user',
      requestLarkAppId: 'cli_app',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves union_id from open_id when the event lacks union_id', async () => {
    const resolve = vi.fn().mockResolvedValue('on_resolved_user');

    const caller = await buildTrustedCallerWithUnionFallback(
      'cli_app',
      'ou_user',
      undefined,
      resolve,
    );

    expect(resolve).toHaveBeenCalledWith('cli_app', 'ou_user');
    expect(caller).toEqual({
      requestUserOpenId: 'ou_user',
      requestUserUnionId: 'on_resolved_user',
      requestLarkAppId: 'cli_app',
    });
  });

  it('keeps fail-closed semantics when open_id lookup cannot resolve union_id', async () => {
    const resolve = vi.fn().mockResolvedValue(null);

    const caller = await buildTrustedCallerWithUnionFallback(
      'cli_app',
      'ou_user',
      undefined,
      resolve,
    );

    expect(caller).toEqual({
      requestUserOpenId: 'ou_user',
      requestUserUnionId: undefined,
      requestLarkAppId: 'cli_app',
    });
  });
});
