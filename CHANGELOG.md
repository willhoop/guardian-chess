# Changelog — Guardian Chess

All notable changes to Guardian Chess are recorded here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Rule.** Every change is logged here in the same pass as the code, together with
the matching updates to the white paper, the deck, and the technical
documentation. A prior conclusion is never silently rewritten; what changed and
why is stated.

---

## [1.0.1] — 2026-10-22
### Fixed
- **One malformed WebSocket frame stopped the server.** No socket had an
  `error` listener, and `ws` re-throws a frame error with nowhere to go, so Node
  exited. Measured: a 6-byte frame with a reserved opcode ended the process and
  every game in memory with it. Each socket now has a listener; `ws` closes that
  one socket.
- **No size cap on WebSocket messages.** The `ws` default is 100 MiB. Frames
  over 4 KiB are now refused and the socket closed with 1009.
- **No rate limit on WebSocket messages.** Each connection now gets a burst of
  20, then 5 a second. Past that a message is dropped with one "slow down"
  error; after 20 dropped in a row the socket is closed with 1008. A test plays
  twelve plies with chat at 4 messages a second and never hits it.
- **Game codes could be guessed without limit.** 32^5 = 33,554,432 codes. With
  no limit, at 1,000 guesses a second against 50 live rooms, a guesser would
  expect a hit about every 11 minutes (33,554,432 / 50 / 1,000 s), and could
  take the empty seat of a host waiting for a friend. Each address now gets 20
  wrong codes per 10 minutes, over HTTP and WebSocket alike; then every lookup
  is refused until the window ends. That is at most 2,880 guesses a day per
  address, an expected 0.0043 hits a day against 50 rooms. Codes stay five
  characters, so they are still easy to read out.
- **The browser re-joined in a loop on a wrong or expired code.** The client
  re-joins after any error, and a refused join is an error. Measured in a
  browser: 234 join messages a second, without end. Render's free plan wipes
  rooms on every restart, so every open game tab did this after a restart.
  Errors now carry `resync`; the client re-joins only when it is true.
- **Login throttling was shared by every visitor on Render.** It keyed on
  `req.ip`, which behind Render's proxy is the proxy. Ten wrong passwords from
  anyone locked every login for 15 minutes. On Render the address is now the
  last `X-Forwarded-For` entry, the one Render appends. Inferred from Render's
  proxy design, not measured on the live site: measuring it would lock real
  players out.
- Room creation is capped at 30 per address per 10 minutes. Before, one script
  could fill memory with rooms.
- Malformed JSON sent to the HTTP API answered with Express's HTML error page,
  stack trace included. It now answers `400 {"error":"Malformed request"}`.
- A spectator could cancel a draw offer. A socket that joined a second room
  stayed registered in the first. Both fixed.
- Moves must arrive as square-name strings. The engine also accepts `{r,c}`
  objects internally; the wire no longer does. The move was always checked
  against the server's own legal-move list, and still is.
- `ping` is answered before a socket joins a room.

### Changed
- The routes and WebSocket handling moved from `server/index.js` to
  `server/app.js` (`createGuardianServer`). `tests/server.test.js` had tested a
  hand-written copy of that wiring, which could drift from the shipped server
  without any test failing; it now starts the real one. Every limit lives in
  `LIMITS` in `server/limits.js`.
- The "100 tests" counts in the README, CLAUDE.md, CONTRIBUTING.md and the
  technical docs were already stale (116) and are removed. `npm test` prints
  the count.

### Record
- **Measured.** No published figure moved. The suite went from 116 to 134
  tests (`npm test`). Each of the twelve fixes was removed in turn from the
  shipped code and its test failed. Crash: 1 frame of 6 bytes before; the server
  survives after (`tests/hardening.test.js`). Client loop: 234 joins a second
  before, 0 in 2 seconds after, measured in a browser on `localhost`.
- **Basis.** unchanged.
- **Supersedes.** ~~100 tests~~ retracted; it was already wrong.
- **Owed to the next major.** Technical docs: a reference table of `LIMITS`,
  the `resync` field on error messages, and the `app.js` / `index.js` split.
  White paper §6: say that the authority tests drive the shipped wiring. Deck:
  nothing.

## [1.0.0] — 2026-08-15
### Added
- The variant: a 10×8 board and the Guardian, which leaps exactly two squares
  orthogonally and jumps whatever stands between.
- Online play with five-character room codes, reconnect, chat, draw offers,
  resignation and rematch with colours swapped.
- A computer opponent at three strengths — negamax with alpha-beta, a
  capture-only quiescence search and iterative deepening under a time budget.
- Elo ratings and a leaderboard covering online games between two people.
- Optional accounts with guest play as the default. Signing up carries the
  guest record over rather than discarding it.
- A material scoreboard showing both sides' totals and the piece value table.
- Landing page rebuilt around six balanced tiles.

### Changed
- **The king and queen were swapped**, so the back rank reads
  `R N B G K Q G B N R`. On ten files the two centre squares are e (dark) and
  f (light); a queen placed to the king's left the way she is on an 8×8 board
  lands on the wrong colour. Capablanca hit the same constraint in his own 10×8
  game and kept the queen on the left, accepting the wrong colour. This game
  makes the opposite choice so each queen begins on her own colour.
- **Castling covers three squares**, following Capablanca's adjustment for the
  wider board, rather than the two of ordinary chess.
- **Castling sides renamed.** "Kingside" means the flank the king stands on.
  With the king on e that is the a-side, which makes the a1 rook the king's
  rook: `O-O` runs toward a and clears three squares, `O-O-O` runs toward j and
  clears four. The labels had been the wrong way round, which made the rules
  text claim the short castle was the queenside one. No geometry changed.
- Piece values moved to `shared/values.js`. The bot and the scoreboard had been
  keeping separate tables and disagreed about the Guardian.
- Player data can live in a free hosted key-value store instead of on disk, so
  ratings survive on hosts whose filesystem is wiped on restart.

### Fixed
- A hidden screen still occupied the page: `#lobby { display: grid }` beat
  `.screen[hidden]` on specificity, leaving the lobby visible above the board.
- Black's board never flipped. Squares are keyed by rank and file, so turning
  the board requires rebuilding the grid, not re-rendering it.
- Browser form restoration overwrote the saved player name during a
  hash-driven join.
- Players were renamed after the colour they played, because the seat label was
  written to their permanent record.
- Signed-in users were not highlighted on the leaderboard: the account id and
  the local guest id legitimately differ, and the lookup used the wrong one.
- The bot played weak moves. Root moves were searched with a narrowed
  alpha-beta window, so a move that failed high came back scored exactly equal
  to alpha and was indistinguishable from a genuine tie.
- With a remote store configured the local file was still read at boot, seeding
  the server from a stale copy.
- Every explicit save cost two writes; the debounce it made redundant was not
  cancelled.
- The rules diagram set grid columns but not rows, so cells were not square and
  the move markers rendered as ellipses.

### Notes
- 100 tests: engine, server, bot, rating, accounts and storage, including a
  fuzz run of 100 random games.
- The Guardian is confined to a quarter of the board for the whole game and can
  never reach an even rank. This is a consequence of the movement rule, not an
  oversight, and there is a test asserting it so it cannot change silently.
