/**
 * Guardian Chess server wiring: the HTTP routes and the WebSocket game.
 *
 * Every move a client sends is re-validated here against shared/engine.js
 * before it is accepted, so a tampered client cannot make an illegal move — it
 * can only get an error back. server/index.js starts this; the tests start the
 * same function, so they exercise the shipped code rather than a copy.
 */

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';
import { WebSocketServer } from 'ws';

import { RoomStore, makeToken } from './rooms.js';
import { validateUsername, validatePassword } from './auth.js';
import { LIMITS, WindowCounter, TokenBucket, clientIp } from './limits.js';
import { WHITE, BLACK } from '../shared/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/**
 * Build the server. Nothing listens until the caller calls server.listen().
 * `limits` overrides any value in LIMITS; `trustProxy` overrides the Render check.
 */
export function createGuardianServer({ players, store = new RoomStore(), limits = {}, trustProxy } = {}) {
  const L = { ...LIMITS, ...limits };
  const ipOf = (req) => clientIp(req, trustProxy);

  const app = express();
  app.use(express.json({ limit: '16kb' }));
  // Bad JSON is the client's fault: answer 400 in JSON, never a stack trace.
  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(err.status || 400).json({ error: 'Malformed request' });
    }
    next(err);
  });

  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  // The client imports the engine directly, so both sides run identical rules.
  app.use('/shared', express.static(path.join(ROOT, 'shared')));

  /**
   * Room codes are five characters from a 32-letter alphabet: 32^5 = 33,554,432
   * codes. Unlimited guessing would find a live room quickly, so every address
   * gets a fixed number of wrong codes per window, over HTTP and WebSocket alike.
   */
  const codeMisses = new WindowCounter(L.codeMisses, L.codeWindowMs);
  const roomCreates = new WindowCounter(L.roomCreates, L.roomWindowMs);
  /** Per-address throttle on password attempts. */
  const loginAttempts = new WindowCounter(L.loginAttempts, L.loginWindowMs);

  const TOO_MANY_CODES = 'Too many wrong game codes. Wait a few minutes.';

  /** Look up a room for this address, counting a miss. Returns {room} or {error}. */
  function lookUp(ip, code) {
    if (codeMisses.blocked(ip)) return { error: TOO_MANY_CODES, status: 429 };
    const room = store.get(code);
    if (room) return { room };
    codeMisses.hit(ip);
    return { error: 'No game with that code. Check it and try again.', status: 404 };
  }

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

  /** Everything the client needs after a successful sign-in. */
  function authPayload(id, session) {
    return { session, player: players.publicPlayer(id) };
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
      res.json({ ...authPayload(account.id, session), claimed: account.claimed });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not create that account.' });
    }
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    const key = ipOf(req);
    if (loginAttempts.hit(key)) {
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
    }

    const account = await players.checkPassword(username ?? '', password ?? '');
    // Same message either way, so this cannot be used to discover usernames.
    if (!account) return res.status(401).json({ error: 'Wrong username or password.' });

    loginAttempts.clear(key);
    const session = players.startSession(account.id);
    res.json(authPayload(account.id, session));
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
    if (roomCreates.hit(ipOf(req))) {
      return res.status(429).json({ error: 'Too many new games. Wait a few minutes.' });
    }
    const requested = req.body?.color;
    const hostColor =
      requested === WHITE || requested === BLACK
        ? requested
        : Math.random() < 0.5
          ? WHITE
          : BLACK;
    const room = store.create({ hostColor, wazir: Boolean(req.body?.wazir) });
    room.touch();
    res.json({ code: room.code, hostColor, rules: room.rules });
  });

  app.get('/api/rooms/:code', (req, res) => {
    const found = lookUp(ipOf(req), req.params.code);
    if (!found.room) return res.status(found.status).json({ error: found.error });
    const room = found.room;
    res.json({ code: room.code, full: room.isFull(), over: room.game.over });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: L.wsMaxBytes });
  // An error on the listening socket must not take the process down.
  wss.on('error', (err) => console.error('WebSocket server error:', err.message));

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

  /**
   * Tell the client its request was refused. `resync: true` asks it to re-join
   * and pull the true state, because its optimistic view may now be wrong. A
   * refused join or a rate limit must not ask that, or the client loops.
   */
  function fail(ws, reason, resync = true) {
    send(ws, { type: 'error', message: reason, resync });
  }

  /** Leave whatever room this socket was in. */
  function detach(ws) {
    const room = ws.room;
    if (!room || !ws.token) return;
    room.removeSocket(ws.token, ws);
    room.touch();
    ws.room = null;
    broadcast(room);
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.room = null;
    ws.token = null;
    ws.color = null;
    ws.ip = ipOf(req);
    ws.bucket = new TokenBucket(L.wsBurst, L.wsPerSecond);
    ws.refused = 0;

    ws.on('pong', () => { ws.isAlive = true; });
    // ws emits 'error' for a bad frame or an oversized message, then closes the
    // socket itself. With no listener, Node would throw and end the process.
    ws.on('error', () => {});

    ws.on('message', (raw, isBinary) => {
      if (!ws.bucket.take()) {
        ws.refused += 1;
        if (ws.refused >= L.wsMaxRefused) return ws.close(1008, 'Too many messages');
        if (ws.refused === 1) fail(ws, 'Too many messages. Slow down.', false);
        return;
      }
      ws.refused = 0;

      let msg;
      try {
        if (isBinary) throw new Error('binary');
        msg = JSON.parse(raw.toString());
      } catch {
        return fail(ws, 'Malformed message', false);
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        return fail(ws, 'Malformed message', false);
      }

      try {
        handle(ws, msg);
      } catch (err) {
        fail(ws, err.message || 'Something went wrong');
      }
    });

    ws.on('close', () => detach(ws));
  });

  function handle(ws, msg) {
    if (msg.type === 'join') return onJoin(ws, msg);
    if (msg.type === 'ping') return send(ws, { type: 'pong' });

    const room = ws.room;
    if (!room) return fail(ws, 'Join a game first', false);
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
      default: return fail(ws, 'Unknown action', false);
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
    const found = lookUp(ws.ip, msg.code);
    if (!found.room) return fail(ws, found.error, false);
    const room = found.room;

    // A socket watches one room. Re-joining another leaves the first.
    if (ws.room && ws.room !== room) detach(ws);

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
    // Square names are short strings. Anything else is not a move.
    if (typeof msg.from !== 'string' || typeof msg.to !== 'string' || msg.from.length > 3 || msg.to.length > 3) {
      return fail(ws, 'Illegal move');
    }

    // The engine throws on anything not in its own legal-move list; that is the whole defence.
    const entry = room.game.move(msg.from, msg.to, typeof msg.promo === 'string' ? msg.promo : null);

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
    if (!ws.color) return fail(ws, 'Spectators cannot decline a draw');
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

  return { app, server, wss, store };
}
