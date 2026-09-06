import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runCli } from '../../../src/cli/main';

/**
 * OX-L8 — a signal must not cut the MCP output stream short.
 *
 * `process.exit()` discards whatever a stream still holds, so exiting the instant `stop()` returns
 * loses any JSON-RPC frame still buffered. The audit recorded this rather than fixing it, and gave
 * the reason plainly: *"delivering SIGINT to exercise that is not something the suite can do
 * here"*, so any fix would ship unverified, and the fix contemplated at the time — dropping the
 * forced exit and letting the loop drain — risked `tokendamper mcp` hanging on Ctrl+C instead.
 *
 * Both halves of that objection are answered now. The defect was measured end to end by spawning
 * the real `tokendamper mcp` on Linux, requesting a 900 kB response and delivering SIGINT
 * mid-stream: **365,696 bytes arrived and the final frame did not parse**, against 900,819 bytes
 * and a whole frame with the fix. And the hang risk is gone, because the exit is still forced —
 * it is merely deferred until the stream says it has flushed, or until a 2 s cap fires.
 *
 * This test pins the ordering deterministically rather than by timing: the output stream defers
 * its write callback, and the assertion is that `process.exit` has *not* run before that callback
 * does. A test that merely waited would pass against the unfixed code by accident.
 */
describe('OX-L8: SIGINT flushes stdout before exiting', () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
    vi.restoreAllMocks();
  });

  it('defers process.exit until the output stream reports its write flushed', () => {
    // A stdout that holds its callback, which is what a pipe with a full buffer does.
    let release: (() => void) | undefined;
    const stdout = Object.assign(new EventEmitter(), {
      write: (_chunk: unknown, cb?: () => void) => {
        if (cb) release = cb;
        return false;
      },
    }) as unknown as NodeJS.WritableStream;
    const stderr = Object.assign(new EventEmitter(), { write: () => true }) as unknown as NodeJS.WritableStream;

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const before = process.listeners('SIGINT').slice();
    runCli(['mcp'], { stdout, stderr });
    const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
    cleanup.push(() => {
      for (const l of added) process.removeListener('SIGINT', l as () => void);
      process.removeAllListeners('SIGTERM');
    });

    expect(added).toHaveLength(1);
    const shutdown = added[0] as () => void;

    shutdown();

    // The whole point: the handler has run, and the process has *not* left yet, because the
    // stream has not said it flushed. Before the fix, `process.exit` ran here.
    expect(release).toBeDefined();
    expect(exit).not.toHaveBeenCalled();

    release!();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits anyway if the stream never reports a flush, so a stuck consumer cannot wedge it', () => {
    // The original objection to fixing this was that the process might never leave. It always
    // leaves: the flush is a best effort under a cap, not a precondition.
    vi.useFakeTimers();
    cleanup.push(() => vi.useRealTimers());

    const stdout = Object.assign(new EventEmitter(), {
      write: () => false, // callback never invoked
    }) as unknown as NodeJS.WritableStream;
    const stderr = Object.assign(new EventEmitter(), { write: () => true }) as unknown as NodeJS.WritableStream;

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const before = process.listeners('SIGINT').slice();
    runCli(['mcp'], { stdout, stderr });
    const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
    cleanup.push(() => {
      for (const l of added) process.removeListener('SIGINT', l as () => void);
      process.removeAllListeners('SIGTERM');
    });

    (added[0] as () => void)();
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits once even if the flush callback and the cap both fire', () => {
    vi.useFakeTimers();
    cleanup.push(() => vi.useRealTimers());

    let release: (() => void) | undefined;
    const stdout = Object.assign(new EventEmitter(), {
      write: (_c: unknown, cb?: () => void) => {
        if (cb) release = cb;
        return false;
      },
    }) as unknown as NodeJS.WritableStream;
    const stderr = Object.assign(new EventEmitter(), { write: () => true }) as unknown as NodeJS.WritableStream;

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    const before = process.listeners('SIGINT').slice();
    runCli(['mcp'], { stdout, stderr });
    const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
    cleanup.push(() => {
      for (const l of added) process.removeListener('SIGINT', l as () => void);
      process.removeAllListeners('SIGTERM');
    });

    (added[0] as () => void)();
    release!();
    vi.advanceTimersByTime(5000);

    expect(exit).toHaveBeenCalledTimes(1);
  });
});
