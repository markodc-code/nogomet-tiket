"""Forma klubova iz svih natjecanja (domaća liga + europska natjecanja).

Isti klub se u različitim izvorima zove različito (npr. "Stuttgart" i "VfB Stuttgart"),
pa europska imena povezujemo s imenima iz domaćih liga. Za klubove čije domaće lige nemamo
na football-data.co.uk dodajemo domaće lige koje pokriva ESPN (Austrija, Danska, Norveška, Švedska).
"""
import datetime as dt
import os

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
    form = {t: [[g[0].isoformat(), g[1], g[2], g[3], g[4]] for g in sorted(lst, reverse=True)[:KEEP]]
            for t, lst in per.items()}
    short = [t for t, lst in form.items() if len(lst) < 5 and (t in espn_names or canon(t) in espn_names)]
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
