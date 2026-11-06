/** A minimal writable surface whose completion callback means the chunk has
 * reached the underlying stream.  `write()` returning false is only a
 * backpressure signal; callers that must not exit early must await callback. */
export interface CompletionWritable {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

/** Write one complete payload before allowing a child process to exit. */
export function writeAndFlush(stream: CompletionWritable, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
