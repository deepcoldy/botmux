/**
 * Subprocess driver for the v3 run-envelope FIFO regression tests.
 *
 * Usage: node --import tsx read-run-envelope-cli.ts <envelope|load> <runDir>
 *
 * Runs the reader in an isolated child so a regression that re-introduces a
 * blocking open hangs THIS process instead of the vitest worker; the parent
 * enforces an execFileSync timeout and fails loudly on the killed child.
 * Prints a single JSON line with the outcome and exits 0.
 */
import {
  RunEnvelopeIntegrityError,
  loadAuthorizedV3Run,
  readRunEnvelope,
} from '../../src/workflows/v3/run-envelope.js';

const [mode, runDir] = process.argv.slice(2);
if (!runDir || (mode !== 'envelope' && mode !== 'load')) {
  console.error('usage: read-run-envelope-cli.ts <envelope|load> <runDir>');
  process.exit(2);
}

if (mode === 'envelope') {
  const read = readRunEnvelope(runDir);
  console.log(JSON.stringify({
    kind: read.kind,
    problems: read.kind === 'invalid' ? read.problems : [],
  }));
} else {
  try {
    loadAuthorizedV3Run(runDir);
    console.log(JSON.stringify({ threw: false }));
  } catch (err) {
    console.log(JSON.stringify({
      threw: true,
      code: err instanceof RunEnvelopeIntegrityError ? err.code : 'unknown',
    }));
  }
}
