/** Reads the routing and expiry claims of a JWT issued by the credential provider. */
export function jwtClaims(jwt: string): { region?: unknown; exp?: unknown } | null {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}
