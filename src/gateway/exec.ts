import { spawn } from 'node:child_process';
import { GatewayServer } from './server';

export interface ExecOptions {
  readonly port?: number | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly io?: { readonly stdout: NodeJS.WritableStream; readonly stderr: NodeJS.WritableStream } | undefined;
}

/**
 * Launches an AI CLI process wired to an embedded TokenDamper Gateway server.
 */
export async function runExecCommand(
  args: readonly string[],
  options: ExecOptions = {},
): Promise<number> {
  const command = args[0];
  if (!command) {
    throw new Error('No command provided for tokendamper exec');
  }

  const server = new GatewayServer({ port: options.port ?? 0 });
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
      reject(err);
    });
  });
}
