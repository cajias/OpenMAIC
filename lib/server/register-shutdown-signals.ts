/**
 * Registers `SIGTERM`/`SIGINT` handlers that trigger the given shutdown
 * callback exactly once.
 *
 * Split out of `instrumentation.ts` and imported dynamically so that
 * Turbopack's static Edge-runtime scan never sees a top-level reference to
 * `process.once` in the Edge-analysed module graph. Node.js APIs like this
 * one are unsupported in the Edge runtime, and the scanner cannot prove the
 * runtime guard in `instrumentation.ts` makes this code unreachable there,
 * so it emits a false-positive warning on every compile.
 */
export function registerShutdownSignals(shutdown: () => Promise<void>): void {
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
