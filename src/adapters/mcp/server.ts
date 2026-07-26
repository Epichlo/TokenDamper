import type { Readable, Writable } from 'node:stream';
import type {
  JsonRpcResponse,
} from './types';
import { JSON_RPC_ERROR_CODES } from './types';

export type McpRequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
) => Promise<unknown>;

export type McpNotificationHandler = (
  method: string,
  params: Record<string, unknown> | undefined,
) => void;

/**
 * Lightweight stdio-based JSON-RPC 2.0 transport for MCP.
 * Reads newline-delimited JSON from input stream (stdin), writes responses to output stream (stdout).
 * Log output is isolated to the log stream (stderr).
 */
export class McpStdioServer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly log: Writable;
  private buffer = '';
  private readonly requestHandler: McpRequestHandler;
  private readonly notificationHandler: McpNotificationHandler;
  private running = false;

  constructor(options: {
    readonly input?: Readable | NodeJS.ReadableStream;
    readonly output?: Writable | NodeJS.WritableStream;
    readonly log?: Writable | NodeJS.WritableStream;
    readonly requestHandler: McpRequestHandler;
    readonly notificationHandler?: McpNotificationHandler;
  }) {
    this.input = (options.input ?? process.stdin) as Readable;
    this.output = (options.output ?? process.stdout) as Writable;
    this.log = (options.log ?? process.stderr) as Writable;
    this.requestHandler = options.requestHandler;
    this.notificationHandler = options.notificationHandler ?? (() => {});
  }

  /**
   * Starts listening on the input stream for JSON-RPC 2.0 messages.
   */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.logMessage('MCP stdio server started');

    this.input.setEncoding('utf8');
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
    this.input.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        this.sendResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: JSON_RPC_ERROR_CODES.PARSE_ERROR, message: 'Buffer limit exceeded: request line too long without newline' },
        });
        this.logMessage('Buffer limit exceeded: request line too long without newline');
        this.buffer = '';
        return;
      }
      this.processBuffer();
    });

    this.input.on('end', () => {
      this.running = false;
      this.logMessage('MCP stdio server input stream ended');
    });
  }

  /**
   * Stops the server from processing further input stream data.
   */
  public stop(): void {
    this.running = false;
    this.input.removeAllListeners('data');
    this.input.removeAllListeners('end');
    this.logMessage('MCP stdio server stopped');
  }

  /**
   * Returns true if the server is currently running.
   */
  public get isRunning(): boolean {
    return this.running;
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERROR_CODES.PARSE_ERROR, message: 'Parse error' },
      });
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      this.sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERROR_CODES.INVALID_REQUEST, message: 'Invalid Request' },
      });
      return;
    }

    const msg = parsed as Record<string, unknown>;

    if (msg.jsonrpc !== '2.0') {
      this.sendResponse({
        jsonrpc: '2.0',
        id: (msg.id as number | string) ?? null,
        error: { code: JSON_RPC_ERROR_CODES.INVALID_REQUEST, message: 'Invalid JSON-RPC version' },
      });
      return;
    }

    // Handle Notification (no `id` property present)
    if (!('id' in msg) || msg.id === undefined) {
      if (typeof msg.method === 'string') {
        this.notificationHandler(
          msg.method,
          msg.params as Record<string, unknown> | undefined,
        );
      }
      return;
    }

    // Handle Request
    const id = msg.id as number | string;
    const method = msg.method as string;
    const params = msg.params as Record<string, unknown> | undefined;

    if (typeof method !== 'string') {
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: JSON_RPC_ERROR_CODES.INVALID_REQUEST, message: 'Method must be a string' },
      });
      return;
    }

    this.requestHandler(method, params)
      .then((result) => {
        this.sendResponse({ jsonrpc: '2.0', id, result });
      })
      .catch((err: Error) => {
        const code = 'code' in err && typeof (err as { code: number }).code === 'number'
          ? (err as { code: number }).code
          : JSON_RPC_ERROR_CODES.INTERNAL_ERROR;
        this.sendResponse({
          jsonrpc: '2.0',
          id,
          error: {
            code,
            message: err.message || 'Internal error',
          },
        });
      });
  }

  public sendResponse(response: JsonRpcResponse): void {
    const serialized = JSON.stringify(response) + '\n';
    this.output.write(serialized);
  }

  private logMessage(message: string): void {
    this.log.write(`[MCP] ${message}\n`);
  }
}
