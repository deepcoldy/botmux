import { getDashboardAdminOpenIds as defaultGetDashboardAdminOpenIds } from '../bot-registry.js';

export interface DashboardAdminLookupDeps {
  getDashboardAdminOpenIds?: (larkAppId: string) => ReadonlyArray<string> | undefined;
  /** Legacy test seam retained while callers migrate from first-owner checks. */
  getOwnerOpenId?: (larkAppId: string) => string | undefined;
}

export function resolveDashboardAdminOpenIds(
  larkAppId: string,
  deps: DashboardAdminLookupDeps = {},
): string[] {
  if (deps.getDashboardAdminOpenIds) {
    return [...(deps.getDashboardAdminOpenIds(larkAppId) ?? [])].filter(Boolean);
  }
  if (deps.getOwnerOpenId) {
    const owner = deps.getOwnerOpenId(larkAppId);
    return owner ? [owner] : [];
  }
  return defaultGetDashboardAdminOpenIds(larkAppId).filter(Boolean);
}

export function isDashboardAdmin(
  larkAppId: string,
  openId: string | undefined,
  deps: DashboardAdminLookupDeps = {},
): openId is string {
  return !!openId && resolveDashboardAdminOpenIds(larkAppId, deps).includes(openId);
}
