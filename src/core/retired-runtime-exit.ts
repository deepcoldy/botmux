/**
 * A worker whose live runtime binding the daemon retired
 * (`runtime_contract_assigned` with `mayExecute=false`) can never run anything
 * again: its transcript bridge and CLI backend are closed, and the close fence
 * it raises makes every later spawn — an in-worker restart included — abort as
 * superseded. Left alive, it only queues each new message as "CLI backend is
 * restarting" with no way out.
 *
 * So once no lifecycle operation (close / suspend / transfer) takes it over, the
 * worker hands its unwritten inputs to the session's next worker and ends its
 * generation with this exit code. The daemon then handles it like a deliberate
 * worker retirement: an input the worker never committed gets the honest
 * "unconfirmed" notice and the session goes dormant; if the worker handed over
 * inputs, a successor starts at once and types them, otherwise the next message
 * starts one.
 */
export const WORKER_EXIT_RUNTIME_RETIRED = 79;

/** How long the retired worker waits for the lifecycle operation that
 *  superseded its runtime. Close, suspend and transfer reach it in the same
 *  daemon flow as the retirement notice; this only bridges that IPC gap so
 *  their own teardown, not this exit, ends the worker. */
export const RETIRED_RUNTIME_EXIT_GRACE_MS = 5_000;

/** A successor started for handed-over inputs is not started again for the
 *  same session within this window: should it be retired too, its inputs wait
 *  for the next message instead of looping. */
export const RETIRED_RUNTIME_SUCCESSOR_COOLDOWN_MS = 60_000;
