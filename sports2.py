"""Hokej (NHL) i tenis (ATP/WTA) s ESPN-a: podaci, modeli i provjera točnosti.

Hokej: Dixon-Coles model golova (kao nogomet) na rezultatima REGULARNOG dijela
(60 min), jer se 1X2 u hokeju igra na regularni dio. Produžeci se računaju posebno.
Tenis: Elo ocjena igrača iz svih mečeva u zadnjih ~13 mjeseci.
"""
import datetime as dt
import json
import math
import os

import basket as K   # _get, _utc, american_to_decimal
import model as M

ESPN = "https://site.api.espn.com/apis/site/v2/sports"
DIR = os.path.join(M.DATA_DIR, "ostalo")
FIXTURE_DAYS = 8
RESULT_DAYS = {"hok": 150, "ten": 30}
GRAND_SLAMS = ("australian open", "roland garros", "french open", "wimbledon", "us open")


def _r(x, n=4):
    return round(x, n)


# ================================================================ HOKEJ (NHL)

def nhl_season(today):
    return today.year + 1 if today.month >= 8 else today.year


def load_nhl(today, force=False, seasons_back=1):
    cur = nhl_season(today)
    teams_js = K._get(f"{ESPN}/hockey/nhl/teams", os.path.join(DIR, "nhl_teams.json"), 30 * 86400)
    teams = [t["team"] for t in teams_js["sports"][0]["leagues"][0]["teams"]]
    aliases = {}
    for t in teams:
        for a in (t.get("shortDisplayName"), t.get("name"), t.get("abbreviation")):
            if a:
                aliases[a] = t["displayName"]
    seasons = {}
    for season in range(cur, cur - seasons_back - 1, -1):
        games = {}
        for t in teams:
            age = None if season < cur else (0 if force else M.MAX_AGE)
            js = K._get(f"{ESPN}/hockey/nhl/teams/{t['id']}/schedule?season={season}",
                        os.path.join(DIR, f"nhl_{season}_{t['id']}.json"), age)
            for ev in (js or {}).get("events", []):
                c = ev["competitions"][0]
                st = c["status"]["type"]
                if not st["completed"]:
                    continue
                side = {x["homeAway"]: x for x in c["competitors"]}
                try:
                    hs, as_ = int(side["home"]["score"]["value"]), int(side["away"]["score"]["value"])
                except (KeyError, TypeError, ValueError):
                    continue
                detail = (st.get("shortDetail") or st.get("detail") or "").upper()
                ot = "OT" in detail or "SO" in detail
                games[ev["id"]] = (K._utc(ev["date"]), side["home"]["team"]["displayName"],
                                   side["away"]["team"]["displayName"], hs, as_, ot)
        seasons[season] = sorted(games.values())
    fixtures = []
    for i in range(FIXTURE_DAYS):
        d = (today + dt.timedelta(days=i - 1)).strftime("%Y%m%d")
        js = K._get(f"{ESPN}/hockey/nhl/scoreboard?dates={d}", os.path.join(DIR, f"nhl_sb_{d}.json"), 0 if force else 3 * 3600)
        for ev in (js or {}).get("events", []):
            c = ev["competitions"][0]
            if c["status"]["type"]["state"] != "pre":
                continue
            side = {x["homeAway"]: x["team"]["displayName"] for x in c["competitors"]}
            fixtures.append({"league": "NHL", "utc": K._utc(ev["date"]).strftime("%Y-%m-%dT%H:%MZ"),
                             "home": side["home"], "away": side["away"], "odds": _nhl_odds(c)})
    return {"seasons": [seasons[s] for s in sorted(seasons, reverse=True)], "fixtures": fixtures,
            "aliases": aliases, "teams": sorted(t["displayName"] for t in teams)}


def _nhl_odds(c):
    o = (c.get("odds") or [{}])[0] or {}
    out = {}
    ml = o.get("moneyline") or {}
    for side, key in (("home", "1OT"), ("away", "2OT")):
        node = ml.get(side) or {}
        v = K.american_to_decimal((node.get("close") or node.get("open") or {}).get("odds"))
        if v:
            out[key] = v
    tot = o.get("total") or {}
    try:
        over = (tot.get("over") or {}).get("close") or {}
        under = (tot.get("under") or {}).get("close") or {}
        out["total"] = float(str(over.get("line", "")).lstrip("ou"))
        out["O"] = K.american_to_decimal(over.get("odds"))
        out["U"] = K.american_to_decimal(under.get("odds"))
    except (TypeError, ValueError):
        if o.get("overUnder") is not None:
            out["total"] = float(o["overUnder"])
    return {k: v for k, v in out.items() if v is not None}


def _reg(g):
    """Rezultat regularnog dijela: kod produžetaka/raspucavanja bilo je neriješeno."""
    t, h, a, hs, as_, ot = g
    if ot:
        m = min(hs, as_)
        return (t.date(), h, a, m, m)
    return (t.date(), h, a, hs, as_)


def nhl_model(seasons, today, teams):
    per = [[_reg(g) for g in s] for s in seasons]
    return M.LeagueModel("NHL", per, today, season_teams=set(teams))


def nhl_backtest(prev, older):
    """Tjedno, samo iz ranijih utakmica: pogađa li model pobjednika (uključujući produžetke)."""
    start = prev[0][0] + dt.timedelta(days=21)
    weeks = {}
    for g in prev:
        if g[0] >= start:
            weeks.setdefault((g[0] - dt.timedelta(days=g[0].weekday())).date(), []).append(g)
    n = hit = home = 0
    ll = 0.0
    teams = {t for g in prev for t in (g[1], g[2])}
    for wk in sorted(weeks):
        cut = wk - dt.timedelta(days=1)
        mdl = M.LeagueModel("NHL", [[_reg(g) for g in prev if g[0].date() <= cut], [_reg(g) for g in older]], cut,
                            season_teams=teams)
        for t, h, a, hs, as_, ot in weeks[wk]:
            m, _, _ = mdl.score_matrix(h, a)
            p1 = sum(m[i][j] for i in range(len(m)) for j in range(len(m)) if i > j)
            px = sum(m[i][i] for i in range(len(m)))
            p = min(max(p1 + px / 2, 1e-4), 1 - 1e-4)
            won = hs > as_
            n += 1; hit += (p > .5) == won; home += won
            ll += -math.log(p if won else 1 - p)
    return {"n": n, "hitModel": round(hit / n, 4), "hitHome": round(home / n, 4), "logLoss": round(ll / n, 4)}


def nhl_table(games, teams):
    tab = {t: {"team": t, "p": 0, "w": 0, "l": 0, "otl": 0, "pf": 0, "pa": 0, "pts": 0, "form": []} for t in teams}
    for _, h, a, hs, as_, ot in sorted(games):
        for t, f, ag in ((h, hs, as_), (a, as_, hs)):
            if t not in tab:
                continue
            r = tab[t]; r["p"] += 1; r["pf"] += f; r["pa"] += ag
            if f > ag:
                r["w"] += 1; r["pts"] += 2; r["form"].append("W")
            elif ot:
                r["otl"] += 1; r["pts"] += 1; r["form"].append("D")
            else:
                r["l"] += 1; r["form"].append("L")
    for r in tab.values():
        r["form"] = "".join(r["form"][-5:])
    return sorted(tab.values(), key=lambda r: (-r["pts"], -(r["pf"] - r["pa"])))


# ================================================================ TENIS (ATP / WTA)

def _bo(tournament, men):
    return 5 if men and any(s in tournament.lower() for s in GRAND_SLAMS) else 3


def load_tennis(today, force=False, days_back=800):
    """Svi pojedinačni mečevi iz ESPN rasporeda (ATP i WTA) i nadolazeći mečevi."""
    seen, done, upcoming = set(), [], []
    now = dt.datetime.now(dt.timezone.utc)
    for tour in ("atp", "wta"):
        for back in range(-FIXTURE_DAYS, days_back, 3):
            day = today - dt.timedelta(days=back)
            d = day.strftime("%Y%m%d")
            age = None if back > 14 else (0 if force else 3 * 3600)
            js = K._get(f"{ESPN}/tennis/{tour}/scoreboard?dates={d}", os.path.join(DIR, f"ten_{tour}_{d}.json"), age) or {}
            for e in js.get("events", []):
                tname = e.get("name", "")
                for g in e.get("groupings", []):
                    gname = g.get("grouping", {}).get("displayName", "")
                    if "Singles" not in gname:
                        continue
                    men = gname.startswith("Men")
                    league = "ATP" if men else "WTA"
                    for c in g.get("competitions", []):
                        if c["id"] in seen:
                            continue
                        comp = c.get("competitors", [])
                        if len(comp) != 2:
                            continue
                        names = [x.get("athlete", {}).get("displayName") for x in comp]
                        # protivnik još nepoznat ("TBD", kvalifikant) - preskoči
                        if not all(names) or any(n.strip().upper() in ("TBD", "TBA", "BYE") or n.lower().startswith("qualifier") for n in names):
                            continue
                        st = c["status"]["type"]
                        when = K._utc(c["date"])
                        if st.get("completed"):
                            if st.get("name") == "STATUS_WALKOVER":
                                continue
                            win = [bool(x.get("winner")) for x in comp]
                            if not any(win):
                                continue
                            sets = [0, 0]
                            ls = [[l.get("value") or 0 for l in x.get("linescores", [])] for x in comp]
                            for k in range(min(len(ls[0]), len(ls[1]))):
                                g0, g1 = ls[0][k], ls[1][k]
                                # broji se samo završen set (6+ gemova s razlikom 2, ili 7 nakon tie-breaka)
                                if max(g0, g1) < 6 or (abs(g0 - g1) < 2 and max(g0, g1) != 7):
                                    continue
                                sets[0 if g0 > g1 else 1] += 1
                            seen.add(c["id"])
                            fs = 0   # pobjednik 1. seta (1/2), 0 ako nije poznat
                            if ls[0] and ls[1] and max(ls[0][0], ls[1][0]) >= 6:
                                fs = 1 if ls[0][0] > ls[1][0] else 2
                            done.append((when, league, names[0], names[1], 0 if win[0] else 1, sets[0], sets[1],
                                         st.get("name") == "STATUS_RETIRED", fs))
                        elif st.get("state") == "pre" and when > now and when < now + dt.timedelta(days=FIXTURE_DAYS):
                            seen.add(c["id"])
                            upcoming.append({"league": league, "utc": when.strftime("%Y-%m-%dT%H:%MZ"),
                                             "home": names[0], "away": names[1], "odds": {},
                                             "bo": _bo(tname, men), "tournament": tname,
                                             "round": (c.get("round") or {}).get("displayName", "")})
    done.sort()
    return done, upcoming


def elo_k(n):
    return 250 / ((n + 5) ** 0.4)   # brže mijenjanje za igrače s malo mečeva (FiveThirtyEight)


def elo_run(matches, until=None, record=None):
    """Elo po ligi (ATP/WTA). record: lista u koju se upisuju predviđanja prije svakog meča."""
    R, N = {}, {}
    for m in matches:
        when, lg, a, b, winner = m[0], m[1], m[2], m[3], m[4]
        if until and when >= until:
            break
        ka, kb = (lg, a), (lg, b)
        ra, rb = R.get(ka, 1500.0), R.get(kb, 1500.0)
        pa = 1 / (1 + 10 ** ((rb - ra) / 400))
        if record is not None:
            record.append((m, pa, N.get(ka, 0), N.get(kb, 0)))
        sa = 1.0 if winner == 0 else 0.0
        R[ka] = ra + elo_k(N.get(ka, 0)) * (sa - pa)
        R[kb] = rb + elo_k(N.get(kb, 0)) * ((1 - sa) - (1 - pa))
        N[ka] = N.get(ka, 0) + 1
        N[kb] = N.get(kb, 0) + 1
    return R, N


def tennis_backtest(matches, today):
    """Predviđanja prije svakog meča u zadnjih 180 dana (Elo se gradi samo iz ranijih mečeva)."""
    rec = []
    elo_run(matches, record=rec)
    cut = dt.datetime.combine(today - dt.timedelta(days=180), dt.time(), dt.timezone.utc)
    out = {}
    for lg in ("ATP", "WTA"):
        rows = [(m, p) for m, p, na, nb in rec if m[1] == lg and m[0] >= cut and na >= 10 and nb >= 10]
        if not rows:
            continue
        n = len(rows)
        hit = sum((p > .5) == (m[4] == 0) for m, p in rows)
        ll = sum(-math.log(max(p if m[4] == 0 else 1 - p, 1e-4)) for m, p in rows)
        out[lg] = {"n": n, "hitModel": round(hit / n, 4), "logLoss": round(ll / n, 4)}
    return out


def tennis_forms(matches, names):
    """Zadnjih 5 mečeva igrača iz svih turnira, najstariji prvi."""
    form = {}
    for m in sorted(matches, key=lambda m: m[0]):
        for k, name in ((0, m[2]), (1, m[3])):
            if name in names:
                form.setdefault(name, []).append("W" if m[4] == k else "L")
    return {n: "".join(f[-5:]) for n, f in form.items()}


def tennis_table(matches, R, N, lg, today):
    since = dt.datetime.combine(today - dt.timedelta(days=365), dt.time(), dt.timezone.utc)
    wl, form = {}, {}
    for m in matches:
        if m[1] != lg or m[0] < since:
            continue
        for k, name in ((0, m[2]), (1, m[3])):
            r = wl.setdefault(name, [0, 0]); won = m[4] == k
            r[0 if won else 1] += 1
            form.setdefault(name, []).append("W" if won else "L")
    rows = [{"team": n, "elo": round(R[(lg, n)]), "w": wl[n][0], "l": wl[n][1], "p": sum(wl[n]),
             "form": "".join(form[n][-5:])} for n in wl if (lg, n) in R]
    rows.sort(key=lambda r: -r["elo"])
    return rows


# ================================================================ izgradnja

def build(today=None, force=False, accuracy=None):
    today = today or dt.date.today()
    now = dt.datetime.now(dt.timezone.utc)
    acc = accuracy or {}
    out = {"leagues": [], "fixtures": [], "results": []}
    # --- hokej
    try:
        d = load_nhl(today, force)
        mdl = nhl_model(d["seasons"], today, d["teams"])
        teams = d["teams"]
        out["leagues"].append({
            "code": "NHL", "sport": "hok", "model": "poisson", "name": "NHL", "flag": "USA", "country": "SAD",
            # hokej se iz rezultata slabo predviđa (provjera: ~53 %), pa se gotovo potpuno oslanjamo na kvote
            "weight": 0.9, "hasOdds": True, "teams": teams, "aliases": d["aliases"],
            "table": nhl_table(d["seasons"][0], teams),
            "mu": _r(mdl.mu), "home": _r(mdl.home), "rho": _r(mdl.rho),
            "att": {t: _r(mdl.att.get(t, 0)) for t in teams}, "de": {t: _r(mdl.de.get(t, 0)) for t in teams},
            "accuracy": acc.get("NHL"),
        })
        out["fixtures"] += [f for f in d["fixtures"] if f["home"] in teams and f["away"] in teams]
        cutoff = now - dt.timedelta(days=RESULT_DAYS["hok"])
        out["results"] += [[g[0].strftime("%Y-%m-%dT%H:%MZ"), "NHL", g[1], g[2], g[3], g[4], int(g[5])]
                           for s in d["seasons"] for g in s if g[0] >= cutoff]
        print(f"  NHL: {len(d['seasons'][0])} utakmica ove sezone, {len(d['fixtures'])} nadolazećih")
    except Exception as e:
        print("  ! NHL nije uspio:", e)
    # --- tenis
    try:
        matches, upcoming = load_tennis(today, force)
        R, N = elo_run(matches)
        active = dt.datetime.combine(today - dt.timedelta(days=365), dt.time(), dt.timezone.utc)
        for lg, name in (("ATP", "ATP (muški)"), ("WTA", "WTA (ženski)")):
            players = sorted({n for m in matches if m[1] == lg and m[0] >= active for n in (m[2], m[3])}
                             | {n for f in upcoming if f["league"] == lg for n in (f["home"], f["away"])})
            out["leagues"].append({
                "code": lg, "sport": "ten", "model": "elo", "name": name, "flag": lg, "country": "Svijet",
                "weight": 0, "hasOdds": False, "teams": players, "aliases": {},
                "elo": {p: round(R.get((lg, p), 1500.0), 1) for p in players},
                "n": {p: N.get((lg, p), 0) for p in players},
                "table": tennis_table(matches, R, N, lg, today)[:100],
                "forms": tennis_forms(matches, {n for f in upcoming if f["league"] == lg for n in (f["home"], f["away"])}),
                "accuracy": acc.get(lg),
            })
        out["fixtures"] += upcoming
        cutoff = now - dt.timedelta(days=RESULT_DAYS["ten"])
        out["results"] += [[m[0].strftime("%Y-%m-%dT%H:%MZ"), m[1], m[2], m[3], m[5], m[6], 1 if m[4] == 0 else 2, m[8]]
                           for m in matches if m[0] >= cutoff]
        print(f"  Tenis: {len(matches)} mečeva, {len(upcoming)} nadolazećih")
    except Exception as e:
        print("  ! Tenis nije uspio:", e)
    out["fixtures"].sort(key=lambda f: f["utc"])
    return out


def run_backtest(path):
    today = dt.date.today()
    res = {}
    d = load_nhl(today, seasons_back=2)
    r = nhl_backtest(d["seasons"][1], d["seasons"][2])
    res["NHL"] = r
    print(f"NHL: n={r['n']}  model pogađa pobjednika {r['hitModel']:.1%}  (uvijek domaćin {r['hitHome']:.1%})  log-loss {r['logLoss']}")
    matches, _ = load_tennis(today)
    for lg, r in tennis_backtest(matches, today).items():
        res[lg] = r
        print(f"{lg}: n={r['n']}  Elo pogađa pobjednika {r['hitModel']:.1%}  log-loss {r['logLoss']}")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"made": today.isoformat(), "leagues": res}, f, ensure_ascii=False, indent=1)
    return res


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    run_backtest(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tocnost_ostalo.json"))
