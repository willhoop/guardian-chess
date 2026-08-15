/**
 * Guardian Chess server.
 *
 * Serves the client and runs the authoritative game. Every move a client sends
 * is re-validated here against shared/engine.js before it is accepted, so a
 * tampered client cannot make an illegal move — it can only get an error back.
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';
import { WebSocketServer } from 'ws';

import { RoomStore, makeToken } from './rooms.js';
import { PlayerStore } from './store.js';
import { validateUsername, validatePassword } from './auth.js';
import { WHITE, BLACK, opposite } from '../shared/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '16kb' }));

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
// The client imports the engine directly, so both sides run identical rules.
app.use('/shared', express.static(path.join(ROOT, 'shared')));

const store = new RoomStore();
const players = new PlayerStore();
// Player data may live in a remote store; load it before answering anything.
await players.init();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: store.size, uptime: process.uptime() });
});

/* ── Leaderboard ─────────────────────────────────────────────────────── */

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  res.json({
    players: players.leaderboard(limit),
    recent: players.recentGames(15),
  });
});

/**
 * A player's record. Someone who has never played is not an error — it is the
 * normal state of every new visitor — so this answers 200 with a null player
 * rather than a 404 the browser would log as a failure.
 */
app.get('/api/players/:id', (req, res) => {
  const player = players.publicPlayer(req.params.id);
  res.json({
    player,
    games: player ? players.gamesFor(req.params.id, 20) : [],
  });
});

/* ── Accounts ────────────────────────────────────────────────────────── */

/**
 * Crude per-address throttle on password attempts. Enough to make guessing
 * impractical without needing a dependency or a store.
 */
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(key) {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { first: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > MAX_ATTEMPTS;
}

function clearAttempts(key) {
  attempts.delete(key);
}

/** Everything the client needs after a successful sign-in. */
function authPayload(store_, id, session) {
  return { session, player: store_.publicPlayer(id) };
}

app.post('/api/register', async (req, res) => {
  const { username, password, claimId } = req.body || {};

  const nameError = validateUsername(username);
  if (nameError) return res.status(400).json({ error: nameError });
  const passError = validatePassword(password);
  if (passError) return res.status(400).json({ error: passError });

  try {
    // Only let a browser claim the guest id it is actually carrying.
    const claim = typeof claimId === 'string' && claimId.length === 32 ? claimId : null;
    const account = await players.createAccount(username, password, claim);
    const session = players.startSession(account.id);
    res.json({ ...authPayload(players, account.id, session), claimed: account.claimed });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not create that account.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const key = `${req.ip}`;
  if (tooManyAttempts(key)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
  }

  const account = await players.checkPassword(username ?? '', password ?? '');
  // Same message either way, so this cannot be used to discover usernames.
  if (!account) return res.status(401).json({ error: 'Wrong username or password.' });

  clearAttempts(key);
  const session = players.startSession(account.id);
  res.json(authPayload(players, account.id, session));
});

app.post('/api/logout', (req, res) => {
  players.endSession(req.body?.session);
  res.json({ ok: true });
});

/** Who am I? Used on page load to restore a signed-in browser. */
app.get('/api/me', (req, res) => {
  const id = players.resolveSession(req.query.session);
  if (!id) return res.json({ player: null });
  res.json({ player: players.publicPlayer(id) });
});

/** Create a room. The caller becomes the host and picks a colour. */
app.post('/api/rooms', (req, res) => {
  const requested = req.body?.color;
  const hostColor =
    requested === WHITE || requested === BLACK
      ? requested
      : Math.random() < 0.5
        ? WHITE
        : BLACK;
  const room = store.create({ hostColor });
  room.touch();
  res.json({ code: room.code, hostColor });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = store.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'No such game' });
  res.json({ code: room.code, full: room.isFull(), over: room.game.over });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/** Push the room state to everyone watching it. */
function broadcast(room) {
  const snapshot = room.snapshot();
  // Attach each seated player's current rating for the player bars.
  for (const color of [WHITE, BLACK]) {
    const seat = room.players[color];
    if (seat && snapshot.players[color]) {
      const record = players.publicPlayer(seat.token);
      snapshot.players[color].rating = record ? record.rating : null;
      snapshot.players[color].provisional = record ? record.provisional : true;
    }
  }
  const payload = { type: 'state', ...snapshot };
  const text = JSON.stringify(payload);
  for (const set of room.sockets.values()) {
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }
}

function fail(ws, reason) {
  send(ws, { type: 'error', message: reason });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.token = null;
  ws.color = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return fail(ws, 'Malformed message');
    }
    if (!msg || typeof msg.type !== 'string') return fail(ws, 'Malformed message');

    try {
      handle(ws, msg);
    } catch (err) {
      fail(ws, err.message || 'Something went wrong');
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room || !ws.token) return;
    room.removeSocket(ws.token, ws);
    room.touch();
    broadcast(room);
  });
});

function handle(ws, msg) {
  if (msg.type === 'join') return onJoin(ws, msg);

  const room = ws.room;
  if (!room) return fail(ws, 'Join a game first');
  room.touch();

  switch (msg.type) {
    case 'move': return onMove(ws, room, msg);
    case 'resign': return onResign(ws, room);
    case 'offerDraw': return onOfferDraw(ws, room);
    case 'acceptDraw': return onAcceptDraw(ws, room);
    case 'declineDraw': return onDeclineDraw(ws, room);
    case 'offerRematch': return onOfferRematch(ws, room);
    case 'acceptRematch': return onAcceptRematch(ws, room);
    case 'chat': return onChat(ws, room, msg);
    case 'ping': return send(ws, { type: 'pong' });
    default: return fail(ws, `Unknown action: ${msg.type}`);
  }
}

/**
 * Work out who is connecting.
 *
 * A signed-in browser proves it with a session token, which the server alone
 * can map to an account. A guest just asserts an id, which is fine because
 * nothing is at stake — except that a guest must never be allowed to assert an
 * id belonging to an account, or they would inherit that account's rating.
 */
function identify(msg) {
  const sessionId = players.resolveSession(msg.session);
  if (sessionId) {
    const record = players.publicPlayer(sessionId);
    return { id: sessionId, name: record?.name || 'Player', account: true };
  }

  const claimed = typeof msg.token === 'string' && msg.token.length === 32 ? msg.token : null;
  // Refuse an unauthenticated claim on an account's id; issue a fresh guest id.
  const id = claimed && !players.isAccountId(claimed) ? claimed : makeToken();
  const name = typeof msg.name === 'string' ? msg.name.slice(0, 24).trim() : '';
  return { id, name, account: false };
}

function onJoin(ws, msg) {
  const room = store.get(msg.code);
  if (!room) return fail(ws, 'No game with that code. Check it and try again.');

  const who = identify(msg);
  const token = who.id;
  const name = who.name;

  const color = room.join(token, name, msg.color === WHITE || msg.color === BLACK ? msg.color : null);

  ws.room = room;
  ws.token = token;
  ws.color = color;
  room.addSocket(token, ws);
  room.touch();

  // Seated players get a leaderboard record; spectators do not. An account's
  // display name is its username, so only guests may set a name here.
  if (color) {
    if (who.account) players.touch(token, undefined);
    else players.touch(token, name);
  }

  send(ws, {
    type: 'joined',
    code: room.code,
    token,
    color,
    account: who.account,
    me: color ? players.publicPlayer(token) : null,
  });
  broadcast(room);
}

/**
 * Write a finished game to the leaderboard, exactly once.
 *
 * Called after every action that could end a game. Bot games and local games
 * never reach the server, so everything recorded here is human versus human.
 */
function recordIfFinished(room) {
  if (room.recorded || !room.game.over) return;
  if (!room.isRated()) {
    // Still mark it handled so we do not re-check on every later broadcast.
    room.recorded = true;
    return;
  }
  room.recorded = true;
  room.lastRatingChange = players.recordGame({
    whiteId: room.players[WHITE].token,
    blackId: room.players[BLACK].token,
    whiteName: room.players[WHITE].name,
    blackName: room.players[BLACK].name,
    winner: room.game.result.winner,
    reason: room.game.result.reason,
    plies: room.game.history.length,
  });
}

function onMove(ws, room, msg) {
  if (!ws.color) return fail(ws, 'Spectators cannot move');
  if (room.game.over) return fail(ws, 'The game is already over');
  if (room.game.turn !== ws.color) return fail(ws, 'Not your turn');
  if (!room.isFull()) return fail(ws, 'Waiting for an opponent');

  // The engine throws on anything illegal; that is the whole defence.
  const entry = room.game.move(msg.from, msg.to, msg.promo || null);

  // A move answers an outstanding draw offer with "no".
  room.drawOffer = null;
  recordIfFinished(room);
  broadcast(room);
  return entry;
}

function onResign(ws, room) {
  if (!ws.color) return fail(ws, 'Spectators cannot resign');
  if (room.game.over) return;
  room.game.resign(ws.color);
  room.drawOffer = null;
  recordIfFinished(room);
  broadcast(room);
}

function onOfferDraw(ws, room) {
  if (!ws.color) return fail(ws, 'Spectators cannot offer a draw');
  if (room.game.over) return;
  room.drawOffer = ws.color;
  broadcast(room);
}

function onAcceptDraw(ws, room) {
  if (!ws.color) return fail(ws, 'Spectators cannot accept a draw');
  if (room.game.over) return;
  if (!room.drawOffer || room.drawOffer === ws.color) {
    return fail(ws, 'There is no draw offer to accept');
  }
  room.game.drawByAgreement();
  room.drawOffer = null;
  recordIfFinished(room);
  broadcast(room);
}

function onDeclineDraw(ws, room) {
  if (room.drawOffer && room.drawOffer !== ws.color) {
    room.drawOffer = null;
    broadcast(room);
  }
}

function onOfferRematch(ws, room) {
  if (!ws.color) return fail(ws, 'Spectators cannot offer a rematch');
  if (!room.game.over) return fail(ws, 'Finish this game first');
  room.rematchOffer = ws.color;
  broadcast(room);
}

function onAcceptRematch(ws, room) {
  if (!ws.color) return fail(ws, 'Spectators cannot accept a rematch');
  if (!room.game.over) return;
  if (!room.rematchOffer || room.rematchOffer === ws.color) {
    return fail(ws, 'There is no rematch offer to accept');
  }
  room.rematch();
  // Seats swapped, so tell each connected socket which colour it now holds.
  for (const [token, set] of room.sockets) {
    const color = room.seatOf(token);
    for (const sock of set) {
      sock.color = color;
      send(sock, { type: 'joined', code: room.code, token, color });
    }
  }
  broadcast(room);
}

function onChat(ws, room, msg) {
  const who = ws.color
    ? room.players[ws.color]?.name || (ws.color === WHITE ? 'White' : 'Black')
    : 'Spectator';
  if (room.addChat(who, msg.text ?? '')) broadcast(room);
}

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
