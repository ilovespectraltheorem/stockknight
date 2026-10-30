//! Solve every table up to 3 pieces and check it two independent ways.

use sk_core::Position;
use sk_tb::solve::{check, solve};
use sk_tb::{all_sigs, brute, decode_value, Tables, Wdl};

fn solved(max: u32) -> Tables {
    let mut t = Tables::default();
    for s in all_sigs(max) {
        let table = solve(s, &t, 2);
        t.map.insert(s, table);
    }
    t
}

#[test]
fn three_pieces_agree_with_brute_force() {
    let t = solved(3);
    let sigs: Vec<_> = all_sigs(3);
    let (n, bad) = brute::compare(&sigs, &t, &|_| {});
    assert!(bad.is_empty(), "{bad:#?}");
    assert!(n > 700_000);
    for s in &sigs {
        check(&t.map[s], &t, 2).unwrap();
    }
}

#[test]
fn known_positions() {
    let t = solved(3);
    let probe =
        |fen: &str| decode_value(t.probe(&Position::from_fen(fen).unwrap()).unwrap()).unwrap();
    // Bare kings are a draw.
    assert_eq!(probe("k5/6/6/6/6/5K[-] w 0 1"), (Wdl::Draw, None));
    // Stalemate loses: the knight on c3 takes b1 and a2 from the king on a1, and no move at all means a loss.
    assert_eq!(probe("6/6/6/2N3/1K4/k5[-] b 0 1").0, Wdl::Loss);
    assert_eq!(probe("6/6/6/2N3/1K4/k5[-] b 0 1").1, Some(0));
}

#[test]
fn table_files_round_trip() {
    let t = solved(3);
    let dir = std::env::temp_dir().join(format!("sk-tb-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for table in t.map.values() {
        table.save(&dir).unwrap();
    }
    let back = Tables::load_dir(&dir, &all_sigs(3)).unwrap();
    for (s, table) in &t.map {
        assert_eq!(back.map[s].data, table.data, "{}", s.name());
    }
    for s in all_sigs(3) {
        std::fs::remove_file(dir.join(sk_tb::Table::file_name(&s))).unwrap();
    }
    std::fs::remove_dir(&dir).unwrap();
}
