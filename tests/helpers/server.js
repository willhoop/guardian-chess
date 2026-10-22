/** Shared by the server tests: the real server on a free port, and a queueing client. */

import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

import { createGuardianServer } from '../../server/app.js';
import { PlayerStore } from '../../server/store.js';

/**
 * Start the real server wiring from server/app.js on a free port, with player
 * data in a throwaway folder. Earlier this file carried its own copy of the
 * wiring, which could drift from the shipped server without any test noticing.
 */
export async function startServer(limits = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gc-server-'));
  const players = new PlayerStore({ dir, autosave: false });
  const { server, wss, store } = createGuardianServer({ players, limits, trustProxy: false });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    port,
    store,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
      await once(server, 'close');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A test client that queues messages so tests can await them.
 *
 * Every join broadcasts a state to the whole room, so several state messages
 * are usually already sitting in the queue. Matching on type alone would hand
 * a test a stale snapshot, so `next` takes a predicate and skips anything that
 * does not satisfy it.
 */
export class Client {
  constructor(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.queue = [];
    this.waiters = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.type === msg.type && w.match(msg));
      if (i >= 0) {
        this.waiters.splice(i, 1)[0].resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  static async connect(port) {
    const c = new Client(port);
    await once(c.ws, 'open');
    return c;
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }

  /** Resolve with the next message of `type` satisfying `match`. */
  next(type, match = () => true, timeout = 2000) {
    const i = this.queue.findIndex((m) => m.type === type && match(m));
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) {
          this.waiters.splice(at, 1);
          reject(new Error(`timed out waiting for "${type}"`));
        }
      }, timeout).unref();
    });
  }

  /** The next state showing exactly `n` moves played. */
  stateAtPly(n) {
    return this.next('state', (m) => m.game.history.length === n);
  }

  close() { this.ws.close(); }
}
