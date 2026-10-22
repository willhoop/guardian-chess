/**
 * Guardian Chess server.
 *
 * Serves the client and runs the authoritative game. The routes and the
 * WebSocket handling live in server/app.js; this file loads the player data,
 * starts listening, and runs the timers.
 */

import { createGuardianServer } from './app.js';
import { PlayerStore } from './store.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const players = new PlayerStore();
// Player data may live in a remote store; load it before answering anything.
await players.init();

const { app, server, wss, store } = createGuardianServer({ players });

/** Drop sockets that have stopped answering, so rooms show accurate presence. */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

const sweeper = setInterval(() => store.sweep(), 60 * 60 * 1000);

heartbeat.unref?.();
sweeper.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`Guardian Chess running on http://localhost:${PORT}`);
  console.log(players.remote
    ? `Player data: ${players.remote.name} (survives restarts)`
    : `Player data: ${players.file}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  players.saveNow();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server, store, players };
