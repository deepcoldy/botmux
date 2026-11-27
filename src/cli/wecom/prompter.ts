import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** The WeCom setup wizard's text questions and output lines. */
export interface WecomPrompter {
  ask(question: string, options?: { hidden?: boolean; defaultValue?: string }): Promise<string | null>;
  write(message: string): void;
}
/** A dedicated output stream prevents readline from echoing any secret bytes.
 * terminal=true disables the terminal driver's own echo. Ctrl-C/EOF cancel. */
export function createWecomPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): WecomPrompter {
  return {
    write: message => {
      output.write(`${message}\n`);
    },
    ask(question, options = {}) {
      return new Promise(resolveAnswer => {
        let settled = false;
        const writer = new Writable({
          write(chunk, _encoding, done) {
            if (!options.hidden) {
              output.write(chunk);
            }
            done();
          },
        });
        const rl = createInterface({ input, output: writer, terminal: true });
        const finish = (answer: string | null) => {
          if (settled) return;
          settled = true;
          rl.close();
          writer.end();
          if (options.hidden) output.write('\n');
          resolveAnswer(answer);
        };
        rl.on('SIGINT', () => finish(null));
        rl.on('close', () => finish(null));
        const suffix = options.defaultValue ? ` [${options.defaultValue}]` : '';
        const prompt = `${question}${suffix}: `;
        if (options.hidden) output.write(prompt);
        rl.question(options.hidden ? '' : prompt, answer => finish(answer || options.defaultValue || ''));
      });
    },
  };
}
