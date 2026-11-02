"""Košarka: NBA (ESPN) i Euroliga (službeni API Eurolige) - podaci i model poena.

Model: očekivani poeni domaćina = mu + prednost terena + napad(domaćin) - obrana(gost),
gosta = mu + napad(gost) - obrana(domaćin). Iz razlike i zbroja (normalna raspodjela)
dobiju se šanse za pobjedu, hendikep i ukupno poena.
"""
import datetime as dt
import json
import math
import os
import time
import urllib.request

import model as M

ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
EL = "https://api-live.euroleague.net/v2/competitions/E/seasons"
DIR = os.path.join(M.DATA_DIR, "kosarka")
HALF_LIFE = 120   # dana
REG = 4.0         # koliko jako ocjene vučemo prema prosjeku
FIXTURE_DAYS = 8

LEAGUES = {
    # reg i half_life odabrani provjerom na prošloj sezoni (python basket.py)
    "NBA": {"name": "NBA", "flag": "USA", "country": "SAD", "marketWeight": 0.75, "reg": 4.0, "half_life": 120},
    "EL": {"name": "Euroliga", "flag": "EUR", "country": "Europa", "marketWeight": 0.0, "reg": 10.0, "half_life": 180},
}


def _get(url, path, max_age):
    """JSON s weba uz spremanje na disk. max_age=None: nikad ne osvježavaj (stara sezona)."""
    if os.path.exists(path) and (max_age is None or time.time() - os.path.getmtime(path) < max_age):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 nogomet-tiket", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=40) as r:
            data = json.loads(r.read())
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return data
    except Exception as e:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        print(f"  ! Ne mogu skinuti {url}: {e}")
        return None


def american_to_decimal(s):
    try:
        v = float(str(s).replace("+", ""))
    except (TypeError, ValueError):
        return None
    if v == 0:
        return None
    return round(1 + (v / 100 if v > 0 else 100 / -v), 3)


def _utc(s):
    s = s.replace("Z", "+00:00")
    if len(s) == 16 + 6:  # 2026-11-03T00:00+00:00
        s = s[:16] + ":00" + s[16:]
    return dt.datetime.fromisoformat(s).astimezone(dt.timezone.utc)


# ---------------------------------------------------------------- NBA

def nba_season(today):
    return today.year + 1 if today.month >= 8 else today.year   # ESPN: godina završetka sezone


def load_nba(today, force=False):
    cur = nba_season(today)
    teams_js = _get(f"{ESPN}/teams", os.path.join(DIR, "nba_teams.json"), 30 * 86400)
    teams = [t["team"] for t in teams_js["sports"][0]["leagues"][0]["teams"]]
    aliases = {}
    for t in teams:
        for a in (t.get("shortDisplayName"), t.get("name"), t.get("abbreviation"), t.get("location")):
            if a and a not in ("Los Angeles",):
                aliases[a] = t["displayName"]
    seasons = {}
    for season in (cur, cur - 1):
        games = {}
        for t in teams:
            age = None if season < cur else (0 if force else M.MAX_AGE)
            js = _get(f"{ESPN}/teams/{t['id']}/schedule?season={season}",
                      os.path.join(DIR, f"nba_{season}_{t['id']}.json"), age)
            for ev in (js or {}).get("events", []):
                c = ev["competitions"][0]
                if not c["status"]["type"]["completed"]:
                    continue
                side = {x["homeAway"]: x for x in c["competitors"]}
                try:
                    hs, as_ = int(side["home"]["score"]["value"]), int(side["away"]["score"]["value"])
                except (KeyError, TypeError, ValueError):
                    continue
                games[ev["id"]] = (_utc(ev["date"]), side["home"]["team"]["displayName"],
                                   side["away"]["team"]["displayName"], hs, as_)
        seasons[season] = sorted(games.values())
    # nadolazeće utakmice s kvotama (ESPN datumi su američki)
    fixtures = []
    for i in range(FIXTURE_DAYS):
        d = (today + dt.timedelta(days=i - 1)).strftime("%Y%m%d")
        js = _get(f"{ESPN}/scoreboard?dates={d}", os.path.join(DIR, f"nba_sb_{d}.json"), 0 if force else 3 * 3600)
        for ev in (js or {}).get("events", []):
            c = ev["competitions"][0]
            if c["status"]["type"]["completed"] or c["status"]["type"]["state"] != "pre":
                continue
            side = {x["homeAway"]: x["team"]["displayName"] for x in c["competitors"]}
            fixtures.append({"league": "NBA", "utc": _utc(ev["date"]).strftime("%Y-%m-%dT%H:%MZ"),
                             "home": side["home"], "away": side["away"], "odds": _nba_odds(c)})
    return {"current": seasons[cur], "previous": seasons[cur - 1], "fixtures": fixtures,
            "aliases": aliases, "teams": sorted(t["displayName"] for t in teams)}


def _nba_odds(c):
    o = (c.get("odds") or [{}])[0]
    out = {}
    ml = o.get("moneyline") or {}
    for side, key in (("home", "1"), ("away", "2")):
        v = american_to_decimal(((ml.get(side) or {}).get("close") or {}).get("odds"))
        if v:
            out[key] = v
    ps = o.get("pointSpread") or {}
    try:
        line = float(((ps.get("home") or {}).get("close") or {}).get("line"))
        out["spread"] = line
        out["H1"] = american_to_decimal(ps["home"]["close"].get("odds"))
        out["H2"] = american_to_decimal(((ps.get("away") or {}).get("close") or {}).get("odds"))
    except (TypeError, ValueError, KeyError):
        if o.get("spread") is not None:
            out["spread"] = float(o["spread"])
    tot = o.get("total") or {}
    try:
        out["total"] = float(str(((tot.get("over") or {}).get("close") or {}).get("line", "")).lstrip("ou"))
        out["O"] = american_to_decimal(tot["over"]["close"].get("odds"))
        out["U"] = american_to_decimal(((tot.get("under") or {}).get("close") or {}).get("odds"))
    except (TypeError, ValueError, KeyError):
        if o.get("overUnder") is not None:
            out["total"] = float(o["overUnder"])
    return {k: v for k, v in out.items() if v is not None}


# ---------------------------------------------------------------- Euroliga

def el_season(today):
    return today.year if today.month >= 8 else today.year - 1


def load_el(today, force=False):
    cur = el_season(today)
    seasons, fixtures, aliases, teams = {}, [], {}, set()
    for season in (cur, cur - 1):
        age = None if season < cur else (0 if force else M.MAX_AGE)
        js = _get(f"{EL}/E{season}/games", os.path.join(DIR, f"el_E{season}.json"), age) or {}
        games = []
        for g in js.get("data", []):
            h, a = g["local"]["club"], g["road"]["club"]
            if season == cur:
                teams.update((h["name"], a["name"]))
            for club in (h, a):
                for al in (club.get("editorialName"), club.get("abbreviatedName"), club.get("tvCode"), club.get("code")):
                    if al and al != club["name"]:
                        aliases[al] = club["name"]
            when = _utc(g["utcDate"])
            if g.get("played"):
                games.append((when, h["name"], a["name"], int(g["local"]["score"]), int(g["road"]["score"])))
            elif season == cur and dt.timedelta(hours=-3) < when - dt.datetime.now(dt.timezone.utc) < dt.timedelta(days=FIXTURE_DAYS):
                fixtures.append({"league": "EL", "utc": when.strftime("%Y-%m-%dT%H:%MZ"),
                                 "home": h["name"], "away": a["name"], "odds": {}})
        seasons[season] = sorted(games)
    return {"current": seasons[cur], "previous": seasons[cur - 1], "fixtures": fixtures,
            "aliases": aliases, "teams": sorted(teams)}


# ---------------------------------------------------------------- model

class PointsModel:
    def __init__(self, games, now, teams=None, reg=REG, iters=40, half_life=HALF_LIFE):
        games = [g for g in games if g[0] <= now]
        self.n = len(games)
        names = sorted({g[1] for g in games} | {g[2] for g in games} | set(teams or []))
        w = [0.5 ** (max((now - g[0]).total_seconds(), 0) / 86400 / half_life) for g in games]
        sw = sum(w) or 1
        mu = sum(wi * (g[3] + g[4]) / 2 for g, wi in zip(games, w)) / sw if games else 110
        home = sum(wi * (g[3] - g[4]) for g, wi in zip(games, w)) / sw / 2 if games else 1.5
        off = {t: 0.0 for t in names}
        de = {t: 0.0 for t in names}
        for _ in range(iters):
            # napad
            num = {t: -reg * off[t] for t in names}; den = {t: reg for t in names}
            for g, wi in zip(games, w):
                _, h, a, hs, as_ = g
                num[h] += wi * (hs - (mu + home + off[h] - de[a])); den[h] += wi
                num[a] += wi * (as_ - (mu - home + off[a] - de[h])); den[a] += wi
            for t in names:
                off[t] += num[t] / den[t]
            # obrana
            num = {t: -reg * de[t] for t in names}; den = {t: reg for t in names}
            for g, wi in zip(games, w):
                _, h, a, hs, as_ = g
                num[a] -= wi * (hs - (mu + home + off[h] - de[a])); den[a] += wi
                num[h] -= wi * (as_ - (mu - home + off[a] - de[h])); den[h] += wi
            for t in names:
                de[t] += num[t] / den[t]
            # prosjek i prednost terena
            r_mu = r_h = 0.0
            for g, wi in zip(games, w):
                _, h, a, hs, as_ = g
                eh, ea = mu + home + off[h] - de[a], mu - home + off[a] - de[h]
                r_mu += wi * ((hs - eh) + (as_ - ea)) / 2
                r_h += wi * ((hs - eh) - (as_ - ea)) / 2
            mu += r_mu / sw
            home += r_h / sw
        self.mu, self.home, self.off, self.de = mu, home, off, de
        # raspršenost razlike i zbroja
        sm = st = 0.0
        for g, wi in zip(games, w):
            eh, ea = self.points(g[1], g[2])
            sm += wi * ((g[3] - g[4]) - (eh - ea)) ** 2
            st += wi * ((g[3] + g[4]) - (eh + ea)) ** 2
        self.sd_margin = math.sqrt(sm / sw) if games else 12.0
        self.sd_total = math.sqrt(st / sw) if games else 18.0

    def points(self, h, a):
        return (self.mu + self.home + self.off.get(h, 0) - self.de.get(a, 0),
                self.mu - self.home + self.off.get(a, 0) - self.de.get(h, 0))


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def table(games, teams):
    tab = {t: {"team": t, "p": 0, "w": 0, "l": 0, "pf": 0, "pa": 0, "form": []} for t in teams}
    for _, h, a, hs, as_ in sorted(games):
        for t, f, ag in ((h, hs, as_), (a, as_, hs)):
            if t not in tab:
                continue
            r = tab[t]; r["p"] += 1; r["pf"] += f; r["pa"] += ag
            win = f > ag
            r["w" if win else "l"] += 1
            r["form"].append("W" if win else "L")
    for r in tab.values():
        r["form"] = "".join(r["form"][-5:])
    return sorted(tab.values(), key=lambda r: (-(r["w"] / r["p"] if r["p"] else 0), -(r["pf"] - r["pa"])))


def backtest(prev, prior, params):
    """Provjera na prošloj sezoni: tjedno računanje samo iz ranijih utakmica (i sezone prije)."""
    if len(prev) < 100:
        return None
    start = prev[0][0] + dt.timedelta(days=21)
    weeks = {}
    for g in prev:
        if g[0] >= start:
            wk = (g[0] - dt.timedelta(days=g[0].weekday())).date()
            weeks.setdefault(wk, []).append(g)
    n = hit = home_hit = 0
    ll = 0.0
    for wk in sorted(weeks):
        cut = dt.datetime.combine(wk, dt.time(), dt.timezone.utc)
        m = PointsModel(prior + [g for g in prev if g[0] < cut], cut, reg=params["reg"], half_life=params["half_life"])
        for _, h, a, hs, as_ in weeks[wk]:
            eh, ea = m.points(h, a)
            p = min(max(phi((eh - ea) / m.sd_margin), 1e-4), 1 - 1e-4)
            won = hs > as_
            n += 1; hit += (p > .5) == won; home_hit += won
            ll += -math.log(p if won else 1 - p)
    return {"n": n, "hitModel": round(hit / n, 4), "hitHome": round(home_hit / n, 4), "logLoss": round(ll / n, 4)}


def build(today=None, force=False, accuracy=None):
    today = today or dt.date.today()
    now = dt.datetime.now(dt.timezone.utc)
    out = {"leagues": [], "fixtures": [], "results": []}
    accuracy = accuracy or {}
    for code, loader in (("NBA", load_nba), ("EL", load_el)):
        try:
            d = loader(today, force)
        except Exception as e:  # jedan izvor ne smije srušiti ostatak
            print(f"  ! {code}: {e}")
            continue
        info = LEAGUES[code]
        games = d["previous"] + d["current"]
        mdl = PointsModel(games, now, d["teams"], reg=info["reg"], half_life=info["half_life"])
        teams = d["teams"] or sorted({g[1] for g in d["current"]} | {g[2] for g in d["current"]})
        r2 = lambda x: round(x, 2)
        out["leagues"].append({
            "code": code, "name": info["name"], "flag": info["flag"], "country": info["country"],
            "weight": info["marketWeight"], "hasOdds": code == "NBA",
            "teams": teams, "aliases": d["aliases"], "table": table(d["current"], teams),
            "mu": r2(mdl.mu), "home": r2(mdl.home), "sdM": r2(mdl.sd_margin), "sdT": r2(mdl.sd_total),
            "off": {t: r2(mdl.off.get(t, 0)) for t in teams}, "def": {t: r2(mdl.de.get(t, 0)) for t in teams},
            "accuracy": accuracy.get(code),
        })
        out["fixtures"] += [f for f in d["fixtures"] if f["home"] in teams and f["away"] in teams]
        cutoff = now - dt.timedelta(days=150)
        out["results"] += [[g[0].strftime("%Y-%m-%dT%H:%MZ"), code, g[1], g[2], g[3], g[4]]
                           for g in games if g[0] >= cutoff]
        print(f"  {code}: {len(d['current'])} utakmica ove sezone, {len(d['previous'])} prošle, "
              f"{sum(1 for f in d['fixtures'] if f['home'] in teams)} nadolazećih")
    out["fixtures"].sort(key=lambda f: f["utc"])
    return out


def run_backtest(path):
    today = dt.date.today()
    res = {}
    for code, loader in (("NBA", load_nba), ("EL", load_el)):
        d = loader(today)
        older = loader(today.replace(year=today.year - 1))["previous"]  # sezona prije prošle
        r = backtest(d["previous"], older, LEAGUES[code])
        if r:
            res[code] = r
            print(f"{code}: n={r['n']}  model pogađa pobjednika {r['hitModel']:.1%}  "
                  f"(uvijek domaćin {r['hitHome']:.1%})  log-loss {r['logLoss']}")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"made": today.isoformat(), "leagues": res}, f, ensure_ascii=False, indent=1)
    return res


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    run_backtest(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tocnost_kosarka.json"))
