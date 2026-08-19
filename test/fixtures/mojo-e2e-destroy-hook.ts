/**
 * Preload hook for the mojo close END-TO-END tests.
 *
 * WHY A PRELOAD AND NOT A vi.mock
 * -------------------------------
 * The behaviours under test live on the REAL wire: the worker's `catch` around
 * destroySession(), buildCloseResultMessage()'s `recovery` field, and the
 * daemon's worker-exit / close-result-timeout fences. Reaching them needs a
 * genuine `src/worker.ts` CHILD PROCESS talking real IPC to the real
 * worker-pool, so an in-process `vi.mock` cannot help: it only patches the
 * daemon's module graph, and the worker is a separate process.
 *
 * This module is loaded inside that child via `node --import`, so it patches
 * the exact MojoBackend the worker will use and nothing else. Every layer that
 * OWNS a decision stays production code:
 *   - the worker's close handler (catch / normalize / send)
 *   - destroy-result.ts
 *   - the real IPC boundary
 *   - the daemon's closeSession(), its abort decision, and the durable journal
 *
 * Only the TRIGGER is injected, because no bots.json / fake-binary combination
 * can make MojoBackend.destroySession() reject, hang forever, or take the
 * worker down: every internal failure is already caught and converted into a
 * structured SessionDestroyResult. Injecting the trigger is the only way to
 * exercise the unknown-outcome fences -- and a trigger is not a verdict, so all
 * four decision points remain observable (and mutation-killable) from here.
 *
 * Modes (BOTMUX_E2E_DESTROY_MODE):
 *   throw  destroySession() rejects        -> worker.ts catch must fence
 *   hang   destroySession() never settles  -> daemon close-result timeout fence
 *   exit   worker dies mid-prepare         -> daemon worker-exit fence
 *
 * Plus one mode that injects NO behaviour at all, only a path:
 *   unscannable  procRoot -> a missing dir, so the REAL scan cannot prove the
 *                subtree is gone and the REAL verdict is retryable + fenced
 *
 * Plus one that injects an EVIDENCE GRADE and nothing else:
 *   localResidual  terminateChildProven() reports the Linux-normal weak-handle
 *                  outcome (ok, but boundary NOT proven). Everything downstream --
 *                  the two-level gate in destroySession, buildCloseResultMessage,
 *                  the IPC hop, the daemon's publish decision -- stays production
 *                  code. That is deliberate: whether this grade is computed
 *                  correctly is charge A's question and is covered elsewhere; the
 *                  question HERE is whether the grade survives the wire, which is
 *                  exactly what it did not.
 */
import { MojoBackend } from '../../src/adapters/backend/mojo-backend.js';

const mode = process.env.BOTMUX_E2E_DESTROY_MODE;
type Destroy = MojoBackend['destroySession'];

if (mode === 'unscannable') {
  // NOT a verdict injection: `procRoot` is a `protected` getter that exists
  // precisely so the subtree scan can be pointed somewhere else in tests.
  // Aiming it at a path that does not exist makes readProcTable() fail, which
  // is the real "cannot prove the subtree is gone" condition — so
  // terminateChildProven(), destroySession() and the whole verdict below it are
  // computed by production code:
  //   mojo_local_child_termination_unproven + recovery:'retryable' + admission:'fenced'
  //
  // That combination is the one place where the two answers legitimately
  // DISAGREE (the irreversible cancel never ran, so the close may be retried,
  // but a credentialed process may still be alive, so writes must stay fenced),
  // which makes it the only end-to-end probe for "the daemon must not re-derive
  // admission from recovery".
  Object.defineProperty(MojoBackend.prototype, 'procRoot', {
    get() { return '/nonexistent-proc-for-e2e'; },
    configurable: true,
  });
}

if (mode === 'throw') {
  // A THROWN destroySession leaves the outcome unknown: it may already have
  // cancelled the remote session. The worker must fence, not roll back.
  MojoBackend.prototype.destroySession = (async function destroySessionThrows() {
    throw new Error('e2e injected destroySession failure');
  }) as Destroy;
} else if (mode === 'hang') {
  // Still running remotely when the daemon's budget expires: unknown outcome.
  MojoBackend.prototype.destroySession = (function destroySessionHangs() {
    return new Promise(() => { /* never settles, on purpose */ });
  }) as Destroy;
} else if (mode === 'exit') {
  // The worker dies mid-prepare, so whatever destroySession() had already done
  // -- including a completed irreversible cancel -- is unknowable. Hard exit:
  // no IPC flush and no close_result, which is the production shape of a worker
  // that crashed while preparing the close.
  MojoBackend.prototype.destroySession = (function destroySessionKillsWorker(): never {
    process.exit(7);
  }) as unknown as Destroy;
}

if (mode === 'localResidual') {
  // ok:true with boundaryProven:false is not a contrived state -- it is the
  // ordinary Linux weak-handle outcome: the turn's child is gone and signalling
  // succeeded, but a /proc scan is not an unforgeable boundary proof, so the
  // containment handle is kept. Reaching it through a real scan would need a
  // synthetic /proc tree in the child; the grade itself is asserted directly in
  // test/mojo-termination-outcome.test.ts, so injecting it here keeps this probe
  // aimed at the seam that actually broke.
  //
  // Injected on the protected method rather than on destroySession(), so the
  // branch that turns this grade into a residual close still runs for real. A
  // stub of destroySession() would have concealed the bug: the payload builder
  // and the daemon are the parts that dropped the field.
  Object.defineProperty(MojoBackend.prototype, 'terminateChildProven', {
    value: async function terminateChildProvenLocalResidual() {
      return {
        ok: true,
        boundaryProven: false,
        evidence: 'diagnostic-clean',
        residual: { deviceIsolation: true, reason: 'e2e injected weak-handle grade' },
        signalsStopped: true,
      };
    },
    configurable: true,
    writable: true,
  });
}
