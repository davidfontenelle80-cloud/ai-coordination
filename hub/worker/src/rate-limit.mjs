/**
 * rate-limit.mjs — task 009.
 *
 * Tiny fixed-window per-principal rate limiter for the command API.
 * In-memory per isolate: on Workers this is per-isolate state, so limits
 * are approximate under many isolates — deliberately conservative (the
 * free tier's real protection is the D1 write quota). Documented, not
 * hidden: a burst spread across isolates can exceed the nominal limit.
 */

export function createRateLimiter({ limit = 120, windowMs = 60_000 } = {}) {
  const buckets = new Map(); // key -> { windowStart, count }
  return {
    check(key, now = Date.now()) {
      let b = buckets.get(key);
      if (!b || now - b.windowStart >= windowMs) {
        b = { windowStart: now, count: 0 };
        buckets.set(key, b);
      }
      b.count += 1;
      if (b.count > limit) {
        return {
          ok: false,
          retryAfterMs: Math.max(0, b.windowStart + windowMs - now),
        };
      }
      return { ok: true };
    },
    // Test/introspection hook.
    _size() { return buckets.size; },
  };
}
