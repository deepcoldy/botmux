/**
 * Stable process-birth identity used by supervisor mutation authority.
 *
 * This used to be a verbatim copy of `utils/process-identity`'s
 * `readProcessStartIdentity` (the supervisor variant only differed in using
 * `Number.isSafeInteger` for the pid guard, which the shared function now does
 * too). The token is persisted and compared across daemon generations, so there
 * must be exactly one implementation of it; the supervisor-facing name is kept
 * for existing importers.
 */
export { readProcessStartIdentity as readSupervisorProcessStartIdentity } from '../utils/process-identity.js';
