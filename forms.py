"""Forma klubova iz svih natjecanja (domaća liga + europska natjecanja).

Isti klub se u različitim izvorima zove različito (npr. "Stuttgart" i "VfB Stuttgart"),
pa europska imena povezujemo s imenima iz domaćih liga. Za klubove čije domaće lige nemamo
na football-data.co.uk dodajemo domaće lige koje pokriva ESPN (Austrija, Danska, Norveška, Švedska).
"""
import datetime as dt
import difflib
import json
import os
import time
import urllib.request

import basket as K
import espn_soccer as E
import model as M

EXTRA_LEAGUES = {"aut.1": "Austrija", "den.1": "Danska", "nor.1": "Norveška", "swe.1": "Švedska"}
DIR = os.path.join(M.DATA_DIR, "espn_ostale_lige")
EXTRA_DAYS = 120
KEEP = 10   # zadnjih 10 utakmica po klubu (dovoljno za 5 kod kuće i 5 u gostima)


def extra_results(today, force=False):
    out = []
    for slug in EXTRA_LEAGUES:
        for back in range(0, EXTRA_DAYS):
            day = today - dt.timedelta(days=back)
            d = day.strftime("%Y%m%d")
            age = None if back > 3 else (0 if force else 3 * 3600)
            js = K._get(f"{E.BASE}/{slug}/scoreboard?dates={d}", os.path.join(DIR, f"{slug}_{d}.json"), age) or {}
            for ev in js.get("events", []):
                c = ev["competitions"][0]
                if not c["status"]["type"].get("completed"):
                    continue
                side = {x["homeAway"]: x for x in c["competitors"]}
                try:
                    out.append((K._utc(ev["date"]).date(), side["home"]["team"]["displayName"], side["away"]["team"]["displayName"],
                                int(side["home"]["score"]), int(side["away"]["score"])))
                except (KeyError, TypeError, ValueError):
                    continue
    return out


def link_names(espn_names, domestic):
    """ESPN ime -> ime iz domaće lige, samo kad je uparivanje sigurno (bez nagađanja)."""
    dom = set(domestic)
    by_n, by_core = {}, {}
    for t in dom:
        by_n.setdefault(E._n(t), []).append(t)
        c = E._core(t)
        if c:
            by_core.setdefault(c, []).append(t)
    out = {}
    for name in espn_names:
        if name in dom:
            continue
        if E.MANUAL.get(name) in dom:
            out[name] = E.MANUAL[name]; continue
        cand = by_n.get(E._n(name)) or by_core.get(E._core(name)) or []
        if len(cand) == 1:
            out[name] = cand[0]; continue
        # npr. "VfB Stuttgart" -> "Stuttgart": jedno domaće ime je cijela riječ u ESPN imenu
        words = set(E._n(name).split())
        hits = [t for t in dom if E._core(t) and set(E._core(t).split()) <= words and len(E._core(t)) >= 4]
        if len(hits) == 1:
            out[name] = hits[0]
    return out


# ---------------------------------------------------------------- FotMob: dopuna za klubove s manje od 5 utakmica
FM = "https://www.fotmob.com/api/data"
FM_DIR = os.path.join(M.DATA_DIR, "fotmob")
FM_UEFA = {"UCL": 42, "UEL": 73, "UECL": 10216}


def _fm(url, name, max_age):
    path = os.path.join(FM_DIR, name)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    try:
        time.sleep(0.4)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=40) as r:
            data = json.loads(r.read())
        os.makedirs(FM_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return data
    except Exception as e:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        print("  ! FotMob:", e)
        return None


def _score(st):
    try:
        a, b = (int(x) for x in st["scoreStr"].split("-"))
        return a, b
    except (KeyError, ValueError, AttributeError):
        return None


def fotmob_ids(uefa_data, max_age):
    """ESPN ime kluba -> FotMob id, prema europskim utakmicama (isti dan i isti rezultat)."""
    sig_fm, names = {}, {}
    for code, lid in FM_UEFA.items():
        d = _fm(f"{FM}/leagues?id={lid}", f"uefa_{lid}.json", max_age) or {}
        for m in ((d.get("fixtures") or {}).get("allMatches") or []):
            st = m.get("status") or {}
            sc = _score(st) if st.get("finished") else None
            if not sc:
                continue
            day = st["utcTime"][:10]
            for side, gf, ga in (("home", sc[0], sc[1]), ("away", sc[1], sc[0])):
                tid = m[side]["id"]
                sig_fm.setdefault(tid, set()).add((day, side, gf, ga))
                names[tid] = m[side]["name"]
    sig_espn = {}
    for d in uefa_data.values():
        for g in d["current"]:
            day = g[0].isoformat()
            sig_espn.setdefault(g[1], set()).add((day, "home", g[3], g[4]))
            sig_espn.setdefault(g[2], set()).add((day, "away", g[4], g[3]))
    out = {}
    for t, sig in sig_espn.items():
        scored = sorted(((len(sig & s), tid) for tid, s in sig_fm.items()), reverse=True)
        if not scored or scored[0][0] < 2:
            continue
        top = [tid for n, tid in scored if n == scored[0][0]]
        if len(top) > 1:   # isti rezultati na iste dane: odluči po sličnosti imena
            sim = sorted(((difflib.SequenceMatcher(None, E._n(t), E._n(names[tid])).ratio(), tid) for tid in top), reverse=True)
            if sim[0][0] < 0.5 or sim[1][0] >= sim[0][0] - 0.15:
                continue
            top = [sim[0][1]]
        out[t] = top[0]
    return out


def fotmob_games(tid, max_age):
    d = _fm(f"{FM}/teams?id={tid}", f"team_{tid}.json", max_age) or {}
    out = []
    for m in (((d.get("fixtures") or {}).get("allFixtures") or {}).get("fixtures") or []):
        st = m.get("status") or {}
        sc = _score(st)
        if not st.get("finished") or st.get("cancelled") or not sc:
            continue
        home = str(m["home"]["id"]) == str(tid)
        opp = m["away"]["name"] if home else m["home"]["name"]
        try:
            day = dt.date.fromisoformat(st["utcTime"][:10])
        except ValueError:
            continue
        gf, ga = (sc[0], sc[1]) if home else (sc[1], sc[0])
        out.append((day, opp, 1 if home else 0, gf, ga))
    return out


def build(leagues_fd, uefa_data, today=None, force=False):
    """leagues_fd: {kod: [sezona...]} iz model.load_all; uefa_data: uefa.load(). Vraća (form, alias)."""
    today = today or dt.date.today()
    domestic = {t for c in leagues_fd for s in leagues_fd[c] for m in s for t in (m[1], m[2])}
    espn_names = {t for d in uefa_data.values() for g in d["current"] + d["previous"] for t in (g[1], g[2])}
    espn_names |= set(t for d in uefa_data.values() for t in d["teams"])
    try:
        extra = extra_results(today, force)
    except Exception as e:
        print("  ! Dodatne lige za formu nisu uspjele:", e)
        extra = []
    alias = link_names(espn_names, domestic)
    canon = lambda n: alias.get(n, n)

    games = {}
    for c in leagues_fd:
        for s in leagues_fd[c]:
            for d, h, a, hg, ag in s:
                games[(d, h, a)] = (d, h, a, hg, ag)
    for d in uefa_data.values():
        for g in d["current"] + d["previous"]:
            if g[5]:   # produžeci: nema rezultata nakon 90 minuta
                continue
            h, a = canon(g[1]), canon(g[2])
            games[(g[0], h, a)] = (g[0], h, a, g[3], g[4])
    for g in extra:
        games[(g[0], g[1], g[2])] = g

    per = {}
    for d, h, a, hg, ag in games.values():
        per.setdefault(h, []).append((d, a, 1, hg, ag))
        per.setdefault(a, []).append((d, h, 0, ag, hg))
    # klubovi s manje od 5 utakmica (npr. Švicarska, Bugarska...): sve utakmice s FotMoba
    recent = today - dt.timedelta(days=60)
    need = [t for t in espn_names if sum(1 for g in per.get(canon(t), []) if g[0] >= recent) < 5]
    if need:
        try:
            ids = fotmob_ids(uefa_data, 0 if force else 6 * 3600)
            added = 0
            for t in need:
                if t not in ids:
                    continue
                have = {g[0] for g in per.get(canon(t), [])}
                extra_g = [g for g in fotmob_games(ids[t], 0 if force else 6 * 3600) if g[0] not in have]
                if extra_g:
                    per.setdefault(canon(t), []).extend(extra_g); added += 1
            print(f"  FotMob dopuna forme: {added} klubova (prepoznato {len(ids)})")
        except Exception as e:
            print("  ! FotMob dopuna nije uspjela:", e)
    form = {t: [[g[0].isoformat(), g[1], g[2], g[3], g[4]] for g in sorted(lst, reverse=True)[:KEEP]]
            for t, lst in per.items()}
    short = [t for t, lst in form.items() if (len(lst) < 5 or lst[4][0] < recent.isoformat()) and (t in espn_names or canon(t) in espn_names)]
    if short:
        print("  Kratka forma:", short)
    print(f"  Forma: {len(form)} klubova, povezano imena: {len(alias)}, s manje od 5 utakmica: {len(short)}")
    return form, alias


if __name__ == "__main__":
    import sys
    import uefa as U
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    lf, _, _ = M.load_all()
    ud = U.load()
    form, alias = build(lf, ud)
    for k in ("VfB Stuttgart", "Paris Saint-Germain", "Bodo/Glimt", "Galatasaray", "Slavia Prague", "AC Milan", "Internazionale"):
        n = alias.get(k, k)
        print(k, "->", n, [f"{g[0][5:]} {'D' if g[2] else 'G'} {g[1]} {g[3]}:{g[4]}" for g in form.get(n, [])[:5]])
    print("povezano:", sorted(alias.items())[:40])
