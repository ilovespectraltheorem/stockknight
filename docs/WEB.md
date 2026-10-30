# The StockKnight website

A static site in `web/` with a small optional server for online games. It uses the reference
engine (`reference/engine.js`) for the rules and the engine, so the site plays exactly the game
the engines play. No build step and no dependencies.

```sh
node web/server.js            # http://localhost:8080/  (all features, including online games)
python3 -m http.server        # from the repo root, then open /web/  (everything but online games)
node web/test.js              # engine tasks, review classification, online server
```

## What it does

| Feature | How |
|---|---|
| Play the engine | Four opponents. Page (depth 1, wide random margin), Squire, Knight and Champion are the reference engine's `casual`, `club` and `strong` levels. The engine runs in a Web Worker |
| Pass and play | Both sides on one screen; the board turns to the side to move |
| Online | `web/server.js` holds rooms in memory. A room link seats the second visitor; later visitors watch. Every move is checked with the reference engine on the server, and state reaches both browsers over server-sent events |
| Moving | Click or drag a piece. To drop, click a piece in your reserve (beside the board), then a highlighted square. A reserve piece is only clickable when it has a legal drop |
| Game review | Every position is searched with a full window for every legal move, so each played move has an exact score at the same depth as the best move. Review time per position: Quick 0.25 s, Standard 0.7 s, Deep 1.8 s |
| Saved games | The last 40 finished or reviewed games are kept in the browser (`localStorage`). Move lists can be copied and pasted back in for review |

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
