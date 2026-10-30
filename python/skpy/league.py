"""League maths, no I/O: ratings, schedules, intervals, regressions and the SPRT.

Results are (wins, draws, losses) from the first model's view. Formulas match sk-match.
"""

import math

import numpy as np

ALPHA = 0.05
BETA = 0.05


def elo_of_score(s: float) -> float:
    s = min(max(s, 1e-6), 1 - 1e-6)
    return -400.0 * math.log10(1.0 / s - 1.0)


def score_of_elo(elo: float) -> float:
    return 1.0 / (1.0 + 10.0 ** (-elo / 400.0))


def moments(w, d, l):
    """Mean score and per-game variance; a sweep gets half a win and half a loss added."""
    n = w + d + l
    s = (w + d / 2) / n
    var = (w * (1 - s) ** 2 + d * (0.5 - s) ** 2 + l * s**2) / n
    if var > 0:
        return s, var
    return moments(w + 0.5, d, l + 0.5)


def score_interval(w, d, l, z=1.96):
    """Score and its 95% interval (normal approximation on the trinomial)."""
    n = w + d + l
    if n == 0:
        return 0.5, 0.0, 1.0
    s, var = moments(w, d, l)
    half = z * math.sqrt(var / n)
    return (w + d / 2) / n, s - half, s + half


def llr(w, d, l, elo0, elo1) -> float:
    n = w + d + l
    if n == 0:
        return 0.0
    s, var = moments(w, d, l)
    s0, s1 = score_of_elo(elo0), score_of_elo(elo1)
    return n * (s1 - s0) * (2 * s - s0 - s1) / (2 * var)


def sprt_bounds(alpha=ALPHA, beta=BETA):
    return math.log(beta / (1 - alpha)), math.log((1 - beta) / alpha)


def sprt_decision(w, d, l, elo0, elo1, min_games=40):
    """'H1' (stronger by elo1), 'H0' (not stronger than elo0) or None (keep playing)."""
    if w + d + l < min_games:
        return None
    lo, hi = sprt_bounds()
    x = llr(w, d, l, elo0, elo1)
    if x >= hi:
        return "H1"
    if x <= lo:
        return "H0"
    return None


def schedule(new: str, earlier: list, recent=200, decay=0.5, minimum=60) -> dict:
    """Games `new` owes each earlier model, newest first: `recent` against the previous one,
    × `decay` per step further back, never fewer than `minimum`, rounded up to even."""
    out = {}
    for i, m in enumerate(reversed(earlier)):
        g = max(minimum, recent * decay**i)
        out[m] = int(math.ceil(g / 2) * 2)
    return out


def head_to_head(games: list) -> dict:
    """{(a, b): [w, d, l]} with a < b by name, summed over game records {a, b, w, d, l}."""
    out = {}
    for g in games:
        a, b, w, d, l = g["a"], g["b"], g["w"], g["d"], g["l"]
        if a > b:
            a, b, w, l = b, a, l, w
        t = out.setdefault((a, b), [0, 0, 0])
        t[0] += w
        t[1] += d
        t[2] += l
    return out


def result_between(games, a, b):
    """[w, d, l] of `a` against `b`."""
    h = head_to_head(games)
    if a < b:
        return list(h.get((a, b), [0, 0, 0]))
    w, d, l = h.get((b, a), [0, 0, 0])
    return [l, d, w]


def regressions(games, model, earlier) -> list:
    """Earlier models `model` scores significantly below 50% against."""
    out = []
    for m in earlier:
        w, d, l = result_between(games, model, m)
        if w + d + l and score_interval(w, d, l)[2] < 0.5:
            out.append(m)
    return out


def fit_ratings(games, models, anchor="g0", iterations=100):
    """Joint maximum-likelihood Elo (Bradley–Terry on the Elo scale), anchored at `anchor` = 0,
    with one virtual draw per pair that has played. Returns {model: (elo, standard error)};
    models not connected to the anchor get NaN."""
    idx = {m: i for i, m in enumerate(models)}
    pairs = []
    for (a, b), (w, d, l) in head_to_head(games).items():
        if a in idx and b in idx and w + d + l:
            pairs.append((idx[a], idx[b], w + d / 2 + 0.5, w + d + l + 1))
    # Connected component of the anchor.
    connected = {idx[anchor]} if anchor in idx else set()
    grew = True
    while grew:
        grew = False
        for i, j, _, _ in pairs:
            if (i in connected) != (j in connected):
                connected |= {i, j}
                grew = True
    free = [i for i in range(len(models)) if i in connected and i != idx.get(anchor)]
    pos = {i: k for k, i in enumerate(free)}
    r = np.zeros(len(models))
    c = math.log(10) / 400
    cov = np.zeros((len(free), len(free)))
    for _ in range(iterations):
        grad = np.zeros(len(free))
        hess = np.zeros((len(free), len(free)))
        for i, j, s, n in pairs:
            if i not in connected:
                continue
            p = 1 / (1 + math.exp(-c * (r[i] - r[j])))
            g = c * (s - n * p)
            h = c * c * n * p * (1 - p)
            for k, sign in ((i, 1), (j, -1)):
                if k in pos:
                    grad[pos[k]] += sign * g
            for k1, s1 in ((i, 1), (j, -1)):
                for k2, s2 in ((i, 1), (j, -1)):
                    if k1 in pos and k2 in pos:
                        hess[pos[k1], pos[k2]] += s1 * s2 * h
        if not free:
            break
        cov = np.linalg.inv(hess)
        step = cov @ grad
        for k, i in enumerate(free):
            r[i] += step[k]
        if np.max(np.abs(step)) < 1e-6:
            break
    out = {}
    for m, i in idx.items():
        if i not in connected:
            out[m] = (float("nan"), float("nan"))
        elif i in pos:
            out[m] = (float(r[i]), float(math.sqrt(cov[pos[i], pos[i]])))
        else:
            out[m] = (0.0, 0.0)
    return out
