import { runBytedcliExecEntry } from './cli/bytedcli-exec.js';
process.exitCode=await runBytedcliExecEntry(process.argv.slice(2));
