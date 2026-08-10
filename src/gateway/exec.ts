import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { GatewayServer } from './server';

export interface ExecOptions {
  readonly port?: number | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly io?: { readonly stdout: NodeJS.WritableStream; readonly stderr: NodeJS.WritableStream } | undefined;
}

/**
 * Launches an AI CLI process wired to an embedded TokenDamper Gateway server.
 * 
 * **Gateway mode is experimental.** It forwards faithfully and runs the full validation
 * pipeline, but it deduplicates only content repeated *within a single payload*; cross-turn
 * deduplication of a sole copy is refused by design, because the marker it would leave is one
 * the model cannot resolve. Measured saving on ordinary two-turn conversations: **0 bytes**.
 * See DECISIONS §41 and the Gateway status notice in `README.md`.
 *
 * SECURITY BOUNDARIES & EXECUTION INVARIANTS:
 * 1. The child process is executed with `shell: true` to support user-provided shell syntax.
 *    The caller must ensure that `args` are provided by a trusted local user (e.g., the CLI runner).
 *    Do NOT expose this function to untrusted input over a network.
 * 2. Interception is by **base URL only** (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`). `HTTP_PROXY`
 *    and `HTTPS_PROXY` are deliberately *not* set: `GatewayServer` is an origin server, not an
 *    HTTP proxy, and implements neither absolute-form request URIs nor `CONNECT` tunnelling.
 * 3. The server binds to loopback and trusts loopback peers, so an unmodified third-party client
 *    can reach it. A token is still generated and injected for a child that chooses to forward
 *    it, and is enforced by the server on any non-loopback bind (audit C3).
 * 4. Process startup errors are sanitized to prevent leaking the injected environment or token.
 */
export async function runExecCommand(
  args: readonly string[],
  options: ExecOptions = {},
): Promise<number> {
  const command = args[0];
  if (!command) {
    throw new Error('No command provided for tokendamper exec');
  }

  const gatewayToken = randomBytes(16).toString('hex');
  const server = new GatewayServer({ port: options.port ?? 0, gatewayToken });
  const port = await server.start();
  const gatewayUrl = `http://127.0.0.1:${port}`;

  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined) {
      env[key] = val;
    }
  }

  if (options.env) {
    for (const [key, val] of Object.entries(options.env)) {
      if (val !== undefined) {
        env[key] = val;
      }
    }
  }

  // Base-URL interception is the *only* supported mechanism — audit C3.
  //
  // `HTTP_PROXY` and `HTTPS_PROXY` used to be set here too, and could never have worked:
  // `GatewayServer` implements neither HTTP proxy semantics (absolute-form request URIs) nor the
  // `connect` event that `CONNECT` tunnelling requires. Any child that honours `HTTPS_PROXY` —
  // which is most HTTP clients — would fail to reach the provider at all, in a way unrelated to
  // (and masked by) the 401 that every request was already getting. Setting a proxy variable for
  // a server that is not a proxy is worse than setting nothing.
  env.OPENAI_BASE_URL = `${gatewayUrl}/v1`;
  env.ANTHROPIC_BASE_URL = `${gatewayUrl}`;
  env.TOKENDAMPER_GATEWAY_URL = gatewayUrl;

  // Still generated and still injected, but no longer load-bearing: the server trusts loopback
  // peers, which is the only kind `exec` can produce. It is here for a child that deliberately
  // forwards it, and for a non-loopback bind where the server does enforce it. Nothing in the
  // third-party clients this command exists to wrap reads it — that was the defect.
  env.TOKENDAMPER_GATEWAY_TOKEN = gatewayToken;

  const commandArgs = args.slice(1);

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      env,
      stdio: 'inherit',
      shell: true,
    });

    child.on('close', async (code: number | null) => {
      await server.stop();
      resolve(code ?? 0);
    });

    child.on('error', async (err: Error) => {
      await server.stop();
      // Sanitize the error message to avoid leaking environment variables attached to the error object
      reject(new Error(`Failed to execute command: ${err.message}`));
    });
  });
}
