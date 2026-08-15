# Changelog — Guardian Chess

All notable changes to Guardian Chess are recorded here, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Rule.** Every change is logged here in the same pass as the code, together with
the matching updates to the white paper, the deck, and the technical
documentation. A prior conclusion is never silently rewritten; what changed and
why is stated.

---

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
