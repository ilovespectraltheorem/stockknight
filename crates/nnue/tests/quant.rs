//! Quantized inference: incremental accumulators equal ones computed from scratch, the AVX2
//! and VNNI kernels equal the portable ones, and quantized values stay close to float.

use sk_core::*;
use sk_eval::Evaluator;
use sk_nnue::{
    active_features, simd_available, vnni_available, Network, NnueEval, NnueMode, QuantEval,
    QuantNet,
};
use sk_search::{Limits, Searcher};

fn net() -> Network {
    Network::random(256, 32, 32, 3)
}

fn scratch(q: &QuantNet, pos: &Position) -> Vec<i16> {
    let mut acc = q.accumulate(&active_features(pos, WHITE));
    acc.extend(q.accumulate(&active_features(pos, BLACK)));
    acc
}

struct Rng(u32);
impl Rng {
    fn next(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_mul(1103515245).wrapping_add(12345);
        (self.0 >> 8) as usize % n
    }
}

/// A random walk that goes forward and takes moves back, evaluating at random, the way a search
/// does, and checks every evaluated accumulator against one computed from scratch.
#[test]
fn incremental_equals_scratch() {
    let q = QuantNet::from_network(&net()).unwrap();
    let mut e = QuantEval::new(q.clone());
    let mut rng = Rng(11);
    let mut checked = 0;
    let mut king_moves = 0;
    for _game in 0..40 {
        let mut pos = Position::startpos();
        e.set_root(&pos);
        let mut depth = 0;
        for _step in 0..600 {
            let moves = pos.legal_moves();
            let back = depth > 0 && (moves.is_empty() || rng.next(3) == 0);
            if back {
                pos.unmake_move();
                e.pop();
                depth -= 1;
            } else if !moves.is_empty() && pos.game_ply() < 200 {
                let m = moves[rng.next(moves.len())];
                king_moves += (type_of(pos.board[move_from(m) as usize]) == KING
                    && move_drop(m) == 0) as usize;
                e.push(&pos, m);
                pos.make_move(m);
                depth += 1;
            }
            if rng.next(2) == 0 {
                assert_eq!(
                    e.accumulators(&pos),
                    &scratch(&q, &pos)[..],
                    "{}",
                    pos.to_fen()
                );
                checked += 1;
            }
        }
    }
    assert!(
        checked > 5000 && king_moves > 500,
        "{checked} checks, {king_moves} king moves"
    );
}

#[test]
fn avx2_equals_portable() {
    if !simd_available() {
        eprintln!("no AVX2 on this CPU; nothing to compare");
        return;
    }
    let mut fast = QuantNet::from_network(&net()).unwrap();
    fast.simd = true;
    fast.vnni = false;
    let mut slow = fast.clone();
    slow.simd = false;
    let mut vnni = fast.clone();
    vnni.vnni = vnni_available();
    let mut rng = Rng(5);
    let mut pos = Position::startpos();
    for _ in 0..3000 {
        let moves = pos.legal_moves();
        if moves.is_empty() || pos.game_ply() > 150 {
            pos = Position::startpos();
            continue;
        }
        pos.make_move(moves[rng.next(moves.len())]);
        let (a, b) = (scratch(&fast, &pos), scratch(&slow, &pos));
        assert_eq!(a, b);
        let ft = fast.ft;
        let out = slow.propagate(&a[..ft], &a[ft..]);
        assert_eq!(fast.propagate(&a[..ft], &a[ft..]), out);
        assert_eq!(vnni.propagate(&a[..ft], &a[ft..]), out);
    }
}

#[test]
fn quantized_close_to_float() {
    let n = net();
    let mut e = QuantEval::new(QuantNet::from_network(&n).unwrap());
    let mut rng = Rng(9);
    let mut pos = Position::startpos();
    let (mut sum, mut max, mut count) = (0i64, 0, 0);
    for _ in 0..3000 {
        let moves = pos.legal_moves();
        if moves.is_empty() || pos.game_ply() > 150 {
            pos = Position::startpos();
            continue;
        }
        pos.make_move(moves[rng.next(moves.len())]);
        let d = (e.evaluate_pos(&pos) - n.evaluate_cp(&pos)).abs();
        sum += d as i64;
        max = max.max(d);
        count += 1;
    }
    let mean = sum as f64 / count as f64;
    assert!(mean < 4.0 && max < 40, "mean {mean:.2} cp, max {max} cp");
}

/// Recomputes the quantized network from scratch at every evaluation.
struct Scratch(QuantNet);
impl Evaluator for Scratch {
    fn evaluate(&mut self, pos: &Position) -> i32 {
        let acc = scratch(&self.0, pos);
        let ft = self.0.ft;
        let (w, b) = acc.split_at(ft);
        if pos.side == WHITE {
            self.0.evaluate_cp(w, b)
        } else {
            self.0.evaluate_cp(b, w)
        }
    }
    fn name(&self) -> &'static str {
        "scratch"
    }
}

/// The search sees the same values whether the accumulators are incremental or not, and with
/// or without AVX2: same nodes, same best move, same score.
#[test]
fn search_is_identical() {
    let fens = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/bench-positions.txt"
    ))
    .unwrap();
    let limits = Limits {
        depth: Some(5),
        ..Limits::default()
    };
    let mut scratch_s = Searcher::new(Scratch(QuantNet::from_network(&net()).unwrap()));
    let mut fast = Searcher::new(NnueEval::new(net()).unwrap());
    let mut portable = Searcher::new(NnueEval::new(net()).unwrap());
    portable.eval.set_mode(NnueMode::Portable);
    let mut avx2 = Searcher::new(NnueEval::new(net()).unwrap());
    avx2.eval.set_mode(NnueMode::Avx2);
    for fen in fens.lines().filter(|l| !l.trim().is_empty()).take(6) {
        let mut results = Vec::new();
        for s in [0, 1, 2, 3] {
            let mut pos = Position::from_fen(fen.trim()).unwrap();
            let r = match s {
                0 => scratch_s.think(&mut pos, limits, |_| {}),
                1 => fast.think(&mut pos, limits, |_| {}),
                2 => portable.think(&mut pos, limits, |_| {}),
                _ => avx2.think(&mut pos, limits, |_| {}),
            };
            results.push((r.best, r.score, r.nodes));
        }
        assert_eq!(results[0], results[1], "{fen}");
        assert_eq!(results[0], results[2], "{fen}");
        assert_eq!(results[0], results[3], "{fen}");
    }
}
