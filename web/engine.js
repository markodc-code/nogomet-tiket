// Izračun šansi i praćenje tiketa u pregledniku.
// Parametre modela (snaga napada/obrane) jednom dnevno računa build_data.py u data.json.
"use strict";

const Engine = (() => {
  let D = null, L = {}, where = {}, byNorm = {}, alias = {}, fixByPair = {}, resultsByPair = {};
  // košarka
  let lamCache = {}, probCache = {};
  let B = {leagues: [], fixtures: [], results: []}, BL = {}, BI = {byNorm: {}, alias: {}, where: {}}, bFix = {}, bRes = {};

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
    L = {}; where = {}; byNorm = {}; fixByPair = {}; resultsByPair = {}; lamCache = {}; probCache = {};
    for (const lg of D.leagues) {
      L[lg.code] = lg;
      for (const t of lg.teams) { where[t] = lg.code; byNorm[norm(t)] = t; }
    }
    alias = {};
    for (const [k, v] of Object.entries(D.aliases)) alias[norm(k)] = v;
    for (const f of D.fixtures) fixByPair[f.home + "|" + f.away] = f;
    for (const [d, h, a, hg, ag] of D.results) {
      const k = h + "|" + a;
      if (!resultsByPair[k]) resultsByPair[k] = [];
      resultsByPair[k].push([d, hg, ag]);
    }
    B = D.basket || {leagues: [], fixtures: [], results: []};
    BL = {}; BI = {byNorm: {}, alias: {}, where: {}}; bFix = {}; bRes = {};
    for (const lg of B.leagues) {
      BL[lg.code] = lg;
      for (const t of lg.teams) { BI.where[t] = lg.code; BI.byNorm[norm(t)] = t; }
      for (const [k, v] of Object.entries(lg.aliases || {})) BI.alias[norm(k)] = v;
    }
    for (const f of B.fixtures) {
      const k = new Date(f.utc);
      f.iso = localIsoD(k); f.time = `${String(k.getHours()).padStart(2, "0")}:${String(k.getMinutes()).padStart(2, "0")}`;
      if (!bFix[f.home + "|" + f.away]) bFix[f.home + "|" + f.away] = f;
    }
    for (const [d, lg, h, a, hs, as] of B.results) (bRes[h + "|" + a] = bRes[h + "|" + a] || []).push([d, hs, as]);
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
  const findTeam = text => findIn({byNorm, alias, where}, text);
  function findIn(ix, text) {
    const {byNorm, alias, where} = ix;
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
    const fx = fixByPair[h + "|" + a];
    const mk = fx ? marketProbabilities(fx.odds) : {};
    const ck = h + "|" + a;
    if (!lamCache[ck]) {
      const [mlh, mla] = expectedGoals(lg, h, a);
      let lh = mlh, la = mla, source = "model";
      if (Object.keys(mk).length) {
        const ml = marketLambdas(mk, mlh, mla, lg.rho);
        if (ml) {
          const w = lg.weight ?? D.marketWeight;
          lh = Math.exp((1 - w) * Math.log(mlh) + w * Math.log(ml[0]));
          la = Math.exp((1 - w) * Math.log(mla) + w * Math.log(ml[1]));
          source = "model+kladionice";
        }
      }
      lamCache[ck] = {lh, la, mlh, mla, source};
    }
    const {lh, la, mlh, mla, source} = lamCache[ck];
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
      home: h, away: a, league: lg.code, leagueName: lg.name, flag: lg.flag, accuracy: lg.accuracy, bet,
      betLabel: BET_LABELS[B] || (B.startsWith("R") ? "Točan rezultat " + B.slice(1) : bet),
      p, pModel, pMarket: mk[B] ?? null, source,
      fairOdds: p > 0 ? 1 / p : null, odds, value: odds ? p * odds - 1 : null,
      xg: [lh, la], xgModel: [mlh, mla], scores: scores.slice(0, 6), basic,
      date: fx ? fx.iso : null, time: fx ? hrTime(fx) : null, homeRow: row(h), awayRow: row(a),
    };
  }

  function evaluateTicket(legs) {
    const res = legs.slice(0, 30).map(l => l.sport === "kos" ? evaluateBasketLeg(l) : evaluateLeg(l)), ok = res.filter(r => !r.error), total = {legs: ok.length};
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

  // ------------------------------------------------------------ košarka
  // Očekivani poeni iz modela; za NBA se razlika, zbroj i pobjednik kombiniraju s kvotama.
  const localIsoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const PHI = x => { // normalna razdioba (Abramowitz-Stegun)
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  };
  const fmtLine = x => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toLocaleString("hr-HR");
  function basketLabel(bet) {
    const [k, v] = String(bet).split(":"), x = v != null ? parseFloat(v) : null;
    if (k === "1") return "1 (pobjeda domaćina)";
    if (k === "2") return "2 (pobjeda gosta)";
    if (k === "H1") return `Hendikep domaćin ${fmtLine(x)}`;
    if (k === "H2") return `Hendikep gost ${fmtLine(x)}`;
    if (k === "O") return `Više od ${x.toLocaleString("hr-HR")} poena`;
    if (k === "U") return `Manje od ${x.toLocaleString("hr-HR")} poena`;
    if (k === "DO") return `Domaćin više od ${x.toLocaleString("hr-HR")} poena`;
    if (k === "DU") return `Domaćin manje od ${x.toLocaleString("hr-HR")} poena`;
    if (k === "GO") return `Gost više od ${x.toLocaleString("hr-HR")} poena`;
    if (k === "GU") return `Gost manje od ${x.toLocaleString("hr-HR")} poena`;
    return bet;
  }
  function basketExpect(lg, h, a, fx) {
    const mh = lg.mu + lg.home + (lg.off[h] || 0) - (lg.def[a] || 0);
    const ma = lg.mu - lg.home + (lg.off[a] || 0) - (lg.def[h] || 0);
    const mm = mh - ma, mt = mh + ma, o = (fx && fx.odds) || {}, w = lg.weight || 0;
    let margin = mm, total = mt, market = false;
    if (w > 0 && o.spread != null) { margin = (1 - w) * mm + w * -o.spread; market = true; }
    if (w > 0 && o.total != null) { total = (1 - w) * mt + w * o.total; market = true; }
    let pHome = PHI(margin / lg.sdM), pHomeModel = PHI(mm / lg.sdM), pHomeMarket = null;
    if (o["1"] && o["2"]) {
      const a1 = 1 / o["1"], a2 = 1 / o["2"]; pHomeMarket = a1 / (a1 + a2);
      if (w > 0) { pHome = (1 - w) * pHome + w * pHomeMarket; market = true; }
    }
    return {margin, total, mm, mt, pHome, pHomeModel, pHomeMarket, market, sdM: lg.sdM, sdT: lg.sdT};
  }
  // Linije za ponudu: kladionice (NBA) ili najbliža ".5" vrijednost modela (Euroliga).
  function basketLines(f) {
    const lg = BL[f.league], o = f.odds || {};
    const e = basketExpect(lg, f.home, f.away, f);
    const spread = o.spread != null ? o.spread : -(Math.floor(e.margin) + 0.5);
    const total = o.total != null ? o.total : Math.floor(e.total) + 0.5;
    const home = Math.floor(e.total / 2 + e.margin / 2) + 0.5, away = Math.floor(e.total / 2 - e.margin / 2) + 0.5;
    return {spread, total, home, away, market: o.spread != null};
  }
  function basketProb(e, bet) {
    const [k, v] = String(bet).split(":"), x = parseFloat(v);
    if (k === "1") return e.pHome;
    if (k === "2") return 1 - e.pHome;
    if (k === "H1") return PHI((e.margin + x) / e.sdM);
    if (k === "H2") return PHI((x - e.margin) / e.sdM);
    if (k === "O") return 1 - PHI((x - e.total) / e.sdT);
    if (k === "U") return PHI((x - e.total) / e.sdT);
    // poeni jedne momčadi: srednja vrijednost iz zbroja i razlike, raspršenost iz obje
    const sdTeam = Math.sqrt(e.sdT * e.sdT + e.sdM * e.sdM) / 2;
    const ph = e.total / 2 + e.margin / 2, pa = e.total / 2 - e.margin / 2;
    if (k === "DO") return 1 - PHI((x - ph) / sdTeam);
    if (k === "DU") return PHI((x - ph) / sdTeam);
    if (k === "GO") return 1 - PHI((x - pa) / sdTeam);
    if (k === "GU") return PHI((x - pa) / sdTeam);
    throw new Error("Nepoznata košarkaška oklada: " + bet);
  }
  // Šansa za gumb u ponudi (bez kvote kladionica, npr. Euroliga).
  function basketProbFor(f, bet) {
    const lg = BL[f.league]; if (!lg) return null;
    return basketProb(basketExpect(lg, f.home, f.away, f), bet);
  }
  function settleBasket(bet, hs, as) {
    const [k, v] = String(bet).split(":"), x = parseFloat(v);
    if (k === "1") return hs > as;
    if (k === "2") return as > hs;
    if (k === "H1") return hs - as + x > 0;
    if (k === "H2") return as - hs + x > 0;
    if (k === "O") return hs + as > x;
    if (k === "U") return hs + as < x;
    if (k === "DO") return hs > x;
    if (k === "DU") return hs < x;
    if (k === "GO") return as > x;
    if (k === "GU") return as < x;
    throw new Error("Nepoznata košarkaška oklada: " + bet);
  }
  function marketPair(o, bet, lines) {
    const [k, v] = String(bet).split(":"), x = parseFloat(v);
    const pair = (a, b) => (o[a] && o[b]) ? (1 / o[a]) / (1 / o[a] + 1 / o[b]) : null;
    if (k === "1") return pair("1", "2");
    if (k === "2") return pair("2", "1");
    if (k === "H1" && lines.market && x === o.spread) return pair("H1", "H2");
    if (k === "H2" && lines.market && x === -o.spread) return pair("H2", "H1");
    if (k === "O" && x === o.total) return pair("O", "U");
    if (k === "U" && x === o.total) return pair("U", "O");
    return null;
  }
  function evaluateBasketLeg(leg) {
    const h = findIn(BI, leg.home), a = findIn(BI, leg.away);
    if (!h || !a) return {error: `Ne prepoznajem momčad „${!h ? leg.home : leg.away}“.`};
    if (h === a) return {error: "Domaćin i gost su ista momčad."};
    if (BI.where[h] !== BI.where[a]) return {error: `${h} i ${a} nisu u istoj ligi.`};
    const lg = BL[BI.where[h]], fx = bFix[h + "|" + a], bet = String(leg.bet || "1").trim();
    const e = basketExpect(lg, h, a, fx);
    const lines = fx ? basketLines(fx) : {spread: -(Math.floor(e.margin) + 0.5), total: Math.floor(e.total) + 0.5,
      home: Math.floor(e.total / 2 + e.margin / 2) + 0.5, away: Math.floor(e.total / 2 - e.margin / 2) + 0.5, market: false};
    let p, pModel;
    try {
      p = basketProb(e, bet);
      pModel = basketProb({...e, margin: e.mm, total: e.mt, pHome: e.pHomeModel}, bet);
    } catch (err) { return {error: err.message}; }
    let odds = leg.odds === undefined || leg.odds === null || leg.odds === "" ? null : parseFloat(String(leg.odds).replace(",", "."));
    if (!(odds > 0)) odds = null;
    const row = t => { const i = lg.table.findIndex(r => r.team === t); return i < 0 ? null : {pos: i + 1, ...lg.table[i]}; };
    const half = e.total / 2;
    return {
      sport: "kos", home: h, away: a, league: lg.code, leagueName: lg.name, flag: lg.flag, accuracy: lg.accuracy, bet,
      betLabel: basketLabel(bet), p, pModel, pMarket: fx ? marketPair(fx.odds || {}, bet, lines) : null,
      source: e.market ? "model+kladionice" : "model", fairOdds: p > 0 ? 1 / p : null, odds, value: odds ? p * odds - 1 : null,
      points: [half + e.margin / 2, half - e.margin / 2], margin: e.margin, total: e.total, lines,
      basic: {"1": e.pHome, "2": 1 - e.pHome},
      date: fx ? fx.iso : null, time: fx ? fx.time : null, homeRow: row(h), awayRow: row(a),
    };
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
      legs: legs.map(r => ({home: r.home, away: r.away, league: r.league, bet: r.bet, betLabel: r.betLabel, p: r.p, odds: r.odds, date: r.date, sport: r.sport || "nog"})),
    };
    const all = loadTickets(); all.push(t);
    return storeTickets(all) ? {ok: true, id: t.id} : {error: "Preglednik ne dopušta spremanje (privatni način?)."};
  }
  function deleteTicket(id) { storeTickets(loadTickets().filter(t => t.id !== id)); return {ok: true}; }

  const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
  function findResult(leg, created) {
    let games = (leg.sport === "kos" ? bRes : resultsByPair)[leg.home + "|" + leg.away] || [];
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
          try { leg.status = (leg.sport === "kos" ? settleBasket : settleBet)(leg.bet, g[1], g[2]) ? "won" : "lost"; } catch { leg.status = "pending"; }
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
  // Provjera na prošloj sezoni pokazala je da model ne pobjeđuje kladionice, pa
  // "model vidi vrijednost" nije dobar kriterij (gubio je ~12 % po okladi).
  // Zato biramo oklade s najvećom šansom među onima čija je kvota barem minOdds,
  // najviše jednu po utakmici.
  const MARKETS = [["1", "1"], ["X", "X"], ["2", "2"], ["3+", "O2.5"], ["0-2", "U2.5"]];
  // Vrijeme u podacima je britansko; Hrvatska je uvijek sat ispred.
  const localIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  function kickoff(f) {
    const [h, m] = (f.time || "12:00").split(":").map(Number);
    const d = new Date(f.iso + "T00:00:00");
    d.setHours(h + 1, m || 0);
    return d;
  }
  const notStarted = (f, now) => kickoff(f) > now;

  // Šanse za gumbe nogometne ponude (1, X, 2, 3+, 0-2) jednim izračunom.
  function fixtureProbs(f) {
    const k = f.home + "|" + f.away;
    if (!probCache[k]) {
      const r = evaluateLeg({home: f.home, away: f.away, bet: "1"});
      const b = r.basic || {};
      probCache[k] = r.error ? {} : {"1": b["1"], "X": b.X, "2": b["2"], "1X": b["1"] + b.X, "X2": b.X + b["2"], "12": b["1"] + b["2"],
        "GG": b.GG, "NG": 1 - b.GG, "3+": b["O2.5"], "0-2": 1 - b["O2.5"], source: r.source};
    }
    return probCache[k];
  }
  // Kad za utakmicu nema kvota, kvotu procjenjujemo iz šanse uz tipičnu maržu kladionica (~6 %).
  const EST_MARGIN = 0.94;
  const estOdds = p => Math.round(EST_MARGIN / p * 100) / 100;
  function candidates(item) {
    const f = item.f, out = [];
    if (item.sport === "kos") {
      const L = basketLines(f), o = f.odds || {};
      for (const [bet, odds] of [["1", o["1"]], ["2", o["2"]], [`H1:${L.spread}`, L.market ? o.H1 : null],
        [`H2:${-L.spread}`, L.market ? o.H2 : null], [`O:${L.total}`, o.total === L.total ? o.O : null], [`U:${L.total}`, o.total === L.total ? o.U : null]]) {
        const p = basketProbFor(f, bet);
        if (p > 0) out.push({bet, p, odds: odds || estOdds(p), est: !odds});
      }
    } else {
      const pr = fixtureProbs(f);
      for (const [bet, key] of MARKETS) {
        const p = pr[bet], odds = f.odds[key];
        if (p > 0) out.push({bet, p, odds: odds || estOdds(p), est: !odds});
      }
    }
    return out;
  }
  // Filter: ili kvota barem minOdds, ili šansa u rasponu (maxP - 10 %, maxP].
  const BAND = 0.10;
  function pickFrom(pool, minOdds, maxP, count, spread) {
    const minP = maxP < 1 ? maxP - BAND : 0;
    const best = [];
    for (const item of pool) {
      let top = null;
      for (const c of candidates(item)) {
        if (c.odds >= minOdds && c.p <= maxP && c.p > minP && (!top || c.p > top.p)) top = c;
      }
      if (!top) continue;
      const f = item.f, leg = {home: f.home, away: f.away, bet: top.bet, odds: top.odds, sport: item.sport};
      const r = item.sport === "kos" ? evaluateBasketLeg(leg) : evaluateLeg(leg);
      if (r.error) continue;
      best.push({...r, sport: item.sport, est: top.est, ev: r.p * top.odds - 1, k: item.k.getTime(),
        date: localIso(item.k), time: `${String(item.k.getHours()).padStart(2, "0")}:${String(item.k.getMinutes()).padStart(2, "0")}`,
        lines: item.sport === "kos" ? basketLines(f) : undefined});
    }
    best.sort((a, b) => b.p - a.p);

    // Svaki sport mora biti zastupljen (bar 1, a uz 10 parova bar 2), ostatak po šansi.
    // Tjedni prijedlog k tome raspoređuje parove kroz dane (najviše trećina na isti dan).
    const sports = [...new Set(best.map(x => x.sport))];
    const quota = count >= 10 ? 2 : 1, dayCap = spread ? Math.ceil(count / 3) : Infinity;
    const chosen = [], perDay = {};
    const take = r => { chosen.push(r); perDay[r.date] = (perDay[r.date] || 0) + 1; };
    for (const sp of sports) best.filter(r => r.sport === sp).slice(0, quota).forEach(r => { if (chosen.length < count) take(r); });
    for (const capOn of [true, false]) {
      for (const r of best) {
        if (chosen.length >= count) break;
        if (chosen.includes(r)) continue;
        if (capOn && (perDay[r.date] || 0) >= dayCap) continue;
        take(r);
      }
    }
    const picks = chosen.sort((a, b) => a.k - b.k);
    const total = picks.length ? {p: picks.reduce((x, r) => x * r.p, 1), odds: picks.reduce((x, r) => x * r.odds, 1)} : null;
    if (total) total.value = total.p * total.odds - 1;
    return {picks, total, considered: pool.length, sports: [...new Set(pool.map(x => x.sport))], minP};
  }

  // Prijedlog dana: utakmice danas koje još nisu počele (ako danas nema ničega,
  // prvi sljedeći dan s utakmicama). Prijedlog tjedna: od sada idućih 7 dana. Svi sportovi.
  function picks(minOdds = 1.5, maxP = 1, count = 5, now = new Date()) {
    if (!D) return null;
    const today = localIso(now);
    const weekEnd = localIso(new Date(now.getTime() + 6 * 864e5));
    const open = [
      ...D.fixtures.map(f => ({sport: "nog", f, k: kickoff(f)})),
      ...B.fixtures.filter(f => BL[f.league]).map(f => ({sport: "kos", f, k: new Date(f.utc)})),
    ].filter(x => x.k > now).sort((a, b) => a.k - b.k);
    const todays = open.filter(x => localIso(x.k) === today);
    const dayIso = todays.length ? today : (open[0] ? localIso(open[0].k) : today);
    const dayPool = todays.length ? todays : open.filter(x => localIso(x.k) === dayIso);
    const weekPool = open.filter(x => localIso(x.k) <= weekEnd);
    const lastFixture = open.length ? localIso(open[open.length - 1].k) : null;
    return {
      minOdds, maxP, count, today,
      day: {...pickFrom(dayPool, minOdds, maxP, count, false), date: dayIso, isToday: dayIso === today},
      week: {...pickFrom(weekPool, minOdds, maxP, count, true), from: today, to: weekEnd, lastFixture},
    };
  }
  const hrTime = f => { const k = kickoff(f); return `${String(k.getHours()).padStart(2, "0")}:${String(k.getMinutes()).padStart(2, "0")}`; };

  function initPayload() {
    return {
      leagues: D.leagues.map(l => ({code: l.code, name: l.name, flag: l.flag, country: l.country,
        weight: l.weight, accuracy: l.accuracy, teams: l.teams, table: l.table})),
      top5: D.top5 || [], accuracySeason: D.accuracySeason,
      basket: {
        leagues: B.leagues.map(l => ({code: l.code, name: l.name, flag: l.flag, country: l.country, hasOdds: l.hasOdds,
          accuracy: l.accuracy, teams: l.teams, table: l.table})),
        fixtures: B.fixtures.map(f => ({...f, lines: basketLines(f)})),
      },
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
    if (path === "/api/picks") return body?.mode === "chance"
      ? picks(0, body?.maxP || 0.5, body?.count || 5)
      : picks(body?.minOdds || 1.5, 1, body?.count || 5);
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

  return {api, exportTickets, importTickets, hrTime, basketLabel, basketProbFor, fixtureProbs, _test: {findTeam, settleBet, matrix, betProbability}};
})();
