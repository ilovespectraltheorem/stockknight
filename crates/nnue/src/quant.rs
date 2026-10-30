//! `QuantNet`: the network in integers, for search.
//!
//! - **Feature transformer**: i16 weights and biases at scale 127·2^s. An accumulator holds the
//!   sum of the bias and the active rows; its activation is `clamp(acc >> s, 0, 127)`, so 127
//!   stands for 1.0. `s` is the largest shift for which no position can overflow i16.
//! - **Hidden and output layers**: weights at scale 2^k (one k per layer, the largest that
//!   fits): i8 for the first layer, which is most of the work (AVX2 multiplies 32 bytes at a
//!   time), i16 after it. i32 sums at scale 127·2^k, activations `clamp(sum >> k, 0, 127)`.
//!   Biases include the half that makes the shifts round to nearest. Training keeps hidden
//!   weights within ±127/64, so the first layer's k is at least 6.
//!
//! Everything is integer arithmetic, so the order of additions does not matter: the AVX2
//! build of each kernel gives exactly the same results as the portable one, and an
//! accumulator updated move by move equals one computed from scratch.

use crate::features::{BOARD_FEATURES, NUM_FEATURES};
use crate::network::Network;

/// Largest feature transformer the evaluator supports (both perspectives: twice this).
pub const MAX_FT: usize = 1024;
/// Largest hidden layer.
pub const MAX_HIDDEN: usize = 128;

#[derive(Clone, Debug)]
pub struct QuantNet {
    pub ft: usize,
    pub l1: usize,
    pub l2: usize,
    pub output_scale: f32,
    pub ft_shift: u32,
    pub l1_shift: u32,
    pub l2_shift: u32,
    pub out_shift: u32,
    /// `[inputs][ft]`.
    pub ft_w: Vec<i16>,
    pub ft_b: Vec<i16>,
    /// `[l1][2·ft]`.
    pub l1_w: Vec<i8>,
    pub l1_b: Vec<i32>,
    /// `[l2][l1]`.
    pub l2_w: Vec<i16>,
    pub l2_b: Vec<i32>,
    pub out_w: Vec<i16>,
    pub out_b: i32,
    /// Use the AVX2 kernels (only set when the CPU has AVX2).
    pub simd: bool,
    /// With `simd`, use the VNNI byte dot product in the first layer (only set when the CPU
    /// has AVX-512 VNNI).
    pub vnni: bool,
}

/// Whether this CPU has the VNNI byte dot product on 256-bit vectors.
pub fn vnni_available() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        simd_available()
            && std::is_x86_feature_detected!("avx512vnni")
            && std::is_x86_feature_detected!("avx512vl")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

/// Whether this CPU can run the AVX2 kernels.
pub fn simd_available() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

fn round_to(x: f32, scale: f64) -> i64 {
    (x as f64 * scale).round() as i64
}

/// The largest k ≤ 14 for which the layer's weights fit `limit` and no sum can overflow i32.
fn hidden_shift(
    w: &[f32],
    b: &[f32],
    inputs: usize,
    limit: i64,
    name: &str,
) -> Result<u32, String> {
    let max_w = w.iter().fold(0f32, |m, x| m.max(x.abs()));
    let max_b = b.iter().fold(0f32, |m, x| m.max(x.abs()));
    for k in (0..=14u32).rev() {
        let scale = (1u64 << k) as f64;
        let wq = round_to(max_w, scale);
        let bq = round_to(max_b, 127.0 * scale) + (1 << k);
        if wq <= limit && 127 * wq * inputs as i64 + bq < i32::MAX as i64 {
            return Ok(k);
        }
    }
    Err(format!("{name} weights are too large to quantize"))
}

impl QuantNet {
    pub fn from_network(net: &Network) -> Result<Self, String> {
        let (ft, l1, l2) = (net.ft, net.l1, net.l2);
        if ft > MAX_FT || l1 > MAX_HIDDEN || l2 > MAX_HIDDEN {
            return Err(format!("unsupported sizes {ft}-{l1}-{l2}"));
        }
        // The worst case for one accumulator entry: the bias, the 35 largest weights of one
        // king square's block (at most 35 pieces besides the own king) and all 10 reserve
        // weights.
        let mut worst = 0f32;
        let mut col = Vec::with_capacity(396);
        for j in 0..ft {
            let reserve: f32 = (BOARD_FEATURES..NUM_FEATURES)
                .map(|i| net.ft_w[i * ft + j].abs())
                .sum();
            for ksq in 0..36 {
                col.clear();
                col.extend((0..396).map(|i| net.ft_w[(ksq * 396 + i) * ft + j].abs()));
                col.sort_unstable_by(|a, b| b.total_cmp(a));
                let board: f32 = col[..35].iter().sum();
                worst = worst.max(net.ft_b[j].abs() + reserve + board);
            }
        }
        let ft_shift = (0..=8u32)
            .rev()
            .find(|&s| round_to(worst, 127.0 * (1u64 << s) as f64) + (1 << s) <= i16::MAX as i64)
            .ok_or("feature transformer weights are too large to quantize")?;
        let l1_shift = hidden_shift(&net.l1_w, &net.l1_b, 2 * ft, 127, "first hidden layer")?;
        let l2_shift = hidden_shift(&net.l2_w, &net.l2_b, l1, 32767, "second hidden layer")?;
        let out_shift = hidden_shift(&net.out_w, &[net.out_b], l2, 32767, "output layer")?;

        let fs = 127.0 * (1u64 << ft_shift) as f64;
        let half = |k: u32| if k == 0 { 0 } else { 1i64 << (k - 1) };
        let ints16 = |w: &[f32], scale: f64| w.iter().map(|&x| round_to(x, scale) as i16).collect();
        let bias32 = |b: &[f32], k: u32| {
            b.iter()
                .map(|&x| (round_to(x, 127.0 * (1u64 << k) as f64) + half(k)) as i32)
                .collect::<Vec<i32>>()
        };
        Ok(QuantNet {
            ft,
            l1,
            l2,
            output_scale: net.output_scale,
            ft_shift,
            l1_shift,
            l2_shift,
            out_shift,
            ft_w: ints16(&net.ft_w, fs),
            ft_b: net
                .ft_b
                .iter()
                .map(|&x| (round_to(x, fs) + half(ft_shift)) as i16)
                .collect(),
            l1_w: net
                .l1_w
                .iter()
                .map(|&x| round_to(x, (1u64 << l1_shift) as f64) as i8)
                .collect(),
            l1_b: bias32(&net.l1_b, l1_shift),
            l2_w: ints16(&net.l2_w, (1u64 << l2_shift) as f64),
            l2_b: bias32(&net.l2_b, l2_shift),
            out_w: ints16(&net.out_w, (1u64 << out_shift) as f64),
            out_b: round_to(net.out_b, 127.0 * (1u64 << out_shift) as f64) as i32,
            simd: simd_available() && Self::simd_shape(ft, l1),
            vnni: vnni_available(),
        })
    }

    /// Sizes the AVX2 kernels handle: whole 32-byte chunks of each accumulator's activations,
    /// rows of the first layer in groups of 4.
    pub fn simd_shape(ft: usize, l1: usize) -> bool {
        ft.is_multiple_of(32) && l1.is_multiple_of(4)
    }

    /// Feature `f`'s row of the feature transformer.
    #[inline]
    pub fn row(&self, f: usize) -> &[i16] {
        &self.ft_w[f * self.ft..(f + 1) * self.ft]
    }

    /// `dst = src + Σ rows(add) − Σ rows(sub)`, one perspective's accumulator.
    #[inline]
    pub fn update(&self, dst: &mut [i16], src: &[i16], add: &[usize], sub: &[usize]) {
        #[cfg(target_arch = "x86_64")]
        if self.simd {
            // SAFETY: `simd` is only set when the CPU has AVX2.
            return unsafe {
                avx2::update(self, &mut dst[..self.ft], Some(&src[..self.ft]), add, sub)
            };
        }
        self.update_generic(dst, src, add, sub)
    }

    /// `acc += Σ rows(add) − Σ rows(sub)`.
    #[inline]
    pub fn update_in_place(&self, acc: &mut [i16], add: &[usize], sub: &[usize]) {
        #[cfg(target_arch = "x86_64")]
        if self.simd {
            // SAFETY: `simd` is only set when the CPU has AVX2.
            return unsafe { avx2::update(self, &mut acc[..self.ft], None, add, sub) };
        }
        self.add_rows(acc, add, sub)
    }

    #[inline(always)]
    fn update_generic(&self, dst: &mut [i16], src: &[i16], add: &[usize], sub: &[usize]) {
        let n = self.ft;
        dst[..n].copy_from_slice(&src[..n]);
        self.add_rows(dst, add, sub)
    }

    #[inline(always)]
    fn add_rows(&self, dst: &mut [i16], add: &[usize], sub: &[usize]) {
        let dst = &mut dst[..self.ft];
        for &f in add {
            for (d, w) in dst.iter_mut().zip(self.row(f)) {
                *d = d.wrapping_add(*w);
            }
        }
        for &f in sub {
            for (d, w) in dst.iter_mut().zip(self.row(f)) {
                *d = d.wrapping_sub(*w);
            }
        }
    }

    /// The accumulator for a set of active inputs, from scratch.
    pub fn accumulate(&self, features: &[u32]) -> Vec<i16> {
        let mut acc = vec![0i16; self.ft];
        let add: Vec<usize> = features.iter().map(|&f| f as usize).collect();
        self.update(&mut acc, &self.ft_b, &add, &[]);
        acc
    }

    /// The layers after the accumulators: the raw output at scale 127·2^out_shift.
    #[inline]
    pub fn propagate(&self, stm: &[i16], other: &[i16]) -> i32 {
        #[cfg(target_arch = "x86_64")]
        if self.simd {
            // SAFETY: `simd` is only set when the CPU has AVX2.
            // SAFETY: `vnni` is only set when the CPU has AVX-512 VNNI.
            return unsafe {
                if self.vnni {
                    avx2::propagate_vnni(self, &stm[..self.ft], &other[..self.ft])
                } else {
                    avx2::propagate(self, &stm[..self.ft], &other[..self.ft])
                }
            };
        }
        self.propagate_generic(stm, other)
    }

    #[inline(always)]
    fn propagate_generic(&self, stm: &[i16], other: &[i16]) -> i32 {
        let ft = self.ft;
        let s = self.ft_shift;
        let mut x = [0u8; 2 * MAX_FT];
        for (d, &a) in x[..ft].iter_mut().zip(&stm[..ft]) {
            *d = (a >> s).clamp(0, 127) as u8;
        }
        for (d, &a) in x[ft..2 * ft].iter_mut().zip(&other[..ft]) {
            *d = (a >> s).clamp(0, 127) as u8;
        }
        let mut h1 = [0i16; MAX_HIDDEN];
        let n = 2 * ft;
        for (o, h) in h1[..self.l1].iter_mut().enumerate() {
            let row = &self.l1_w[o * n..(o + 1) * n];
            let sum = row.iter().zip(&x[..n]).fold(self.l1_b[o], |s, (&w, &a)| {
                s.wrapping_add(w as i32 * a as i32)
            });
            *h = (sum >> self.l1_shift).clamp(0, 127) as i16;
        }
        self.finish(&h1)
    }

    /// The second hidden layer and the output, from the first hidden layer.
    #[inline(always)]
    fn finish(&self, h1: &[i16; MAX_HIDDEN]) -> i32 {
        let mut h2 = [0i16; MAX_HIDDEN];
        layer(
            &self.l2_w,
            &self.l2_b,
            &h1[..self.l1],
            self.l2_shift,
            &mut h2[..self.l2],
        );
        self.out_b + dot(&self.out_w, &h2[..self.l2])
    }

    /// Centipawns from a raw output.
    #[inline]
    pub fn to_cp(&self, raw: i32) -> i32 {
        let scale = 127.0 * (1u64 << self.out_shift) as f64;
        (raw as f64 * self.output_scale as f64 / scale).round() as i32
    }

    pub fn evaluate_cp(&self, stm: &[i16], other: &[i16]) -> i32 {
        self.to_cp(self.propagate(stm, other))
    }
}

#[inline(always)]
fn dot(w: &[i16], x: &[i16]) -> i32 {
    w.iter()
        .zip(x)
        .fold(0i32, |s, (&a, &b)| s.wrapping_add(a as i32 * b as i32))
}

#[inline(always)]
fn layer(w: &[i16], b: &[i32], x: &[i16], shift: u32, out: &mut [i16]) {
    let n = x.len();
    for (o, h) in out.iter_mut().enumerate() {
        let sum = b[o].wrapping_add(dot(&w[o * n..(o + 1) * n], x));
        *h = (sum >> shift).clamp(0, 127) as i16;
    }
}

/// The AVX2 kernels. Same integer operations as the portable code, so the same results.
#[cfg(target_arch = "x86_64")]
mod avx2 {
    use std::arch::x86_64::*;

    use super::{QuantNet, MAX_FT, MAX_HIDDEN};

    /// `dst = (src or dst) + Σ rows(add) − Σ rows(sub)`; `dst` and `src` are `ft` long.
    #[target_feature(enable = "avx2")]
    pub unsafe fn update(
        q: &QuantNet,
        dst: &mut [i16],
        src: Option<&[i16]>,
        add: &[usize],
        sub: &[usize],
    ) {
        let ft = q.ft;
        let src = src.map_or(dst.as_ptr(), |s| s.as_ptr());
        let w = q.ft_w.as_ptr();
        for c in (0..ft).step_by(16) {
            let mut v = _mm256_loadu_si256(src.add(c) as *const __m256i);
            for &f in add {
                v = _mm256_add_epi16(v, _mm256_loadu_si256(w.add(f * ft + c) as *const __m256i));
            }
            for &f in sub {
                v = _mm256_sub_epi16(v, _mm256_loadu_si256(w.add(f * ft + c) as *const __m256i));
            }
            _mm256_storeu_si256(dst.as_mut_ptr().add(c) as *mut __m256i, v);
        }
    }

    /// Sums of four i32x8 vectors, in order.
    #[inline(always)]
    unsafe fn hadd4(a: __m256i, b: __m256i, c: __m256i, d: __m256i) -> __m128i {
        let ab = _mm256_hadd_epi32(a, b);
        let cd = _mm256_hadd_epi32(c, d);
        let abcd = _mm256_hadd_epi32(ab, cd);
        _mm_add_epi32(
            _mm256_castsi256_si128(abcd),
            _mm256_extracti128_si256(abcd, 1),
        )
    }

    #[target_feature(enable = "avx2")]
    pub unsafe fn propagate(q: &QuantNet, stm: &[i16], other: &[i16]) -> i32 {
        propagate_impl::<false>(q, stm, other)
    }

    #[target_feature(enable = "avx2,avx512vnni,avx512vl")]
    pub unsafe fn propagate_vnni(q: &QuantNet, stm: &[i16], other: &[i16]) -> i32 {
        propagate_impl::<true>(q, stm, other)
    }

    #[inline(always)]
    unsafe fn propagate_impl<const VNNI: bool>(q: &QuantNet, stm: &[i16], other: &[i16]) -> i32 {
        let ft = q.ft;
        let chunks = 2 * ft / 32;
        let top = _mm256_set1_epi16(127);
        let shift = _mm_cvtsi32_si128(q.ft_shift as i32);
        // Activations as bytes. Negative values become 0 when packed; packing interleaves the
        // two 128-bit lanes, which the permute puts back in order.
        let mut x = std::mem::MaybeUninit::<[__m256i; 2 * MAX_FT / 32]>::uninit();
        // Only the first `chunks` entries are written and read.
        let x = &mut *(x.as_mut_ptr() as *mut [std::mem::MaybeUninit<__m256i>; 2 * MAX_FT / 32]);
        for (half, acc) in [stm, other].into_iter().enumerate() {
            for c in 0..ft / 32 {
                let p = acc.as_ptr().add(32 * c) as *const __m256i;
                let a = _mm256_min_epi16(_mm256_sra_epi16(_mm256_loadu_si256(p), shift), top);
                let b =
                    _mm256_min_epi16(_mm256_sra_epi16(_mm256_loadu_si256(p.add(1)), shift), top);
                x[half * ft / 32 + c].write(_mm256_permute4x64_epi64(
                    _mm256_packus_epi16(a, b),
                    0b11_01_10_00,
                ));
            }
        }
        let x = std::slice::from_raw_parts(x.as_ptr() as *const __m256i, chunks);
        let n = 2 * ft;
        let w = q.l1_w.as_ptr();
        let ones = _mm256_set1_epi16(1);
        let shift = _mm_cvtsi32_si128(q.l1_shift as i32);
        let mut h1 = [0i16; MAX_HIDDEN];
        for o in (0..q.l1).step_by(4) {
            // Four rows side by side, so the four sums are independent chains.
            let mut s = [_mm256_setzero_si256(); 4];
            let rows = [0, 1, 2, 3].map(|r| w.add((o + r) * n));
            for (c, xc) in x.iter().enumerate() {
                for (sum, row) in s.iter_mut().zip(rows) {
                    let wc = _mm256_loadu_si256(row.add(32 * c) as *const __m256i);
                    *sum = if VNNI {
                        _mm256_dpbusd_epi32(*sum, *xc, wc)
                    } else {
                        // Pairs of byte products cannot saturate i16: 2 · 127 · 127 < 32768.
                        let pairs = _mm256_maddubs_epi16(*xc, wc);
                        _mm256_add_epi32(*sum, _mm256_madd_epi16(pairs, ones))
                    };
                }
            }
            let sums = _mm_add_epi32(
                hadd4(s[0], s[1], s[2], s[3]),
                _mm_loadu_si128(q.l1_b.as_ptr().add(o) as *const __m128i),
            );
            let act = _mm_min_epi32(
                _mm_max_epi32(_mm_sra_epi32(sums, shift), _mm_setzero_si128()),
                _mm_set1_epi32(127),
            );
            let mut out = [0i32; 4];
            _mm_storeu_si128(out.as_mut_ptr() as *mut __m128i, act);
            for r in 0..4 {
                h1[o + r] = out[r] as i16;
            }
        }
        if q.l1 % 16 == 0 && q.l2 % 4 == 0 {
            finish(q, &h1)
        } else {
            q.finish(&h1)
        }
    }

    /// The second hidden layer and the output, when the sizes fit whole vectors.
    #[inline(always)]
    unsafe fn finish(q: &QuantNet, h1: &[i16; MAX_HIDDEN]) -> i32 {
        let n = q.l1;
        let mut x = [_mm256_setzero_si256(); MAX_HIDDEN / 16];
        for (c, xc) in x[..n / 16].iter_mut().enumerate() {
            *xc = _mm256_loadu_si256(h1.as_ptr().add(16 * c) as *const __m256i);
        }
        let w = q.l2_w.as_ptr();
        let shift = _mm_cvtsi32_si128(q.l2_shift as i32);
        let mut h2 = [0i32; MAX_HIDDEN];
        for o in (0..q.l2).step_by(4) {
            let mut s = [_mm256_setzero_si256(); 4];
            let rows = [0, 1, 2, 3].map(|r| w.add((o + r) * n));
            for (c, xc) in x[..n / 16].iter().enumerate() {
                for (sum, row) in s.iter_mut().zip(rows) {
                    let wc = _mm256_loadu_si256(row.add(16 * c) as *const __m256i);
                    *sum = _mm256_add_epi32(*sum, _mm256_madd_epi16(wc, *xc));
                }
            }
            let sums = _mm_add_epi32(
                hadd4(s[0], s[1], s[2], s[3]),
                _mm_loadu_si128(q.l2_b.as_ptr().add(o) as *const __m128i),
            );
            let act = _mm_min_epi32(
                _mm_max_epi32(_mm_sra_epi32(sums, shift), _mm_setzero_si128()),
                _mm_set1_epi32(127),
            );
            _mm_storeu_si128(h2.as_mut_ptr().add(o) as *mut __m128i, act);
        }
        let mut out = q.out_b;
        for (&w, &h) in q.out_w.iter().zip(&h2[..q.l2]) {
            out = out.wrapping_add(w as i32 * h);
        }
        out
    }
}
