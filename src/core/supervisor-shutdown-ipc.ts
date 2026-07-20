export const SUPERVISOR_SHUTDOWN_ROUTE = '/__supervisor-ipc/v1/shutdown';

export interface SupervisorShutdownIdentity {
  larkAppId: string;
  bootInstanceId: string;
  processStartIdentity: string;
}

export interface SupervisorShutdownRequest extends SupervisorShutdownIdentity {}

export function isExactSupervisorShutdownRequest(
  identity: SupervisorShutdownIdentity,
  value: unknown,
): value is SupervisorShutdownRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.larkAppId === identity.larkAppId
    && record.bootInstanceId === identity.bootInstanceId
    && record.processStartIdentity === identity.processStartIdentity;
}
