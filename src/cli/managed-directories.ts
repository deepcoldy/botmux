import { readFileSync } from 'node:fs';
import { beginDirectoryCollection, retireManagedDirectories, resumeDirectoryRetirement } from '../services/managed-directory-retention.js';

/** Local operator protocol. JSON enters on stdin; no Feishu transport or daemon
 * restart. External collectors must hold their own installer/singleton locks. */
export async function managedDirectoriesCommand(args: string[]): Promise<void> {
  try {
    if (args.length !== 1 || !['begin', 'retire', 'resume'].includes(args[0])) {
      throw new Error('usage: botmux managed-directories begin|retire|resume < request.json');
    }
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (input.protocol !== 'botmux.managed-directories.v1') throw new Error('invalid_protocol');
    const result = args[0] === 'begin' ? { id: beginDirectoryCollection() }
      : args[0] === 'retire' ? { quarantined: retireManagedDirectories(input.id, input.candidates, input.retained) }
      : { quarantined: resumeDirectoryRetirement(input.path) };
    process.stdout.write(JSON.stringify({ protocol: input.protocol, ok: true, ...result }) + '\n');
  } catch (error) {
    process.stderr.write(`managed-directories: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
