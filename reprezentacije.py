"""Reprezentacije: prijateljske utakmice, Liga nacija, kvalifikacije i velika natjecanja.

Povijest rezultata: javni popis svih reprezentativnih utakmica (github.com/martj42/international_results),
dopunjen ESPN-om za zadnje tjedne. Raspored i kvote: ESPN. Jedan zajednički model jakosti za sve
reprezentacije (Dixon-Coles kao kod liga), a svako natjecanje je zasebna "liga" u ponudi.
"""
import concurrent.futures as cf
import csv
import datetime as dt
import os
import re
import time
import unicodedata
import urllib.request

import basket as K
import espn_soccer as E
import model as M

BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
HIST_URL = "https://raw.githubusercontent.com/martj42/international_results/master/results.csv"
DIR = os.path.join(M.DATA_DIR, "reprezentacije")
YEARS = 4            # koliko godina povijesti ulazi u model
HALF_LIFE = 540      # reprezentacije igraju rijetko, pa stariji rezultati vrijede dulje
FRIENDLY_W = 0.7     # prijateljske utakmice govore manje o pravoj jačini
WEIGHT = 0.8         # koliko vjerujemo kvotama kad postoje

# kod: (ESPN slug, naziv, oznaka)
COMPS = {
    "NTF": ("fifa.friendly", "Prijateljske utakmice", "🤝"),
    "UNL": ("uefa.nations", "Liga nacija", "🇪🇺"),
    "EURQ": ("uefa.euroq", "Kvalifikacije za Europsko prvenstvo", "🇪🇺"),
    "EURO": ("uefa.euro", "Europsko prvenstvo", "🏆"),
    "WC": ("fifa.world", "Svjetsko prvenstvo", "🏆"),
    "WCQE": ("fifa.worldq.uefa", "Kvalifikacije za SP – Europa", "🌍"),
    "WCQS": ("fifa.worldq.conmebol", "Kvalifikacije za SP – Južna Amerika", "🌎"),
    "WCQN": ("fifa.worldq.concacaf", "Kvalifikacije za SP – Sj. i Srednja Amerika", "🌎"),
    "WCQA": ("fifa.worldq.afc", "Kvalifikacije za SP – Azija", "🌏"),
    "WCQF": ("fifa.worldq.caf", "Kvalifikacije za SP – Afrika", "🌍"),
    "CNL": ("concacaf.nations.league", "CONCACAF Liga nacija", "🌎"),
    "GOLD": ("concacaf.gold", "Gold Cup", "🌎"),
    "COPA": ("conmebol.america", "Copa América", "🌎"),
    "AFCN": ("caf.nations", "Afrički kup nacija", "🌍"),
    "AFCQ": ("caf.nations_qual", "Kvalifikacije za Afrički kup nacija", "🌍"),
    "ASIA": ("afc.asian.cup", "Azijski kup", "🌏"),
}
# ESPN ime -> ime u popisu povijesti (kad se razlikuju)
MANUAL = {
    "Bosnia-Herzegovina": "Bosnia and Herzegovina", "Kyrgyz Republic": "Kyrgyzstan", "Congo DR": "DR Congo",
    "Cape Verde Islands": "Cape Verde", "Korea Republic": "South Korea", "South Korea": "South Korea",
    "Korea DPR": "North Korea", "Türkiye": "Turkey", "Turkiye": "Turkey", "Czechia": "Czech Republic",
    "Chinese Taipei": "Taiwan", "St. Lucia": "Saint Lucia", "St. Kitts and Nevis": "Saint Kitts and Nevis",
    "St. Vincent and the Grenadines": "Saint Vincent and the Grenadines", "St. Martin": "Saint Martin",
    "Republic of Ireland": "Republic of Ireland", "Ireland": "Republic of Ireland", "USA": "United States",
    "Congo": "Congo", "Ivory Coast": "Ivory Coast", "Cote d'Ivoire": "Ivory Coast", "Côte d'Ivoire": "Ivory Coast",
    "China PR": "China PR", "China": "China PR", "Macau": "Macau", "Hong Kong": "Hong Kong",
    "Eswatini": "Eswatini", "Swaziland": "Eswatini", "Gambia": "Gambia", "The Gambia": "Gambia",
    "Curacao": "Curaçao", "Curaçao": "Curaçao", "US Virgin Islands": "United States Virgin Islands",
    "U.S. Virgin Islands": "United States Virgin Islands", "British Virgin Islands": "British Virgin Islands",
    "Sao Tome and Principe": "São Tomé and Príncipe", "Timor-Leste": "East Timor", "Brunei Darussalam": "Brunei",
    "North Macedonia": "North Macedonia", "Macedonia": "North Macedonia", "Iran": "Iran", "IR Iran": "Iran",
    "Vietnam": "Vietnam", "Viet Nam": "Vietnam", "Antigua & Barbuda": "Antigua and Barbuda",
    "Trinidad & Tobago": "Trinidad and Tobago", "Turks & Caicos Islands": "Turks and Caicos Islands",
}


def _n(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ").replace("st.", "saint").replace("-", " ")
    return re.sub(r"[^a-z ]", "", re.sub(r"\s+", " ", s)).strip()


def _hist(force):
    path = os.path.join(DIR, "results.csv")
    if force or not os.path.exists(path) or time.time() - os.path.getmtime(path) > 12 * 3600:
        try:
            req = urllib.request.Request(HIST_URL, headers={"User-Agent": "Mozilla/5.0 nogomet-tiket"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            os.makedirs(DIR, exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
        except Exception as e:
            print("  ! Povijest reprezentacija nije skinuta:", e)
    out = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                try:
                    d = dt.date.fromisoformat(r["date"])
                    hs, as_ = int(r["home_score"]), int(r["away_score"])
                except (ValueError, KeyError):
                    continue
                out.append((d, r["home_team"], r["away_team"], hs, as_, r["neutral"].upper() == "TRUE",
                            r["tournament"] == "Friendly"))
    return out


def _day(slug, day, today, force):
    ds = day.strftime("%Y%m%d")
    back = (today - day).days
    age = None if back > 4 else (0 if force else 3 * 3600)
    return K._get(f"{BASE}/{slug}/scoreboard?dates={ds}", os.path.join(DIR, f"{slug}_{ds}.json"), age) or {}


def load(today=None, force=False, hist_end=None):
    """ESPN: rezultati od kraja popisa povijesti do danas i raspored za idućih 8 dana."""
    today = today or dt.date.today()
    now = dt.datetime.now(dt.timezone.utc)
    start = (hist_end or today - dt.timedelta(days=40)) + dt.timedelta(days=1)
    start = max(start, today - dt.timedelta(days=60))
    days = [start + dt.timedelta(days=i) for i in range((today - start).days + E.DAYS + 1)]
    jobs = [(code, slug, d) for code, (slug, _, _) in COMPS.items() for d in days]
    results, fixtures = [], []
    with cf.ThreadPoolExecutor(8) as ex:
        pages = list(ex.map(lambda j: (j[0], _day(j[1], j[2], today, force)), jobs))
    seen = set()
    for code, js in pages:
        for ev in js.get("events", []):
            if ev["id"] in seen:
                continue
            seen.add(ev["id"])
            c = ev["competitions"][0]
            st = c["status"]["type"]
            side = {x["homeAway"]: x for x in c["competitors"]}
            if "home" not in side or "away" not in side:
                continue
            h, a = side["home"]["team"]["displayName"], side["away"]["team"]["displayName"]
            when = K._utc(ev["date"])
            neutral = bool(c.get("neutralSite"))
            if st.get("completed"):
                detail = (st.get("shortDetail") or st.get("detail") or "").upper()
                if "AET" in detail or "PEN" in detail or "ET" == detail[-2:]:
                    continue    # produžeci: nema rezultata nakon 90 minuta
                try:
                    results.append((when.date(), h, a, int(side["home"]["score"]), int(side["away"]["score"]),
                                    neutral, code == "NTF", code))
                except (TypeError, ValueError, KeyError):
                    pass
            elif st.get("state") == "pre" and when > now:
                uk = E._uk(when)
                fixtures.append({"league": code, "iso": uk.date().isoformat(), "time": uk.strftime("%H:%M"),
                                 "home": h, "away": a, "odds": E._odds(c), "src": "espn", "neutral": neutral})
    return results, fixtures


class NTModel(M.LeagueModel):
    """Isti model kao za lige, ali s neutralnim terenima, lakšim prijateljskim i duljim pamćenjem."""

    def __init__(self, matches, today):
        self.code = "NT"
        ms, w = [], []
        for d, h, a, hg, ag, neutral, friendly in matches:
            age = max((today - d).days, 0)
            wi = 0.5 ** (age / HALF_LIFE) * (FRIENDLY_W if friendly else 1.0)
            if neutral:   # bez prednosti domaćeg terena: utakmica u oba smjera s pola težine
                ms += [(d, h, a, hg, ag), (d, a, h, ag, hg)]; w += [wi / 2, wi / 2]
            else:
                ms.append((d, h, a, hg, ag)); w.append(wi)
        teams = sorted({m[1] for m in ms} | {m[2] for m in ms})
        self.teams, self.n_matches = teams, len(ms)
        self._fit(ms, w, teams, {t: (0.0, 0.0) for t in teams}, reg=1.5)


def build(today=None, force=False):
    today = today or dt.date.today()
    hist = [m for m in _hist(force) if m[0] >= today - dt.timedelta(days=365 * YEARS) and m[0] <= today]
    hist_end = max((m[0] for m in hist), default=None)
    try:
        recent, fixtures = load(today, force, hist_end)
    except Exception as e:
        print("  ! Reprezentacije (ESPN) nisu uspjele:", e)
        recent, fixtures = [], []
    # ESPN imena su glavna (ista kao rezultati uživo); povijest prevodimo na njih
    espn_names = {t for m in recent for t in m[1:3]} | {t for f in fixtures for t in (f["home"], f["away"])}
    hist_names = {t for m in hist for t in m[1:3]}
    by_n = {_n(t): t for t in hist_names}
    to_espn, unmatched = {}, []
    for e in espn_names:
        h = MANUAL.get(e)
        h = h if h in hist_names else e if e in hist_names else by_n.get(_n(e))
        if h:
            to_espn[h] = e
        else:
            unmatched.append(e)
    rn = lambda t: to_espn.get(t, t)
    matches = [(d, rn(h), rn(a), hg, ag, ne, fr) for d, h, a, hg, ag, ne, fr in hist]
    have = {(m[0], m[1], m[2]) for m in matches}
    matches += [m[:7] for m in recent if (m[0], m[1], m[2]) not in have]
    mdl = NTModel(matches, today)
    known = set(mdl.att)
    fixtures = [f for f in fixtures if f["home"] in known and f["away"] in known]

    r4 = lambda x: round(x, 4)
    leagues = []
    since = today - dt.timedelta(days=400)
    for code, (slug, name, icon) in COMPS.items():
        teams = sorted({t for f in fixtures if f["league"] == code for t in (f["home"], f["away"])}
                       | {t for m in recent if m[7] == code and m[0] >= since for t in m[1:3]} & known)
        if not any(f["league"] == code for f in fixtures):
            continue      # natjecanje se trenutno ne igra
        leagues.append({
            "code": code, "name": name, "flag": icon, "country": "Reprezentacije", "nt": True,
            "weight": WEIGHT, "accuracy": None, "teams": teams, "table": [],
            "mu": r4(mdl.mu), "home": r4(mdl.home), "rho": r4(mdl.rho),
            "att": {t: r4(mdl.att[t]) for t in teams}, "de": {t: r4(mdl.de[t]) for t in teams},
        })
    cutoff = today - dt.timedelta(days=500)
    results = sorted({(m[0].isoformat(), m[1], m[2], m[3], m[4]) for m in matches if m[0] >= cutoff})
    print(f"  Reprezentacije: {len(hist)} utakmica povijesti (do {hist_end}), +{len(recent)} s ESPN-a, "
          f"{len(fixtures)} nadolazećih u {len(leagues)} natjecanja"
          + (f"; neupareno: {sorted(unmatched)[:15]}" if unmatched else ""))
    return leagues, fixtures, [list(r) for r in results], {c: v[0] for c, v in COMPS.items()}


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    l, f, r, s = build()
    lg = {x["code"]: x for x in l}
    import math
    for x in f[:25]:
        L = lg[x["league"]]
        lh = math.exp(L["mu"] + L["home"] + L["att"][x["home"]] - L["de"][x["away"]])
        la = math.exp(L["mu"] + L["att"][x["away"]] - L["de"][x["home"]])
        print(x["league"], x["iso"], x["time"], x["home"], "-", x["away"], f"{lh:.2f}:{la:.2f}", x["odds"])
