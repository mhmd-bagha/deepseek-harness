/** Shared agent-loop scheduler defaults.
 * @module dsh-agent-loop/constants
 */

/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/**
 * Default watchdog for a live assistant stream that stops delivering chunks
 * without closing or erroring. A stalled stream otherwise hangs the step
 * forever: no settlement, no request error, no retry — the turn shows
 * "running" with nothing rendering until the user steers it.
 */
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 90_000

/** Minimum accepted stall timeout; `0` disables the watchdog. */
export const MIN_STREAM_STALL_TIMEOUT_MS = 10_000
