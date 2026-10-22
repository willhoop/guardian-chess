# Guardian Chess — technical documentation

**Version 1.0.0 — 2026-08-15**

---

## Running it

```bash
npm install
npm start          # http://localhost:3000
npm test           # the whole suite; it prints the count
```

Node 20 or newer. Two runtime dependencies (`express`, `ws`). No build step, no
framework, no database.

---

## Layout

```
shared/engine.js    the rules: board, moves, check, mate, notation
shared/bot.js       the computer opponent
shared/rating.js    Elo maths
shared/values.js    piece values, shared by the bot and the scoreboard
server/index.js     HTTP + WebSocket server, API, result recording
server/rooms.js     rooms, seats, reconnect, rematch
server/store.js     player records, accounts, game history
server/auth.js      scrypt password hashing, session tokens
server/storage.js   where data lives: local file or hosted key-value store
public/             the client
tests/              the suite
```

### The central constraint

`shared/engine.js` is served to the browser and imported by the server. Both run
the identical file. The client uses it to render legal moves; the server uses it
to validate them. There is no second implementation to fall out of sync.

---

## The engine

**Board.** `board[r][c]`, row 0 = rank 8, column 0 = file a. 8 rows, 10 columns.
A square is light when `(r + c)` is even, which makes `a1` dark as usual.

**Position.**

```js
{ board, turn, castling: {w:{k,q}, b:{k,q}}, ep, halfmove, fullmove }
```

**Move generation.** `pseudoLegalMoves` produces moves that follow the movement
rules; `legalMoves` filters those leaving the mover's own king in check by
applying each and testing. `applyMove` is pure and returns a new position.

**The Guardian** is four offsets — (-2,0), (2,0), (0,-2), (0,2) — with no path
check, which is what makes it a leaper. It appears in `isAttacked` the same way,
so a Guardian check cannot be blocked by interposition.

**Castling.** The king moves three squares. Sides are named for the flank the
king occupies, so with the king on `e` the a-file rook is the king's rook:

| Side | King | Rook | Must be empty | King must not be attacked on |
|---|---|---|---|---|
| `k` (O-O) | e1 to b1 | a1 to c1 | b1 c1 d1 | e1 d1 c1 b1 |
| `q` (O-O-O) | e1 to h1 | j1 to g1 | f1 g1 h1 i1 | e1 f1 g1 h1 |

**Endings.** Checkmate, stalemate, insufficient material (a Guardian counts as a
minor piece), threefold repetition and the fifty-move rule are all automatic.

**Notation.** Standard algebraic with `G` for the Guardian and files `a` to `j`,
including disambiguation and check/mate suffixes.

---

## The server

**Authority.** `Game.move` throws on anything illegal, and that is the entire
defence. `onMove` checks seat, turn and game state, then calls it. A tampered
client receives `{type:'error'}` and re-syncs.

**Rooms** are in memory, keyed by a five-character code from an alphabet with no
`O`, `0`, `I` or `1`. A player's seat is held by their token, so a refresh or a
dropped connection reclaims it. Presence is derived from open sockets.

**Protocol.** WebSocket at `/ws`. Client sends `join`, `move`, `resign`,
`offerDraw`, `acceptDraw`, `declineDraw`, `offerRematch`, `acceptRematch`,
`chat`. Server replies `joined`, `state`, `error`. Every state-changing action
broadcasts a full snapshot; there is no diffing.

**HTTP API.**

| Route | Purpose |
|---|---|
| `POST /api/rooms` | create a room |
| `GET /api/leaderboard` | rankings and recent games |
| `GET /api/players/:id` | one player's record; `player: null` if none |
| `POST /api/register` | create an account, optionally claiming a guest record |
| `POST /api/login` | sign in |
| `POST /api/logout` | end a session |
| `GET /api/me?session=` | resolve a session |
| `GET /api/health` | liveness |

---

## Identity

Guests hold a random 32-hex id in `localStorage`, sent on join and used as the
leaderboard key. It is self-asserted, which is acceptable because a guest id is
worth nothing.

Accounts add a session token. `identify()` resolves a session to an account id;
failing that it accepts the asserted guest id **only if no account owns it**.
That last clause is the security-relevant one: without it, anyone could read a
rival's id off the leaderboard and inherit their rating. The same guard applies
to the `claimId` used when registering.

Passwords: scrypt, per-user salt, `timingSafeEqual`. Session tokens: 32 random
bytes, persisted only as SHA-256.

---

## Ratings

Elo from 1200. K is 40 below ten games, 16 above 2100, otherwise 24. A game is
rated only when two distinct players are seated and at least two plies have been
played, which stops instant-resign farming.

---

## The computer opponent

Negamax with alpha-beta, capture-only quiescence, and iterative deepening under a
wall-clock budget (450 ms normal, 1600 ms strong; easy moves at random). Moves
are ordered most-valuable-victim first.

Root moves are searched with a **full window**. Narrowing it prunes harder, but a
move that fails high returns clamped to exactly alpha and becomes
indistinguishable from a genuine tie, which let a strictly worse move win the
random tiebreak. A half-finished depth is discarded rather than mixed with
timed-out estimates.

---

## Storage

One JSON document: players, accounts, sessions, recent games.

Default is a local file, written atomically via temp-and-rename, debounced
400 ms. `DATA_DIR` relocates it.

Setting `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` switches to a
hosted key-value store over plain HTTPS — no dependency, no schema. Needed on
free hosts, whose filesystem is wiped whenever the instance restarts.

Three behaviours worth knowing:

- With a remote store configured the local file is **not read at all**, so a
  stale copy on the host cannot seed the server.
- A remote store that cannot be read is **fatal at boot**. Starting empty would
  let the first save overwrite every rating with nothing.
- Concurrent saves coalesce, and an explicit save cancels the debounce it makes
  redundant.

---

## Tests

```bash
npm test
```

| File | Covers |
|---|---|
| `tests/engine.test.js` | rules, the Guardian, castling, endings, a 100-game fuzz |
| `tests/server.test.js` | seating, authority, reconnect, spectators, rematch |
| `tests/bot.test.js` | legality, mate in one, not hanging material |
| `tests/rating.test.js` | Elo, leaderboard, persistence |
| `tests/auth.test.js` | hashing, sessions, the impersonation guard |
| `tests/storage.test.js` | the remote backend against a stub, and its failure modes |

The storage tests run against a stub speaking the Upstash REST shape. They
verify this client, not the live service.
