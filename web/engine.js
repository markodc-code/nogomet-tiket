// Izračun šansi i praćenje tiketa u pregledniku.
// Parametre modela (snaga napada/obrane) jednom dnevno računa build_data.py u data.json.
"use strict";

const Engine = (() => {
  let D = null, L = {}, where = {}, byNorm = {}, alias = {}, fixByPair = {}, resultsByPair = {};

  const BET_LABELS = {
    "1": "1 (pobjeda domaćina)", "X": "X (neriješeno)", "2": "2 (pobjeda gosta)",
    "1X": "1X", "X2": "X2", "12": "12",
    "GG": "GG (oba daju gol)", "NG": "NG (barem jedan ne daje)", "GG3+": "GG i 3+ golova",
    "0-1": "0-1 gol", "0-2": "0-2 gola", "2+": "2+ gola", "2-3": "2-3 gola", "3+": "3+ gola",
    "4+": "4+ gola", "5+": "5+ golova", "2-4": "2-4 gola",
    "O1.5": "Više od 1.5", "U1.5": "Manje od 1.5", "O2.5": "Više od 2.5", "U2.5": "Manje od 2.5",
    "O3.5": "Više od 3.5", "U3.5": "Manje od 3.5",
    "1&GG": "1 i GG", "2&GG": "2 i GG",
    "D2+": "Domaćin 2+ golova", "G2+": "Gost 2+ golova",
    "D0": "Domaćin ne zabija", "G0": "Gost ne zabija",
  };

  // ------------------------------------------------------------ podaci
  async function load(force) {
    const r = await fetch("data.json" + (force ? "?t=" + Date.now() : ""), {cache: force ? "reload" : "default"});
    if (!r.ok) throw new Error("Ne mogu učitati podatke (" + r.status + ")");
    D = await r.json();
    L = {}; where = {}; byNorm = {}; fixByPair = {}; resultsByPair = {};
    for (const lg of D.leagues) {
      L[lg.code] = lg;
      for (const t of lg.teams) { where[t] = lg.code; byNorm[norm(t)] = t; }
    }
    alias = {};
    for (const [k, v] of Object.entries(D.aliases)) alias[norm(k)] = v;
    for (const f of D.fixtures) fixByPair[f.home + "|" + f.away] = f;
    for (const [d, h, a, hg, ag] of D.results) (resultsByPair[h + "|" + a] ||= []).push([d, hg, ag]);
    return D;
  }

  // ------------------------------------------------------------ model
  const fact = n => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
  function tau(x, y, lh, la, rho) {
    if (x === 0 && y === 0) return 1 - lh * la * rho;
    if (x === 0 && y === 1) return 1 + lh * rho;
    if (x === 1 && y === 0) return 1 + la * rho;
    if (x === 1 && y === 1) return 1 - rho;
    return 1;
  }
  function matrix(lh, la, rho) {
    const n = D.maxGoals + 1, ph = [], pa = [];
    for (let k = 0; k < n; k++) { ph.push(Math.exp(-lh) * lh ** k / fact(k)); pa.push(Math.exp(-la) * la ** k / fact(k)); }
    let s = 0;
    const m = ph.map((p, i) => pa.map((q, j) => { const v = p * q * tau(i, j, lh, la, rho); s += v; return v; }));
    return m.map(row => row.map(v => v / s));
  }
  function expectedGoals(lg, h, a) {
    return [Math.exp(lg.mu + lg.home + lg.att[h] - lg.de[a]), Math.exp(lg.mu + lg.att[a] - lg.de[h])];
  }

  const SIMPLE = {
    "1": (i, j) => i > j, "X": (i, j) => i === j, "2": (i, j) => i < j,
    "1X": (i, j) => i >= j, "X2": (i, j) => i <= j, "12": (i, j) => i !== j,
    "GG": (i, j) => i > 0 && j > 0, "NG": (i, j) => i === 0 || j === 0,
    "GG3+": (i, j) => i > 0 && j > 0 && i + j >= 3,
    "1&GG": (i, j) => i > j && j > 0, "2&GG": (i, j) => j > i && i > 0,
    "D2+": (i, j) => i >= 2, "G2+": (i, j) => j >= 2, "D0": (i, j) => i === 0, "G0": (i, j) => j === 0,
  };
  function betCond(bet) {
    const b = String(bet).trim().toUpperCase().replace(",", ".");
    if (SIMPLE[b]) return SIMPLE[b];
    let m;
    if ((m = b.match(/^O(\d+(?:\.\d+)?)$/))) { const x = +m[1]; return (i, j) => i + j > x; }
    if ((m = b.match(/^U(\d+(?:\.\d+)?)$/))) { const x = +m[1]; return (i, j) => i + j < x; }
    if ((m = b.match(/^(\d+)\+$/))) { const x = +m[1]; return (i, j) => i + j >= x; }
    if ((m = b.match(/^(\d+)-(\d+)$/))) { const lo = +m[1], hi = +m[2]; return (i, j) => i + j >= lo && i + j <= hi; }
    if ((m = b.match(/^R(\d+):(\d+)$/))) { const x = +m[1], y = +m[2]; return (i, j) => i === x && j === y; }
    throw new Error("Nepoznata oklada: " + bet);
  }
  function betProbability(m, bet) {
    const c = betCond(bet); let p = 0;
    for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) if (c(i, j)) p += m[i][j];
    return p;
  }
  const settleBet = (bet, hg, ag) => betCond(bet)(hg, ag);

  function marketProbabilities(odds) {
    const out = {};
    if (odds && odds["1"] && odds.X && odds["2"]) {
      const inv = [1 / odds["1"], 1 / odds.X, 1 / odds["2"]], s = inv[0] + inv[1] + inv[2];
      const [p1, px, p2] = inv.map(v => v / s);
      Object.assign(out, {"1": p1, X: px, "2": p2, "1X": p1 + px, X2: px + p2, "12": p1 + p2});
    }
    if (odds && odds["O2.5"] && odds["U2.5"]) {
      const a = 1 / odds["O2.5"], b = 1 / odds["U2.5"];
      out["O2.5"] = out["3+"] = a / (a + b); out["U2.5"] = out["0-2"] = b / (a + b);
    }
    return out;
  }
  function marketLambdas(mk, lh0, la0, rho) {
    if (mk["1"] == null) return null;
    const targets = [["1", SIMPLE["1"]], ["2", SIMPLE["2"]]];
    if (mk["O2.5"] != null) targets.push(["O2.5", (i, j) => i + j > 2.5]);
    const loss = (x, y) => {
      const m = matrix(Math.exp(x), Math.exp(y), rho); let e = 0;
      for (const [k, c] of targets) {
        let p = 0;
        for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) if (c(i, j)) p += m[i][j];
        e += (p - mk[k]) ** 2;
      }
      return e;
    };
    let x = Math.log(lh0), y = Math.log(la0), step = 0.2, best = loss(x, y);
    while (step > 0.002) {
      let moved = false;
      for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, -step], [-step, step], [step, step], [-step, -step]]) {
        const l = loss(x + dx, y + dy);
        if (l < best) { best = l; x += dx; y += dy; moved = true; break; }
      }
      if (!moved) step /= 2;
    }
    return [Math.exp(x), Math.exp(y)];
  }

  // ------------------------------------------------------------ imena momčadi
  function norm(s) {
    s = String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/đ/g, "d").replace(/[.'\-_]/g, " ");
    return s.split(/\s+/).filter(w => w && !["fc", "cf", "sc", "ac", "afc", "ssc", "1"].includes(w)).join(" ");
  }
  function similarity(a, b) { // omjer kao difflib: 2*zajedničko / ukupno, preko LCS
    const n = a.length, m = b.length; if (!n || !m) return 0;
    let prev = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      const cur = [0];
      for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      prev = cur;
    }
    return 2 * prev[m] / (n + m);
  }
  function findTeam(text) {
    const q = norm(text || "");
    if (!q) return null;
    if (byNorm[q]) return byNorm[q];
    if (alias[q] && where[alias[q]]) return alias[q];
    const starts = Object.keys(byNorm).filter(n => n.startsWith(q) || q.startsWith(n));
    if (starts.length === 1) return byNorm[starts[0]];
    const contains = Object.keys(byNorm).filter(n => n.includes(q));
    if (contains.length === 1) return byNorm[contains[0]];
    let best = null, bs = 0.72;
    for (const k of [...Object.keys(byNorm), ...Object.keys(alias)]) {
      const s = similarity(q, k);
      if (s >= bs) { bs = s; best = k; }
    }
    if (best) { const t = byNorm[best] || alias[best]; if (where[t]) return t; }
    return null;
  }

  // ------------------------------------------------------------ tiket
  function evaluateLeg(leg) {
    const h = findTeam(leg.home), a = findTeam(leg.away);
    if (!h || !a) return {error: `Ne prepoznajem momčad „${!h ? leg.home : leg.away}“.`};
    if (h === a) return {error: "Domaćin i gost su ista momčad."};
    if (where[h] !== where[a]) return {error: `${h} (${L[where[h]].name}) i ${a} (${L[where[a]].name}) nisu u istoj ligi.`};
    const lg = L[where[h]], bet = String(leg.bet || "1").trim();
    const [mlh, mla] = expectedGoals(lg, h, a);
    const fx = fixByPair[h + "|" + a];
    const mk = fx ? marketProbabilities(fx.odds) : {};
    let lh = mlh, la = mla, source = "model";
    if (Object.keys(mk).length) {
      const ml = marketLambdas(mk, mlh, mla, lg.rho);
      if (ml) {
        const w = D.marketWeight;
        lh = Math.exp((1 - w) * Math.log(mlh) + w * Math.log(ml[0]));
        la = Math.exp((1 - w) * Math.log(mla) + w * Math.log(ml[1]));
        source = "model+kladionice";
      }
    }
    const mat = matrix(lh, la, lg.rho), modelMat = matrix(mlh, mla, lg.rho);
    let p, pModel;
    try { p = betProbability(mat, bet); pModel = betProbability(modelMat, bet); }
    catch (e) { return {error: e.message}; }
    const scores = [];
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) scores.push([mat[i][j], `${i}:${j}`]);
    scores.sort((x, y) => y[0] - x[0]);
    let odds = leg.odds;
    odds = odds === undefined || odds === null || odds === "" ? null : parseFloat(String(odds).replace(",", "."));
    if (!(odds > 0)) odds = null;
    const row = t => { const i = lg.table.findIndex(r => r.team === t); return i < 0 ? null : {pos: i + 1, ...lg.table[i]}; };
    const basic = {}; for (const k of ["1", "X", "2", "GG", "O2.5"]) basic[k] = betProbability(mat, k);
    const B = bet.toUpperCase();
    return {
      home: h, away: a, league: lg.code, leagueName: lg.name, bet,
      betLabel: BET_LABELS[B] || (B.startsWith("R") ? "Točan rezultat " + B.slice(1) : bet),
      p, pModel, pMarket: mk[B] ?? null, source,
      fairOdds: p > 0 ? 1 / p : null, odds, value: odds ? p * odds - 1 : null,
      xg: [lh, la], xgModel: [mlh, mla], scores: scores.slice(0, 6), basic,
      date: fx ? fx.iso : null, time: fx ? fx.time : null, homeRow: row(h), awayRow: row(a),
    };
  }

  function evaluateTicket(legs) {
    const res = legs.slice(0, 30).map(evaluateLeg), ok = res.filter(r => !r.error), total = {legs: ok.length};
    if (ok.length) {
      const p = ok.reduce((x, r) => x * r.p, 1);
      Object.assign(total, {p, fairOdds: p > 0 ? 1 / p : null});
      if (ok.every(r => r.odds)) { const o = ok.reduce((x, r) => x * r.odds, 1); Object.assign(total, {odds: o, value: p * o - 1}); }
      if (ok.every(r => r.pMarket != null)) total.pMarket = ok.reduce((x, r) => x * r.pMarket, 1);
      const pairs = ok.map(r => r.home + "|" + r.away);
      total.duplicate = new Set(pairs).size !== pairs.length;
    }
    return {legs: res, total};
  }

  // ------------------------------------------------------------ spremljeni tiketi (na ovom uređaju)
  const KEY = "nt-tickets";
  function loadTickets() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } }
  function storeTickets(t) { try { localStorage.setItem(KEY, JSON.stringify(t)); return true; } catch { return false; } }

  function saveTicket(body) {
    const ev = evaluateTicket(body.legs || []), legs = ev.legs.filter(r => !r.error);
    if (!legs.length) return {error: "Na tiketu nema ispravnih parova."};
    const stake = Math.max(parseFloat(String(body.stake || 0).replace(",", ".")) || 0, 0), now = new Date();
    const t = {
      id: now.getTime().toString(36) + Math.random().toString(36).slice(2, 6),
      created: now.toISOString().slice(0, 19), stake, p: ev.total.p, odds: ev.total.odds ?? null,
      legs: legs.map(r => ({home: r.home, away: r.away, league: r.league, bet: r.bet, betLabel: r.betLabel, p: r.p, odds: r.odds, date: r.date})),
    };
    const all = loadTickets(); all.push(t);
    return storeTickets(all) ? {ok: true, id: t.id} : {error: "Preglednik ne dopušta spremanje (privatni način?)."};
  }
  function deleteTicket(id) { storeTickets(loadTickets().filter(t => t.id !== id)); return {ok: true}; }

  const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
  function findResult(leg, created) {
    let games = resultsByPair[leg.home + "|" + leg.away] || [];
    games = leg.date ? games.filter(g => Math.abs(dayDiff(g[0], leg.date)) <= 2)
                     : games.filter(g => dayDiff(g[0], created) >= -1);
    return games.length ? games.slice().sort()[0] : null;
  }

  function ticketsPayload() {
    const out = loadTickets().sort((a, b) => b.created.localeCompare(a.created)).map(t => {
      const created = t.created.slice(0, 10);
      let status = "won";
      for (const leg of t.legs) {
        const g = findResult(leg, created);
        if (g) {
          leg.score = `${g[1]}:${g[2]}`; leg.playedOn = g[0];
          try { leg.status = settleBet(leg.bet, g[1], g[2]) ? "won" : "lost"; } catch { leg.status = "pending"; }
        } else leg.status = "pending";
        if (leg.status === "lost") status = "lost";
        else if (leg.status === "pending" && status !== "lost") status = "pending";
      }
      t.status = status;
      t.payout = status === "won" && t.odds ? t.stake * t.odds : status === "lost" ? 0 : null;
      return t;
    });
    return {tickets: out, stats: ticketStats(out), lastResult: D.lastResult};
  }

  function ticketStats(tickets) {
    const done = tickets.filter(t => t.status !== "pending");
    const money = done.filter(t => t.odds && t.stake > 0);
    const staked = money.reduce((s, t) => s + t.stake, 0), returned = money.reduce((s, t) => s + (t.payout || 0), 0);
    const seen = new Set(), uniq = [];
    for (const t of tickets) for (const l of t.legs) {
      if (l.status === "pending") continue;
      const k = [l.home, l.away, l.bet, l.playedOn].join("|");
      if (!seen.has(k)) { seen.add(k); uniq.push(l); }
    }
    const buckets = [];
    for (const [lo, hi] of [[0, .4], [.4, .55], [.55, .7], [.7, .85], [.85, 1.01]]) {
      const b = uniq.filter(l => l.p >= lo && l.p < hi);
      if (b.length) buckets.push({lo, hi: Math.min(hi, 1), n: b.length,
        expected: b.reduce((s, l) => s + l.p, 0) / b.length, won: b.filter(l => l.status === "won").length});
    }
    return {
      total: tickets.length, pending: tickets.length - done.length,
      won: done.filter(t => t.status === "won").length, lost: done.filter(t => t.status === "lost").length,
      expectedWins: done.reduce((s, t) => s + t.p, 0),
      staked, returned, profit: returned - staked, roi: staked ? (returned - staked) / staked : null,
      legs: uniq.length, legsWon: uniq.filter(l => l.status === "won").length,
      legsExpected: uniq.reduce((s, l) => s + l.p, 0), buckets,
    };
  }

  // ------------------------------------------------------------ prijedlozi dana
  // Za svaku nadolazeću utakmicu gleda oklade s kvotama (1, X, 2, 3+, 0-2) i bira
  // one gdje je naša šansa najviše iznad onoga što kvota plaća (očekivani povrat),
  // uz minimalnu šansu, najviše jednu okladu po utakmici.
  const MARKETS = [["1", "1"], ["X", "X"], ["2", "2"], ["3+", "O2.5"], ["0-2", "U2.5"]];
  function suggestions(count = 5, minP = 0.45, days = 3) {
    if (!D || !D.fixtures.length) return {picks: [], window: null};
    const first = D.fixtures[0].iso;
    const until = new Date(new Date(first).getTime() + (days - 1) * 864e5).toISOString().slice(0, 10);
    let pool = D.fixtures.filter(f => f.iso <= until);
    if (pool.length < count) pool = D.fixtures;
    const best = [];
    for (const f of pool) {
      let top = null;
      for (const [bet, key] of MARKETS) {
        const odds = f.odds[key];
        if (!odds) continue;
        const r = evaluateLeg({home: f.home, away: f.away, bet, odds});
        if (r.error || r.p < minP) continue;
        const cand = {...r, ev: r.p * odds - 1};
        if (!top || cand.ev > top.ev) top = cand;
      }
      if (top) best.push(top);
    }
    best.sort((a, b) => b.ev - a.ev);
    const picks = best.slice(0, count);
    const total = picks.length ? {
      p: picks.reduce((x, r) => x * r.p, 1), odds: picks.reduce((x, r) => x * r.odds, 1),
    } : null;
    if (total) total.value = total.p * total.odds - 1;
    return {picks, total, from: pool[0]?.iso, to: pool[pool.length - 1]?.iso, considered: pool.length};
  }

  function initPayload() {
    return {
      leagues: D.leagues.map(l => ({code: l.code, name: l.name, flag: l.flag, teams: l.teams, table: l.table})),
      fixtures: D.fixtures, bets: Object.entries(BET_LABELS).map(([code, label]) => ({code, label})),
      lastResult: D.lastResult, builtAt: D.builtAt, seasons: D.seasons,
    };
  }

  // Ista sučelja kao nekadašnji Python server, samo lokalno.
  async function api(path, body) {
    if (path === "/api/init") { if (!D) await load(false); return initPayload(); }
    if (path === "/api/refresh") { await load(true); return initPayload(); }
    if (path === "/api/ticket") return evaluateTicket(body.legs || []);
    if (path === "/api/tickets") return ticketsPayload();
    if (path === "/api/suggestions") return suggestions();
    if (path === "/api/tickets/save") return saveTicket(body);
    if (path === "/api/tickets/delete") return deleteTicket(String(body.id || ""));
    throw new Error("Nepoznato: " + path);
  }

  function exportTickets() { return JSON.stringify({app: "nogomet-tiket", version: 1, tickets: loadTickets()}, null, 1); }
  function importTickets(text) {
    const d = JSON.parse(text), list = Array.isArray(d) ? d : d.tickets;
    if (!Array.isArray(list)) throw new Error("Datoteka nije sigurnosna kopija tiketa.");
    const all = loadTickets(), ids = new Set(all.map(t => t.id));
    let added = 0;
    for (const t of list) if (t && t.id && Array.isArray(t.legs) && !ids.has(t.id)) { all.push(t); added++; }
    storeTickets(all);
    return added;
  }

  return {api, exportTickets, importTickets, _test: {findTeam, settleBet, matrix, betProbability}};
})();
