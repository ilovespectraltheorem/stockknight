//! `sk-nnue`: network tools.
//!
//! ```text
//! sk-nnue info <net>
//! sk-nnue random <out> [--ft 256] [--l1 32] [--l2 32] [--seed 1]
//! sk-nnue features <fen>
//! sk-nnue eval <net> <records> [--n N]      raw outputs, one per line (side to move's view)
//! sk-nnue g0 <records> <out>                G0 values as little-endian i32, one per record
//! ```

use std::io::Write;

use sk_data::RecordReader;
use sk_eval::hand_eval;
use sk_nnue::{active_features, Network};

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("sk-nnue: {msg}");
    std::process::exit(2);
}

fn opt(args: &[String], key: &str, default: usize) -> usize {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .map_or(default, |v| {
            v.parse()
                .unwrap_or_else(|_| fail(format!("{key}: bad value {v}")))
        })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| {
        args.get(i)
            .cloned()
            .unwrap_or_else(|| fail("missing argument"))
    };
    match args.first().map(String::as_str) {
        Some("info") => {
            let net = Network::load(&arg(1)).unwrap_or_else(|e| fail(e));
            println!(
                "inputs {} ft {} l1 {} l2 {} output_scale {}",
                net.inputs, net.ft, net.l1, net.l2, net.output_scale
            );
            println!("description {}", net.description);
        }
        Some("random") => {
            let net = Network::random(
                opt(&args, "--ft", 256),
                opt(&args, "--l1", 32),
                opt(&args, "--l2", 32),
                opt(&args, "--seed", 1) as u64,
            );
            net.save(&arg(1)).unwrap_or_else(|e| fail(e));
        }
        Some("features") => {
            let pos = sk_core::Position::from_fen(&args[1..].join(" ")).unwrap_or_else(|e| fail(e));
            for p in [pos.side, pos.side ^ 1] {
                println!("{:?}", active_features(&pos, p));
            }
        }
        Some("eval") => {
            let net = Network::load(&arg(1)).unwrap_or_else(|e| fail(e));
            let n = opt(&args, "--n", usize::MAX);
            let mut out = std::io::BufWriter::new(std::io::stdout().lock());
            for r in RecordReader::open(arg(2))
                .unwrap_or_else(|e| fail(e))
                .take(n)
            {
                let pos = r
                    .unwrap_or_else(|e| fail(e))
                    .position()
                    .unwrap_or_else(|e| fail(e));
                writeln!(out, "{:.7}", net.forward(&pos)).unwrap();
            }
        }
        Some("g0") => {
            let mut out =
                std::io::BufWriter::new(std::fs::File::create(arg(2)).unwrap_or_else(|e| fail(e)));
            for r in RecordReader::open(arg(1)).unwrap_or_else(|e| fail(e)) {
                let pos = r
                    .unwrap_or_else(|e| fail(e))
                    .position()
                    .unwrap_or_else(|e| fail(e));
                out.write_all(&hand_eval(&pos).to_le_bytes()).unwrap();
            }
        }
        _ => fail("usage: sk-nnue info|random|features|eval|g0 ..."),
    }
}
