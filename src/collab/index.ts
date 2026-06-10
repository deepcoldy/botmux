/**
 * collab — shared-cognition collaboration core (P0.0 walking skeleton).
 *
 * The integration面 (daemon/registry/IM/control-plane) should import from here.
 * The contract (events, board interface, snapshot) is the only seam; the board
 * factory (openCollabBoard) is the only constructor it needs.
 */
export * from './contract.js';
export { openCollabBoard, getCollabRunsDir } from './board.js';
export type { CollabBoardOptions } from './board.js';
// event-log/materialize are core internals; exported for tests & the referee.
export { CollabEventLog } from './event-log.js';
export { materialize } from './materialize.js';
export { runReferee, execOracleAdapter, STALL_THRESHOLD } from './referee.js';
export type { RefereeResult, RefereeOptions, OracleAdapter, OracleEvaluation } from './referee.js';
export { getWorkerProtocolText, WORKER_PROTOCOL_TEXT } from './worker-protocol.js';
export { parseCollabIntake, buildAcceptanceCriteria } from './intake.js';
export type { CollabIntake, AcceptanceParts } from './intake.js';
