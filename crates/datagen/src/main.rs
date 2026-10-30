//! `sk-datagen`: self-play training data and tools for record files.
//!
//! ```text
//! sk-datagen run --out <prefix> (--positions N | --games N | --minutes M) [options]
//! sk-datagen stats <file>
//! sk-datagen dump <file> [--n N]
//! sk-datagen dedup <in>... <out> [--exclude <file>]
//! ```

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sk_core::*;
use sk_data::{GameResult, Record, RecordReader};
use sk_eval::Evaluator;
#[cfg(test)]
use sk_eval::HandEval;
use sk_nnue::AnyEval;
use sk_search::{Limits, Searcher, MATE_BOUND};

const USAGE: &str = "usage:
  sk-datagen run --out <prefix> (--positions N | --games N | --minutes M)
      [--eval-file net.nnue] [--nodes 5000] [--threads N] [--seed 1] [--random-plies 8] [--opening-limit 600]
      [--max-plies 400] [--adjudicate 1500] [--adjudicate-plies 8] [--quiet-draw 120]
      [--record-quiet-limit 40] [--val-fraction 0.01]
  sk-datagen stats <file>
  sk-datagen dump <file> [--n 20]
  sk-datagen dedup <in>... <out> [--exclude <file>]";

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("sk-datagen: {msg}\n{USAGE}");
    std::process::exit(2);
}

/// Splits `args` into positional arguments and `--key value` options, rejecting unknown keys.
fn parse(args: &[String], known: &[&str]) -> (Vec<String>, BTreeMap<String, String>) {
    let (mut pos, mut opts) = (Vec::new(), BTreeMap::new());
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            if !known.contains(&key) {
                fail(format!("unknown option --{key}"));
            }
            let Some(v) = args.get(i + 1) else {
                fail(format!("--{key} needs a value"))
            };
            opts.insert(key.to_string(), v.clone());
            i += 2;
        } else {
            pos.push(args[i].clone());
            i += 1;
        }
    }
    (pos, opts)
}

fn num<T: std::str::FromStr>(opts: &BTreeMap<String, String>, key: &str, default: T) -> T {
    match opts.get(key) {
        None => default,
        Some(v) => v
            .parse()
            .unwrap_or_else(|_| fail(format!("--{key}: bad value {v}"))),
    }
}

// --- run ----------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct Settings {
    pub nodes: u64,
    pub seed: u64,
    pub random_plies: usize,
    pub opening_limit: i32,
    pub max_plies: usize,
    pub adjudicate: i32,
    pub adjudicate_plies: usize,
    pub quiet_draw: u32,
    pub record_quiet_limit: u32,
    pub val_fraction: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            nodes: 5000,
            seed: 1,
            random_plies: 8,
            opening_limit: 600,
            max_plies: 400,
            adjudicate: 1500,
            adjudicate_plies: 8,
            quiet_draw: 120,
            record_quiet_limit: 40,
            val_fraction: 0.01,
        }
    }
}

fn splitmix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

pub struct Game {
    /// `None` when the opening was discarded.
    pub records: Option<Vec<Record>>,
    pub ending: &'static str,
    pub result: GameResult,
    pub plies: usize,
    pub validation: bool,
}

/// One self-play game, fully determined by the settings and the game index.
pub fn play_game<E: Evaluator>(s: &Settings, searcher: &mut Searcher<E>, index: u64) -> Game {
    let mut rng = splitmix(s.seed ^ splitmix(index));
    let mut next = || {
        rng = splitmix(rng);
        rng
    };
    let validation = (next() % 1_000_000) as f64 / 1_000_000.0 < s.val_fraction;
    let discarded = |plies| Game {
        records: None,
        ending: "discarded",
        result: GameResult::Draw,
        plies,
        validation,
    };
    searcher.clear();

    let mut pos = Position::startpos();
    for _ in 0..s.random_plies {
        let moves = pos.legal_moves();
        if moves.is_empty() || pos.outcome() != Outcome::Ongoing {
            return discarded(pos.game_ply());
        }
        pos.make_move(moves[(next() % moves.len() as u64) as usize]);
    }

    let limits = Limits {
        nodes: Some(s.nodes),
        ..Default::default()
    };
    let mut pending: Vec<Record> = Vec::new();
    let mut streak = [0usize; 2];
    let mut first = true;
    let (result, ending) = loop {
        match pos.outcome() {
            Outcome::Win { winner, reason } => {
                let r = if winner == WHITE {
                    GameResult::WhiteWon
                } else {
                    GameResult::BlackWon
                };
                break (
                    r,
                    if reason == WinReason::Checkmate {
                        "checkmate"
                    } else {
                        "stalemate"
                    },
                );
            }
            Outcome::Draw(DrawReason::Threefold) => break (GameResult::Draw, "threefold"),
            Outcome::Draw(DrawReason::BareKings) => break (GameResult::Draw, "bare kings"),
            Outcome::Ongoing => {}
        }
        if pos.clock >= s.quiet_draw {
            break (GameResult::Draw, "quiet plies");
        }
        if pos.game_ply() >= s.max_plies {
            break (GameResult::Draw, "length cap");
        }

        let r = searcher.think(&mut pos, limits, |_| {});
        if first {
            if r.score.abs() > s.opening_limit {
                return discarded(pos.game_ply());
            }
            first = false;
        }
        let in_check = pos.checked();
        let capture = pos.captured_by(r.best) != 0;
        let forced = r.score.abs() >= MATE_BOUND;
        if !in_check && !capture && !forced && pos.clock <= s.record_quiet_limit {
            pending.push(Record::encode(&pos, r.score, GameResult::Draw, r.best));
        }

        let white_view = if pos.side == WHITE { r.score } else { -r.score };
        streak[0] = if white_view >= s.adjudicate {
            streak[0] + 1
        } else {
            0
        };
        streak[1] = if white_view <= -s.adjudicate {
            streak[1] + 1
        } else {
            0
        };
        pos.make_move(r.best);
        if streak[0] >= s.adjudicate_plies {
            break (GameResult::WhiteWon, "adjudication");
        }
        if streak[1] >= s.adjudicate_plies {
            break (GameResult::BlackWon, "adjudication");
        }
    };

    for r in pending.iter_mut() {
        r.set_result(result);
    }
    Game {
        records: Some(pending),
        ending,
        result,
        plies: pos.game_ply(),
        validation,
    }
}

#[derive(Default)]
struct Totals {
    games: u64,
    discarded: u64,
    plies: u64,
    results: [u64; 3],
    endings: BTreeMap<&'static str, u64>,
    train: u64,
    val: u64,
}

fn run(args: &[String]) {
    let known = [
        "out",
        "eval-file",
        "positions",
        "games",
        "minutes",
        "nodes",
        "threads",
        "seed",
        "random-plies",
        "opening-limit",
        "max-plies",
        "adjudicate",
        "adjudicate-plies",
        "quiet-draw",
        "record-quiet-limit",
        "val-fraction",
    ];
    let (rest, o) = parse(args, &known);
    if !rest.is_empty() {
        fail(format!("unexpected argument {}", rest[0]));
    }
    let Some(prefix) = o.get("out").cloned() else {
        fail("--out is required")
    };
    let target_positions: u64 = num(&o, "positions", 0);
    let target_games: u64 = num(&o, "games", 0);
    let minutes: f64 = num(&o, "minutes", 0.0);
    if target_positions == 0 && target_games == 0 && minutes <= 0.0 {
        fail("give --positions, --games or --minutes");
    }
    let eval_file = o.get("eval-file").cloned().unwrap_or_else(|| "none".into());
    let evaluator = AnyEval::from_file(&eval_file)
        .unwrap_or_else(|e| fail(e))
        .name();
    let threads: usize = num(
        &o,
        "threads",
        std::thread::available_parallelism().map_or(1, |n| n.get()),
    );
    let d = Settings::default();
    let s = Settings {
        nodes: num(&o, "nodes", d.nodes),
        seed: num(&o, "seed", d.seed),
        random_plies: num(&o, "random-plies", d.random_plies),
        opening_limit: num(&o, "opening-limit", d.opening_limit),
        max_plies: num(&o, "max-plies", d.max_plies),
        adjudicate: num(&o, "adjudicate", d.adjudicate),
        adjudicate_plies: num(&o, "adjudicate-plies", d.adjudicate_plies),
        quiet_draw: num(&o, "quiet-draw", d.quiet_draw),
        record_quiet_limit: num(&o, "record-quiet-limit", d.record_quiet_limit),
        val_fraction: num(&o, "val-fraction", d.val_fraction),
    };

    let create = |ext: &str| {
        BufWriter::with_capacity(
            1 << 20,
            File::create(format!("{prefix}.{ext}")).unwrap_or_else(|e| fail(e)),
        )
    };
    let _ = std::fs::remove_file(format!("{prefix}.info.txt"));
    let out = Arc::new(Mutex::new((
        create("train.bin"),
        create("val.bin"),
        Totals::default(),
    )));
    let next_game = Arc::new(AtomicU64::new(0));
    let positions = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let start = Instant::now();
    let deadline = (minutes > 0.0).then(|| start + Duration::from_secs_f64(minutes * 60.0));

    let workers: Vec<_> = (0..threads.max(1))
        .map(|_| {
            let (s, out, next_game, positions, stop, eval_file) =
                (s.clone(), out.clone(), next_game.clone(), positions.clone(), stop.clone(), eval_file.clone());
            std::thread::spawn(move || {
                let mut searcher = Searcher::new(AnyEval::from_file(&eval_file).unwrap_or_else(|e| fail(e)));
                loop {
                    let done_positions = target_positions > 0 && positions.load(Ordering::Relaxed) >= target_positions;
                    if stop.load(Ordering::Relaxed) || done_positions || deadline.is_some_and(|d| Instant::now() >= d) {
                        break;
                    }
                    let index = next_game.fetch_add(1, Ordering::Relaxed);
                    if target_games > 0 && index >= target_games {
                        break;
                    }
                    let g = play_game(&s, &mut searcher, index);
                    let mut guard = out.lock().unwrap();
                    let (train, val, t) = &mut *guard;
                    let Some(records) = g.records else {
                        t.discarded += 1;
                        continue;
                    };
                    t.games += 1;
                    t.plies += g.plies as u64;
                    t.results[g.result as usize] += 1;
                    *t.endings.entry(g.ending).or_default() += 1;
                    let (file, count) = if g.validation { (val, &mut t.val) } else { (train, &mut t.train) };
                    for r in &records {
                        file.write_all(&r.0).expect("write records");
                    }
                    *count += records.len() as u64;
                    let total = positions.fetch_add(records.len() as u64, Ordering::Relaxed) + records.len() as u64;
                    if t.games % 20 == 0 {
                        let secs = start.elapsed().as_secs_f64();
                        eprintln!(
                            "progress games {} positions {} seconds {:.0} positions_per_second {:.0}",
                            t.games, total, secs, total as f64 / secs
                        );
                    }
                }
            })
        })
        .collect();
    for w in workers {
        w.join().expect("worker panicked");
    }

    let mut guard = out.lock().unwrap();
    let (train, val, t) = &mut *guard;
    train.flush().expect("flush");
    val.flush().expect("flush");
    let secs = start.elapsed().as_secs_f64();
    let mut info = String::new();
    let mut kv = |k: &str, v: String| info.push_str(&format!("{k}: {v}\n"));
    kv("ruleset", RULESET.into());
    kv("evaluator", evaluator.into());
    kv("eval_file", eval_file.clone());
    kv("nodes", s.nodes.to_string());
    kv("random_plies", s.random_plies.to_string());
    kv("opening_limit", s.opening_limit.to_string());
    kv("max_plies", s.max_plies.to_string());
    kv("adjudicate", s.adjudicate.to_string());
    kv("adjudicate_plies", s.adjudicate_plies.to_string());
    kv("quiet_draw", s.quiet_draw.to_string());
    kv("record_quiet_limit", s.record_quiet_limit.to_string());
    kv("val_fraction", s.val_fraction.to_string());
    kv("seed", s.seed.to_string());
    kv("threads", threads.to_string());
    kv("games", t.games.to_string());
    kv("discarded_openings", t.discarded.to_string());
    kv(
        "average_plies",
        format!("{:.1}", t.plies as f64 / t.games.max(1) as f64),
    );
    let g = t.games.max(1) as f64;
    let [b, d, w] = t.results;
    kv(
        "results_white_view",
        format!(
            "white {w} ({:.1}%) draw {d} ({:.1}%) black {b} ({:.1}%)",
            100.0 * w as f64 / g,
            100.0 * d as f64 / g,
            100.0 * b as f64 / g
        ),
    );
    for (ending, n) in &t.endings {
        kv(
            &format!("ending {ending}"),
            format!("{n} ({:.1}%)", 100.0 * *n as f64 / g),
        );
    }
    kv("positions_train", t.train.to_string());
    kv("positions_val", t.val.to_string());
    kv("seconds", format!("{secs:.1}"));
    kv(
        "positions_per_second",
        format!("{:.0}", (t.train + t.val) as f64 / secs),
    );
    std::fs::write(format!("{prefix}.info.txt"), &info).expect("write info");
    print!("{info}");
}

// --- tools --------------------------------------------------------------------------------------

fn open(path: &str) -> RecordReader<std::io::BufReader<File>> {
    RecordReader::open(path).unwrap_or_else(|e| fail(format!("{path}: {e}")))
}

fn stats(args: &[String]) {
    let (rest, _) = parse(args, &[]);
    let [path] = rest.as_slice() else {
        fail("stats takes one file")
    };
    let (mut n, mut results, mut sides) = (0u64, [0u64; 3], [0u64; 2]);
    let (mut abs_score, mut drops, mut pawns_enemy_half) = (0f64, 0u64, 0u64);
    let mut keys = HashSet::new();
    for r in open(path) {
        let r = r.unwrap_or_else(|e| fail(e));
        n += 1;
        results[r.result() as usize] += 1;
        sides[r.side() as usize] += 1;
        abs_score += (r.score() as f64).abs();
        drops += (move_drop(r.best_move()) != 0) as u64;
        for sq in 0..36 {
            let code = r.piece_at(sq);
            if type_of(code) == PAWN && in_enemy_half(color_of(code), rank_of(sq as u8)) {
                pawns_enemy_half += 1;
            }
        }
        keys.insert(r.key());
    }
    let pct = |x: u64| 100.0 * x as f64 / n.max(1) as f64;
    println!("records: {n}");
    println!(
        "distinct positions: {} ({:.1}%)",
        keys.len(),
        pct(keys.len() as u64)
    );
    println!(
        "results (white view): white {:.1}% draw {:.1}% black {:.1}%",
        pct(results[2]),
        pct(results[1]),
        pct(results[0])
    );
    println!(
        "side to move: white {:.1}% black {:.1}%",
        pct(sides[0]),
        pct(sides[1])
    );
    println!("mean |score|: {:.0} cp", abs_score / n.max(1) as f64);
    println!("best move is a drop: {:.1}%", pct(drops));
    println!(
        "pawns in the enemy half per position: {:.2}",
        pawns_enemy_half as f64 / n.max(1) as f64
    );
}

fn dump(args: &[String]) {
    let (rest, o) = parse(args, &["n"]);
    let [path] = rest.as_slice() else {
        fail("dump takes one file")
    };
    let limit: usize = num(&o, "n", 20);
    for r in open(path).take(limit) {
        let r = r.unwrap_or_else(|e| fail(e));
        let result = match r.result() {
            GameResult::WhiteWon => "1-0",
            GameResult::Draw => "1/2",
            GameResult::BlackWon => "0-1",
        };
        println!(
            "{}  score {:>6}  result {result}  best {}",
            r.fen(),
            r.score(),
            Position::move_to_uci(r.best_move())
        );
    }
}

fn dedup(args: &[String]) {
    let (rest, o) = parse(args, &["exclude"]);
    if rest.len() < 2 {
        fail("dedup takes at least one input and an output");
    }
    let (inputs, output) = rest.split_at(rest.len() - 1);
    let mut seen = HashSet::new();
    let mut excluded = 0u64;
    if let Some(ex) = o.get("exclude") {
        for r in open(ex) {
            seen.insert(r.unwrap_or_else(|e| fail(e)).key());
        }
        excluded = seen.len() as u64;
    }
    let tmp = format!("{}.tmp", output[0]);
    let mut out = BufWriter::with_capacity(1 << 20, File::create(&tmp).unwrap_or_else(|e| fail(e)));
    let (mut read, mut kept) = (0u64, 0u64);
    for path in inputs {
        for r in open(path) {
            let r = r.unwrap_or_else(|e| fail(e));
            read += 1;
            if seen.insert(r.key()) {
                out.write_all(&r.0).expect("write");
                kept += 1;
            }
        }
    }
    out.flush().expect("flush");
    drop(out);
    std::fs::rename(&tmp, &output[0]).expect("rename");
    println!(
        "read {read}, kept {kept}, dropped {} (exclude list: {excluded} positions)",
        read - kept
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("run") => run(&args[1..]),
        Some("stats") => stats(&args[1..]),
        Some("dump") => dump(&args[1..]),
        Some("dedup") => dedup(&args[1..]),
        _ => fail("expected a subcommand"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quick() -> Settings {
        Settings {
            nodes: 400,
            max_plies: 160,
            ..Default::default()
        }
    }

    #[test]
    fn records_follow_the_filters() {
        let s = quick();
        let mut searcher = Searcher::new(HandEval);
        let mut checked = 0;
        for index in 0..6 {
            let g = play_game(&s, &mut searcher, index);
            for r in g.records.unwrap_or_default() {
                let mut pos = r.position().unwrap();
                assert!(!pos.checked(), "no positions in check");
                assert_eq!(pos.captured_by(r.best_move()), 0, "no capture as best move");
                assert!((r.score() as i32).abs() < MATE_BOUND, "no forced results");
                assert!(
                    pos.legal_moves().contains(&r.best_move()),
                    "best move is legal"
                );
                assert_eq!(r.result(), g.result);
                checked += 1;
            }
        }
        assert!(checked > 0);
    }

    #[test]
    fn same_seed_same_games() {
        let s = quick();
        let a = play_game(&s, &mut Searcher::new(HandEval), 3);
        let b = play_game(&s, &mut Searcher::new(HandEval), 3);
        assert_eq!(a.records, b.records);
        assert_eq!(a.plies, b.plies);
        let c = play_game(&Settings { seed: 2, ..s }, &mut Searcher::new(HandEval), 3);
        assert_ne!(a.records, c.records);
    }

    #[test]
    fn quiet_ply_rules() {
        let s = Settings {
            quiet_draw: 30,
            record_quiet_limit: 10,
            ..quick()
        };
        let mut searcher = Searcher::new(HandEval);
        for index in 0..4 {
            let g = play_game(&s, &mut searcher, index);
            if g.ending == "quiet plies" {
                assert_eq!(g.result, GameResult::Draw);
            }
            assert!(g.plies <= s.max_plies + 1);
        }
    }
}
