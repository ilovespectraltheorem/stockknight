//! Rust = JS on 10,000 random positions: legal moves in generation order, status, check,
//! perft(2), G0 value and Zobrist key, all exact (data from `node reference/gen-diff.js`).

use sk_core::Position;
use sk_eval::hand_eval;

#[test]
fn matches_javascript_engine() {
    let data = include_str!("../../../testdata/diff-positions.txt");
    let mut checked = 0;
    for (line_no, line) in data.lines().enumerate() {
        let f: Vec<&str> = line.split('\t').collect();
        assert_eq!(f.len(), 7, "line {}", line_no + 1);
        let mut pos =
            Position::from_fen(f[0]).unwrap_or_else(|e| panic!("line {}: {e}", line_no + 1));
        assert_eq!(pos.to_fen(), f[0], "FEN round trip, line {}", line_no + 1);
        let legal: Vec<String> = pos
            .legal_moves()
            .into_iter()
            .map(Position::move_to_uci)
            .collect();
        assert_eq!(legal.join(" "), f[1], "legal moves, {}", f[0]);
        assert_eq!(pos.outcome().code(), f[2], "status, {}", f[0]);
        assert_eq!(
            pos.checked() as u8,
            f[3].parse::<u8>().unwrap(),
            "check, {}",
            f[0]
        );
        assert_eq!(
            pos.perft(2),
            f[4].parse::<u64>().unwrap(),
            "perft(2), {}",
            f[0]
        );
        assert_eq!(
            hand_eval(&pos),
            f[5].parse::<i32>().unwrap(),
            "G0, {}",
            f[0]
        );
        assert_eq!(format!("{:016x}", pos.key()), f[6], "hash, {}", f[0]);
        checked += 1;
    }
    assert_eq!(checked, 10_000);
}
