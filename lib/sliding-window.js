/**
 * SlidingWindow — memory-efficient bucketed counters for rate tracking.
 *
 * Tracks request counts and token usage over a rolling time window
 * using fixed-size circular buffers (no per-request arrays).
 *
 * @example
 *   const w = new SlidingWindow(60000, 60); // 1-min window, 60 buckets
 *   w.record(1, 150);                        // 1 request, 150 tokens
 *   const { requests, tokens } = w.totals(); // current window totals
 */
class SlidingWindow {
  /**
   * @param {number} windowMs  - Rolling window duration (default: 60s)
   * @param {number} bucketCount - Number of buckets (default: 60)
   */
  constructor(windowMs = 60000, bucketCount = 60) {
    this.windowMs = windowMs;
    this.bucketCount = bucketCount;
    this.bucketMs = windowMs / bucketCount;
    this.buckets = Array.from({ length: bucketCount }, () => ({ ts: 0, requests: 0, tokens: 0 }));
    this.currentIndex = 0;
  }

  _bucketIndex(now) {
    return Math.floor((now / this.bucketMs) % this.bucketCount);
  }

  _rotate(now) {
    const idx = this._bucketIndex(now);
    const cutoff = now - this.windowMs;
    for (let i = 0; i < this.bucketCount; i++) {
      if (this.buckets[i].ts < cutoff) {
        this.buckets[i] = { ts: 0, requests: 0, tokens: 0 };
      }
    }
    if (!this.buckets[idx].ts || this.buckets[idx].ts < cutoff) {
      this.buckets[idx] = { ts: now, requests: 0, tokens: 0 };
    }
    this.currentIndex = idx;
  }

  /**
   * Record a request and/or tokens in the current bucket.
   * @param {number} requests - Number of requests (default: 1)
   * @param {number} tokens   - Number of tokens (default: 0)
   */
  record(requests = 1, tokens = 0) {
    const now = Date.now();
    this._rotate(now);
    this.buckets[this.currentIndex].requests += requests;
    this.buckets[this.currentIndex].tokens += tokens;
  }

  /**
   * Sum all non-expired buckets.
   * @returns {{ requests: number, tokens: number }}
   */
  totals() {
    const now = Date.now();
    this._rotate(now);
    const cutoff = now - this.windowMs;
    let requests = 0, tokens = 0;
    for (const b of this.buckets) {
      if (b.ts >= cutoff) {
        requests += b.requests;
        tokens += b.tokens;
      }
    }
    return { requests, tokens };
  }

  /** Reset all buckets. */
  reset() {
    for (let i = 0; i < this.bucketCount; i++) {
      this.buckets[i] = { ts: 0, requests: 0, tokens: 0 };
    }
  }
}

module.exports = SlidingWindow;
