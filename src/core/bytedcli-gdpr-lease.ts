import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { snapshotBytedcliTrustedFiles } from './bytedcli-runtime-integrity.js';
import { bytedcliSafeFingerprint, type BytedcliCredentialLease, type BytedcliLeaseResolver } from './bytedcli-broker-credentials.js';
import { BytedcliBrokerError } from './bytedcli-broker-process.js';
/** Host operator selects this protected platform-login cache. JWT claims only
 * bound freshness; they do not prove a ByteCloud subject or an actor account. */
export function createBytedcliGdprLeaseResolver(machineFile?: string): NonNullable<BytedcliLeaseResolver['realm']> {
  if (machineFile && (!isAbsolute(machineFile) || resolve(machineFile) !== machineFile)) throw new BytedcliBrokerError('invalid_request');
  return async (realm, kind, request): Promise<BytedcliCredentialLease> => {
    if (kind !== 'machine') throw new BytedcliBrokerError('actor_identity_unverified');
    if (realm !== 'gdpr' || !machineFile) throw new BytedcliBrokerError('region_auth_required');
    if (request.signal.aborted) throw new BytedcliBrokerError('cancelled');
    const stale = await request.recheck(); if (stale) throw new BytedcliBrokerError(stale);
    try {
      const before = lstatSync(machineFile);
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.size > 16 * 1024
        || process.getuid && before.uid !== process.getuid()) throw new Error('unsafe');
      const snapshot = snapshotBytedcliTrustedFiles([machineFile]);
      const fd = openSync(machineFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      let jwt: string;
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('changed');
        jwt = readFileSync(fd, 'utf8').trim();
      } finally { closeSync(fd); }
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt) || !snapshot.stillCurrent()) throw new Error('unsafe');
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
      const expiration = claims.exp ?? claims.expireTime;
      if (!Number.isSafeInteger(expiration)) throw new Error('invalid expiry');
      const expiresAt = expiration * 1000;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() + 60_000) throw new Error('expired');
      const stillCurrent = async () => {
        if (request.signal.aborted) return 'cancelled' as const;
        const code = await request.recheck(); if (code) return code;
        if (!snapshot.stillCurrent() || expiresAt <= Date.now() + 60_000) return 'region_auth_required' as const;
        return undefined;
      };
      const code = await stillCurrent(); if (code) throw new BytedcliBrokerError(code);
      return Object.freeze({ realm: 'gdpr', jwt, kind, source: 'machine', region: 'cn', expiresAt,
        // Credential-source fingerprint; deliberately not a claimed account subject.
        accountFingerprint: bytedcliSafeFingerprint(['gdpr', 'host-operator-machine-cache', machineFile, jwt]), stillCurrent });
    } catch (error) {
      if (error instanceof BytedcliBrokerError) throw error;
      throw new BytedcliBrokerError('region_auth_required');
    }
  };
}
