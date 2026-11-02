"""Nogometni raspored i kvote za idućih 7 dana s ESPN-a.

football-data.co.uk objavljuje utakmice tek kad izađu kvote (obično samo iduće kolo),
pa ostatak tjedna uzimamo s ESPN-a. Imena momčadi uparujemo s imenima iz naših podataka.
"""
import datetime as dt
import difflib
import os
import unicodedata

import basket as K   # _get, american_to_decimal, _utc
import model as M

BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
DIR = os.path.join(M.DATA_DIR, "espn_nogomet")
DAYS = 8

SLUGS = {"E0": "eng.1", "E1": "eng.2", "E2": "eng.3", "E3": "eng.4", "EC": "eng.5", "SP1": "esp.1", "SP2": "esp.2",
         "I1": "ita.1", "I2": "ita.2", "D1": "ger.1", "D2": "ger.2", "F1": "fra.1", "F2": "fra.2", "N1": "ned.1",
         "P1": "por.1", "B1": "bel.1", "T1": "tur.1", "G1": "gre.1", "SC0": "sco.1", "SC1": "sco.2", "SC2": "sco.3",
         "SC3": "sco.4"}

# ESPN ime -> naše ime, kad automatsko uparivanje ne uspije ili pogriješi
MANUAL = {
    "Atlético Madrid": "Ath Madrid", "Athletic Club": "Ath Bilbao", "Real Sociedad": "Sociedad",
    "Rayo Vallecano": "Vallecano", "Celta Vigo": "Celta", "Real Betis": "Betis", "Espanyol": "Espanol",
    "Manchester United": "Man United", "Manchester City": "Man City", "Nottingham Forest": "Nott'm Forest",
    "Wolverhampton Wanderers": "Wolves", "Brighton & Hove Albion": "Brighton", "AFC Bournemouth": "Bournemouth",
    "Tottenham Hotspur": "Tottenham", "West Ham United": "West Ham", "Newcastle United": "Newcastle",
    "Leeds United": "Leeds", "Sheffield Wednesday": "Sheffield Weds", "Sheffield United": "Sheffield United",
    "Queens Park Rangers": "QPR", "West Bromwich Albion": "West Brom", "Milton Keynes Dons": "Milton Keynes Dons",
    "Bayern Munich": "Bayern Munich", "Borussia Dortmund": "Dortmund", "Borussia Mönchengladbach": "M'gladbach",
    "Bayer Leverkusen": "Leverkusen", "Eintracht Frankfurt": "Ein Frankfurt", "1. FC Köln": "FC Koln",
    "1. FC Union Berlin": "Union Berlin", "VfB Stuttgart": "Stuttgart", "VfL Wolfsburg": "Wolfsburg",
    "TSG Hoffenheim": "Hoffenheim", "1. FC Heidenheim 1846": "Heidenheim", "FC St. Pauli": "St Pauli",
    "Hamburg SV": "Hamburg", "Werder Bremen": "Werder Bremen", "Mainz": "Mainz", "SC Freiburg": "Freiburg",
    "Paris Saint-Germain": "Paris SG", "AS Monaco": "Monaco", "Olympique Lyonnais": "Lyon", "Olympique de Marseille": "Marseille",
    "Marseille": "Marseille", "Lyon": "Lyon", "Stade Rennais": "Rennes", "AS Saint-Étienne": "St Etienne",
    "Saint-Étienne": "St Etienne", "AJ Auxerre": "Auxerre", "Stade Brestois 29": "Brest", "RC Strasbourg Alsace": "Strasbourg",
    "Internazionale": "Inter", "AC Milan": "Milan", "AS Roma": "Roma", "Hellas Verona": "Verona",
    "PSV Eindhoven": "PSV Eindhoven", "Ajax Amsterdam": "Ajax", "AZ Alkmaar": "AZ Alkmaar", "Feyenoord Rotterdam": "Feyenoord",
    "Sporting CP": "Sp Lisbon", "FC Porto": "Porto", "SC Braga": "Sp Braga", "Vitória de Guimarães": "Guimaraes",
    "Deportivo": "La Coruna", "Deportivo La Coruña": "La Coruna", "RC Celta Fortuna": "Celta B", "Real Sociedad II": "Sociedad B",
    "OH Leuven": "Oud-Heverlee Leuven", "Amed SFK": "Amedspor", "Erzurum BB": "Erzurumspor",
    "Istanbul Basaksehir": "Buyuksehyr", "Heart of Midlothian": "Hearts", "Inverness Caledonian Thistle": "Inverness C",
}

STOP = {"fc", "cf", "sc", "ac", "afc", "ssc", "as", "ss", "us", "rc", "sv", "vfb", "vfl", "tsg", "fsv", "kv", "krc",
        "kaa", "rsc", "sk", "fk", "cd", "ud", "sd", "rcd", "club", "de", "la", "calcio", "1", "the", "town", "city",
        "united", "athletic", "fk", "afc", "cfc", "sad", "kas", "ksv", "royal", "ca", "cp"}


def _n(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    for ch in ".'-_&/()":
        s = s.replace(ch, " ")
    return " ".join(s.split())


def _core(s):
    return " ".join(w for w in _n(s).split() if w not in STOP)


def match(espn, teams, aliases):
    """Naše ime za ESPN ime unutar jedne lige, ili None."""
    if espn in MANUAL and MANUAL[espn] in teams:
        return MANUAL[espn]
    n = _n(espn)
    for t in teams:
        if _n(t) == n:
            return t
    al = aliases.get(n) or aliases.get(_core(espn))
    if al in teams:
        return al
    c = _core(espn)
    best, bs = None, 0.0
    for t in teams:
        ct = _core(t) or _n(t)
        if not ct:
            continue
        if c and (c == ct or c.startswith(ct + " ") or ct.startswith(c + " ") or ct in c.split() or c in ct.split()):
            s = 0.95
        else:
            s = max(difflib.SequenceMatcher(None, c, ct).ratio(), difflib.SequenceMatcher(None, n, _n(t)).ratio())
        if s > bs:
            best, bs = t, s
    return best if bs >= 0.72 else None


def _uk(utc):
    """Britansko lokalno vrijeme (kao u football-data): ljeti UTC+1."""
    y = utc.year
    last_sun = lambda m: max(dt.date(y, m, d) for d in range(25, 32) if dt.date(y, m, d).weekday() == 6)
    start = dt.datetime.combine(last_sun(3), dt.time(1), dt.timezone.utc)
    end = dt.datetime.combine(last_sun(10), dt.time(1), dt.timezone.utc)
    return utc + dt.timedelta(hours=1 if start <= utc < end else 0)


def _odds(c):
    o = (c.get("odds") or [{}])[0] or {}
    out = {}
    ml = o.get("moneyline") or {}
    for side, key in (("home", "1"), ("draw", "X"), ("away", "2")):
        node = ml.get(side) or {}
        v = K.american_to_decimal((node.get("close") or node.get("open") or {}).get("odds"))
        if v:
            out[key] = v
    if "X" not in out and (o.get("drawOdds") or {}).get("moneyLine") is not None:
        v = K.american_to_decimal((o.get("drawOdds") or {}).get("moneyLine"))
        if v:
            out["X"] = v
    tot = o.get("total") or {}
    try:
        over = (tot.get("over") or {}).get("close") or (tot.get("over") or {}).get("open") or {}
        under = (tot.get("under") or {}).get("close") or (tot.get("under") or {}).get("open") or {}
        line = float(str(over.get("line", "")).lstrip("ou"))
        if line == 2.5:
            out["O2.5"] = K.american_to_decimal(over.get("odds"))
            out["U2.5"] = K.american_to_decimal(under.get("odds"))
    except (TypeError, ValueError):
        pass
    if not all(out.get(k) for k in ("1", "X", "2")):
        for k in ("1", "X", "2"):
            out.pop(k, None)
    return {k: v for k, v in out.items() if v}


def fixtures(models, today=None, force=False, report=False):
    """Nadolazeće utakmice za 8 dana: [{league, iso, time, home, away, odds, src}] (britansko vrijeme)."""
    today = today or dt.date.today()
    now = dt.datetime.now(dt.timezone.utc)
    out, unmatched = [], {}
    aliases = {_n(k): v for k, v in M.ALIASES.items()}
    for code, slug in SLUGS.items():
        if code not in models:
            continue
        teams = models[code].teams
        seen = {}
        for i in range(DAYS):
            d = (today + dt.timedelta(days=i)).strftime("%Y%m%d")
            js = K._get(f"{BASE}/{slug}/scoreboard?dates={d}", os.path.join(DIR, f"{slug}_{d}.json"),
                        0 if force else 3 * 3600) or {}
            for ev in js.get("events", []):
                c = ev["competitions"][0]
                if c["status"]["type"]["state"] != "pre":
                    continue
                when = K._utc(ev["date"])
                if when < now:
                    continue
                side = {x["homeAway"]: x["team"]["displayName"] for x in c["competitors"]}
                h, a = (match(side["home"], teams, aliases), match(side["away"], teams, aliases))
                for e, t in ((side["home"], h), (side["away"], a)):
                    seen[e] = t
                if not h or not a or h == a:
                    unmatched.setdefault(code, set()).update(x for x, t in ((side["home"], h), (side["away"], a)) if not t)
                    continue
                uk = _uk(when)
                out.append({"league": code, "iso": uk.date().isoformat(), "time": uk.strftime("%H:%M"),
                            "home": h, "away": a, "odds": _odds(c), "src": "espn"})
        if report:
            used = [t for t in seen.values() if t]
            dup = {t for t in used if used.count(t) > 1}
            print(f"{code}: " + ", ".join(f"{e} → {t or '???'}" for e, t in sorted(seen.items())) + (f"   !!! DUPLIKAT: {dup}" if dup else ""))
    if unmatched:
        print("  Neupareno:", {k: sorted(v) for k, v in unmatched.items()})
    return out


if __name__ == "__main__":
    import sys
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    leagues, _, _ = M.load_all()
    fx = fixtures(M.build_models(leagues), report=True)
    print(len(fx), "utakmica")
