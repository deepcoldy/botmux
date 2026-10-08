import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FixtureTape, SseEvent } from './types.js';
import { extractMarker, extractMarkerFromMessages } from './marker-extractor.js';

export class TapeRecorder {
  private fixturesDir: string;

  constructor(fixturesDir?: string) {
    this.fixturesDir = fixturesDir ?? join(process.cwd(), 'test/fixtures/mock-tapes');
    if (!existsSync(this.fixturesDir)) {
      mkdirSync(this.fixturesDir, { recursive: true });
    }
  }

  /**
   * Save a recorded request/response tape to disk.
   */
  saveTape(tape: FixtureTape): string {
    const filename = `${tape.id}.json`;
    const filePath = join(this.fixturesDir, filename);
    writeFileSync(filePath, JSON.stringify(tape, null, 2), 'utf-8');
    return filePath;
  }

  /**
   * Find a recorded tape matching the current request.
   */
  findTape(reqPath: string, model?: string): FixtureTape | null {
    if (!existsSync(this.fixturesDir)) return null;
    const files = readdirSync(this.fixturesDir).filter((f) => f.endsWith('.json'));
    const targetPath = (reqPath || '/').split('?')[0];

    for (const file of files) {
      try {
        const content = readFileSync(join(this.fixturesDir, file), 'utf-8');
        const tape = JSON.parse(content) as FixtureTape;
        const tapePath = (tape.request?.path ?? '').split('?')[0];
        if (tapePath === targetPath) {
          if (!model || tape.request?.model === model) {
            return tape;
          }
        }
      } catch {
        // ignore broken tape
      }
    }
    return null;
  }

  /**
   * Proxy request to upstream URL and record the full SSE stream.
   */
  async proxyAndRecord(
    req: IncomingMessage,
    res: ServerResponse,
    reqBody: any,
    upstreamBaseUrl: string,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', upstreamBaseUrl);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    headers['accept-encoding'] = 'identity';

    const upstreamReq = await fetch(url.toString(), {
      method: req.method ?? 'POST',
      headers: headers as Record<string, string>,
      body: reqBody ? JSON.stringify(reqBody) : undefined,
    });

    const respHeaders = Object.fromEntries(upstreamReq.headers.entries());
    delete respHeaders['content-encoding'];
    delete respHeaders['content-length'];

    res.writeHead(upstreamReq.status, respHeaders);

    const sseEvents: SseEvent[] = [];
    const reader = upstreamReq.body?.getReader();

    if (!reader) {
      const buffer = await upstreamReq.arrayBuffer();
      let bodyJson: unknown = null;
      try {
        bodyJson = JSON.parse(Buffer.from(buffer).toString('utf-8'));
      } catch {
        // not json
      }

      const model = reqBody?.model;
      const reqPath = req.url ?? '/';
      const hash = createHash('sha256')
        .update(`${reqPath}:${model}:${Date.now()}`)
        .digest('hex')
        .slice(0, 10);

      const tape: FixtureTape = {
        id: `tape-${model ?? 'api'}-${hash}`,
        timestamp: Date.now(),
        request: {
          method: req.method ?? 'POST',
          path: reqPath,
          model,
          messagesSnippet: JSON.stringify(reqBody?.messages ?? []).slice(0, 300),
          body: reqBody,
        },
        response: {
          status: upstreamReq.status,
          headers: respHeaders,
          bodyJson,
          events: [],
        },
      };

      this.saveTape(tape);
      res.end(Buffer.from(buffer));
      return;
    }

    const decoder = new TextDecoder();
    let partialChunk = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      res.write(value);

      const text = decoder.decode(value, { stream: true });
      partialChunk += text;

      const lines = partialChunk.split('\n\n');
      partialChunk = lines.pop() ?? '';

      for (const block of lines) {
        if (!block.trim()) continue;
        let eventName: string | undefined;
        let data = '';

        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) {
            eventName = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            data += (data ? '\n' : '') + line.slice(6);
          }
        }

        if (data) {
          sseEvents.push({ event: eventName, data });
        }
      }
    }

    res.end();

    // Persist recorded tape
    const model = reqBody?.model;
    const reqPath = req.url ?? '/';
    const hash = createHash('sha256')
      .update(`${reqPath}:${model}:${Date.now()}`)
      .digest('hex')
      .slice(0, 10);

    const tape: FixtureTape = {
      id: `tape-${model ?? 'api'}-${hash}`,
      timestamp: Date.now(),
      request: {
        method: req.method ?? 'POST',
        path: reqPath,
        model,
        messagesSnippet: JSON.stringify(reqBody?.messages ?? []).slice(0, 300),
        body: reqBody,
      },
      response: {
        status: upstreamReq.status,
        headers: Object.fromEntries(upstreamReq.headers.entries()),
        events: sseEvents,
      },
    };

    this.saveTape(tape);
  }

  /**
   * Replay a tape to ServerResponse, dynamically replacing old markers with the new marker.
   */
  async replayTape(
    res: ServerResponse,
    tape: FixtureTape,
    currentMarker: string | null,
    delayMs = 0,
  ): Promise<void> {
    if (!tape.response.events || tape.response.events.length === 0) {
      res.writeHead(tape.response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tape.response.bodyJson ?? {}));
      return;
    }

    // Identify old marker in tape
    const oldTapeText = JSON.stringify(tape);
    const oldMarker = extractMarker(oldTapeText);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    for (const evt of tape.response.events) {
      if (res.destroyed || res.writableEnded) break;

      let data = evt.data;
      if (oldMarker && currentMarker && oldMarker !== currentMarker) {
        data = data.replaceAll(oldMarker, currentMarker);
      }

      const prefix = evt.event ? `event: ${evt.event}\n` : '';
      res.write(`${prefix}data: ${data}\n\n`);

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (!res.writableEnded) {
      res.end();
    }
  }
}
