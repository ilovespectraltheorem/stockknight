//! `sk-match`: plays two engines against each other over the engine protocol.
//!
//! Openings: random plies, kept only if G0 scores them within ±150 cp; each opening is played
//! twice with colours swapped. Games end by the rules, by a ply cap (a draw) or by adjudication
//! (one side's score beyond the bound for 8 plies in a row). Reports W/D/L, Elo with a 95%
//! interval and, with `--sprt`, stops as soon as the sequential test decides.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use sk_core::*;
use sk_eval::hand_eval;

const USAGE: &str = "usage: sk-match --e1 <cmd> --e2 <cmd> [--init1 <cmds>] [--init2 <cmds>] [--name1 n] [--name2 n]
  --games N (--nodes N | --movetime MS | --depth N) [--concurrency N] [--sprt elo0,elo1]
  [--seed N] [--random-plies 8] [--max-plies 400] [--adjudicate 1500] [--json file] [--log file]
init commands are separated by ';', e.g. --init1 \"setoption name RandomMargin value 0\"";

#[derive(Clone)]
struct Config {
    cmd: [String; 2],
    init: [Vec<String>; 2],
    name: [String; 2],
    games: usize,
    go: String,
    condition: String,
    concurrency: usize,
    sprt: Option<(f64, f64)>,
    seed: u64,
    random_plies: usize,
    max_plies: usize,
    adjudicate: i32,
    json: Option<String>,
    log: Option<String>,
}

fn parse_args() -> Result<Config, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut opts = BTreeMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i]
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected argument {}", args[i]))?;
        let value = args
            .get(i + 1)
            .ok_or_else(|| format!("--{key} needs a value"))?;
        opts.insert(key.to_string(), value.clone());
        i += 2;
    }
    const KNOWN: [&str; 17] = [
        "e1",
        "e2",
        "init1",
        "init2",
        "name1",
        "name2",
        "games",
        "nodes",
        "movetime",
        "depth",
        "concurrency",
        "sprt",
        "seed",
        "random-plies",
        "max-plies",
        "adjudicate",
        "json",
    ];
    for k in opts.keys() {
        if !KNOWN.contains(&k.as_str()) && k != "log" {
            return Err(format!("unknown option --{k}"));
        }
    }
    let get = |k: &str| opts.get(k).cloned();
    let num = |k: &str, default: u64| -> Result<u64, String> {
        get(k).map_or(Ok(default), |v| {
            v.parse().map_err(|_| format!("--{k}: not a number: {v}"))
        })
    };
    let cmd1 = get("e1").ok_or("--e1 is required")?;
    let cmd2 = get("e2").ok_or("--e2 is required")?;
    let split = |s: Option<String>| -> Vec<String> {
        s.map(|s| {
            s.split(';')
                .map(|c| c.trim().to_string())
                .filter(|c| !c.is_empty())
                .collect()
        })
        .unwrap_or_default()
    };
    let limits: Vec<(&str, String)> = ["nodes", "movetime", "depth"]
        .into_iter()
        .filter_map(|k| get(k).map(|v| (k, v)))
        .collect();
    if limits.len() != 1 {
        return Err("give exactly one of --nodes, --movetime, --depth".into());
    }
    let (kind, value) = &limits[0];
    value
        .parse::<u64>()
        .map_err(|_| format!("--{kind}: not a number: {value}"))?;
    let sprt = match get("sprt") {
        None => None,
        Some(s) => {
            let v: Vec<f64> = s.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            if v.len() != 2 || v[0] >= v[1] {
                return Err(format!("--sprt: expected elo0,elo1 with elo0 < elo1: {s}"));
            }
            Some((v[0], v[1]))
        }
    };
    let base = |c: &str| {
        c.split_whitespace()
            .last()
            .unwrap_or("engine")
            .rsplit('/')
            .next()
            .unwrap()
            .to_string()
    };
    Ok(Config {
        name: [
            get("name1").unwrap_or_else(|| base(&cmd1)),
            get("name2").unwrap_or_else(|| base(&cmd2)),
        ],
        cmd: [cmd1, cmd2],
        init: [split(get("init1")), split(get("init2"))],
        games: num("games", 100)? as usize,
        go: format!("go {kind} {value}"),
        condition: format!("{kind} {value}"),
        concurrency: num("concurrency", 1)?.max(1) as usize,
        sprt,
        seed: num("seed", 0)?,
        random_plies: num("random-plies", 8)? as usize,
        max_plies: num("max-plies", 400)? as usize,
        adjudicate: num("adjudicate", 1500)? as i32,
        json: get("json"),
        log: get("log"),
    })
}

// --- engines ------------------------------------------------------------------------------------

struct EngineProc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    nodes: u64,
    millis: u128,
}

impl EngineProc {
    fn start(cmd: &str, init: &[String]) -> Result<Self, String> {
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        let mut child = Command::new(parts[0])
            .args(&parts[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("cannot start {cmd}: {e}"))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut e = EngineProc {
            child,
            stdin,
            stdout,
            nodes: 0,
            millis: 0,
        };
        e.send("uci")?;
        e.wait_for("uciok")?;
        for c in init {
            e.send(c)?;
        }
        e.send("isready")?;
        e.wait_for("readyok")?;
        Ok(e)
    }

    fn send(&mut self, line: &str) -> Result<(), String> {
        writeln!(self.stdin, "{line}")
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("engine write: {e}"))
    }

    fn read_line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        let n = self
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("engine read: {e}"))?;
        if n == 0 {
            return Err("engine closed its output".into());
        }
        Ok(line.trim().to_string())
    }

    fn wait_for(&mut self, token: &str) -> Result<(), String> {
        while self.read_line()? != token {}
        Ok(())
    }

    /// Returns the move text and the last reported score (side to move's view, cp; mates as ±30000).
    fn think(&mut self, position: &str, go: &str) -> Result<(String, Option<i32>), String> {
        let start = Instant::now();
        self.send(position)?;
        self.send(go)?;
        let mut score = None;
        let mut nodes = 0;
        loop {
            let line = self.read_line()?;
            let w: Vec<&str> = line.split_whitespace().collect();
            match w.first() {
                Some(&"info") => {
                    if let Some(i) = w.iter().position(|&x| x == "score") {
                        match (
                            w.get(i + 1),
                            w.get(i + 2).and_then(|s| s.parse::<i32>().ok()),
                        ) {
                            (Some(&"cp"), Some(v)) => score = Some(v),
                            (Some(&"mate"), Some(v)) => {
                                score = Some(if v > 0 { 30000 } else { -30000 })
                            }
                            _ => {}
                        }
                    }
                    if let Some(n) = w
                        .iter()
                        .position(|&x| x == "nodes")
                        .and_then(|i| w.get(i + 1))
                    {
                        nodes = n.parse().unwrap_or(nodes);
                    }
                }
                Some(&"bestmove") => {
                    self.nodes += nodes;
                    self.millis += start.elapsed().as_millis();
                    return Ok((w.get(1).unwrap_or(&"0000").to_string(), score));
                }
                _ => {}
            }
        }
    }
}

impl Drop for EngineProc {
    fn drop(&mut self) {
        let _ = self.send("quit");
        let _ = self.child.wait();
    }
}

// --- openings -----------------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

/// A random opening of `plies` moves that G0 scores within ±150 cp, as UCI move texts.
fn opening(seed: u64, plies: usize) -> Vec<String> {
    let mut rng = Rng(seed);
    loop {
        let mut pos = Position::startpos();
        let mut moves = Vec::new();
        for _ in 0..plies {
            let legal = pos.legal_moves();
            if legal.is_empty() {
                break;
            }
            let m = legal[(rng.next() % legal.len() as u64) as usize];
            moves.push(Position::move_to_uci(m));
            pos.make_move(m);
        }
        if moves.len() == plies && pos.outcome() == Outcome::Ongoing && hand_eval(&pos).abs() <= 150
        {
            return moves;
        }
    }
}

// --- games --------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Res {
    WhiteWins,
    Draw,
    BlackWins,
}

struct GameRecord {
    index: usize,
    white: usize,
    result: Res,
    ending: String,
    moves: Vec<String>,
}

fn play_game(
    cfg: &Config,
    engines: &mut [EngineProc; 2],
    index: usize,
) -> Result<GameRecord, String> {
    let white = index % 2; // engine index playing White: openings are played twice, colours swapped
    let book = opening(
        cfg.seed.wrapping_mul(0x2545_f491_4f6c_dd1d) ^ (index / 2) as u64,
        cfg.random_plies,
    );
    let mut pos = Position::startpos();
    let mut moves = Vec::new();
    for text in &book {
        let m = pos.move_from_uci(text).expect("opening move");
        pos.make_move(m);
        moves.push(text.clone());
    }
    for e in engines.iter_mut() {
        e.send("ucinewgame")?;
    }
    let mut streak: [usize; 2] = [0, 0]; // plies in a row with White's view score beyond ±bound
    let finish = |result, ending: &str, moves: Vec<String>| GameRecord {
        index,
        white,
        result,
        ending: ending.into(),
        moves,
    };
    loop {
        match pos.outcome() {
            Outcome::Ongoing => {}
            Outcome::Win { winner, reason } => {
                let r = if winner == WHITE {
                    Res::WhiteWins
                } else {
                    Res::BlackWins
                };
                let ending = if reason == WinReason::Checkmate {
                    "checkmate"
                } else {
                    "stalemate (no legal move loses)"
                };
                return Ok(finish(r, ending, moves));
            }
            Outcome::Draw(DrawReason::Threefold) => {
                return Ok(finish(Res::Draw, "threefold repetition", moves))
            }
            Outcome::Draw(DrawReason::BareKings) => {
                return Ok(finish(Res::Draw, "bare kings", moves))
            }
        }
        if moves.len() >= cfg.max_plies {
            return Ok(finish(Res::Draw, "length cap", moves));
        }
        let side = pos.side;
        let mover = if side == WHITE { white } else { 1 - white };
        let position = format!("position startpos moves {}", moves.join(" "));
        let (text, score) = engines[mover].think(&position, &cfg.go)?;
        let Some(m) = pos.move_from_uci(&text) else {
            let r = if side == WHITE {
                Res::BlackWins
            } else {
                Res::WhiteWins
            };
            return Ok(finish(r, "illegal move", moves));
        };
        pos.make_move(m);
        moves.push(text);
        if let Some(s) = score {
            let white_view = if side == WHITE { s } else { -s };
            streak[0] = if white_view >= cfg.adjudicate {
                streak[0] + 1
            } else {
                0
            };
            streak[1] = if white_view <= -cfg.adjudicate {
                streak[1] + 1
            } else {
                0
            };
            if streak[0] >= 8 {
                return Ok(finish(Res::WhiteWins, "adjudication", moves));
            }
            if streak[1] >= 8 {
                return Ok(finish(Res::BlackWins, "adjudication", moves));
            }
        }
    }
}

// --- statistics ---------------------------------------------------------------------------------

fn elo_of_score(s: f64) -> f64 {
    let s = s.clamp(1e-6, 1.0 - 1e-6);
    -400.0 * (1.0 / s - 1.0).log10()
}

fn score_of_elo(elo: f64) -> f64 {
    1.0 / (1.0 + 10f64.powf(-elo / 400.0))
}

/// Mean score and per-game variance; a sweep gets half a win and half a loss added.
fn moments(w: f64, d: f64, l: f64) -> (f64, f64) {
    let (mut w, d, mut l) = (w, d, l);
    let n = w + d + l;
    let s = (w + d / 2.0) / n;
    let var = (w * (1.0 - s).powi(2) + d * (0.5 - s).powi(2) + l * s.powi(2)) / n;
    if var > 0.0 {
        return (s, var);
    }
    w += 0.5;
    l += 0.5;
    let n = w + d + l;
    let s = (w + d / 2.0) / n;
    (
        s,
        (w * (1.0 - s).powi(2) + d * (0.5 - s).powi(2) + l * s.powi(2)) / n,
    )
}

/// The generalized log-likelihood ratio, normal approximation on the trinomial score.
fn llr(w: f64, d: f64, l: f64, elo0: f64, elo1: f64) -> f64 {
    let n = w + d + l;
    if n == 0.0 {
        return 0.0;
    }
    let (s, var) = moments(w, d, l);
    let (s0, s1) = (score_of_elo(elo0), score_of_elo(elo1));
    n * (s1 - s0) * (2.0 * s - s0 - s1) / (2.0 * var)
}

const ALPHA: f64 = 0.05;
const BETA: f64 = 0.05;
const MIN_SPRT_GAMES: usize = 40;

fn sprt_bounds() -> (f64, f64) {
    ((BETA / (1.0 - ALPHA)).ln(), ((1.0 - BETA) / ALPHA).ln())
}

#[derive(Default)]
struct Tally {
    w: usize,
    d: usize,
    l: usize,
    endings: BTreeMap<String, usize>,
    decision: Option<(String, usize, f64)>,
    records: Vec<GameRecord>,
}

impl Tally {
    fn games(&self) -> usize {
        self.w + self.d + self.l
    }
}

fn json_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn main() {
    let cfg = match parse_args() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("sk-match: {e}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let start = Instant::now();
    let tally = Arc::new(Mutex::new(Tally::default()));
    let next = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let speed = Arc::new(Mutex::new([(0u64, 0u128); 2]));

    let workers: Vec<_> = (0..cfg.concurrency.min(cfg.games.max(1)))
        .map(|_| {
            let (cfg, tally, next, stop, speed) = (
                cfg.clone(),
                tally.clone(),
                next.clone(),
                stop.clone(),
                speed.clone(),
            );
            std::thread::spawn(move || -> Result<(), String> {
                let mut engines = [
                    EngineProc::start(&cfg.cmd[0], &cfg.init[0])?,
                    EngineProc::start(&cfg.cmd[1], &cfg.init[1])?,
                ];
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    if index >= cfg.games {
                        break;
                    }
                    let g = play_game(&cfg, &mut engines, index)?;
                    let mut t = tally.lock().unwrap();
                    // Result from engine 1's view.
                    let e1_white = g.white == 0;
                    match (g.result, e1_white) {
                        (Res::Draw, _) => t.d += 1,
                        (Res::WhiteWins, true) | (Res::BlackWins, false) => t.w += 1,
                        _ => t.l += 1,
                    }
                    *t.endings.entry(g.ending.clone()).or_default() += 1;
                    t.records.push(g);
                    let n = t.games();
                    eprint!("\r{} games: +{} ={} -{}   ", n, t.w, t.d, t.l);
                    if let Some((e0, e1)) = cfg.sprt {
                        if t.decision.is_none() && n >= MIN_SPRT_GAMES {
                            let v = llr(t.w as f64, t.d as f64, t.l as f64, e0, e1);
                            let (lo, hi) = sprt_bounds();
                            if v >= hi || v <= lo {
                                t.decision = Some((if v >= hi { "H1" } else { "H0" }.into(), n, v));
                                stop.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                }
                let mut sp = speed.lock().unwrap();
                for (i, e) in engines.iter().enumerate() {
                    sp[i].0 += e.nodes;
                    sp[i].1 += e.millis;
                }
                Ok(())
            })
        })
        .collect();
    for w in workers {
        if let Err(e) = w.join().unwrap() {
            eprintln!("\nsk-match: {e}");
            std::process::exit(1);
        }
    }
    eprintln!();

    let t = tally.lock().unwrap();
    let n = t.games();
    if n == 0 {
        eprintln!("sk-match: no games played");
        std::process::exit(1);
    }
    let (w, d, l) = (t.w as f64, t.d as f64, t.l as f64);
    let s = (w + d / 2.0) / n as f64;
    let (_, var) = moments(w, d, l);
    let se = (var / n as f64).sqrt();
    let (elo, lo, hi) = (
        elo_of_score(s),
        elo_of_score(s - 1.96 * se),
        elo_of_score(s + 1.96 * se),
    );
    let seconds = start.elapsed().as_secs_f64();
    let sp = speed.lock().unwrap();

    println!(
        "{} vs {}  ({}, {} games, seed {})",
        cfg.name[0], cfg.name[1], cfg.condition, n, cfg.seed
    );
    println!(
        "  +{} ={} -{}  score {:.3}  Elo {:+.1} [{:+.1}, {:+.1}]",
        t.w, t.d, t.l, s, elo, lo, hi
    );
    for (ending, count) in &t.endings {
        println!(
            "  {ending}: {count} ({:.0}%)",
            100.0 * *count as f64 / n as f64
        );
    }
    for i in 0..2 {
        let nps = sp[i].0 as f64 / (sp[i].1.max(1) as f64 / 1000.0);
        println!("  {}: {:.0} nodes/s", cfg.name[i], nps);
    }
    let mut sprt_json = "null".to_string();
    if let Some((e0, e1)) = cfg.sprt {
        let v = llr(w, d, l, e0, e1);
        let (decision, at) = match &t.decision {
            Some((dname, at, _)) => (dname.clone(), *at),
            None => ("none".into(), n),
        };
        println!("  SPRT [{e0}, {e1}]: {decision} after {at} games, LLR {v:.3}");
        sprt_json = format!(
            "{{\"elo0\": {e0}, \"elo1\": {e1}, \"decision\": \"{decision}\", \"games_at_decision\": {at}, \"llr\": {v:.3}}}"
        );
    }
    println!("  {seconds:.1} s");

    if let Some(path) = &cfg.json {
        let endings: Vec<String> = t
            .endings
            .iter()
            .map(|(k, v)| format!("{}: {v}", json_string(k)))
            .collect();
        let json = format!(
            "{{\n  \"name1\": {}, \"name2\": {},\n  \"wins\": {}, \"draws\": {}, \"losses\": {},\n  \"score\": {:.3}, \"elo\": {:.1}, \"elo_low\": {:.1}, \"elo_high\": {:.1},\n  \"condition\": {}, \"seed\": {}, \"random_plies\": {},\n  \"sprt\": {},\n  \"endings\": {{{}}},\n  \"seconds\": {:.1}\n}}\n",
            json_string(&cfg.name[0]), json_string(&cfg.name[1]), t.w, t.d, t.l, s, elo, lo, hi,
            json_string(&cfg.condition), cfg.seed, cfg.random_plies, sprt_json, endings.join(", "), seconds
        );
        let tmp = format!("{path}.tmp");
        std::fs::write(&tmp, json)
            .and_then(|_| std::fs::rename(&tmp, path))
            .expect("write --json");
    }
    if let Some(path) = &cfg.log {
        let mut records: Vec<&GameRecord> = t.records.iter().collect();
        records.sort_by_key(|g| g.index);
        let lines: Vec<String> = records
            .iter()
            .map(|g| {
                let result = match g.result {
                    Res::WhiteWins => "1-0",
                    Res::Draw => "1/2-1/2",
                    Res::BlackWins => "0-1",
                };
                format!(
                    "{}\t{}\t{}\t{}\t{}\t{}",
                    g.index,
                    cfg.name[g.white],
                    cfg.name[1 - g.white],
                    result,
                    g.ending,
                    g.moves.join(" ")
                )
            })
            .collect();
        std::fs::write(path, lines.join("\n") + "\n").expect("write --log");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elo_round_trip() {
        for e in [-300.0, -10.0, 0.0, 55.0, 400.0] {
            assert!((elo_of_score(score_of_elo(e)) - e).abs() < 1e-6);
        }
    }

    #[test]
    fn sprt_decides_clear_cases() {
        let (lo, hi) = sprt_bounds();
        assert!((hi - 2.944).abs() < 1e-3 && (lo + 2.944).abs() < 1e-3);
        assert!(llr(300.0, 100.0, 100.0, 0.0, 10.0) > hi);
        assert!(llr(100.0, 100.0, 300.0, 0.0, 10.0) < lo);
        assert!(
            llr(40.0, 0.0, 0.0, 0.0, 10.0).is_finite(),
            "a sweep still decides"
        );
    }

    #[test]
    fn openings_are_balanced_and_reproducible() {
        let a = opening(7, 8);
        assert_eq!(a, opening(7, 8));
        let mut pos = Position::startpos();
        for t in &a {
            let m = pos.move_from_uci(t).unwrap();
            pos.make_move(m);
        }
        assert!(hand_eval(&pos).abs() <= 150);
    }
}
