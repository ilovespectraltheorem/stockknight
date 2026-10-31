//! sk-tb: build, check and probe endgame tablebases. See docs/TABLEBASES.md.

use std::path::PathBuf;
use std::time::Instant;

use sk_core::Position;
use sk_tb::index::Layout;
use sk_tb::solve::{check, solve, stats};
use sk_tb::{all_sigs, brute, canonical_sigs, decode_value, Sig, Tables};

const USAGE: &str = "usage:
  sk-tb census [--max N]                       table sizes by piece count (default 6)
  sk-tb gen --dir D [--max N] [--threads T]    solve and save missing tables (default max 4)
  sk-tb check --dir D [--max N | SIG...]       check every stored value against its successors
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

fn open(a: &Args) -> Tables {
    Tables::in_dir(&dir(a))
}

/// A table and every table its moves lead to, loaded; everything else dropped.
fn with_successors(tables: &mut Tables, s: Sig) {
    let mut need = s.successors();
    need.push(s);
    tables.keep_only(&need);
    tables.ensure(&need).unwrap_or_else(|e| die(&e));
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = argv.first() else { die(USAGE) };
    let a = parse(&argv[1..]);
    match cmd.as_str() {
        "census" => {
            let max = a.max.unwrap_or(6);
            println!(
                "pieces  signatures  stored tables  index entries  stored entries  largest table"
            );
            for k in 2..=max {
                let sigs: Vec<Sig> = all_sigs(k)
                    .into_iter()
                    .filter(|s| s.pieces() == k)
                    .collect();
                let stored: Vec<Sig> = canonical_sigs(k)
                    .into_iter()
                    .filter(|s| s.pieces() == k)
                    .collect();
                let size = |v: &[Sig]| v.iter().map(|&s| Layout::new(s).size).sum::<u64>();
                let big = sigs.iter().max_by_key(|&&s| Layout::new(s).size).unwrap();
                println!(
                    "{k:>6}  {:>10}  {:>13}  {:>13}  {:>14}  {} ({})",
                    sigs.len(),
                    stored.len(),
                    size(&sigs),
                    size(&stored),
                    big.name(),
                    Layout::new(*big).size
                );
            }
        }
        "gen" => {
            let d = dir(&a);
            std::fs::create_dir_all(&d).unwrap_or_else(|e| die(&e.to_string()));
            let mut tables = open(&a);
            let start = Instant::now();
            let todo: Vec<Sig> = canonical_sigs(a.max.unwrap_or(4))
                .into_iter()
                .filter(|s| !tables.has_file(s))
                .collect();
            println!("{} tables to solve", todo.len());
            for (i, s) in todo.iter().enumerate() {
                let t0 = Instant::now();
                tables.keep_only(&s.successors());
                tables.ensure(&s.successors()).unwrap_or_else(|e| die(&e));
                let t = solve(*s, &tables, a.threads);
                t.save(&d).unwrap_or_else(|e| die(&e.to_string()));
                let st = stats(&t);
                println!(
                    "[{}/{}] {:<16} {:>10} positions  win {:>9}  draw {:>9}  loss {:>9}  longest {:>3}  {:.1}s",
                    i + 1,
                    todo.len(),
                    s.name(),
                    st.valid,
                    st.wins,
                    st.draws,
                    st.losses,
                    st.longest,
                    t0.elapsed().as_secs_f64()
                );
                tables.insert(t);
            }
            println!("done in {:.1}s", start.elapsed().as_secs_f64());
        }
        "check" => {
            let mut tables = open(&a);
            let mut total = 0;
            let sigs: Vec<Sig> = if a.rest.is_empty() {
                canonical_sigs(a.max.unwrap_or(4))
            } else {
                a.rest
                    .iter()
                    .map(|x| Sig::parse(x).unwrap_or_else(|e| die(&e)).canonical().0)
                    .collect()
            };
            for s in sigs {
                with_successors(&mut tables, s);
                match check(&tables.map[&s], &tables, a.threads) {
                    Ok(n) => total += n,
                    Err(e) => die(&e),
                }
            }
            println!("checked {total} positions: every value follows from its successors");
        }
        "brute" => {
            let mut tables = open(&a);
            let sigs: Vec<Sig> = if a.rest.is_empty() {
                all_sigs(a.max.unwrap_or(3))
            } else {
                a.rest
                    .iter()
                    .map(|x| Sig::parse(x).unwrap_or_else(|e| die(&e)))
                    .collect()
            };
            tables.ensure(&sigs).unwrap_or_else(|e| die(&e));
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
            let mut tables = open(&a);
            for s in canonical_sigs(a.max.unwrap_or(4)) {
                if !tables.has_file(&s) {
                    continue;
                }
                tables.keep_only(&[]);
                tables.ensure(&[s]).unwrap_or_else(|e| die(&e));
                let st = stats(&tables.map[&s]);
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
        "probe" => {
            let fen = a.rest.join(" ");
            let mut pos = Position::from_fen(&fen).unwrap_or_else(|e| die(&e));
            let mut tables = open(&a);
            let sig = Sig::of(&pos);
            with_successors(&mut tables, sig);
            let v = tables.probe(&pos).unwrap();
            println!("{}: {}", sig.name(), show(v));
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
