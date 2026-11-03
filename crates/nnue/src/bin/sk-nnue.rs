//! `sk-nnue`: network tools.
//!
//! ```text
//! sk-nnue info <net>
//! sk-nnue random <out> [--ft 256] [--l1 32] [--l2 32] [--seed 1]
//! sk-nnue features <fen>
//! sk-nnue eval <net> <records> [--n N]      raw outputs, one per line (side to move's view)
//! sk-nnue g0 <records> <out>                G0 values as little-endian i32, one per record
//! sk-nnue quant <net> <records> [--n N]     quantization shifts and error against float
//! sk-nnue speed <net>                       time the kernels (VNNI, AVX2 and portable)
//! ```

use std::io::Write;

use sk_data::RecordReader;
use sk_eval::hand_eval;
use sk_nnue::{active_features, Network, QuantEval, QuantNet};

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
        Some("quant") => {
            let net = Network::load(&arg(1)).unwrap_or_else(|e| fail(e));
            let q = QuantNet::from_network(&net).unwrap_or_else(|e| fail(e));
            println!(
                "shifts: ft {} l1 {} l2 {} out {}  (avx2 {})",
                q.ft_shift, q.l1_shift, q.l2_shift, q.out_shift, q.simd
            );
            let mut eval = QuantEval::new(q);
            let n = opt(&args, "--n", 100_000);
            let (mut count, mut sum, mut max, mut over10) = (0usize, 0i64, 0i32, 0usize);
            let (mut active, mut groups) = (0usize, 0usize);
            for r in RecordReader::open(arg(2))
                .unwrap_or_else(|e| fail(e))
                .take(n)
            {
                let pos = r
                    .unwrap_or_else(|e| fail(e))
                    .position()
                    .unwrap_or_else(|e| fail(e));
                let shift = eval.net.ft_shift;
                let acts: Vec<bool> = eval
                    .accumulators(&pos)
                    .iter()
                    .map(|&a| a >> shift > 0)
                    .collect();
                active += acts.iter().filter(|&&a| a).count();
                groups += acts.chunks(4).filter(|g| g.iter().any(|&a| a)).count();
                let d = (eval.evaluate_pos(&pos) - net.evaluate_cp(&pos)).abs();
                count += 1;
                sum += d as i64;
                max = max.max(d);
                over10 += (d > 10) as usize;
            }
            println!(
                "{count} positions: mean |quantized - float| {:.2} cp, max {max} cp, over 10 cp {:.2}%",
                sum as f64 / count.max(1) as f64,
                100.0 * over10 as f64 / count.max(1) as f64
            );
            let width = 2 * eval.net.ft * count.max(1);
            println!(
                "first-layer inputs non-zero: {:.1}%, groups of 4 with a non-zero: {:.1}%",
                100.0 * active as f64 / width as f64,
                400.0 * groups as f64 / width as f64
            );
        }
        Some("speed") => {
            let net = Network::load(&arg(1)).unwrap_or_else(|e| fail(e));
            let mut q = QuantNet::from_network(&net).unwrap_or_else(|e| fail(e));
            let pos = sk_core::Position::startpos();
            let mut acc = q.accumulate(&active_features(&pos, 0));
            acc.extend(q.accumulate(&active_features(&pos, 1)));
            let ft = q.ft;
            for (simd, vnni) in [(true, true), (true, false), (false, false)] {
                if simd && !sk_nnue::simd_available() || vnni && !sk_nnue::vnni_available() {
                    continue;
                }
                q.simd = simd;
                q.vnni = vnni;
                let n = 2_000_000u32;
                let t = std::time::Instant::now();
                let mut x = 0i64;
                for i in 0..n {
                    acc[(i % 7) as usize] ^= 1;
                    x += q.propagate(&acc[..ft], &acc[ft..]) as i64;
                }
                let prop = t.elapsed().as_nanos() as f64 / n as f64;
                let t = std::time::Instant::now();
                let mut dst = vec![0i16; ft];
                for i in 0..n {
                    let f = (i as usize * 31) % 14000;
                    q.update(&mut dst, &acc[..ft], &[f, f + 1], &[f + 2]);
                    x += dst[3] as i64;
                }
                let upd = t.elapsed().as_nanos() as f64 / n as f64;
                println!(
                    "{}: propagate {prop:.0} ns, update (2 on, 1 off) {upd:.0} ns  [{x}]",
                    match (simd, vnni) {
                        (true, true) => "avx2+vnni",
                        (true, false) => "avx2",
                        _ => "portable",
                    }
                );
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
