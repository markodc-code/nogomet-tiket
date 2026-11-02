"""Provjera točnosti na prošloj sezoni, bez gledanja u budućnost.

Za svaki tjedan prošle sezone model se izračuna samo iz utakmica odigranih
prije tog tjedna, pa se njegove šanse usporede sa stvarnim rezultatima i s
kvotama kladionica. Rezultat ide u tocnost.json, koji build_data.py koristi
za odabir liga i za to koliko vjerujemo modelu naspram kladionica.

Pokreni: python backtest.py   (traje par minuta)
"""
import datetime as dt
import json
import math
import os
import sys

import model as M

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "tocnost.json")
WEIGHTS = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def odds_for(code, season):
    path = os.path.join(M.DATA_DIR, f"{code}_{season}.csv")
    out = {}
    if not os.path.exists(path):
        return out
    for r in M._read_csv(path):
        d = M._date(r.get("Date", ""))
        o = {k: M._num(r.get(c)) for k, c in (("1", "AvgH"), ("X", "AvgD"), ("2", "AvgA"),
                                              ("O2.5", "Avg>2.5"), ("U2.5", "Avg<2.5"))}
        if d and all(o[k] for k in ("1", "X", "2")):
            out[(d, r["HomeTeam"].strip(), r["AwayTeam"].strip())] = o
    return out


def ll(p):
    return -math.log(max(p, 1e-6))


def run(codes=None):
    leagues, _, seasons = M.load_all(count=4)
    test_season = seasons[1]
    codes = codes or list(M.LEAGUES)
    report = {"season": test_season, "made": dt.date.today().isoformat(), "leagues": {}}
    for c in codes:
        test = sorted(leagues[c][1])
        if len(test) < 100:
            print(f"{c}: premalo utakmica ({len(test)})")
            continue
        odds = odds_for(c, test_season)
        teams = {t for m in test for t in (m[1], m[2])}
        # po tjednima (ponedjeljak)
        weeks = {}
        for m in test:
            wk = m[0] - dt.timedelta(days=m[0].weekday())
            weeks.setdefault(wk, []).append(m)
        stats = {"n": 0, "llModel": 0.0, "llMarket": 0.0, "llW": [0.0] * len(WEIGHTS),
                 "hitModel": 0, "hitMarket": 0, "hitW": [0] * len(WEIGHTS),
                 "llOU": [0.0] * len(WEIGHTS), "llOUMarket": 0.0, "nOU": 0}
        for wk in sorted(weeks):
            mdl = M.build_models(leagues, today=wk - dt.timedelta(days=1), offset=1,
                                 season_teams={c: teams}, codes=[c])[c]
            for d, h, a, hg, ag in weeks[wk]:
                o = odds.get((d, h, a))
                if not o:
                    continue
                res = "1" if hg > ag else "X" if hg == ag else "2"
                over = hg + ag > 2.5
                mk = M.market_probabilities(o)
                lh, la = mdl.expected_goals(h, a)
                ml = M.market_lambdas(mk, lh, la, mdl.rho)
                stats["n"] += 1
                stats["llMarket"] += ll(mk[res])
                stats["hitMarket"] += max(("1", "X", "2"), key=lambda k: mk[k]) == res
                has_ou = "O2.5" in mk
                if has_ou:
                    stats["nOU"] += 1
                    stats["llOUMarket"] += ll(mk["O2.5"] if over else mk["U2.5"])
                for i, w in enumerate(WEIGHTS):
                    bl = M.blended_lambdas(lh, la, *ml, w=w) if ml else (lh, la)
                    m = M.matrix(*bl, mdl.rho)
                    p = {k: M.bet_probability(m, k) for k in ("1", "X", "2", "O2.5")}
                    stats["llW"][i] += ll(p[res])
                    stats["hitW"][i] += max(("1", "X", "2"), key=lambda k: p[k]) == res
                    if has_ou:
                        stats["llOU"][i] += ll(p["O2.5"] if over else 1 - p["O2.5"])
                    if w == 0.0:
                        stats["llModel"] += ll(p[res])
                        stats["hitModel"] += max(("1", "X", "2"), key=lambda k: p[k]) == res
        n = stats["n"]
        if not n:
            continue
        llw = [x / n for x in stats["llW"]]
        best = min(range(len(WEIGHTS)), key=lambda i: llw[i])
        nou = max(stats["nOU"], 1)
        rep = {
            "n": n,
            "logLossModel": round(stats["llModel"] / n, 4),
            "logLossMarket": round(stats["llMarket"] / n, 4),
            "logLossByWeight": {str(w): round(v, 4) for w, v in zip(WEIGHTS, llw)},
            "bestWeight": WEIGHTS[best],
            "logLossBest": round(llw[best], 4),
            "hitModel": round(stats["hitModel"] / n, 4),
            "hitMarket": round(stats["hitMarket"] / n, 4),
            "hitBest": round(stats["hitW"][best] / n, 4),
            "logLossOUBest": round(stats["llOU"][best] / nou, 4),
            "logLossOUMarket": round(stats["llOUMarket"] / nou, 4),
        }
        report["leagues"][c] = rep
        print(f"{c:4} n={n:4}  model {rep['logLossModel']:.4f}  kladionice {rep['logLossMarket']:.4f}  "
              f"najbolje w={rep['bestWeight']} {rep['logLossBest']:.4f}  "
              f"pogodak 1X2: model {rep['hitModel']:.1%}  klad. {rep['hitMarket']:.1%}  kombinacija {rep['hitBest']:.1%}")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    return report


if __name__ == "__main__":
    run(sys.argv[1:] or None)
