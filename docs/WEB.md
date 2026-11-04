# The Maki website

Maki is the game (formerly KnightChess); Stockhorse is its engine (formerly StockKnight).

A static site in `web/` with a small optional server for online games. It uses the reference
engine (`reference/engine.js`) for the rules and the engine, so the site plays exactly the game
the engines play. No build step and no dependencies.

```sh
node web/server.js            # http://localhost:8080/  (all features, including online games)
node web/server.js --data rooms.json   # the same, keeping games across restarts
python3 -m http.server        # from the repo root, then open /web/  (everything but online games)
node web/test.js              # engine tasks, review classification, online server
node web/calibrate.js         # re-measure the Elo of each strength setting (see docs/STRENGTH.md)
```

## What it does

| Feature | How |
|---|---|
| Play the engine | Pick Stockhorse's strength by Elo with a slider (50-point steps, up to 3000 = full strength). Each Elo maps to a search node budget and a move-choice temperature, measured by self-play; see [STRENGTH.md](STRENGTH.md). The engine runs in a Web Worker |
| Pass and play | Both sides on one screen; the board turns to the side to move |
| Online | See [Online play](#online-play) below |
| Moving | Click or drag a piece. To drop, click a piece in your reserve (beside the board), then a highlighted square. A reserve piece is only clickable when it has a legal drop |
| Game review | Every position is searched with a full window for every legal move, so each played move has an exact score at the same depth as the best move. Review time per position: Quick 0.25 s, Standard 0.7 s, Deep 1.8 s |
| Saved games | The last 40 finished or reviewed games are kept in the browser (`localStorage`). Move lists can be copied and pasted back in for review |

## Online play

`web/server.js` is the referee. Browsers send moves; the server checks each one with the
reference engine, runs the clocks and decides every result, then pushes the new state to both
players and any watchers over server-sent events.

| Feature | How it works |
|---|---|
| Quick pairing | Pick a time control and press Quick pairing. You join the oldest waiting player at the same time control, or you wait and your game shows under Open challenges for others. A waiting game only counts while its player is connected, and two tabs of the same browser are never paired together |
| Invite link | Make an invite link (pick White, Black or random) and send it. The first visitor takes the free seat; anyone after that watches |
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

The site evaluates with G0, the hand-written evaluation. When a trained network is served through
WebAssembly, `web/engine-tasks.js` is the one place to switch it in.
