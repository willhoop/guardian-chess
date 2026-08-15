# Guardian Chess — the short version

**Version 1.0.0 — 2026-08-15**

---

## 1. What it is

Chess, on a board two columns wider, with one new piece.

The variant was invented by **Alex Hooper**. This is a playable implementation of
it: play a friend online, play the computer, or pass one device back and forth.

Live at **guardian-chess.onrender.com**.

---

## 2. The new piece

The **Guardian** moves exactly two squares — up, down, left or right.

Never one square. Never three. Never diagonally.

It jumps, like a knight. Whatever is standing in the way is ignored, and is not
captured. It only takes what is on the square it lands on.

```
        . . O . .        O = where a Guardian in the
        . . . . .            centre may move
        O . G . O
        . . . . .        It cannot reach any of the
        . . O . .        eight squares touching it.
```

---

## 3. The one thing everybody should know about it

Because it always moves exactly two, a Guardian can never change whether it is
on an odd or an even row.

It spends the entire game on a quarter of the board. It can never set foot on an
even rank. It can never defend a pawn on its starting square, because that row
is even.

That is not a bug. It follows from the rule, and there is a test that fails if
anyone changes it.

Two more things follow:

- **You cannot block a Guardian check.** Putting a piece in the way does
  nothing. Move the king, or take the Guardian.
- **A Guardian cannot checkmate on its own.** King and Guardian against a lone
  king is a draw.

---

## 4. Two adjustments the wider board forced

**The king and queen are swapped.** The back rank reads `R N B G K Q G B N R`.

Every chess player knows the queen starts on her own colour. On a ten-wide board
you can have the queen on the king's left, *or* the queen on her own colour, but
not both — the arithmetic does not allow it. Capablanca had the same problem in
his 10x8 game a century ago and kept the queen on the left. This one keeps her
colour instead.

**Castling covers three squares** rather than two, because the board is wider.
Kingside is still the short castle. It just runs to the left here, since the
king sits on `e` and both extra files were added on the queen's side.

---

## 5. What you can do with it

- **Play a friend.** Create a game, send the five-character code.
- **Play the computer.** Three strengths. It will take your hanging pieces and
  it sees mate in one.
- **Same screen.** Pass the device back and forth; the board turns to face
  whoever is on move.
- **Ratings.** Elo, a leaderboard, and recent games. Only real games against
  real people count.
- **Accounts are optional.** Guests play immediately with no sign-up and still
  get a rating. Making an account keeps that rating across devices, and carries
  over what you earned as a guest.

---

## 6. How much of this is new

Honest answer: the pieces are borrowed, the combination is not.

- A piece that leaps exactly two is a **Dabbaba**, one of the oldest fairy chess
  pieces, found in medieval variants.
- A 10x8 board with two extra pieces beside the king and queen is **Capablanca
  chess**, from the 1920s.

Putting Dabbabas on Capablanca's board is the part I cannot find anywhere else.

---

## 7. What is not settled

**The Guardian may be too passive.** One legal move in the opening, and a
quarter of the board for life. Letting it also step one square would fix that
and keep its character. Nobody has tried it yet.

**Its value is a guess.** It is priced at 2.75 pawns, just under a knight,
reasoned from the geometry rather than measured from games.

**The castling change may annoy people.** Reversing which side is quicker to
castle goes against a deep habit.

All three need real games to answer, not more reasoning.
