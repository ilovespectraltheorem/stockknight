//! `stockknight`: the engine. Reads UCI-like commands from stdin, or runs each argument as a
//! command: `stockknight bench`, `stockknight "position startpos" "perft 5"`.

use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use sk_core::*;
use sk_eval::{hand_eval, HandEval};
use sk_search::{level_limits, mate_in, Limits, SearchResult, Searcher, MATE_BOUND};

const BENCH: &str = include_str!("../../../testdata/bench-positions.txt");

struct Engine {
    pos: Position,
    searcher: Arc<Mutex<Searcher<HandEval>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    random_margin: i32,
}

fn score_text(score: i32) -> String {
    if score.abs() >= MATE_BOUND {
        format!("mate {}", mate_in(score))
    } else {
        format!("cp {score}")
    }
}

fn info_line(r: &SearchResult) -> String {
    let ms = r.elapsed.as_millis().max(1);
    let pv: Vec<String> = r.pv.iter().map(|&m| Position::move_to_uci(m)).collect();
    format!(
        "info depth {} score {} nodes {} nps {} time {} pv {}",
        r.depth,
        score_text(r.score),
        r.nodes,
        r.nodes as u128 * 1000 / ms,
        ms,
        pv.join(" ")
    )
}

fn say(line: &str) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

impl Engine {
    fn new() -> Self {
        let searcher = Searcher::new(HandEval);
        let stop = searcher.stop_handle();
        Engine {
            pos: Position::startpos(),
            searcher: Arc::new(Mutex::new(searcher)),
            stop,
            worker: None,
            random_margin: 0,
        }
    }

    fn wait(&mut self) {
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }

    /// Returns false on `quit`.
    fn command(&mut self, line: &str, block: bool) -> bool {
        let words: Vec<&str> = line.split_whitespace().collect();
        let Some(&cmd) = words.first() else {
            return true;
        };
        if cmd != "stop" && cmd != "isready" {
            self.wait();
        }
        match cmd {
            "uci" => {
                say("id name StockKnight 0.1");
                say("id author StockKnight authors");
                say("option name RandomMargin type spin default 0 min 0 max 1000");
                say("uciok");
            }
            "isready" => say("readyok"),
            "ucinewgame" => self.searcher.lock().unwrap().clear(),
            "quit" => {
                self.stop.store(true, Ordering::Relaxed);
                self.wait();
                return false;
            }
            "stop" => {
                self.stop.store(true, Ordering::Relaxed);
                self.wait();
            }
            "setoption" => self.setoption(&words),
            "position" => {
                if let Err(e) = self.position(&words) {
                    say(&format!("info string error {e}"));
                }
            }
            "go" => self.go(&words, block),
            "d" => say(&self.pos.board_text()),
            "legal" => {
                let moves: Vec<String> = self
                    .pos
                    .legal_moves()
                    .into_iter()
                    .map(Position::move_to_uci)
                    .collect();
                say(&moves.join(" "));
            }
            "eval" => say(&format!("G0 {} cp (side to move)", hand_eval(&self.pos))),
            "status" => say(&self.pos.outcome().code()),
            "perft" => {
                let depth = words.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
                let t = Instant::now();
                let n = self.pos.perft(depth);
                say(&format!(
                    "perft {depth}: {n} ({} ms)",
                    t.elapsed().as_millis()
                ));
            }
            "bench" => {
                let depth = words.get(1).and_then(|s| s.parse().ok()).unwrap_or(7);
                bench(depth);
            }
            _ => say(&format!("info string unknown command: {line}")),
        }
        true
    }

    fn setoption(&mut self, words: &[&str]) {
        let name = words
            .iter()
            .position(|&w| w == "name")
            .and_then(|i| words.get(i + 1));
        let value = words
            .iter()
            .position(|&w| w == "value")
            .and_then(|i| words.get(i + 1));
        match (name.copied(), value) {
            (Some("RandomMargin"), Some(v)) => self.random_margin = v.parse().unwrap_or(0),
            (Some("Hash"), _) => {} // fixed-size table for now
            _ => say("info string unknown option"),
        }
    }

    fn position(&mut self, words: &[&str]) -> Result<(), String> {
        let moves_at = words
            .iter()
            .position(|&w| w == "moves")
            .unwrap_or(words.len());
        let mut pos = match words.get(1) {
            Some(&"startpos") => Position::startpos(),
            Some(&"fen") => Position::from_fen(&words[2..moves_at].join(" "))?,
            _ => return Err("expected startpos or fen".into()),
        };
        for &text in words.iter().skip(moves_at + 1) {
            let m = pos
                .move_from_uci(text)
                .ok_or_else(|| format!("illegal move {text}"))?;
            pos.make_move(m);
        }
        self.pos = pos;
        Ok(())
    }

    fn go(&mut self, words: &[&str], block: bool) {
        let num = |key: &str| -> Option<u64> {
            words
                .iter()
                .position(|&w| w == key)
                .and_then(|i| words.get(i + 1))
                .and_then(|s| s.parse().ok())
        };
        let mut limits = Limits {
            random_margin: self.random_margin,
            ..Default::default()
        };
        if let Some(level) = words
            .iter()
            .position(|&w| w == "level")
            .and_then(|i| words.get(i + 1))
        {
            match level_limits(level) {
                Some(l) => limits = l,
                None => say("info string unknown level"),
            }
        }
        if let Some(d) = num("depth") {
            limits.depth = Some(d as i32);
        }
        if let Some(n) = num("nodes") {
            limits.nodes = Some(n);
        }
        if let Some(t) = num("movetime") {
            limits.movetime = Some(Duration::from_millis(t));
        }
        let (time, inc) = if self.pos.side == WHITE {
            ("wtime", "winc")
        } else {
            ("btime", "binc")
        };
        if let Some(t) = num(time) {
            let budget = t / 25 + num(inc).unwrap_or(0) * 4 / 5;
            limits.movetime = Some(Duration::from_millis(
                budget.min(t.saturating_sub(50)).max(10),
            ));
        }
        if words.contains(&"infinite") {
            limits = Limits {
                random_margin: limits.random_margin,
                ..Default::default()
            };
        }

        self.stop.store(false, Ordering::Relaxed);
        let searcher = self.searcher.clone();
        let mut pos = self.pos.clone();
        limits.seed = pos.key();
        let mut run = move || {
            let mut s = searcher.lock().unwrap();
            let r = s.think(&mut pos, limits, |info| say(&info_line(info)));
            let best = if r.best == 0 {
                "0000".to_string()
            } else {
                Position::move_to_uci(r.best)
            };
            say(&format!("bestmove {best}"));
        };
        if block {
            run();
        } else {
            self.worker = Some(std::thread::spawn(run));
        }
    }
}

fn bench(depth: i32) {
    let start = Instant::now();
    let mut total = 0;
    for fen in BENCH.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let mut pos = Position::from_fen(fen).expect("bench FEN");
        let mut s = Searcher::new(HandEval);
        let r = s.think(
            &mut pos,
            Limits {
                depth: Some(depth),
                ..Default::default()
            },
            |_| {},
        );
        total += r.nodes;
        say(&format!(
            "{:<6} {:>6} {:>9}  {fen}",
            Position::move_to_uci(r.best),
            r.score,
            r.nodes
        ));
    }
    let ms = start.elapsed().as_millis().max(1);
    say(&format!(
        "depth {depth}: {total} nodes, {ms} ms, {} nodes/s",
        total as u128 * 1000 / ms
    ));
}

fn main() {
    let mut engine = Engine::new();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        for a in &args {
            if !engine.command(a, true) {
                break;
            }
        }
        return;
    }
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if !engine.command(line.trim(), false) {
            break;
        }
    }
    engine.wait();
}
