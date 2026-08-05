/** Build the platform SSO jump while preserving only the current SPA hash. */
export function dashboardLoginHref(
  platformLoginUrl: string | undefined,
  hash: string,
): string | undefined {
  if (!platformLoginUrl) return undefined;
  try {
    const url = new URL(platformLoginUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const route = hash.startsWith('#/') && hash.length <= 4_096 && !/[\u0000-\u001f\u007f]/.test(hash)
      ? hash
      : '#/';
    url.searchParams.set('next', `/${route}`);
    return url.toString();
  } catch {
    return undefined;
  }
}
