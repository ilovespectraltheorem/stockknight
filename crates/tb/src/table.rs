//! Tables, their values and the `.sktb` file format.
//!
//! A value is the distance to the end of the game in plies with best play, stored as
//! `distance + 1`: an odd distance means the side to move wins, an even one that it loses
//! (0 = no legal move now). 0 means a draw and `INVALID` an index that is not a legal position.
//!
//! File: `SKTB`, u32 format, the ruleset id and the signature name (each u16 length + bytes),
//! u64 entry count, then the values as u16 little endian.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;

use sk_core::{Position, RULESET};

use crate::index::Layout;
use crate::sig::Sig;

pub const DRAW: u16 = 0;
pub const INVALID: u16 = u16::MAX;
pub const FORMAT: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wdl {
    Loss,
    Draw,
    Win,
}

/// Result for the side to move and distance in plies (None for a draw), or None if invalid.
pub fn decode_value(v: u16) -> Option<(Wdl, Option<u32>)> {
    match v {
        INVALID => None,
        DRAW => Some((Wdl::Draw, None)),
        _ => {
            let d = v as u32 - 1;
            Some((if d % 2 == 1 { Wdl::Win } else { Wdl::Loss }, Some(d)))
        }
    }
}

pub struct Table {
    pub layout: Layout,
    pub data: Vec<u16>,
}

impl Table {
    pub fn sig(&self) -> Sig {
        self.layout.sig
    }

    pub fn get(&self, board: &[u8; 36], side: u8) -> u16 {
        self.data[self.layout.index(board, side) as usize]
    }

    pub fn file_name(sig: &Sig) -> String {
        format!("{}.sktb", sig.name())
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        let path = dir.join(Self::file_name(&self.sig()));
        let tmp = path.with_extension("sktb.tmp");
        let mut out = Vec::with_capacity(self.data.len() * 2 + 64);
        out.extend_from_slice(b"SKTB");
        out.extend_from_slice(&FORMAT.to_le_bytes());
        for s in [RULESET, &self.sig().name()] {
            out.extend_from_slice(&(s.len() as u16).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        }
        out.extend_from_slice(&(self.data.len() as u64).to_le_bytes());
        for v in &self.data {
            out.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::File::create(&tmp)?.write_all(&out)?;
        std::fs::rename(tmp, path)
    }

    pub fn load(dir: &Path, sig: Sig) -> Result<Table, String> {
        let path = dir.join(Self::file_name(&sig));
        let mut bytes = Vec::new();
        std::fs::File::open(&path)
            .and_then(|mut f| f.read_to_end(&mut bytes))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let bad = |what: &str| format!("{}: {what}", path.display());
        let mut at = 0usize;
        let mut take = |n: usize| -> Result<&[u8], String> {
            let s = bytes.get(at..at + n).ok_or_else(|| bad("truncated"))?;
            at += n;
            Ok(s)
        };
        if take(4)? != b"SKTB" {
            return Err(bad("not a tablebase file"));
        }
        if u32::from_le_bytes(take(4)?.try_into().unwrap()) != FORMAT {
            return Err(bad("unknown format"));
        }
        let mut text = || -> Result<String, String> {
            let n = u16::from_le_bytes(take(2)?.try_into().unwrap()) as usize;
            Ok(String::from_utf8_lossy(take(n)?).into_owned())
        };
        let (ruleset, name) = (text()?, text()?);
        if ruleset != RULESET {
            return Err(bad(&format!(
                "made for ruleset {ruleset}, this is {RULESET}"
            )));
        }
        if name != sig.name() {
            return Err(bad(&format!("holds {name}")));
        }
        let layout = Layout::new(sig);
        let n = u64::from_le_bytes(take(8)?.try_into().unwrap());
        if n != layout.size {
            return Err(bad("wrong size"));
        }
        let raw = take(n as usize * 2)?;
        let data = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Ok(Table { layout, data })
    }
}

/// A set of solved tables.
#[derive(Default)]
pub struct Tables {
    pub map: HashMap<Sig, Table>,
}

impl Tables {
    pub fn load_dir(dir: &Path, sigs: &[Sig]) -> Result<Tables, String> {
        let mut t = Tables::default();
        for &s in sigs {
            if dir.join(Table::file_name(&s)).exists() {
                t.map.insert(s, Table::load(dir, s)?);
            }
        }
        Ok(t)
    }

    pub fn max_pieces(&self) -> u32 {
        self.map.keys().map(|s| s.pieces()).max().unwrap_or(0)
    }

    /// Value of a position, or None when its table is not loaded.
    pub fn probe(&self, pos: &Position) -> Option<u16> {
        let t = self.map.get(&Sig::of(pos))?;
        Some(t.get(&pos.board, pos.side))
    }
}
