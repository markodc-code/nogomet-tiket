"""Hrvatske lige: SuperSport HNL (FotMob) i Prva NL (TheSportsDB, kolo po kolo).

Odigrane sezone i kola spremaju se zauvijek, pa se nakon prvog skidanja
dohvaća samo tekuća sezona HNL-a i tekuća kola Prve NL.
"""
import datetime as dt
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

import model as M

DIR = os.path.join(M.DATA_DIR, "hrvatska")
FOTMOB = "https://www.fotmob.com/api/data/leagues?id=252&season={season}"
TSDB = "https://www.thesportsdb.com/api/v1/json/123/eventsround.php?id=4952&r={r}&s={season}"
DONE = {"FT", "AET", "PEN", "Match Finished", "AOT"}
FRESH = 3 * 3600
_last = [0.0]


def _uk(utc):
    import espn_soccer as E
    return E._uk(utc)


def _http(url, gap=0.0):
    wait = gap - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 nogomet-tiket"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read())


def _cached(path, refresh, url, gap=0.0):
    """refresh: treba li osvježiti postojeću datoteku. Ako skidanje ne uspije, ostaje stara."""
    old = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
        if not refresh(old, time.time() - os.path.getmtime(path)):
            return old
    data = _http(url, gap)
    os.makedirs(DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return data


def _fixture(code, utc, h, a):
    uk = _uk(utc)
    return {"league": code, "iso": uk.date().isoformat(), "time": uk.strftime("%H:%M"),
            "home": h, "away": a, "odds": {}, "src": "hr"}


# ---------------------------------------------------------------- HNL (FotMob)

def load_hnl(years, today, force):
    per, fixtures = [], []
    for i, y in enumerate(years):
        season = f"{y}/{y + 1}"
        path = os.path.join(DIR, f"hnl_{y}.json")
        cur = i == 0
        try:
            d = _cached(path, lambda old, age: cur and (force or age > FRESH),
                        FOTMOB.format(season=urllib.parse.quote(season, safe="")))
        except Exception as e:
            print(f"  ! HNL {season}: {e}")
            d = None
        ms = []
        for m in ((d or {}).get("fixtures") or {}).get("allMatches") or []:
            st = m.get("status") or {}
            try:
                utc = dt.datetime.fromisoformat(st["utcTime"].replace("Z", "+00:00"))
            except (KeyError, ValueError):
                continue
            h, a = m["home"]["name"], m["away"]["name"]
            if st.get("finished") and not st.get("cancelled") and st.get("scoreStr"):
                try:
                    hs, as_ = (int(x) for x in st["scoreStr"].split("-"))
                except ValueError:
                    continue
                ms.append((utc.date(), h, a, hs, as_))
            elif cur and not st.get("started") and not st.get("cancelled") and utc.date() >= today:
                fixtures.append(_fixture("HR1", utc, h, a))
        per.append(ms)
    return per, fixtures


# ---------------------------------------------------------------- Prva NL (TheSportsDB)

def _tsdb_round(season, r, today, force, budget):
    path = os.path.join(DIR, f"prvanl_{season}_{r}.json")

    def refresh(old, age):
        ev = old.get("events") or []
        last = max((e.get("dateEvent") or "" for e in ev), default="")
        settled = ev and all(e.get("strStatus") in DONE or e.get("strPostponed") == "yes" for e in ev) \
            and last < (today - dt.timedelta(days=3)).isoformat()
        if settled or (not ev and season != seasons_tsdb(today)[0]):
            return False
        return force or age > FRESH

    if not os.path.exists(path) or refresh(json.load(open(path, encoding="utf-8")), time.time() - os.path.getmtime(path)):
        if budget[0] <= 0:      # ostatak skidamo idući put (besplatni izvor ograničava broj upita)
            return (json.load(open(path, encoding="utf-8")).get("events") or []) if os.path.exists(path) else None
        budget[0] -= 1
    try:
        return (_cached(path, refresh, TSDB.format(r=r, season=season), gap=3.0) or {}).get("events") or []
    except urllib.error.HTTPError as e:
        if e.code == 429:
            budget[0] = 0
        print(f"  ! Prva NL {season} kolo {r}: {e}")
    except Exception as e:
        print(f"  ! Prva NL {season} kolo {r}: {e}")
    return None


def seasons_tsdb(today, count=2):
    y = today.year if today.month >= 7 else today.year - 1
    return [f"{x}-{x + 1}" for x in range(y, y - count, -1)]


def load_prvanl(today, force, count, budget=25):
    budget = [budget]
    per, fixtures = [], []
    seasons = seasons_tsdb(today, count)
    for si, season in enumerate(seasons):
        ms, empty = [], 0
        for r in range(1, 45):
            ev = _tsdb_round(season, r, today, force, budget)
            if ev is None:          # nije skinuto (ograničenje) - preskoči, probaj sljedeće
                continue
            if not ev:
                empty += 1
                if empty >= 2:
                    break
                continue
            empty = 0
            for e in ev:
                h, a = (e.get("strHomeTeam") or "").strip(), (e.get("strAwayTeam") or "").strip()
                try:
                    utc = dt.datetime.fromisoformat((e.get("strTimestamp") or f"{e['dateEvent']}T{e.get('strTime') or '15:00:00'}")[:19]) \
                        .replace(tzinfo=dt.timezone.utc)
                except (KeyError, ValueError):
                    continue
                hs, as_ = e.get("intHomeScore"), e.get("intAwayScore")
                if e.get("strStatus") in DONE and hs not in (None, "") and as_ not in (None, ""):
                    ms.append((utc.date(), h, a, int(hs), int(as_)))
                elif si == 0 and e.get("strStatus") in ("NS", "TBD", "", None) and utc.date() >= today:
                    fixtures.append(_fixture("HR2", utc, h, a))
        per.append(ms)
    return per, fixtures


def load(today=None, force=False, count=3):
    """Vraća ({kod: [sezona, ...]} najnovija prva, [nadolazeće utakmice])."""
    today = today or dt.date.today()
    y0 = today.year if today.month >= 7 else today.year - 1
    hnl, f1 = load_hnl(list(range(y0, y0 - count, -1)), today, force)
    pnl, f2 = load_prvanl(today, force, min(count, 2))
    pnl += [[] for _ in range(count - len(pnl))]
    leagues = {"HR1": hnl, "HR2": pnl}
    for c in leagues:
        print(f"  {M.LEAGUES[c]}: {[len(s) for s in leagues[c]]} utakmica po sezoni")
    return leagues, f1 + f2


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    lg, fx = load()
    for c in lg:
        print(c, sorted({t for m in lg[c][0] for t in m[1:3]}))
    for f in fx[:16]:
        print(f)
