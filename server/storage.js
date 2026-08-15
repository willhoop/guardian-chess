/**
 * Where player records actually live.
 *
 * By default: a JSON file next to the app. That is right for running at home
 * or on a VPS, and it is what the tests use.
 *
 * Free hosting is the awkward case. Free tiers hand you a filesystem that is
 * wiped whenever the instance restarts, and a free instance restarts every time
 * it goes idle — so a local file means the leaderboard resets more or less
 * daily. Setting the two Upstash environment variables switches storage to a
 * free hosted key-value store instead, and the data survives.
 *
 * The whole dataset is one JSON document, read once at boot and written back
 * on a debounce. For a game played among friends that is a few writes an hour,
 * which sits far inside any free quota, and it means no schema and no
 * dependency — Upstash speaks plain HTTPS, so `fetch` is the entire client.
 */

const KEY = 'guardian-chess:leaderboard';

/** Reads and writes one JSON document over the Upstash REST API. */
class UpstashBackend {
  constructor(url, token) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.name = 'Upstash';
  }

  get #headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async load() {
    const res = await fetch(`${this.url}/get/${encodeURIComponent(KEY)}`, {
      headers: this.#headers,
    });
    if (!res.ok) throw new Error(`Upstash GET failed: ${res.status}`);
    const { result } = await res.json();
    if (!result) return null;
    return typeof result === 'string' ? JSON.parse(result) : result;
  }

  async save(data) {
    const res = await fetch(`${this.url}/set/${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: { ...this.#headers, 'Content-Type': 'text/plain' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Upstash SET failed: ${res.status}`);
  }
}

/**
 * Pick a backend from the environment. Returns null when none is configured,
 * which means "use the local file".
 */
export function makeBackend(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new UpstashBackend(url, token);
  return null;
}
