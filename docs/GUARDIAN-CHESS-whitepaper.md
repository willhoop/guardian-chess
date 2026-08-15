# Guardian Chess — white paper

**Version 1.0.0 — 2026-08-15**

A chess variant on a 10×8 board with one new piece, the Guardian, which leaps
exactly two squares orthogonally. The variant was devised by **Alex Hooper**.
This paper records what the piece actually does to the game, what is inherited
from existing variants rather than invented, and what the implementation
guarantees.

---

## 1. The variant

Standard chess with three differences.

**The board is ten files wide.** Files run `a` to `j`. Each side has ten pawns
and a ten-piece back rank:

```
  a  b  c  d  e  f  g  h  i  j
  R  N  B  G  K  Q  G  B  N  R
```

**The Guardian (G)** moves exactly two squares — up, down, left or right. Never
one, never three, never diagonally. It leaps: anything between it and its
destination is ignored and is not captured. It captures only what occupies the
square it lands on.

**Castling covers three squares**, not two.

Everything else is unchanged: en passant, promotion, stalemate, threefold
repetition, the fifty-move rule.

---

## 2. What is inherited, and what is new

Neither ingredient is original, though the combination appears to be. Saying so
plainly is more useful than claiming novelty that does not survive a search.

**The piece is a Dabbaba.** A piece that leaps (2,0) is one of the oldest fairy
chess pieces, the name being Arabic for a siege engine. It appears in medieval
variants such as Tamerlane chess. Its confinement to a quarter of the board is a
documented property, not a discovery of this project.

**The board is Capablanca's.** A 10×8 board with two extra pieces flanking the
king and queen is Capablanca chess (1920s), whose back rank is `RNABQKBCNR`.
The three-square castling rule used here is Capablanca's too.

**What appears to be new** is placing Dabbabas — rather than Capablanca's
Archbishop and Chancellor — on that board, at `d` and `g`.

---

## 3. The Guardian's defining property

Because the Guardian always moves exactly two, it can never change whether it
stands on an odd or an even rank or file. Its rank parity and file parity are
both invariant for the entire game.

The consequence is severe and worth stating precisely:

- A Guardian starting on `d1` reaches exactly **20 of the 80 squares**.
- It can **never stand on an even rank** — not once, all game.
- The two Guardians travel different quarters and can never occupy or defend the
  same square as one another.
- **No Guardian can ever defend a pawn on its starting rank**, because rank 2 is
  even. The king's pawn shield is permanently outside their reach.

This is asserted by a test (`tests/engine.test.js`, "guardian is confined to one
parity of rank and file") so that it cannot be altered by accident.

Two further consequences follow from the leap:

- **A Guardian check cannot be blocked.** Interposing does nothing. The reply
  must be a king move or a capture of the Guardian.
- **A lone Guardian cannot force mate.** King and Guardian against a bare king is
  drawn for insufficient material, as with a lone bishop or knight. Four
  Guardians covering all four quarters can force mate, but no side has four.

The piece is also slow to start: in the opening position each Guardian has
exactly one legal move, straight forward two, because its sideways leaps land on
its own occupied back rank.

---

## 4. Why the king and queen are swapped

Every chess player knows the queen starts on her own colour. On an eight-file
board that agrees with placing her to the king's left, because the left of the
two centre squares happens to be light.

Adding two files flips the parity:

| Board width | Centre files | Square left of the king |
|---|---|---|
| 8 (standard) | d / e | light — both conventions agree |
| **10** | e / f | **dark** — one must be given up |
| 12 | f / g | light — they agree again |

On ten files, with a symmetric back rank, the king and queen must occupy the two
centre squares, and those are always opposite colours. You can have the queen on
the king's left, or the queen on her own colour, but not both.

Capablanca kept the queen on the left and accepted the wrong colour. Guardian
Chess makes the opposite choice: the king takes `e`, the queen takes `f`, and
each queen begins on her own colour. Kings still face kings, queens still face
queens, and the right-hand corner square is still light.

### The cost

Castling asymmetry inverts relative to Capablanca's arrangement. "Kingside"
means the flank the king stands on, which here is the a-side, so the a1 rook is
the king's rook:

| | Castle | Squares to clear |
|---|---|---|
| Kingside `O-O` | K e1→b1, R a1→c1 | three: `b1 c1 d1` |
| Queenside `O-O-O` | K e1→h1, R j1→g1 | four: `f1 g1 h1 i1` |

Kingside remains the short castle, as in ordinary chess; it simply runs toward
`a`, because both extra files were added on the queen's flank. In play the gap
is wider than three-against-four suggests: castling short took four developing
moves in testing, castling long took six, because the queen on `f1` starts boxed
in behind her own pawn.

---

## 5. Piece values

Estimates from the geometry of the pieces, not from played games. They are
stated here so that they can be argued with.

| Pawn | Guardian | Knight | Bishop | Rook | Queen |
|---|---|---|---|---|---|
| 1 | **2.75** | 3 | 3.25 | 5 | 9 |

The Guardian is priced below a knight because a quarter of the board is
unreachable to it for the whole game, so much of the mobility its move-set
implies is unavailable. A single table in `shared/values.js` serves both the
computer opponent and the material scoreboard, so the two cannot disagree.

**This is the weakest claim in the document.** The number has not been
calibrated against played games, only reasoned from the movement rule. It should
be revised once there is a body of real play.

---

## 6. Implementation guarantees

**One copy of the rules.** `shared/engine.js` is loaded unmodified by both the
browser and the server. The client uses it to show legal moves; the server uses
it to validate them. They cannot drift apart.

**The server is authoritative.** Every move is re-checked server-side. A
modified client cannot make an illegal move; it receives an error and is
resynchronised. Tests drive a client that attempts to move a Guardian one
square, three squares and diagonally, to move out of turn, and to move as a
spectator. Each is rejected without disturbing the game.

**Ratings.** Elo, starting at 1200, with a larger K-factor for the first ten
games. Only online games between two distinct players count. Games against the
computer, same-screen games, and games ending before both sides have moved are
unrated — the last of these prevents two accounts farming rating by resigning
immediately.

**Identity.** Guest play requires no account. A guest asserts a random browser
id, which is safe because it is worth nothing. Accounts are protected by a
scrypt-hashed password and a session token stored only as a hash. A guest can
never assert an id belonging to an account; without that guard, anyone could
read a rival's id and inherit their rating.

---

## 7. Evidence

100 automated tests: 36 engine, 10 server, 11 bot, 22 rating, 14 account and
8 storage, including a fuzz run of 100 random games that asserts the engine
never reaches an illegal state.

Several tests exist because an assumption that looked obviously correct turned
out to be wrong when the application was actually run rather than reasoned
about. Two examples, both recorded in the changelog: a hidden screen that still
occupied the page because an id selector beat a class selector on specificity,
and a computer opponent that played weak moves because root moves searched with
a narrowed alpha-beta window returned scores indistinguishable from genuine ties.

---

## 8. Open questions

1. **Is the Guardian too passive?** It is confined to a quarter of the board and
   has one legal move in the opening. Giving it a one-square orthogonal step as
   well — making it a Wazir-Dabbaba compound — would unlock the whole board while
   keeping its character. This has not been tried.
2. **Is 2.75 right?** See section 5. It needs real games.
3. **Does the castling inversion play well?** Making the queenside the slower
   side reverses a deeply held habit. Whether that is interesting or merely
   irritating is not yet known.
