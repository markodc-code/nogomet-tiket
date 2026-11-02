"""Skine rezultate i kvote, izračuna model i spremi sve u web/data.json.

Pokreće se lokalno (server.py) i jednom dnevno na GitHubu (Actions).
"""
import datetime as dt
import json
import os
import sys

import model as M

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "web", "data.json")
ACCURACY = os.path.join(HERE, "tocnost.json")
RESULT_DAYS = 150  # koliko unazad čuvamo rezultate za provjeru tiketa


def load_accuracy():
    try:
        with open(ACCURACY, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"leagues": {}}


def r4(x):
    return round(x, 4)


def build(force=False, out=OUT):
    leagues, fixtures, seasons = M.load_all(force)
    today = dt.date.today()
    models = M.build_models(leagues)
    acc = load_accuracy()

    played = {(m[1], m[2], m[0]) for c in leagues for s in leagues[c] for m in s}
    played_pairs_recent = {(h, a) for (h, a, d) in played if (today - d).days < 3}
    upcoming = []
    for f in fixtures:
        d = M._date(f["date"])
        mdl = models[f["league"]]
        if d and d >= today and (f["home"], f["away"]) not in played_pairs_recent \
                and f["home"] in mdl.att and f["away"] in mdl.att:
            upcoming.append({"league": f["league"], "iso": d.isoformat(), "time": f["time"],
                             "home": f["home"], "away": f["away"],
                             "odds": {k: v for k, v in f["odds"].items() if v}})
    upcoming.sort(key=lambda f: (f["iso"], f["time"], f["league"]))

    results = []
    for c in leagues:
        for s in leagues[c]:
            for d, h, a, hg, ag in s:
                if (today - d).days <= RESULT_DAYS:
                    results.append([d.isoformat(), h, a, hg, ag])
    results.sort()
    last = max((r[0] for r in results), default=None)

    data = {
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "lastResult": last,
        "seasons": seasons,
        "marketWeight": M.MARKET_WEIGHT,
        "maxGoals": M.MAX_GOALS,
        "aliases": M.ALIASES,
        "accuracySeason": acc.get("season"),
        "top5": list(M.TOP5),
        "leagues": [{
            "code": c, "name": M.LEAGUES[c], "flag": M.LEAGUE_FLAGS[c], "country": M.LEAGUE_COUNTRY[c],
            "weight": acc["leagues"].get(c, {}).get("bestWeight", M.MARKET_WEIGHT),
            "accuracy": {k: acc["leagues"][c][k] for k in ("n", "hitModel", "hitMarket", "hitBest")}
            if c in acc["leagues"] else None,
            "teams": mdl.teams, "table": mdl.table,
            "mu": r4(mdl.mu), "home": r4(mdl.home), "rho": r4(mdl.rho),
            "att": {t: r4(v) for t, v in mdl.att.items() if t in mdl.teams},
            "de": {t: r4(v) for t, v in mdl.de.items() if t in mdl.teams},
        } for c, mdl in models.items()],
        "fixtures": upcoming,
        "results": results,
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, out)
    print(f"data.json: {sum(len(l['teams']) for l in data['leagues'])} momčadi, "
          f"{len(upcoming)} nadolazećih, {len(results)} rezultata, "
          f"{os.path.getsize(out) // 1024} KB")
    return data


if __name__ == "__main__":
    build(force="--force" in sys.argv)
