//! The search reproduces the reference engine: same best move, score and node count on every
//! bench position at depth 6 (`node reference/bench.js 6 > testdata/bench-js-depth6.txt`).

use sk_core::Position;
use sk_eval::HandEval;
use sk_search::{Limits, Searcher};

#[test]
fn bench_matches_javascript() {
    let data = include_str!("../../../testdata/bench-js-depth6.txt");
    let mut checked = 0;
    for line in data.lines().filter(|l| !l.starts_with("depth")) {
        let f: Vec<&str> = line.split_whitespace().collect();
        let fen = f[3..].join(" ");
        let mut pos = Position::from_fen(&fen).unwrap();
        let r = Searcher::new(HandEval).think(
            &mut pos,
            Limits {
                depth: Some(6),
                ..Default::default()
            },
            |_| {},
        );
        assert_eq!(Position::move_to_uci(r.best), f[0], "{fen}");
        assert_eq!(r.score.to_string(), f[1], "{fen}");
        assert_eq!(r.nodes.to_string(), f[2], "{fen}");
        checked += 1;
    }
    assert_eq!(checked, 12);
}

#[test]
fn node_limit_stops_exactly() {
    let mut pos = Position::startpos();
    let r = Searcher::new(HandEval).think(
        &mut pos,
        Limits {
            nodes: Some(5000),
            ..Default::default()
        },
        |_| {},
    );
    assert!(r.best != 0);
    assert!(r.nodes <= 5000, "{}", r.nodes);
}

#[test]
fn finds_forced_win() {
    let mut pos = Position::from_fen("k5/2Q3/6/1N4/6/5K[R] w 0 1").unwrap();
    let r = Searcher::new(HandEval).think(
        &mut pos,
        Limits {
            depth: Some(4),
            ..Default::default()
        },
        |_| {},
    );
    assert_eq!(r.score, sk_search::MATE - 1);
    assert_eq!(sk_search::mate_in(r.score), 1);
}
