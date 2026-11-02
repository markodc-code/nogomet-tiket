"""Europska natjecanja (Liga prvaka, Europska liga, Konferencijska liga) s ESPN-a.

Rezultati ove i prošle sezone za model (kao domaće lige), raspored i kvote za idućih
8 dana. Kvote postoje za gotovo sve utakmice, pa se šanse uglavnom oslanjaju na njih.
"""
import datetime as dt
import os

import basket as K
import espn_soccer as E
import model as M

BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
DIR = os.path.join(M.DATA_DIR, "uefa")
COMPS = {
    "UCL": ("uefa.champions", "Liga prvaka"),
    "UEL": ("uefa.europa", "Europska liga"),
    "UECL": ("uefa.europa.conf", "Konferencijska liga"),
}
WEIGHT = 0.9
DAYS_BACK = 430


def _season_start(d):
    return dt.date(d.year if d.month >= 7 else d.year - 1, 7, 1)


def _match_days(today):
    """Europske utakmice igraju se uglavnom utorkom, srijedom i četvrtkom (finala i subotom)."""
    d = today - dt.timedelta(days=DAYS_BACK)
    while d <= today + dt.timedelta(days=E.DAYS):
        if d.weekday() in (1, 2, 3) or (d.month in (5, 6) and d.weekday() in (5, 6)):
            yield d
        d += dt.timedelta(days=1)


def load(today=None, force=False):
    today = today or dt.date.today()
    now = dt.datetime.now(dt.timezone.utc)
    cur_start = _season_start(today)
    out = {}
    for code, (slug, name) in COMPS.items():
        cur, prev, fixtures, teams = [], [], [], set()
        for day in _match_days(today):
            ds = day.strftime("%Y%m%d")
            age = None if (today - day).days > 4 else (0 if force else 3 * 3600)
            js = K._get(f"{BASE}/{slug}/scoreboard?dates={ds}", os.path.join(DIR, f"{code}_{ds}.json"), age) or {}
            for ev in js.get("events", []):
                c = ev["competitions"][0]
                st = c["status"]["type"]
                side = {x["homeAway"]: x for x in c["competitors"]}
                if "home" not in side or "away" not in side:
                    continue
                h, a = side["home"]["team"]["displayName"], side["away"]["team"]["displayName"]
                when = K._utc(ev["date"])
                if st.get("completed"):
                    detail = (st.get("shortDetail") or st.get("detail") or "").upper()
                    try:
                        hs, as_ = int(side["home"]["score"]), int(side["away"]["score"])
                    except (TypeError, ValueError, KeyError):
                        continue
                    et = "AET" in detail or "PEN" in detail or "ET" == detail.strip()
                    g = (when.date(), h, a, hs, as_, et)
                    (cur if when.date() >= cur_start else prev).append(g)
                    if when.date() >= cur_start:
                        teams.update((h, a))
                elif st.get("state") == "pre" and when > now:
                    teams.update((h, a))
                    uk = E._uk(when)
                    fixtures.append({"league": code, "iso": uk.date().isoformat(), "time": uk.strftime("%H:%M"),
                                     "home": h, "away": a, "odds": E._odds(c), "src": "espn"})
        # isti dan može doći iz više upita: bez duplikata
        dedup = lambda gs: sorted({(g[0], g[1], g[2]): g for g in gs}.values())
        fx = {(f["home"], f["away"], f["iso"]): f for f in fixtures}
        out[code] = {"name": name, "current": dedup(cur), "previous": dedup(prev),
                     "fixtures": sorted(fx.values(), key=lambda f: (f["iso"], f["time"])), "teams": sorted(teams)}
    return out


def build(today=None, force=False):
    """Lige, nadolazeće utakmice i rezultati u istom obliku kao domaće lige."""
    today = today or dt.date.today()
    leagues, fixtures, results = [], [], []
    try:
        data = load(today, force)
    except Exception as e:
        print("  ! Europska natjecanja nisu uspjela:", e)
        return leagues, fixtures, results
    for code, d in data.items():
        if not d["teams"]:
            continue
        # model na 90-minutnim rezultatima; utakmice s produžecima izostavljamo (nema rezultata nakon 90')
        per = [[g[:5] for g in d["current"] if not g[5]], [g[:5] for g in d["previous"] if not g[5]]]
        mdl = M.LeagueModel(code, per, today, season_teams=set(d["teams"]))
        r4 = lambda x: round(x, 4)
        leagues.append({
            "code": code, "name": d["name"], "flag": "UEFA", "country": "Europska natjecanja", "uefa": True,
            "weight": WEIGHT, "accuracy": None, "teams": d["teams"], "table": mdl.table,
            "mu": r4(mdl.mu), "home": r4(mdl.home), "rho": r4(mdl.rho),
            "att": {t: r4(v) for t, v in mdl.att.items() if t in d["teams"]},
            "de": {t: r4(v) for t, v in mdl.de.items() if t in d["teams"]},
        })
        fixtures += d["fixtures"]
        cutoff = today - dt.timedelta(days=150)
        results += [[g[0].isoformat(), g[1], g[2], g[3], g[4]] for g in d["current"] + d["previous"]
                    if g[0] >= cutoff and not g[5]]
        print(f"  {d['name']}: {len(d['current'])} utakmica ove sezone, {len(d['previous'])} prošle, "
              f"{len(d['fixtures'])} nadolazećih")
    return leagues, fixtures, results


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    l, f, r = build()
    print(len(l), "natjecanja,", len(f), "nadolazećih,", len(r), "rezultata")
    for x in f[:5]:
        print(" ", x)
