"""Skidanje podataka i statistički model (Dixon-Coles) za ligu peticu."""
import csv
import datetime as dt
import difflib
import io
import math
import os
import time
import unicodedata
import urllib.request

LEAGUES = {
    "E0": "Premier League",
    "SP1": "La Liga",
    "I1": "Serie A",
    "D1": "Bundesliga",
    "F1": "Ligue 1",
}
LEAGUE_FLAGS = {"E0": "ENG", "SP1": "ESP", "I1": "ITA", "D1": "GER", "F1": "FRA"}

BASE = "https://www.football-data.co.uk"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "podaci")
MAX_AGE = 6 * 3600          # podaci se osvježavaju svakih 6 sati
HALF_LIFE_DAYS = 180        # stariji rezultati vrijede manje (pola težine nakon 180 dana)
MAX_GOALS = 10

# Česti nazivi -> nazivi iz football-data.co.uk
ALIASES = {
    "manchester united": "Man United", "man utd": "Man United", "mu": "Man United",
    "manchester city": "Man City", "city": "Man City",
    "nottingham forest": "Nott'm Forest", "nottingham": "Nott'm Forest", "forest": "Nott'm Forest",
    "tottenham hotspur": "Tottenham", "spurs": "Tottenham",
    "wolverhampton": "Wolves", "newcastle united": "Newcastle",
    "west ham united": "West Ham", "brighton and hove albion": "Brighton",
    "sheffield united": "Sheffield United", "leeds united": "Leeds",
    "atletico madrid": "Ath Madrid", "atletico": "Ath Madrid", "atl madrid": "Ath Madrid",
    "athletic bilbao": "Ath Bilbao", "athletic club": "Ath Bilbao", "bilbao": "Ath Bilbao",
    "real sociedad": "Sociedad", "celta vigo": "Celta", "betis": "Betis", "real betis": "Betis",
    "rayo vallecano": "Vallecano", "rayo": "Vallecano", "espanyol": "Espanol",
    "barca": "Barcelona", "real": "Real Madrid",
    "inter milan": "Inter", "internazionale": "Inter", "ac milan": "Milan",
    "as roma": "Roma", "ss lazio": "Lazio", "napoli": "Napoli", "juve": "Juventus",
    "hellas verona": "Verona",
    "bayern": "Bayern Munich", "bayern munchen": "Bayern Munich", "bayern munich": "Bayern Munich",
    "borussia dortmund": "Dortmund", "bvb": "Dortmund",
    "borussia monchengladbach": "M'gladbach", "monchengladbach": "M'gladbach", "gladbach": "M'gladbach",
    "bayer leverkusen": "Leverkusen", "eintracht frankfurt": "Ein Frankfurt", "frankfurt": "Ein Frankfurt",
    "rb leipzig": "RB Leipzig", "leipzig": "RB Leipzig", "vfb stuttgart": "Stuttgart",
    "fc koln": "FC Koln", "koln": "FC Koln", "cologne": "FC Koln",
    "union berlin": "Union Berlin", "werder bremen": "Werder Bremen", "bremen": "Werder Bremen",
    "mainz 05": "Mainz", "hamburger sv": "Hamburg", "hsv": "Hamburg", "st pauli": "St Pauli",
    "psg": "Paris SG", "paris saint germain": "Paris SG", "paris": "Paris SG",
    "olympique marseille": "Marseille", "om": "Marseille", "olympique lyon": "Lyon", "ol": "Lyon",
    "as monaco": "Monaco", "saint etienne": "St Etienne", "stade rennais": "Rennes",
}


# ---------------------------------------------------------------- podaci

def season_codes(today=None, count=3):
    today = today or dt.date.today()
    start = today.year if today.month >= 7 else today.year - 1
    codes = []
    for y in range(start, start - count, -1):
        codes.append(f"{y % 100:02d}{(y + 1) % 100:02d}")
    return codes  # najnovija prva


def _download(url, path, force=False):
    fresh = os.path.exists(path) and time.time() - os.path.getmtime(path) < MAX_AGE
    if fresh and not force:
        return path
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 nogomet-tiket"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
    except Exception as e:  # bez interneta koristimo ono što već imamo
        if not os.path.exists(path):
            print(f"  ! Ne mogu skinuti {url}: {e}")
            return None
    return path


def _read_csv(path):
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = list(csv.DictReader(io.StringIO(text)))
    return [r for r in rows if r.get("HomeTeam")]


def _date(s):
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return dt.datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            pass
    return None


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def load_all(force=False):
    seasons = season_codes()
    leagues = {}
    for code in LEAGUES:
        per_season = []
        for s in seasons:
            p = _download(f"{BASE}/mmz4281/{s}/{code}.csv",
                          os.path.join(DATA_DIR, f"{code}_{s}.csv"), force)
            if not p:
                per_season.append([])
                continue
            ms = []
            for r in _read_csv(p):
                hg, ag, d = _num(r.get("FTHG")), _num(r.get("FTAG")), _date(r.get("Date", ""))
                if hg is None or ag is None or d is None:
                    continue
                ms.append((d, r["HomeTeam"].strip(), r["AwayTeam"].strip(), int(hg), int(ag)))
            per_season.append(ms)
        leagues[code] = per_season

    fixtures = []
    p = _download(f"{BASE}/fixtures.csv", os.path.join(DATA_DIR, "fixtures.csv"), force)
    if p:
        for r in _read_csv(p):
            if r.get("Div") not in LEAGUES:
                continue
            fixtures.append({
                "league": r["Div"], "date": r.get("Date", ""), "time": r.get("Time", ""),
                "home": r["HomeTeam"].strip(), "away": r["AwayTeam"].strip(),
                "odds": {k: _num(r.get(c)) for k, c in
                         (("1", "AvgH"), ("X", "AvgD"), ("2", "AvgA"),
                          ("O2.5", "Avg>2.5"), ("U2.5", "Avg<2.5"))},
            })
    return leagues, fixtures, seasons


# ---------------------------------------------------------------- model

def _tau(x, y, lh, la, rho):
    if x == 0 and y == 0:
        return 1 - lh * la * rho
    if x == 0 and y == 1:
        return 1 + lh * rho
    if x == 1 and y == 0:
        return 1 + la * rho
    if x == 1 and y == 1:
        return 1 - rho
    return 1.0


class LeagueModel:
    def __init__(self, code, per_season, today=None):
        self.code = code
        today = today or dt.date.today()
        matches = [m for s in per_season for m in s]
        self.n_matches = len(matches)
        current = per_season[0] if per_season else []
        current_teams = {m[1] for m in current} | {m[2] for m in current}
        last_season = per_season[1] if len(per_season) > 1 else []
        last_teams = {m[1] for m in last_season} | {m[2] for m in last_season}
        self.teams = sorted(current_teams) if current_teams else sorted(
            {m[1] for m in matches} | {m[2] for m in matches})
        all_teams = sorted({m[1] for m in matches} | {m[2] for m in matches})

        # Novopridošle momčadi (nisu bile u ligi prošle sezone) startaju kao slabije od prosjeka
        prior = {t: ((-0.25, -0.20) if last_teams and t not in last_teams else (0.0, 0.0))
                 for t in all_teams}
        w = [0.5 ** (max((today - m[0]).days, 0) / HALF_LIFE_DAYS) for m in matches]
        self._fit(matches, w, all_teams, prior)
        self.table = self._form_table(current)

    def _fit(self, matches, w, teams, prior, reg=6.0, iters=60):
        att = {t: prior[t][0] for t in teams}
        de = {t: prior[t][1] for t in teams}
        mu, home = math.log(1.35), 0.25

        def rates():
            return [(math.exp(mu + home + att[h] - de[a]), math.exp(mu + att[a] - de[h]))
                    for (_, h, a, _, _) in matches]

        for _ in range(iters):
            # mu i prednost domaćeg terena
            lam = rates()
            g_mu = h_mu = g_home = h_home = 0.0
            for (_, h, a, hg, ag), (lh, la), wi in zip(matches, lam, w):
                g_mu += wi * (hg - lh + ag - la)
                h_mu += wi * (lh + la)
                g_home += wi * (hg - lh)
                h_home += wi * lh
            mu += g_mu / h_mu
            home += g_home / (h_home + 1e-9)

            # napad
            lam = rates()
            g = {t: -reg * (att[t] - prior[t][0]) for t in teams}
            hs = {t: reg for t in teams}
            for (_, h, a, hg, ag), (lh, la), wi in zip(matches, lam, w):
                g[h] += wi * (hg - lh); hs[h] += wi * lh
                g[a] += wi * (ag - la); hs[a] += wi * la
            for t in teams:
                att[t] += g[t] / hs[t]

            # obrana
            lam = rates()
            g = {t: -reg * (de[t] - prior[t][1]) for t in teams}
            hs = {t: reg for t in teams}
            for (_, h, a, hg, ag), (lh, la), wi in zip(matches, lam, w):
                g[a] -= wi * (hg - lh); hs[a] += wi * lh
                g[h] -= wi * (ag - la); hs[h] += wi * la
            for t in teams:
                de[t] += g[t] / hs[t]

        # rho (Dixon-Coles korekcija za niske rezultate)
        lam = rates()
        best, best_ll = 0.0, -1e18
        for i in range(-25, 16):
            rho = i / 100
            ll = 0.0
            for (_, h, a, hg, ag), (lh, la), wi in zip(matches, lam, w):
                if hg <= 1 and ag <= 1:
                    t = _tau(hg, ag, lh, la, rho)
                    ll += wi * math.log(max(t, 1e-9))
            if ll > best_ll:
                best, best_ll = rho, ll

        self.mu, self.home, self.att, self.de, self.rho = mu, home, att, de, best

    def _form_table(self, current):
        tab = {t: {"team": t, "p": 0, "w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0, "pts": 0, "form": []}
               for t in self.teams}
        for d, h, a, hg, ag in sorted(current):
            for t, gf, ga in ((h, hg, ag), (a, ag, hg)):
                if t not in tab:
                    continue
                r = tab[t]
                r["p"] += 1; r["gf"] += gf; r["ga"] += ga
                res = "W" if gf > ga else "D" if gf == ga else "L"
                r["w" if res == "W" else "d" if res == "D" else "l"] += 1
                r["pts"] += 3 if res == "W" else 1 if res == "D" else 0
                r["form"].append(res)
        for r in tab.values():
            r["form"] = "".join(r["form"][-5:])
        return sorted(tab.values(), key=lambda r: (-r["pts"], -(r["gf"] - r["ga"]), -r["gf"]))

    def expected_goals(self, h, a):
        lh = math.exp(self.mu + self.home + self.att[h] - self.de[a])
        la = math.exp(self.mu + self.att[a] - self.de[h])
        return lh, la

    def score_matrix(self, h, a, lh=None, la=None):
        if lh is None:
            lh, la = self.expected_goals(h, a)
        return matrix(lh, la, self.rho), lh, la


def matrix(lh, la, rho):
    ph = [math.exp(-lh) * lh ** k / math.factorial(k) for k in range(MAX_GOALS + 1)]
    pa = [math.exp(-la) * la ** k / math.factorial(k) for k in range(MAX_GOALS + 1)]
    m = [[ph[i] * pa[j] * _tau(i, j, lh, la, rho) for j in range(MAX_GOALS + 1)]
         for i in range(MAX_GOALS + 1)]
    s = sum(map(sum, m))
    return [[v / s for v in row] for row in m]


MARKET_WEIGHT = 0.6  # koliko vjerujemo kladionicama naspram čistog modela


def market_lambdas(mk, lh0, la0, rho):
    """Očekivani golovi koji najbolje odgovaraju kvotama kladionica (1X2 i 2.5 gola)."""
    if "1" not in mk:
        return None
    targets = [("1", lambda i, j: i > j), ("2", lambda i, j: i < j)]
    if "O2.5" in mk:
        targets.append(("O2.5", lambda i, j: i + j > 2.5))

    def loss(x, y):
        m = matrix(math.exp(x), math.exp(y), rho)
        e = 0.0
        for k, cond in targets:
            p = sum(m[i][j] for i in range(len(m)) for j in range(len(m)) if cond(i, j))
            e += (p - mk[k]) ** 2
        return e

    x, y, step = math.log(lh0), math.log(la0), 0.2
    best = loss(x, y)
    while step > 0.002:  # jednostavno pretraživanje u log prostoru
        moved = False
        for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step),
                       (step, -step), (-step, step), (step, step), (-step, -step)):
            l = loss(x + dx, y + dy)
            if l < best:
                best, x, y, moved = l, x + dx, y + dy, True
                break
        if not moved:
            step /= 2
    return math.exp(x), math.exp(y)


def blended_lambdas(model_lh, model_la, market_lh, market_la, w=MARKET_WEIGHT):
    return (math.exp((1 - w) * math.log(model_lh) + w * math.log(market_lh)),
            math.exp((1 - w) * math.log(model_la) + w * math.log(market_la)))


# ---------------------------------------------------------------- oklade

def bet_probability(m, bet):
    """m = matrica rezultata, bet = kod oklade (1, X, 2, 1X, GG, O2.5, 3+, 0-2, R2:1 ...)."""
    b = bet.strip().upper().replace(",", ".")
    n = len(m)
    cells = [(i, j, m[i][j]) for i in range(n) for j in range(n)]

    def p(cond):
        return sum(v for i, j, v in cells if cond(i, j))

    simple = {
        "1": lambda i, j: i > j, "X": lambda i, j: i == j, "2": lambda i, j: i < j,
        "1X": lambda i, j: i >= j, "X2": lambda i, j: i <= j, "12": lambda i, j: i != j,
        "GG": lambda i, j: i > 0 and j > 0, "NG": lambda i, j: i == 0 or j == 0,
        "GG3+": lambda i, j: i > 0 and j > 0 and i + j >= 3,
        "1&GG": lambda i, j: i > j and j > 0, "2&GG": lambda i, j: j > i and i > 0,
        "D2+": lambda i, j: i >= 2, "G2+": lambda i, j: j >= 2,
        "D0": lambda i, j: i == 0, "G0": lambda i, j: j == 0,
    }
    if b in simple:
        return p(simple[b])
    if b.startswith("O") and b[1:].replace(".", "").isdigit():
        x = float(b[1:]); return p(lambda i, j: i + j > x)
    if b.startswith("U") and b[1:].replace(".", "").isdigit():
        x = float(b[1:]); return p(lambda i, j: i + j < x)
    if b.endswith("+") and b[:-1].isdigit():
        x = int(b[:-1]); return p(lambda i, j: i + j >= x)
    if "-" in b and all(s.isdigit() for s in b.split("-")):
        lo, hi = map(int, b.split("-")); return p(lambda i, j: lo <= i + j <= hi)
    if b.startswith("R") and ":" in b:
        x, y = map(int, b[1:].split(":")); return m[x][y] if x < n and y < n else 0.0
    raise ValueError(f"Nepoznata oklada: {bet}")


def settle_bet(bet, hg, ag):
    """True/False: je li oklada prošla uz konačni rezultat hg:ag."""
    n = max(MAX_GOALS + 1, hg + 1, ag + 1)
    m = [[0.0] * n for _ in range(n)]
    m[hg][ag] = 1.0
    return bet_probability(m, bet) > 0.5


def market_probabilities(odds):
    """Vjerojatnosti iz prosječnih kvota kladionica, bez marže."""
    out = {}
    trio = [odds.get(k) for k in ("1", "X", "2")]
    if all(trio):
        inv = [1 / o for o in trio]; s = sum(inv)
        p1, px, p2 = (v / s for v in inv)
        out.update({"1": p1, "X": px, "2": p2, "1X": p1 + px, "X2": px + p2, "12": p1 + p2})
    duo = [odds.get("O2.5"), odds.get("U2.5")]
    if all(duo):
        inv = [1 / o for o in duo]; s = sum(inv)
        out["O2.5"], out["U2.5"] = inv[0] / s, inv[1] / s
        out["3+"], out["0-2"] = out["O2.5"], out["U2.5"]
    return out


# ---------------------------------------------------------------- imena momčadi

def _norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    for ch in ".'-_":
        s = s.replace(ch, " ")
    s = " ".join(w for w in s.split() if w not in ("fc", "cf", "sc", "ac", "afc", "ssc", "1."))
    return s.strip()


class TeamIndex:
    def __init__(self, models):
        self.where = {}
        for code, mdl in models.items():
            for t in mdl.teams:
                self.where[t] = code
        self.by_norm = {_norm(t): t for t in self.where}
        self.alias = {_norm(k): v for k, v in ALIASES.items()}

    def find(self, text):
        q = _norm(text)
        if not q:
            return None
        if q in self.by_norm:
            return self.by_norm[q]
        if q in self.alias and self.alias[q] in self.where:
            return self.alias[q]
        starts = [t for n, t in self.by_norm.items() if n.startswith(q) or q.startswith(n)]
        if len(starts) == 1:
            return starts[0]
        contains = [t for n, t in self.by_norm.items() if q in n]
        if len(contains) == 1:
            return contains[0]
        close = difflib.get_close_matches(q, list(self.by_norm) + list(self.alias), n=1, cutoff=0.72)
        if close:
            c = close[0]
            t = self.by_norm.get(c) or self.alias.get(c)
            if t in self.where:
                return t
        return None
