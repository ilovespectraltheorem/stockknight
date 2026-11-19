//! `Network` (float weights), the `.nnue` file and the reference forward pass.
//!
//! File layout, all little-endian:
//!
//! | Field | Type |
//! |---|---|
//! | magic `SKNN` | 4 bytes |
//! | version (1 or 2) | u32 |
//! | inputs, ft, l1, l2 | 4 × u32 |
//! | buckets (version 2 only) | u32 |
//! | output scale | f32 |
//! | description length, description (UTF-8; holds the ruleset id) | u32, bytes |
//! | ft weights `[inputs][ft]`, ft bias `[ft]` | f32 |
//! | psqt weights `[inputs][buckets]` (version 2 only) | f32 |
//! | per bucket: l1 weights `[l1][2·ft]`, l1 bias; l2 weights `[l2][l1]`, l2 bias; out weights `[l2]`, out bias | f32 |
//!
//! Hidden layers are stored `[out][in]`, as in PyTorch. Version 1 is a single bucket without
//! psqt weights.
//!
//! The output for a position in bucket `b` (`features::bucket`) is the bucket's layer stack
//! plus half the difference of the two perspectives' psqt sums for `b`: a direct material and
//! placement term, as in Stockfish's networks.

use std::io::Read;

use sk_core::{Position, RULESET};

use crate::features::{active_features, bucket, NUM_FEATURES};

pub const MAGIC: &[u8; 4] = b"SKNN";
pub const VERSION: u32 = 2;

#[derive(Clone, Debug)]
pub struct Network {
    pub inputs: usize,
    pub ft: usize,
    pub l1: usize,
    pub l2: usize,
    pub buckets: usize,
    pub output_scale: f32,
    pub description: String,
    pub ft_w: Vec<f32>,
    pub ft_b: Vec<f32>,
    /// `[inputs][buckets]`; all zero for a version 1 file.
    pub psqt_w: Vec<f32>,
    /// From here on, one layer stack per bucket, stacks one after the other.
    pub l1_w: Vec<f32>,
    pub l1_b: Vec<f32>,
    pub l2_w: Vec<f32>,
    pub l2_b: Vec<f32>,
    pub out_w: Vec<f32>,
    pub out_b: Vec<f32>,
}

fn crelu(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

impl Network {
    /// A small random network (for tests and tooling), deterministic in `seed`.
    pub fn random(ft: usize, l1: usize, l2: usize, seed: u64) -> Self {
        Self::random_buckets(ft, l1, l2, 1, seed)
    }

    /// A random network with `buckets` layer stacks and psqt weights (zero psqt for one bucket,
    /// like a version 1 file).
    pub fn random_buckets(ft: usize, l1: usize, l2: usize, buckets: usize, seed: u64) -> Self {
        let mut s = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut rnd = |scale: f32| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            ((s >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 2.0 * scale
        };
        let mut v = |n: usize, scale: f32| (0..n).map(|_| rnd(scale)).collect::<Vec<f32>>();
        Network {
            inputs: NUM_FEATURES,
            ft,
            l1,
            l2,
            buckets,
            output_scale: 600.0,
            description: format!("{RULESET} random seed {seed}"),
            ft_w: v(NUM_FEATURES * ft, 0.05),
            ft_b: v(ft, 0.1),
            psqt_w: if buckets > 1 {
                v(NUM_FEATURES * buckets, 0.05)
            } else {
                vec![0.0; NUM_FEATURES]
            },
            l1_w: v(buckets * l1 * 2 * ft, 0.1),
            l1_b: v(buckets * l1, 0.1),
            l2_w: v(buckets * l2 * l1, 0.3),
            l2_b: v(buckets * l2, 0.1),
            out_w: v(buckets * l2, 0.3),
            out_b: vec![0.0; buckets],
        }
    }

    pub fn load(path: &str) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        Self::from_bytes(&bytes).map_err(|e| format!("{path}: {e}"))
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let mut r = bytes;
        let mut magic = [0u8; 4];
        r.read_exact(&mut magic).map_err(|_| "too short")?;
        if &magic != MAGIC {
            return Err("not a StockKnight network (bad magic)".into());
        }
        let u32_ = |r: &mut &[u8]| -> Result<u32, String> {
            let mut b = [0u8; 4];
            r.read_exact(&mut b)
                .map_err(|_| "truncated header".to_string())?;
            Ok(u32::from_le_bytes(b))
        };
        let version = u32_(&mut r)?;
        if version != 1 && version != VERSION {
            return Err(format!("unsupported version {version}"));
        }
        let (inputs, ft, l1, l2) = (
            u32_(&mut r)? as usize,
            u32_(&mut r)? as usize,
            u32_(&mut r)? as usize,
            u32_(&mut r)? as usize,
        );
        if inputs != NUM_FEATURES {
            return Err(format!(
                "network has {inputs} inputs, this engine uses {NUM_FEATURES}"
            ));
        }
        if ft == 0 || ft > 1024 || l1 == 0 || l1 > 128 || l2 == 0 || l2 > 128 {
            return Err(format!("unsupported sizes {ft}-{l1}-{l2}"));
        }
        let buckets = if version >= 2 { u32_(&mut r)? as usize } else { 1 };
        if buckets == 0 || buckets > 16 {
            return Err(format!("unsupported bucket count {buckets}"));
        }
        let output_scale = f32::from_bits(u32_(&mut r)?);
        let len = u32_(&mut r)? as usize;
        if r.len() < len {
            return Err("truncated description".into());
        }
        let description = String::from_utf8_lossy(&r[..len]).into_owned();
        r = &r[len..];
        if !description.starts_with(RULESET) {
            return Err(format!(
                "network was trained for another ruleset: {description}"
            ));
        }
        let psqt = if version >= 2 { inputs * buckets } else { 0 };
        let stack = l1 * 2 * ft + l1 + l2 * l1 + l2 + l2 + 1;
        let expected = inputs * ft + ft + psqt + buckets * stack;
        if r.len() != expected * 4 {
            return Err(format!(
                "expected {} weight bytes, found {}",
                expected * 4,
                r.len()
            ));
        }
        let mut floats = r
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
        let mut take = |n: usize| (&mut floats).take(n).collect::<Vec<f32>>();
        let ft_w = take(inputs * ft);
        let ft_b = take(ft);
        let psqt_w = if psqt > 0 {
            take(psqt)
        } else {
            vec![0.0; inputs]
        };
        let (mut l1_w, mut l1_b, mut l2_w, mut l2_b, mut out_w, mut out_b) =
            (vec![], vec![], vec![], vec![], vec![], vec![]);
        for _ in 0..buckets {
            l1_w.extend(take(l1 * 2 * ft));
            l1_b.extend(take(l1));
            l2_w.extend(take(l2 * l1));
            l2_b.extend(take(l2));
            out_w.extend(take(l2));
            out_b.extend(take(1));
        }
        Ok(Network {
            inputs,
            ft,
            l1,
            l2,
            buckets,
            output_scale,
            description,
            ft_w,
            ft_b,
            psqt_w,
            l1_w,
            l1_b,
            l2_w,
            l2_b,
            out_w,
            out_b,
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        for v in [
            VERSION,
            self.inputs as u32,
            self.ft as u32,
            self.l1 as u32,
            self.l2 as u32,
        ] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&(self.buckets as u32).to_le_bytes());
        out.extend_from_slice(&self.output_scale.to_le_bytes());
        out.extend_from_slice(&(self.description.len() as u32).to_le_bytes());
        out.extend_from_slice(self.description.as_bytes());
        let mut put = |xs: &[f32]| {
            for x in xs {
                out.extend_from_slice(&x.to_le_bytes());
            }
        };
        put(&self.ft_w);
        put(&self.ft_b);
        if self.psqt_w.len() == self.inputs * self.buckets {
            put(&self.psqt_w);
        } else {
            put(&vec![0.0; self.inputs * self.buckets]);
        }
        let (ft, l1, l2) = (self.ft, self.l1, self.l2);
        for b in 0..self.buckets {
            put(&self.l1_w[b * l1 * 2 * ft..(b + 1) * l1 * 2 * ft]);
            put(&self.l1_b[b * l1..(b + 1) * l1]);
            put(&self.l2_w[b * l2 * l1..(b + 1) * l2 * l1]);
            put(&self.l2_b[b * l2..(b + 1) * l2]);
            put(&self.out_w[b * l2..(b + 1) * l2]);
            put(&self.out_b[b..b + 1]);
        }
        out
    }

    pub fn save(&self, path: &str) -> Result<(), String> {
        std::fs::write(path, self.to_bytes()).map_err(|e| format!("{path}: {e}"))
    }

    /// The feature transformer output for one perspective.
    pub fn accumulate(&self, features: &[u32]) -> Vec<f32> {
        let mut acc = self.ft_b.clone();
        for &f in features {
            let row = &self.ft_w[f as usize * self.ft..(f as usize + 1) * self.ft];
            for (a, w) in acc.iter_mut().zip(row) {
                *a += w;
            }
        }
        acc
    }

    /// The layers after the accumulators: the raw network output.
    /// The psqt sum of one perspective for bucket `b`.
    pub fn psqt(&self, features: &[u32], b: usize) -> f32 {
        if self.psqt_w.len() != self.inputs * self.buckets {
            return 0.0;
        }
        features
            .iter()
            .map(|&f| self.psqt_w[f as usize * self.buckets + b])
            .sum()
    }

    /// Bucket `b`'s layer stack on the two accumulators: its raw output.
    pub fn propagate(&self, stm: &[f32], other: &[f32], b: usize) -> f32 {
        let (ft, l1, l2) = (self.ft, self.l1, self.l2);
        let x: Vec<f32> = stm.iter().chain(other).map(|&v| crelu(v)).collect();
        let layer = |w: &[f32], b: &[f32], input: &[f32]| -> Vec<f32> {
            b.iter()
                .enumerate()
                .map(|(o, &bias)| {
                    let row = &w[o * input.len()..(o + 1) * input.len()];
                    crelu(bias + row.iter().zip(input).map(|(a, b)| a * b).sum::<f32>())
                })
                .collect()
        };
        let h1 = layer(
            &self.l1_w[b * l1 * 2 * ft..(b + 1) * l1 * 2 * ft],
            &self.l1_b[b * l1..(b + 1) * l1],
            &x,
        );
        let h2 = layer(
            &self.l2_w[b * l2 * l1..(b + 1) * l2 * l1],
            &self.l2_b[b * l2..(b + 1) * l2],
            &h1,
        );
        let out_w = &self.out_w[b * l2..(b + 1) * l2];
        self.out_b[b] + out_w.iter().zip(&h2).map(|(a, b)| a * b).sum::<f32>()
    }

    /// The raw output for `pos`, from the side to move's view.
    pub fn forward(&self, pos: &Position) -> f32 {
        let (fs, fo) = (
            active_features(pos, pos.side),
            active_features(pos, pos.side ^ 1),
        );
        let b = bucket(pos, self.buckets);
        let (stm, other) = (self.accumulate(&fs), self.accumulate(&fo));
        self.propagate(&stm, &other, b) + (self.psqt(&fs, b) - self.psqt(&fo, b)) / 2.0
    }

    pub fn evaluate_cp(&self, pos: &Position) -> i32 {
        (self.forward(pos) * self.output_scale).round() as i32
    }
}
