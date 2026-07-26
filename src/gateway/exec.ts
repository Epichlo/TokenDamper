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
 * SECURITY BOUNDARIES & EXECUTION INVARIANTS:
 * 1. The child process is executed with `shell: true` to support user-provided shell syntax.
 *    The caller must ensure that `args` are provided by a trusted local user (e.g., the CLI runner).
 *    Do NOT expose this function to untrusted input over a network.
 * 2. A single-use, cryptographically secure 16-byte gateway token is generated per execution.
 *    This token is injected into the child process environment to authorize proxy requests.
 * 3. Environment variables like `HTTP_PROXY` and `OPENAI_BASE_URL` are overridden to intercept 
 *    outbound LLM API requests from the child process.
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

  env.HTTP_PROXY = gatewayUrl;
  env.HTTPS_PROXY = gatewayUrl;
  env.OPENAI_BASE_URL = `${gatewayUrl}/v1`;
  env.ANTHROPIC_BASE_URL = `${gatewayUrl}`;
  env.TOKENDAMPER_GATEWAY_URL = gatewayUrl;
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
