/**
 * Time budgets of the per-turn platform credential grant, and of every caller
 * that waits on one. Dependency-free on purpose: the CLI-side runners (the
 * identity wrapper's runner, the bound lark-cli runner) size their daemon
 * timeouts from these without pulling the grant client in.
 *
 * A grant sits on the turn's critical path, so the whole call — including its
 * one retry — has a hard cap. On a platform cache miss the grant is minted on
 * the spot, which takes seconds; once started, the platform finishes a mint
 * even if the client gave up, so a retry can land on another instance and mint
 * again from scratch.
 *
 * - First attempt: long enough to wait out a slow mint.
 * - Total: the same 30s the daemon gives a local bytedcli invocation
 *   (`BYTEDCLI_TIMEOUT_MS`), so preparing a turn's identity is bounded alike
 *   whichever source the credentials come from. The retry gets whatever is
 *   left of it (23s after a silent first attempt), not just another first
 *   attempt's worth.
 *
 * Everything that waits on a grant has to outlast it, or the longer budget is
 * cut short by whoever gave up first: see {@link GRANT_WAIT_CAP_MS} and
 * {@link GRANT_ROUTE_CLIENT_TIMEOUT_MS}.
 */
export const FIRST_ATTEMPT_TIMEOUT_MS = 7_000;
export const TOTAL_BUDGET_MS = 30_000;

/** Room for the union_id lookup that runs in front of a grant. The contact call
 *  has no deadline of its own; normally the id is already cached from the
 *  turn's inbound event. */
const UNION_ID_LOOKUP_ROOM_MS = 5_000;
/** Room for what a daemon route does around the grant: peer attestation, the
 *  Feishu token checks of the bound lark-cli route. */
const ROUTE_OVERHEAD_ROOM_MS = 5_000;

/** Daemon side: longest an identity fetch waits on work that ends in a grant
 *  (a turn's publication still in flight, a re-ask after a transient refusal)
 *  before it serves what it has and lets the work finish in the background. */
export const GRANT_WAIT_CAP_MS = TOTAL_BUDGET_MS + UNION_ID_LOOKUP_ROOM_MS;

/** Client side: timeout of a request to a daemon route that may wait up to
 *  {@link GRANT_WAIT_CAP_MS} (or run a grant itself). */
export const GRANT_ROUTE_CLIENT_TIMEOUT_MS = GRANT_WAIT_CAP_MS + ROUTE_OVERHEAD_ROOM_MS;
