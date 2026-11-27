# The Maki website

Maki is the game (formerly KnightChess); Stockhorse is its engine (formerly StockKnight).

A static site in `web/` with a small optional server for online games. It uses the reference
engine (`reference/engine.js`) for the rules and the engine, so the site plays exactly the game
the engines play. No build step and no dependencies.

```sh
node web/server.js            # http://localhost:8080/  (all features, including online games)
node web/server.js --data rooms.json   # the same, keeping games across restarts
python3 -m http.server        # from the repo root, then open /web/  (everything but online games)
node web/test-train.js        # the Train section's openings and puzzles against the rules
node web/test.js              # engine tasks, analysis lines and move tree, review classification, online server
node web/test-tutorial.js     # every Learn lesson position is legal and every exercise solvable
node web/test-coach.js        # the Learn by playing coach explains each rule when it comes up
node web/calibrate.js         # re-measure the Elo of each strength setting (see docs/STRENGTH.md)
```

## What it does

| Feature | How |
|---|---|
| Home | One grid of every mode: Play Stockhorse across the top, then Learn by playing, Pass and play, Play online, Train, Analysis board and Review. A first-time visitor sees "New? Start here" on Learn by playing |
| Play the engine | Pick Stockhorse's strength by Elo with a slider and − / + (50-point steps, up to 3000 = full strength), and your colour. Each Elo maps to a search node budget and a move-choice temperature, measured by self-play; see [STRENGTH.md](STRENGTH.md). The engine runs in a Web Worker |
| Pass and play | Both sides on one screen; the board turns to the side to move |
| Play screen | Status, the move list and one row of tools: Undo, Flip, Eval, Resign and More (New game, Analyse on the board, Share, Review this game). When a game ends, Review this game and New game come up above the tools |
| Online | See [Online play](#online-play) below |
| Moving | Click or drag a piece. To drop, click a piece in your reserve (beside the board), then a highlighted square. A reserve piece is only clickable when it has a legal drop, and then it is outlined and bobs a few times. A dropped piece lands with a bounce and a ripple on every board |
| Home hero | A real combination on a loop: a gloved hand drops a bishop from the reserve, 1. B@c5+!! c6xc5 2. Re6# (from `rkp3/pp1PR1/r5/4KP/1q2P1/P5[B] w 0 25`; Stockhorse finds it as mate in 2, and `web/test-coach.js` checks it stays forced). With reduced motion the final position shows |
| Analysis board | See [Analysis board](#analysis-board) below |
| Learn | See [Learn](#learn) below |
| Train | `#/train`: named openings to study and practise, 367 middlegame tactics and 270 tablebase endgames with levels, hints, explanations and a training rating. See [TRAIN.md](TRAIN.md) |
| Game review | Every position is searched with a full window for every legal move, so each played move has an exact score at the same depth as the best move. Review time per position: Quick 0.25 s, Standard 0.7 s, Deep 1.8 s |
| Share | **Share** on the analysis board, in Review, on the play screen and in the end-of-game dialog opens a share sheet: a preview of the position, a link, the phone's own share sheet (**Share…**, where the browser has one), Copy position, Copy moves and Download game file. See [Sharing and importing](#sharing-and-importing) |
| Import | Open a shared link, paste (Ctrl+V anywhere outside a text box), drop a file or link on the page, use **Import…** on the analysis board, or the box and **Open a game file…** on the empty Review page |
| Saved games | The last 40 finished or reviewed games are kept in the browser (`localStorage`). Move lists can be copied and pasted back in for review |

## Sharing and importing

Everything lives in the link, so sharing needs no server and works on GitHub Pages:

| Link | Opens |
|---|---|
| `#/analysis?fen=<fen>&moves=b2b3.c5c4&at=1` | The analysis board, with the line as its main line and the cursor after `at` moves. The FEN is left out for the starting position; spaces in it are written `_` |
| `#/review?moves=…&w=<white>&b=<black>&r=w\|b\|d&why=<reason>[&fen=…][&at=…]` | The game in Review (and in the saved games) |
| `#/online/<id>` | A live online game, as before |

After a shared link is opened its query is dropped from the address bar, so a reload does not
import it again. A game file (Download game file) is a few tag lines and numbered UCI moves:

```
[Game "Maki"]
[White "You"]
[Black "Stockhorse 1200"]
[Result "1-0"]
[Termination "checkmate"]
[FEN "…"]        (only for a game that did not start from the usual position)

1. b2b3 c5c4 2. R@c4 … 1-0
```

`web/share.js` writes links and files and reads anything back: a link (also inside other text),
a game file, a FEN with or without `moves …`, or a bare move list. Game files and review links open
in Review; positions, analysis links and move lists open on the analysis board (in Review when
pasted on the Review page). The site has a web app manifest: installed on a phone, Maki appears in
the system share sheet (`share_target`) and opens `.maki`/`.txt` game files (`file_handlers`).

## Learn

`#/learn`, from the Learn link in the top bar or the Learn by playing card on the home page, is
**Learn by playing**: a real game as White against Stockhorse at 400 Elo, with a coach beside the
board (`web/coach.js`). Each rule is explained the first time it matters: picking up each kind
of piece, a drop (and its two limits), the first time a drop becomes legal, a capture, a pawn
crossing into the enemy half or reaching the last rank, check given and received, the
opponent's first drop, piece values a few moves in, and how the game ended (checkmate,
stalemate wins, repetition, bare kings). The rules met so far show as chips to read again, and
**Show a good move** draws Stockhorse's best move as an arrow. `web/test-coach.js` checks that
each tip fires when it should.

`#/learn/lessons`, linked from the coach and the Rules page, keeps the step-by-step lessons: 15 lessons for
complete beginners in four parts (the pieces; captures and drops; check, mate and stalemate;
playing well), 55 steps in all. A step is either text beside a position, or an exercise played
as White on the board:

| Exercise | Solved when |
|---|---|
| Stars | Every star has been visited. Black passes, so the learner keeps the move |
| Capture | Every black piece but the king has been taken, Black passing as above |
| One move | The move gives check, checkmate or stalemate; escapes check in the asked way (king move, capture or block); attacks the named pieces (with a drop of the named type, if given); or is one of the listed moves. A wrong move is shown, explained and taken back |

Hint explains the idea and, for one-move exercises, draws an arrow to an answer the rules engine
found. Progress (lessons done, the step reached in each) is kept in the browser. The lessons are
data in `web/lessons.js`; `web/tutorial.js` runs them with the reference engine, and
`web/test-tutorial.js` checks every position and solves every exercise.

## Analysis board

`#/analysis`, from the Analysis link in the top bar or the Analysis board card on the home page.

| Feature | How |
|---|---|
| Starting point | The starting position, any position set up in the editor, or a position string pasted into the Position box (a FEN as in [RULES.md](RULES.md), optionally followed by `moves` and UCI moves, as Copy moves writes it). Review's **Analyse from here** and the play screen's **Analyse** open a game with the cursor on the chosen move |
| Position editor | Pick a piece (or the eraser), then click squares; clicking the same piece again or right-clicking removes it. Set each side's reserve (up to 2 pawns, 1 bishop, 1 rook) and the side to move. The editor says what to fix before it lets a position through: a missing king, kings side by side, or the side not to move standing in check |
| Moves | Moves and drops for both sides, by click or drag. Every move tried is kept in a tree: a new move from an earlier position starts a variation, shown indented under the move it replaces. Click any move to go there; ←, →, Home and End step through the line, F flips the board. **Make main line** promotes the current line, **Delete from here** removes the current move and what follows |
| Stockhorse | The best 1, 2, 3 or 5 moves with their scores and lines (MultiPV), an eval bar, and arrows for the top three moves. The search deepens in steps (0.25 s, 0.7 s, 1.8 s, 4.5 s, 12 s) on its own Web Worker and keeps its hash table between steps; moving on restarts it. Click a move in a line to play the line up to it. The switch turns the engine off |
| Play from here | Opens the opponent picker and starts a game against Stockhorse from the current position. The picker shows the position, offers the side to move as your colour, and can switch to the usual start. Undo only takes back your own moves, so it is off until you have moved. Such games save and review like any other |
| Play online from here | Opens the online dialog with the current position as the starting position, so a friend can play it out with you. See [Online play](#online-play) |
| Endgame table | When one side has a king and one or two bishops or knights against a bare king, with empty reserves, `web/endgame.js` solves the ending exactly (a few seconds the first time, in its own Web Worker) and shows who wins, in how many moves, and the exact value of every legal move; its best moves get the arrows. **Lone-piece endings** sets up the longest king-and-bishop, king-and-knight and king-and-two-knights positions. Why a lone bishop or knight never mates, and how to win anyway: [ENDGAMES.md](ENDGAMES.md) |
| Remembered | The tree and the current move are kept in the browser, so the board is as you left it next time |

The engine side is `lines` in `web/engine-tasks.js`: the first k root moves get a full window
and every other move a null window against the k-th best score, re-searched only when it beats
it, so asking for three lines costs little depth. The move tree is `web/tree.js`.

## Online play

`web/server.js` is the referee. Browsers send moves; the server checks each one with the
reference engine, runs the clocks and decides every result, then pushes the new state to both
players and any watchers over server-sent events.

| Feature | How it works |
|---|---|
| Quick pairing | Pick a time control and press Quick pairing. You join the oldest waiting player at the same time control, or you wait and your game shows under Open challenges for others. A waiting game only counts while its player is connected, and two tabs of the same browser are never paired together |
| Invite link | Make an invite link (pick White, Black or random) and send it. The first visitor takes the free seat; anyone after that watches |
| Start from a position | In the online dialog, Starting position: From a position takes a position string (FEN, as in [RULES.md](RULES.md)), shows it on a small board, and says what is wrong if it is not a legal position or the game is already over. **Set up on the board** opens the analysis board's editor; its **Use this position** button brings the dialog back with that position (Cancel brings it back as it was). Enter in the position box makes the invite. Opened from anywhere else, the dialog starts on the usual position. These games are by invite only (quick pairing always uses the usual start), show as "set-up position" in the lobby, and a rematch starts from the same position. The server checks the position (`fen` in `POST /api/rooms`) and every move from it; the room state carries it as `startFen` |
| Lobby | The online dialog lists open challenges and live games to watch, refreshed every 3 s |
| Time controls | 1 min, 3 \| 2, 5 min, 10 \| 5, 15 \| 10 or untimed. Clocks start after both sides have made their first move; each side has 30 s for its first move or the game is aborted. The increment is added after every timed move. Running out of time loses, unless the opponent has only a king and an empty reserve, which is a draw |
| Draws | Offer a draw after your first move. Your opponent accepts or declines; making a move also declines it. Repetition and bare kings end the game as usual |
| Abort and resign | Before both sides have moved, the button reads Abort and ends the game with no result. After that it is Resign (click twice) |
| Reconnecting | Each browser keeps its seat token in `localStorage`, so a reload or a dropped connection rejoins the same seat and gets the full game back. The player bars show who is connected. If a player has been gone for 60 s, the opponent may claim the win (or abort, if the game had not really started). Clocks keep running while a player is away |
| Rematch | After a game either player asks for a rematch; when both have, a new game with colours swapped opens for both |
| Restarts | With `--data FILE` (or `MAKI_DATA`) the server saves games to a JSON file and reloads them on start; clocks pause while the server is down |

The site also runs as a claude.ai Artifact (`node web/build-artifact.js`). There, games live in
the Artifact's shared database and both browsers check every move. That version has invite
codes, the lobby, draw offers, abort and rematches, but no clocks or quick pairing, since there
is no server to keep time.

Not built yet: accounts and ratings, premoves, chat, takeback requests and
correspondence (days per move) games.

## Move classifications

Scores become expected points with `wp = 1 / (1 + e^(-0.00368 · cp))` from the mover's view, and
mates count as 0 or 1. A move's loss is the best move's expected points minus the played move's.

| Class | Rule |
|---|---|
| Forced | The only legal move |
| Best | The engine's move, or within 0.2% of it |
| Excellent / Good | Loss under 2% / under 5% |
| Inaccuracy / Mistake / Blunder | Loss under 10% / under 20% / 20% or more |
| Great | Best or excellent, at least 15% better than every other move, and not losing afterwards |
| Brilliant | Loss under 2%, gives up more than a pawn's worth of material (board plus reserve) along the opponent's best reply line, still at least even afterwards, and the mover was not already completely winning |
| Miss | An inaccuracy, mistake or blunder of 10% or more straight after the opponent's mistake or blunder, while not losing: the chance was there and went unused |

Accuracy per move is `103.1668 · e^(-4.354 · loss) - 3.1669`, clamped to 0–100, and a player's
accuracy is the mean over their unforced moves.

The engine worker searches with Stockhorse in WebAssembly and the network named in
`web/config.js` (G25), and falls back to the reference engine with G0, the hand-written
evaluation, when that is unavailable. See [DEPLOY.md](DEPLOY.md).
