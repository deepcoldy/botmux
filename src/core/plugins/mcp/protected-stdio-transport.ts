import { spawn, type ChildProcessWithoutNullStreams, type IOType } from 'node:child_process';
import { PassThrough, type Stream } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface ProtectedStdioServerParameters {
  command: string;
  args?: string[];
  env: Record<string, string>;
  cwd?: string;
  stderr?: IOType | Stream | number;
  inheritedSecretFd: number;
}

/** Stdio MCP transport with one read-only host fd mapped to child fd 3. */
export class ProtectedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private process?: ChildProcessWithoutNullStreams;
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;

  constructor(private readonly server: ProtectedStdioServerParameters) {
    this.stderrStream = server.stderr === 'pipe' || server.stderr === 'overlapped'
      ? new PassThrough()
      : null;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('ProtectedStdioClientTransport already started');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.server.command, this.server.args ?? [], {
        env: this.server.env,
        stdio: ['pipe', 'pipe', this.server.stderr ?? 'inherit', this.server.inheritedSecretFd],
        shell: false,
        windowsHide: true,
        cwd: this.server.cwd,
      });
      this.process = child as ChildProcessWithoutNullStreams;
      child.once('error', error => {
        reject(error);
        this.onerror?.(error);
      });
      child.once('spawn', resolve);
      child.once('close', () => {
        this.process = undefined;
        this.onclose?.();
      });
      child.stdin?.on('error', error => this.onerror?.(error));
      child.stdout?.on('data', chunk => {
        try {
          this.readBuffer.append(chunk);
          while (true) {
            const message = this.readBuffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
          }
        } catch (error) {
          this.onerror?.(error as Error);
          void this.close();
        }
      });
      child.stdout?.on('error', error => this.onerror?.(error));
      if (this.stderrStream && child.stderr) child.stderr.pipe(this.stderrStream);
    });
  }

  get stderr(): Stream | null {
    return this.stderrStream ?? this.process?.stderr ?? null;
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (child) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.stdin?.end();
      await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 2_000).unref())]);
      if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 2_000).unref())]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    this.readBuffer.clear();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('Not connected'));
        return;
      }
      const payload = serializeMessage(message);
      if (this.process.stdin.write(payload)) resolve();
      else this.process.stdin.once('drain', resolve);
    });
  }
}
