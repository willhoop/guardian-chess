/**
 * Abuse limits for Guardian Chess.
 *
 * Every number that bounds what one client may do lives in LIMITS, so a change
 * is one edit. The limiters keep their state in memory, like the rooms do.
 */

export const LIMITS = {
  /** Largest WebSocket frame accepted. A 500-character chat line in UTF-8 plus its JSON fits. */
  wsMaxBytes: 4 * 1024,
  /** Messages per connection: a burst, then a steady refill per second. */
  wsBurst: 20,
  wsPerSecond: 5,
  /** Messages refused before the connection is closed. */
  wsMaxRefused: 20,
  /** Lookups of a room code that does not exist, per address per window. */
  codeMisses: 20,
  codeWindowMs: 10 * 60 * 1000,
  /** Rooms one address may create per window. */
  roomCreates: 30,
  roomWindowMs: 10 * 60 * 1000,
  /** Password attempts per address per window. */
  loginAttempts: 10,
  loginWindowMs: 15 * 60 * 1000,
};

/**
 * Count events per key inside a fixed window. Expired keys are pruned as the
 * map is used, so an address that stops calling stops costing memory.
 */
export class WindowCounter {
  constructor(max, windowMs, now = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.counts = new Map();
    this.lastPrune = now();
  }

  #prune(t) {
    if (t - this.lastPrune < this.windowMs) return;
    this.lastPrune = t;
    for (const [key, record] of this.counts) {
      if (t - record.first > this.windowMs) this.counts.delete(key);
    }
  }

  #current(key, t) {
    const record = this.counts.get(key);
    return record && t - record.first <= this.windowMs ? record : null;
  }

  /** True when the key has used up its window. Does not count anything. */
  blocked(key) {
    const record = this.#current(key, this.now());
    return Boolean(record && record.count >= this.max);
  }

  /** Count one event. Returns true when the key is now over its limit. */
  hit(key) {
    const t = this.now();
    this.#prune(t);
    const record = this.#current(key, t);
    if (!record) {
      this.counts.set(key, { first: t, count: 1 });
      return this.max < 1;
    }
    record.count += 1;
    return record.count > this.max;
  }

  clear(key) {
    this.counts.delete(key);
  }
}

/** A token bucket for one connection: `burst` messages at once, `perSecond` after that. */
export class TokenBucket {
  constructor(burst, perSecond, now = Date.now) {
    this.burst = burst;
    this.perSecond = perSecond;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }

  take() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.perSecond);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * The address a request came from. Behind Render's proxy the socket address is
 * the proxy's, shared by every visitor, so there the last X-Forwarded-For entry
 * (the one Render itself appended) is used. Elsewhere the header is ignored,
 * because anyone can send it.
 */
export function clientIp(req, trustProxy = Boolean(process.env.RENDER)) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}
