import { afterEach, describe, expect, test } from 'vitest';

import { registerShutdownSignals } from '@/lib/server/register-shutdown-signals';

describe('registerShutdownSignals', () => {
  afterEach(() => {
    // `process.once` listeners self-remove on emit, but a failed assertion
    // mid-test can leave one attached; strip anything this suite added so it
    // never leaks into other tests sharing the worker process.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  test('attaches exactly one SIGTERM and one SIGINT listener', () => {
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(0);

    registerShutdownSignals(async () => {});

    expect(process.listenerCount('SIGTERM')).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(1);
  });

  test('invokes the shutdown callback once on SIGTERM, and only once', async () => {
    let calls = 0;
    registerShutdownSignals(async () => {
      calls++;
    });

    process.emit('SIGTERM');
    await Promise.resolve();
    expect(calls).toBe(1);

    // `process.once` self-removes after firing, so a second emit must not
    // invoke the callback again, and the listener must be gone.
    process.emit('SIGTERM');
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  test('invokes the shutdown callback once on SIGINT, and only once', async () => {
    let calls = 0;
    registerShutdownSignals(async () => {
      calls++;
    });

    process.emit('SIGINT');
    await Promise.resolve();
    expect(calls).toBe(1);

    process.emit('SIGINT');
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(0);
  });
});
