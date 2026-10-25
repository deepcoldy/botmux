import { REMOTE_RUNNER_BASE_CAPABILITIES, type RemoteRunnerCapability } from '../adapters/backend/remote-runner-protocol.js';

/** Native Orca uses host-acknowledged final delivery, including across runner restarts. */
export const ORCA_RUNNER_CAPABILITIES: readonly RemoteRunnerCapability[] = [
  ...REMOTE_RUNNER_BASE_CAPABILITIES, 'turn_recovery', 'outbound_message', 'outbound_message_final',
];
