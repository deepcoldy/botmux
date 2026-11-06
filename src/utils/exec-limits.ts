/**
 * Output caps for child_process exec* calls.
 *
 * Node's exec / execFile / execSync / execFileSync / spawnSync all default to
 * `maxBuffer: 1024 * 1024`. Past that the child is killed and the call throws
 * (sync: `ENOBUFS`; async: `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`). For a
 * whole-process-table `ps` scan the output scales with the host's process
 * count (and with argv length when `args`/`command` is selected; on macOS even
 * `comm` is a full path), so a busy shared host crosses 1MiB and every caller
 * silently drops into its fail-closed branch.
 */

/** maxBuffer for any whole-process-table scan (`ps -A` / `-ax` / `-e` …). */
export const PROCESS_TABLE_MAX_BUFFER = 32 * 1024 * 1024;
