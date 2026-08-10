export interface Pm2ExactStartClient {
  launchRPC(callback: (error?: unknown) => void): void;
  executeRemote(
    method: 'startProcessId',
    processId: number,
    callback: (error?: unknown) => void,
  ): void;
  close(callback: (error?: unknown) => void): void;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

/** `God.startProcessId` rejects these states before executeApp and therefore
 * cannot have killed or restarted a live generation. The final jlist remains
 * authoritative about whether the fleet is available. */
export function isNonMutatingPm2StartRefusal(error: unknown): boolean {
  return /(?:\bid unknown\b|process already online|process already started|process with pid \d+ already exists)/i
    .test(errorText(error));
}

function launchRpc(client: Pm2ExactStartClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.launchRPC(error => error ? reject(error) : resolve());
  });
}

function closeRpc(client: Pm2ExactStartClient): Promise<void> {
  return new Promise(resolve => client.close(() => resolve()));
}

function startExactProcessId(
  client: Pm2ExactStartClient,
  processId: number,
): Promise<string | null> {
  return new Promise(resolve => {
    client.executeRemote('startProcessId', processId, error => {
      if (!error || isNonMutatingPm2StartRefusal(error)) {
        resolve(null);
        return;
      }
      resolve(`pm_id ${processId}: ${errorText(error)}`);
    });
  });
}

/** Connect once and concurrently issue PM2's conditional startProcessId RPC
 * for distinct exact registry identities. The caller must hold Botmux's shared
 * fleet-operation lock: PM2 checks a row before an async fork and is not itself
 * a CAS across two clients. Unlike `pm2 start <name|id>`, this never routes
 * through restartProcessId or intentionally interrupts a live successor. */
export async function startExactPm2ProcessIds(
  processIds: number[],
  client: Pm2ExactStartClient,
): Promise<void> {
  const uniqueIds = [...new Set(processIds)];
  if (uniqueIds.length !== processIds.length
    || uniqueIds.some(id => !Number.isInteger(id) || id < 0)) {
    throw new Error('exact PM2 compensation requires unique non-negative pm_id values');
  }
  if (uniqueIds.length === 0) return;

  await launchRpc(client);
  try {
    const failures = (await Promise.all(
      uniqueIds.map(id => startExactProcessId(client, id)),
    )).filter((failure): failure is string => !!failure);
    if (failures.length > 0) {
      throw new Error(`conditional PM2 start failed (${failures.join('; ')})`);
    }
  } finally {
    await closeRpc(client);
  }
}
