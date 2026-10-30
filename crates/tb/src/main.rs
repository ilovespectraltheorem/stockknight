//! sk-tb: build, check and probe endgame tablebases. See docs/TABLEBASES.md.

use std::path::{Path, PathBuf};
use std::time::Instant;

use sk_core::Position;
use sk_tb::index::Layout;
use sk_tb::solve::{check, solve, stats};
use sk_tb::{all_sigs, brute, decode_value, Sig, Tables};

const USAGE: &str = "usage:
  sk-tb census [--max N]                       table sizes by piece count (default 6)
  sk-tb gen --dir D [--max N] [--threads T]    solve and save missing tables (default max 4)
  sk-tb check --dir D [--max N] [--threads T]  check every stored value against its successors
  sk-tb brute --dir D [--max N | SIG...]       compare with an independent brute-force solver
  sk-tb stats --dir D [--max N]                wins, draws, losses and longest distance per table
  sk-tb probe --dir D FEN                      result and every move's value";

struct Args {
    dir: Option<PathBuf>,
    max: Option<u32>,
    threads: usize,
    rest: Vec<String>,
}

fn parse(args: &[String]) -> Args {
    let mut a = Args {
        dir: None,
        max: None,
        threads: 1,
        rest: Vec::new(),
    };
    let mut it = args.iter();
    while let Some(x) = it.next() {
        let mut val = || {
            it.next()
                .cloned()
                .unwrap_or_else(|| die(&format!("{x} needs a value")))
        };
        match x.as_str() {
            "--dir" => a.dir = Some(PathBuf::from(val())),
            "--max" => {
                a.max = Some(
                    val()
                        .parse()
                        .unwrap_or_else(|_| die("--max takes a number")),
                )
            }
            "--threads" => {
                a.threads = val()
                    .parse()
                    .unwrap_or_else(|_| die("--threads takes a number"))
            }
            _ => a.rest.push(x.clone()),
        }
    }
    a
}

fn die(msg: &str) -> ! {
    eprintln!("sk-tb: {msg}");
    std::process::exit(2)
}

fn dir(a: &Args) -> PathBuf {
    a.dir.clone().unwrap_or_else(|| die("--dir is required"))
}

fn show(v: u16) -> String {
    match decode_value(v) {
        None => "invalid".into(),
        Some((w, None)) => format!("{w:?}").to_lowercase(),
        Some((w, Some(d))) => format!("{} in {d}", format!("{w:?}").to_lowercase()),
    }
}

fn load_all(d: &Path, max: u32) -> (Vec<Sig>, Tables) {
    let sigs = all_sigs(max);
    let t = Tables::load_dir(d, &sigs).unwrap_or_else(|e| die(&e));
    (sigs, t)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = argv.first() else { die(USAGE) };
    let a = parse(&argv[1..]);
    match cmd.as_str() {
        "census" => {
            let max = a.max.unwrap_or(6);
            println!("pieces  signatures  index entries  largest table");
            for k in 2..=max {
                let sigs: Vec<Sig> = all_sigs(k)
                    .into_iter()
                    .filter(|s| s.pieces() == k)
                    .collect();
                let sizes: Vec<u64> = sigs.iter().map(|&s| Layout::new(s).size).collect();
                let big = sigs.iter().zip(&sizes).max_by_key(|x| x.1).unwrap();
                println!(
                    "{k:>6}  {:>10}  {:>13}  {} ({})",
                    sigs.len(),
                    sizes.iter().sum::<u64>(),
                    big.0.name(),
                    big.1
                );
            }
        }
        "gen" => {
            let d = dir(&a);
            std::fs::create_dir_all(&d).unwrap_or_else(|e| die(&e.to_string()));
            let (sigs, mut tables) = load_all(&d, a.max.unwrap_or(4));
            let start = Instant::now();
            for s in sigs {
                if tables.map.contains_key(&s) {
                    continue;
                }
                let t0 = Instant::now();
                let t = solve(s, &tables, a.threads);
                t.save(&d).unwrap_or_else(|e| die(&e.to_string()));
                let st = stats(&t);
                println!(
                    "{:<16} {:>10} positions  win {:>9}  draw {:>9}  loss {:>9}  longest {:>3}  {:.1}s",
                    s.name(),
                    st.valid,
                    st.wins,
                    st.draws,
                    st.losses,
                    st.longest,
                    t0.elapsed().as_secs_f64()
                );
                tables.map.insert(s, t);
            }
            println!("done in {:.1}s", start.elapsed().as_secs_f64());
        }
        "check" => {
            let (sigs, tables) = load_all(&dir(&a), a.max.unwrap_or(4));
            let mut total = 0;
            for s in sigs {
                let Some(t) = tables.map.get(&s) else {
                    die(&format!("{} is missing", s.name()))
                };
                match check(t, &tables, a.threads) {
                    Ok(n) => total += n,
                    Err(e) => die(&e),
                }
            }
            println!("checked {total} positions: every value follows from its successors");
        }
        "brute" => {
            let (all, tables) = load_all(&dir(&a), 6);
            let sigs: Vec<Sig> = if a.rest.is_empty() {
                let max = a.max.unwrap_or(3);
                all.into_iter().filter(|s| s.pieces() <= max).collect()
            } else {
                a.rest
                    .iter()
                    .map(|x| Sig::parse(x).unwrap_or_else(|e| die(&e)))
                    .collect()
            };
            let (n, bad) = brute::compare(&sigs, &tables, &|m| eprintln!("{m}"));
            if bad.is_empty() {
                println!(
                    "{n} positions in {} tables agree with the brute-force solver",
                    sigs.len()
                );
            } else {
                for b in &bad {
                    println!("{b}");
                }
                die("tables disagree with the brute-force solver");
            }
        }
        "stats" => {
            let (sigs, tables) = load_all(&dir(&a), a.max.unwrap_or(4));
            for s in sigs {
                if let Some(t) = tables.map.get(&s) {
                    let st = stats(t);
                    println!(
                        "{:<16} {:>10}  win {:>6.2}%  draw {:>6.2}%  loss {:>6.2}%  longest {}",
                        s.name(),
                        st.valid,
                        100.0 * st.wins as f64 / st.valid as f64,
                        100.0 * st.draws as f64 / st.valid as f64,
                        100.0 * st.losses as f64 / st.valid as f64,
                        st.longest
                    );
                }
            }
        }
        "probe" => {
            let fen = a.rest.join(" ");
            let mut pos = Position::from_fen(&fen).unwrap_or_else(|e| die(&e));
            let (_, tables) = load_all(&dir(&a), 6);
            let Some(v) = tables.probe(&pos) else {
                die(&format!("no table for {}", Sig::of(&pos).name()))
            };
            println!("{}: {}", Sig::of(&pos).name(), show(v));
            for m in pos.legal_moves() {
                let text = pos.move_to_text(m);
                pos.make_move(m);
                let cv = tables
                    .probe(&pos)
                    .map(show)
                    .unwrap_or_else(|| "no table".into());
                pos.unmake_move();
                println!("  {text:<8} opponent {cv}");
            }
        }
        _ => die(USAGE),
    }
}
