import { createDefaultAppSmokeDeps, runAppSmokeCommand } from '../src/desktop/smoke.js';

process.exitCode = await runAppSmokeCommand(process.argv.slice(2), createDefaultAppSmokeDeps());
