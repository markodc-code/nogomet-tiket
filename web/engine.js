// Izračun šansi i praćenje tiketa u pregledniku.
// Parametre modela (snaga napada/obrane) jednom dnevno računa build_data.py u data.json.
"use strict";

const Engine = (() => {
  let D = null, L = {}, where = {}, byNorm = {}, alias = {}, fixByPair = {}, resultsByPair = {};
  // košarka
  let lamCache = {}, probCache = {}, byTeam = {};
  let B = {leagues: [], fixtures: [], results: []}, BL = {}, BI = {byNorm: {}, alias: {}, where: {}}, bFix = {}, bRes = {};

  const BET_LABELS = {
    "1": "1 (pobjeda domaćina)", "X": "X (neriješeno)", "2": "2 (pobjeda gosta)",
    "1X": "1X", "X2": "X2", "12": "12",
    "GG": "Oba tima daju gol", "NG": "Barem jedan tim ne daje gol", "GG3+": "Oba tima daju gol i 3+ golova",
    "0-1": "0-1 gol", "0-2": "0-2 gola", "2+": "2+ gola", "2-3": "2-3 gola", "3+": "3+ gola",
    "4+": "4+ gola", "5+": "5+ golova", "2-4": "2-4 gola",
    "O1.5": "Više od 1.5", "U1.5": "Manje od 1.5", "O2.5": "Više od 2.5", "U2.5": "Manje od 2.5",
    "O3.5": "Više od 3.5", "U3.5": "Manje od 3.5",
    "1&GG": "1 i oba tima daju gol", "2&GG": "2 i oba tima daju gol",
    "D2+": "Domaćin 2+ golova", "G2+": "Gost 2+ golova",
    "D0": "Domaćin ne zabija", "G0": "Gost ne zabija", "0-3": "0-3 gola",
  };

  // ------------------------------------------------------------ podaci
  async function load(force) {
    const r = await fetch("data.json" + (force ? "?t=" + Date.now() : ""), {cache: force ? "reload" : "default"});
    if (!r.ok) throw new Error("Ne mogu učitati podatke (" + r.status + ")");
    D = await r.json();
    L = {}; where = {}; byNorm = {}; fixByPair = {}; resultsByPair = {}; lamCache = {}; probCache = {}; byTeam = {};
    for (const lg of D.leagues) {
      L[lg.code] = lg;
      for (const t of lg.teams) { if (!where[t]) where[t] = lg.code; byNorm[norm(t)] = t; }
    }
    alias = {};
    for (const [k, v] of Object.entries(D.aliases)) alias[norm(k)] = v;
    for (const f of D.fixtures) { fixByPair[f.home + "|" + f.away] = f; fixByPair[f.league + "|" + f.home + "|" + f.away] = f; }
    for (const [d, h, a, hg, ag] of D.results) {
      const k = h + "|" + a;
      if (!resultsByPair[k]) resultsByPair[k] = [];
      resultsByPair[k].push([d, hg, ag]);
      (byTeam[h] = byTeam[h] || []).push([d, h, a, hg, ag]);
      (byTeam[a] = byTeam[a] || []).push([d, h, a, hg, ag]);
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
    for (const [d, lg, h, a, hs, as, ex, fs] of B.results) (bRes[h + "|" + a] = bRes[h + "|" + a] || []).push([d, hs, as, ex, fs]);
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
    // natjecanje uz par (npr. Liga prvaka) ima prednost pred domaćom ligom
    const LL = leg.league && L[leg.league];
    const forced = LL && LL.att && h in LL.att && a in LL.att ? leg.league : null;
    if (!forced && where[h] !== where[a]) return {error: `${h} (${L[where[h]].name}) i ${a} (${L[where[a]].name}) nisu u istoj ligi.`};
    const lg = L[forced || where[h]], bet = String(leg.bet || "1").trim();
    const fx = fixByPair[lg.code + "|" + h + "|" + a] || fixByPair[h + "|" + a];
    const mk = fx ? marketProbabilities(fx.odds) : {};
    const ck = lg.code + "|" + h + "|" + a;
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
    const res = legs.slice(0, 30).map(l => l.sport && l.sport !== "nog" ? evaluateBasketLeg(l) : evaluateLeg(l)), ok = res.filter(r => !r.error), total = {legs: ok.length};
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
  function basketLabel(bet, sport) {
    if (sport === "hok") return hockeyLabel(bet);
    if (sport === "ten") return tennisLabel(bet);
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
    if (lg.model === "poisson") return {total: o.total != null ? o.total : 5.5, market: o.total != null};
    if (lg.model === "elo") return {bo: f.bo || 3};
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
    if (lg.model === "poisson") return hockeyBetP(hockeyLambdas(lg, f.home, f.away, f).m, bet);
    if (lg.model === "elo") return tennisBetP(tennisMatchP(lg, f.home, f.away), f.bo || 3, bet);
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
    if (!h || !a) return {error: `Ne prepoznajem „${!h ? leg.home : leg.away}“.`};
    if (h === a) return {error: "Domaćin i gost su isti."};
    if (BI.where[h] !== BI.where[a]) return {error: `${h} i ${a} nisu u istoj ligi.`};
    const lg = BL[BI.where[h]], fx = bFix[h + "|" + a], bet = String(leg.bet || "1").trim();
    if (lg.model === "poisson") return evaluateHockey(leg, lg, h, a, fx, bet);
    if (lg.model === "elo") return evaluateTennis(leg, lg, h, a, fx, bet);
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

  // ------------------------------------------------------------ hokej (NHL)
  // Model golova regularnog dijela (60 min). "1OT"/"2OT" uključuju produžetke i raspucavanje,
  // a ukupno golova kao kod kladionica: pobjednik produžetaka dobiva jedan gol.
  function hockeyLabel(bet) {
    const [k, v] = String(bet).split(":"), x = v != null ? parseFloat(v).toLocaleString("hr-HR") : "";
    return ({"1": "1 (regularni dio)", "X": "X (regularni dio)", "2": "2 (regularni dio)",
      "1X": "1X (regularni dio)", "X2": "X2 (regularni dio)", "12": "12 (regularni dio)",
      "1OT": "1 (uključujući produžetke)", "2OT": "2 (uključujući produžetke)",
      "GG": "Oba tima daju gol", "NG": "Barem jedan tim ne daje gol"})[k]
      || (k === "O" ? `Više od ${x} golova` : k === "U" ? `Manje od ${x} golova`
      : k === "H1" ? `Hendikep domaćin ${fmtLine(parseFloat(v))}` : k === "H2" ? `Hendikep gost ${fmtLine(parseFloat(v))}` : bet);
  }
  function hockeyBetP(m, bet) {
    const [k, v] = String(bet).split(":"), x = parseFloat(v);
    let p1 = 0, px = 0, p2 = 0, over = 0, gg = 0, hc = 0;
    for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) {
      const q = m[i][j];
      if (i > j) p1 += q; else if (i < j) p2 += q; else px += q;
      if (k === "O" || k === "U") { const tot = i + j + (i === j ? 1 : 0); if (tot > x) over += q; }
      if (i > 0 && j > 0) gg += q;
      // hendikep (puck line) na konačnom rezultatu: kod neriješenog pobjednik produžetaka dobiva +1 (pola-pola)
      if (k === "H1" || k === "H2") {
        const marg = k === "H1" ? i - j : j - i;
        if (i === j) hc += q * 0.5 * ((1 + x > 0 ? 1 : 0) + (-1 + x > 0 ? 1 : 0));
        else if (marg + x > 0) hc += q;
      }
    }
    if (k === "H1" || k === "H2") return hc;
    if (k === "GG") return gg;
    if (k === "NG") return 1 - gg;
    const r = {"1": p1, "X": px, "2": p2, "1X": p1 + px, "X2": px + p2, "12": p1 + p2, "1OT": p1 + px / 2, "2OT": p2 + px / 2};
    if (k in r) return r[k];
    if (k === "O") return over;
    if (k === "U") return 1 - over;
    throw new Error("Nepoznata hokejaška oklada: " + bet);
  }
  const hCache = {};
  function hockeyLambdas(lg, h, a, fx) {
    const ck = h + "|" + a + "|" + (fx ? fx.utc : "");
    if (hCache[ck]) return hCache[ck];
    const mlh = Math.exp(lg.mu + lg.home + (lg.att[h] || 0) - (lg.de[a] || 0));
    const mla = Math.exp(lg.mu + (lg.att[a] || 0) - (lg.de[h] || 0));
    const o = (fx && fx.odds) || {};
    let lh = mlh, la = mla, market = false, pMkt = null;
    if (lg.weight > 0 && o["1OT"] && o["2OT"]) {
      const a1 = 1 / o["1OT"], a2 = 1 / o["2OT"]; pMkt = a1 / (a1 + a2);
      const pO = o.O && o.U && o.total != null ? (1 / o.O) / (1 / o.O + 1 / o.U) : null;
      const loss = (x, y) => {
        const m = matrix(Math.exp(x), Math.exp(y), lg.rho);
        let e = (hockeyBetP(m, "1OT") - pMkt) ** 2;
        if (pO != null) e += (hockeyBetP(m, `O:${o.total}`) - pO) ** 2;
        return e;
      };
      let x = Math.log(mlh), y = Math.log(mla), step = 0.2, best = loss(x, y);
      while (step > 0.004) {
        let moved = false;
        for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, -step], [-step, step], [step, step], [-step, -step]]) {
          const l = loss(x + dx, y + dy);
          if (l < best) { best = l; x += dx; y += dy; moved = true; break; }
        }
        if (!moved) step /= 2;
      }
      const w = lg.weight;
      lh = Math.exp((1 - w) * Math.log(mlh) + w * x);
      la = Math.exp((1 - w) * Math.log(mla) + w * y);
      market = true;
    }
    return (hCache[ck] = {lh, la, mlh, mla, market, m: matrix(lh, la, lg.rho), mModel: matrix(mlh, mla, lg.rho)});
  }
  function settleHockey(bet, hs, as, ot) {
    const [k, v] = String(bet).split(":"), x = parseFloat(v);
    const reg = ot ? "X" : hs > as ? "1" : "2";
    if (k === "1" || k === "X" || k === "2") return reg === k;
    if (k === "1X") return reg !== "2";
    if (k === "X2") return reg !== "1";
    if (k === "12") return reg !== "X";
    if (k === "1OT") return hs > as;
    if (k === "GG") return hs > 0 && as > 0;
    if (k === "NG") return hs === 0 || as === 0;
    if (k === "H1") return hs - as + x > 0;
    if (k === "H2") return as - hs + x > 0;
    if (k === "2OT") return as > hs;
    if (k === "O") return hs + as > x;
    if (k === "U") return hs + as < x;
    throw new Error("Nepoznata hokejaška oklada: " + bet);
  }
  function evaluateHockey(leg, lg, h, a, fx, bet) {
    const L = hockeyLambdas(lg, h, a, fx), o = (fx && fx.odds) || {};
    let p, pModel;
    try { p = hockeyBetP(L.m, bet); pModel = hockeyBetP(L.mModel, bet); } catch (e) { return {error: e.message}; }
    const [k, v] = bet.split(":");
    const pair = (x, y) => (o[x] && o[y]) ? (1 / o[x]) / (1 / o[x] + 1 / o[y]) : null;
    const pMarket = k === "1OT" ? pair("1OT", "2OT") : k === "2OT" ? pair("2OT", "1OT")
      : k === "O" && parseFloat(v) === o.total ? pair("O", "U") : k === "U" && parseFloat(v) === o.total ? pair("U", "O") : null;
    return otherResult(leg, lg, h, a, fx, bet, "hok", p, pModel, pMarket, L.market, {
      points: [L.lh, L.la], margin: L.lh - L.la, total: L.lh + L.la,
      basic: {"1": hockeyBetP(L.m, "1"), "X": hockeyBetP(L.m, "X"), "2": hockeyBetP(L.m, "2"), "1OT": hockeyBetP(L.m, "1OT")},
      lines: basketLines(fx || {league: lg.code, odds: {}}),
    });
  }

  // ------------------------------------------------------------ tenis (ATP / WTA)
  // Elo ocjena igrača -> šansa za meč -> šansa za set -> rezultat u setovima.
  function tennisLabel(bet) {
    const [k, a, b] = String(bet).split(":");
    if (k === "1") return "Pobjeda prvog igrača";
    if (k === "2") return "Pobjeda drugog igrača";
    if (k === "S") return `Rezultat u setovima ${a}:${b}`;
    if (k === "SO") return `Više od ${parseFloat(a).toLocaleString("hr-HR")} seta`;
    if (k === "SU") return `Manje od ${parseFloat(a).toLocaleString("hr-HR")} seta`;
    if (k === "F1") return "Prvi igrač osvaja 1. set";
    if (k === "F2") return "Drugi igrač osvaja 1. set";
    if (k === "A1") return "Prvi igrač osvaja barem jedan set";
    if (k === "A2") return "Drugi igrač osvaja barem jedan set";
    return bet;
  }
  function tennisMatchP(lg, a, b) {
    const ra = lg.elo[a] ?? 1450, rb = lg.elo[b] ?? 1450;
    return 1 / (1 + Math.pow(10, (rb - ra) / 400));
  }
  function setScores(s, bo) {
    const q = 1 - s, out = {};
    if (bo === 5) Object.assign(out, {"3:0": s ** 3, "3:1": 3 * s ** 3 * q, "3:2": 6 * s ** 3 * q * q, "2:3": 6 * s * s * q ** 3, "1:3": 3 * s * q ** 3, "0:3": q ** 3});
    else Object.assign(out, {"2:0": s * s, "2:1": 2 * s * s * q, "1:2": 2 * s * q * q, "0:2": q * q});
    return out;
  }
  function setP(pm, bo) {   // vjerojatnost osvajanja seta iz koje slijedi zadana šansa za meč
    let lo = 0, hi = 1;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2, sc = setScores(mid, bo);
      const win = Object.entries(sc).filter(([k]) => +k[0] > +k[2]).reduce((x, [, v]) => x + v, 0);
      if (win < pm) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function tennisBetP(pm, bo, bet) {
    const [k, a, b] = String(bet).split(":");
    if (k === "1") return pm;
    if (k === "2") return 1 - pm;
    const sp = setP(pm, bo), sc = setScores(sp, bo);
    if (k === "S") return sc[`${a}:${b}`] ?? 0;
    if (k === "F1") return sp;
    if (k === "F2") return 1 - sp;
    if (k === "A1") return 1 - (bo === 5 ? sc["0:3"] : sc["0:2"]);
    if (k === "A2") return 1 - (bo === 5 ? sc["3:0"] : sc["2:0"]);
    const line = parseFloat(a), over = Object.entries(sc).filter(([key]) => +key[0] + +key[2] > line).reduce((x, [, v]) => x + v, 0);
    if (k === "SO") return over;
    if (k === "SU") return 1 - over;
    throw new Error("Nepoznata teniska oklada: " + bet);
  }
  function settleTennis(bet, s1, s2, w, fs) {
    const [k, a, b] = String(bet).split(":");
    if (k === "F1" || k === "F2") { if (!fs) throw new Error("nema rezultata 1. seta"); return fs === (k === "F1" ? 1 : 2); }
    if (k === "A1") return s1 >= 1;
    if (k === "A2") return s2 >= 1;
    if (k === "1") return w === 1;
    if (k === "2") return w === 2;
    if (k === "S") return s1 === +a && s2 === +b;
    if (k === "SO") return s1 + s2 > parseFloat(a);
    if (k === "SU") return s1 + s2 < parseFloat(a);
    throw new Error("Nepoznata teniska oklada: " + bet);
  }
  function evaluateTennis(leg, lg, h, a, fx, bet) {
    const bo = (fx && fx.bo) || (leg.lines && leg.lines.bo) || 3, pm = tennisMatchP(lg, h, a);
    let p;
    try { p = tennisBetP(pm, bo, bet); } catch (e) { return {error: e.message}; }
    const r = otherResult(leg, lg, h, a, fx, bet, "ten", p, p, null, false, {
      elo: [lg.elo[h] ?? null, lg.elo[a] ?? null], basic: {"1": pm, "2": 1 - pm}, bo, lines: {bo},
      tournament: fx && fx.tournament, round: fx && fx.round,
    });
    // ime igrača umjesto "prvi/drugi igrač"
    if (bet === "1") r.betLabel = `Pobjeda: ${h}`;
    if (bet === "2") r.betLabel = `Pobjeda: ${a}`;
    if (bet === "F1" || bet === "F2") r.betLabel = `${bet === "F1" ? h : a} osvaja 1. set`;
    if (bet === "A1" || bet === "A2") r.betLabel = `${bet === "A1" ? h : a} osvaja barem jedan set`;
    return r;
  }

  function otherResult(leg, lg, h, a, fx, bet, sport, p, pModel, pMarket, market, extra) {
    let odds = leg.odds === undefined || leg.odds === null || leg.odds === "" ? null : parseFloat(String(leg.odds).replace(",", "."));
    if (!(odds > 0)) odds = null;
    const row = t => { const i = lg.table.findIndex(r => r.team === t); return i < 0 ? null : {pos: i + 1, ...lg.table[i]}; };
    return {
      sport, home: h, away: a, league: lg.code, leagueName: lg.name, flag: lg.flag, accuracy: lg.accuracy, bet,
      betLabel: basketLabel(bet, sport), p, pModel, pMarket, source: market ? "model+kladionice" : "model",
      fairOdds: p > 0 ? 1 / p : null, odds, value: odds ? p * odds - 1 : null,
      date: fx ? fx.iso : null, time: fx ? fx.time : null, homeRow: row(h), awayRow: row(a), ...extra,
    };
  }
  function settleOther(sport, bet, g) {
    if (sport === "hok") return settleHockey(bet, g[1], g[2], !!g[3]);
    if (sport === "ten") return settleTennis(bet, g[1], g[2], g[3], g[4]);
    return settleBasket(bet, g[1], g[2]);
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
      legs: legs.map(r => ({home: r.home, away: r.away, league: r.league, bet: r.bet, betLabel: r.betLabel, p: r.p, odds: r.odds, date: r.date, time: r.time, sport: r.sport || "nog"})),
    };
    const all = loadTickets(); all.push(t);
    return storeTickets(all) ? {ok: true, id: t.id} : {error: "Preglednik ne dopušta spremanje (privatni način?)."};
  }
  function deleteTicket(id) { storeTickets(loadTickets().filter(t => t.id !== id)); return {ok: true}; }

  const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
  function findResult(leg, created) {
    let games = (leg.sport && leg.sport !== "nog" ? bRes : resultsByPair)[leg.home + "|" + leg.away] || [];
    games = leg.date ? games.filter(g => Math.abs(dayDiff(g[0], leg.date)) <= 2)
                     : games.filter(g => dayDiff(g[0], created) >= -1);
    return games.length ? games.slice().sort()[0] : null;
  }

  // ------------------------------------------------------------ rezultati uživo (ESPN, odmah nakon utakmice)
  // Spremljeni podaci osvježavaju se nekoliko puta dnevno; za tikete aplikacija sama pita ESPN.
  const ESPN_API = "https://site.api.espn.com/apis/site/v2/sports/";
  let LIVE = {};                      // "sport|domaćin|gost" -> {done, row, score}
  const liveFetched = {};             // url -> vrijeme zadnjeg upita
  const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
  function liveSource(leg) {
    const sp = leg.sport || "nog";
    if (sp === "nog") {
      const code = leg.league || where[leg.home], slug = ((D.espn || {}).slugs || {})[code];
      return slug ? {sp, path: "soccer/" + slug, names: ((D.espn || {}).names || {})[code] || {}} : null;
    }
    const lg = leg.league || BI.where[leg.home];
    if (sp === "kos" && lg === "NBA") return {sp, path: "basketball/nba", names: {}};
    if (sp === "hok") return {sp, path: "hockey/nhl", names: {}};
    if (sp === "ten" && (lg === "ATP" || lg === "WTA")) return {sp, path: "tennis/" + lg.toLowerCase(), names: {}};
    return null;
  }
  const scoreOf = x => { const v = x && x.score; return v == null ? null : +(typeof v === "object" ? (v.value ?? v.displayValue) : v); };
  function readTeamGame(src, c, date) {
    const side = {}; for (const x of c.competitors || []) side[x.homeAway] = x;
    if (!side.home || !side.away) return;
    const nm = x => src.names[x.team.displayName] || x.team.displayName;
    const st = c.status.type, state = st.state, hs = scoreOf(side.home), as = scoreOf(side.away);
    if (state === "pre" || hs == null || as == null || isNaN(hs) || isNaN(as)) return;
    let row = [date, hs, as];
    if (src.sp === "hok") {            // oklade se računaju na regularni dio (3 trećine)
      const per = x => (x.linescores || []).slice(0, 3).reduce((s, l) => s + (+l.value || 0), 0);
      const ot = (side.home.linescores || []).length > 3 || /OT|SO/i.test(st.shortDetail || st.detail || "");
      row = ot ? [date, per(side.home), per(side.away), true] : [date, hs, as, false];
    }
    LIVE[src.sp + "|" + nm(side.home) + "|" + nm(side.away)] = {done: !!st.completed, row, score: `${hs}:${as}`};
  }
  function readTennis(c, date) {
    const comp = c.competitors || [];
    if (comp.length !== 2) return;
    const names = comp.map(x => (x.athlete || {}).displayName), st = c.status.type;
    if (!names[0] || !names[1] || st.state === "pre" || st.name === "STATUS_WALKOVER") return;
    const ls = comp.map(x => (x.linescores || []).map(l => +l.value || 0)), sets = [0, 0];
    for (let k = 0; k < Math.min(ls[0].length, ls[1].length); k++) {
      const a = ls[0][k], b = ls[1][k];
      if (Math.max(a, b) < 6 || (Math.abs(a - b) < 2 && Math.max(a, b) !== 7)) continue;
      sets[a > b ? 0 : 1]++;
    }
    const fs = ls[0].length && ls[1].length && Math.max(ls[0][0], ls[1][0]) >= 6 ? (ls[0][0] > ls[1][0] ? 1 : 2) : 0;
    const w = comp[0].winner ? 1 : comp[1].winner ? 2 : 0;
    const done = !!st.completed && !!w;
    const put = (h, a, row, score) => { LIVE["ten|" + h + "|" + a] = {done, row, score}; };
    put(names[0], names[1], [date, sets[0], sets[1], w, fs], `${sets[0]}:${sets[1]}`);
    put(names[1], names[0], [date, sets[1], sets[0], w ? 3 - w : 0, fs ? 3 - fs : 0], `${sets[1]}:${sets[0]}`);
  }
  async function fetchLive(maxAge = 45000) {
    const now = new Date(), jobs = {};
    for (const t of loadTickets()) for (const leg of t.legs) {
      if (!leg.date) continue;
      const start = leg.time ? new Date(leg.date + "T" + leg.time) : new Date(leg.date + "T00:00");
      if (start > now || now - start > 3 * 864e5) continue;          // nije počela ili je davno gotova
      const key = (leg.sport || "nog") + "|" + leg.home + "|" + leg.away;
      if (LIVE[key] && LIVE[key].done) continue;
      const src = liveSource(leg);
      if (!src) continue;
      // ESPN dan ovisi o američkom vremenu, pa pitamo i susjedne dane
      const base = new Date(leg.date + "T12:00:00Z");
      for (const off of src.sp === "nog" ? [0] : [-1, 0, 1]) {
        const url = `${ESPN_API}${src.path}/scoreboard?dates=${ymd(new Date(base.getTime() + off * 864e5))}`;
        if (!liveFetched[url] || now - liveFetched[url] > maxAge) jobs[url] = {src, date: leg.date};
      }
    }
    const urls = Object.keys(jobs);
    await Promise.all(urls.map(async url => {
      liveFetched[url] = Date.now();
      try {
        const js = await (await fetch(url, {cache: "no-store"})).json(), {src, date} = jobs[url];
        for (const ev of js.events || []) {
          if (src.sp === "ten") { for (const g of ev.groupings || []) for (const c of g.competitions || []) readTennis(c, date); }
          else if (ev.competitions && ev.competitions[0]) readTeamGame(src, ev.competitions[0], date);
        }
      } catch (e) { /* bez interneta: ostaju spremljeni podaci */ }
    }));
    return urls.length;
  }

  function ticketsPayload() {
    const out = loadTickets().sort((a, b) => b.created.localeCompare(a.created)).map(t => {
      const created = t.created.slice(0, 10);
      let status = "won";
      for (const leg of t.legs) {
        if (!leg.time) {
          const fx = leg.sport === "kos" ? bFix[leg.home + "|" + leg.away] : fixByPair[leg.home + "|" + leg.away];
          if (fx) { leg.time = leg.sport === "kos" ? fx.time : hrTime(fx); if (!leg.date) leg.date = fx.iso; }
        }
        let g = findResult(leg, created);
        const lv = LIVE[(leg.sport || "nog") + "|" + leg.home + "|" + leg.away];
        if (!g && lv && lv.done) g = lv.row;
        leg.live = !g && lv && !lv.done ? lv.score : null;
        if (g) {
          leg.score = `${g[1]}:${g[2]}`; leg.playedOn = g[0];
          try { leg.status = (leg.sport && leg.sport !== "nog" ? settleOther(leg.sport, leg.bet, g) : settleBet(leg.bet, g[1], g[2])) ? "won" : "lost"; } catch { leg.status = "pending"; }
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

  // Šansa za bilo koju nogometnu okladu iz iste matrice rezultata (za 20 opcija u ponudi).
  const fullCache = {};
  function fixtureBetP(f, bet) {
    const key = f.league + "|" + f.home + "|" + f.away;
    if (!fullCache[key]) {
      const r = evaluateLeg({home: f.home, away: f.away, bet: "1", league: f.league});
      const c = lamCache[key];
      fullCache[key] = r.error || !c ? null : matrix(c.lh, c.la, L[f.league].rho);
    }
    const m = fullCache[key];
    if (!m) return null;
    try { return betProbability(m, bet); } catch { return null; }
  }
  // Šanse za gumbe nogometne ponude (1, X, 2, 3+, 0-2) jednim izračunom.
  function fixtureProbs(f) {
    const k = f.league + "|" + f.home + "|" + f.away;
    if (!probCache[k]) {
      const r = evaluateLeg({home: f.home, away: f.away, bet: "1", league: f.league});
      const b = r.basic || {};
      probCache[k] = r.error ? {} : {"1": b["1"], "X": b.X, "2": b["2"], "1X": b["1"] + b.X, "X2": b.X + b["2"], "12": b["1"] + b["2"],
        "GG": b.GG, "NG": 1 - b.GG, "3+": b["O2.5"], "0-2": 1 - b["O2.5"], source: r.source};
    }
    return probCache[k];
  }
  // Kad za utakmicu nema kvota, kvotu procjenjujemo iz šanse uz tipičnu maržu kladionica (~6 %).
  const EST_MARGIN = 0.94;
  const estOdds = p => Math.round(EST_MARGIN / p * 100) / 100;
  // Svi tipovi oklada iz ponude, sa stvarnom kvotom gdje postoji (inače procjena iz šanse).
  function candidates(item) {
    const f = item.f, out = [], o = f.odds || {};
    const add = (bet, p, odds) => { if (p > 0.02 && p < 0.98) out.push({bet, p, odds: odds || estOdds(p), est: !odds}); };
    const dbl = (a, b) => o[a] && o[b] ? Math.round(100 / (1 / o[a] + 1 / o[b])) / 100 : null;
    if (item.sport === "hok") {
      const L = basketLines(f);
      for (const [bet, odds] of [["1"], ["X"], ["2"], ["1X"], ["X2"], ["12"], ["1OT", o["1OT"]], ["2OT", o["2OT"]],
        [`O:${L.total}`, L.market ? o.O : null], [`U:${L.total}`, L.market ? o.U : null]]) add(bet, basketProbFor(f, bet), odds);
    } else if (item.sport === "ten") {
      const bo = f.bo || 3, line = bo === 5 ? 3.5 : 2.5;
      const sets = bo === 5 ? ["3:0", "3:1", "3:2", "2:3", "1:3", "0:3"] : ["2:0", "2:1", "1:2", "0:2"];
      for (const bet of ["1", "2", ...sets.map(x => "S:" + x), `SO:${line}`, `SU:${line}`]) add(bet, basketProbFor(f, bet));
    } else if (item.sport === "kos") {
      const L = basketLines(f);
      for (const [bet, odds] of [["1", o["1"]], ["2", o["2"]], [`H1:${L.spread}`, L.market ? o.H1 : null],
        [`H2:${-L.spread}`, L.market ? o.H2 : null], [`O:${L.total}`, o.total === L.total ? o.O : null], [`U:${L.total}`, o.total === L.total ? o.U : null],
        [`DO:${L.home}`], [`DU:${L.home}`], [`GO:${L.away}`], [`GU:${L.away}`]]) add(bet, basketProbFor(f, bet), odds);
    } else {
      const pr = fixtureProbs(f);
      for (const [bet, odds] of [["1", o["1"]], ["X", o.X], ["2", o["2"]], ["1X", dbl("1", "X")], ["X2", dbl("X", "2")], ["12", dbl("1", "2")],
        ["GG"], ["NG"], ["3+", o["O2.5"]], ["0-2", o["U2.5"]]]) add(bet, pr[bet], odds);
    }
    return out;
  }
  // Vrsta oklade, da se prijedlozi ne svode na istu (npr. svugdje "pobjeda").
  function betFamily(sport, bet) {
    const k = String(bet).split(":")[0];
    if (["1", "2", "1OT", "2OT"].includes(k)) return "pobjednik";
    if (["1X", "X2", "12"].includes(k)) return "dupla";
    if (k === "X") return "nerijeseno";
    if (["GG", "NG"].includes(k)) return "golovi-oba";
    if (["3+", "0-2", "O", "U"].includes(k)) return "ukupno";
    if (["H1", "H2"].includes(k)) return "hendikep";
    if (["DO", "DU", "GO", "GU"].includes(k)) return "momcad-poeni";
    if (k === "S") return "setovi-rezultat";
    if (["SO", "SU"].includes(k)) return "setovi-broj";
    return k;
  }
  // Filter: ili kvota barem minOdds, ili šansa u rasponu (maxP - 10 %, maxP].
  const BAND = 0.10;
  function pickFrom(pool, minOdds, maxP, count, spread) {
    const minP = maxP < 1 ? maxP - BAND : 0;
    // kandidati: za svaku utakmicu nekoliko najboljih oklada koje prolaze filter
    const cands = [];
    for (const item of pool) {
      candidates(item).filter(c => c.odds >= minOdds && c.p <= maxP && c.p > minP)
        .sort((a, b) => b.p - a.p).slice(0, 5).forEach(c => cands.push({item, c, fam: betFamily(item.sport, c.bet), date: localIso(item.k)}));
    }
    cands.sort((a, b) => b.c.p - a.c.p);

    // Pravila raznolikosti: svaki sport zastupljen (bar 1, uz 10 parova bar 2), ista vrsta oklade
    // najviše trećina prijedloga, tjedni raspoređen kroz dane (najviše trećina isti dan),
    // jedna oklada po utakmici. Ako nema dovoljno, pravila se postupno opuštaju.
    const cap = Math.max(1, Math.ceil(count / 3)), quota = count >= 10 ? 2 : 1, dayCap = spread ? cap : Infinity;
    const chosen = [], usedFx = new Set(), perDay = {}, perFam = {};
    const ok = (x, famOn, dayOn) => !usedFx.has(x.item) && (!famOn || (perFam[x.fam] || 0) < cap) && (!dayOn || (perDay[x.date] || 0) < dayCap);
    const take = x => { chosen.push(x); usedFx.add(x.item); perDay[x.date] = (perDay[x.date] || 0) + 1; perFam[x.fam] = (perFam[x.fam] || 0) + 1; };
    for (const sp of [...new Set(cands.map(x => x.item.sport))]) {
      let n = 0;
      for (const x of cands) { if (n >= quota || chosen.length >= count) break; if (x.item.sport === sp && ok(x, true, true)) { take(x); n++; } }
    }
    for (const [famOn, dayOn] of [[true, true], [true, false], [false, true], [false, false]]) {
      for (const x of cands) { if (chosen.length >= count) break; if (ok(x, famOn, dayOn)) take(x); }
    }

    const picks = [];
    for (const {item, c} of chosen) {
      const f = item.f, leg = {home: f.home, away: f.away, bet: c.bet, odds: c.odds, sport: item.sport, league: f.league};
      const r = item.sport !== "nog" ? evaluateBasketLeg(leg) : evaluateLeg(leg);
      if (r.error) continue;
      picks.push({...r, odds: c.odds, sport: item.sport, est: c.est, ev: r.p * c.odds - 1, k: item.k.getTime(),
        date: localIso(item.k), time: `${String(item.k.getHours()).padStart(2, "0")}:${String(item.k.getMinutes()).padStart(2, "0")}`,
        lines: item.sport !== "nog" ? basketLines(f) : undefined});
    }
    picks.sort((a, b) => a.k - b.k);
    const total = picks.length ? {p: picks.reduce((x, r) => x * r.p, 1), odds: picks.reduce((x, r) => x * r.odds, 1)} : null;
    if (total) total.value = total.p * total.odds - 1;
    return {picks, total, considered: pool.length, sports: [...new Set(pool.map(x => x.sport))], minP};
  }

  // Prijedlog dana: utakmice danas koje još nisu počele (ako danas nema ničega,
  // prvi sljedeći dan s utakmicama). Prijedlog tjedna: od sada idućih 7 dana. Svi sportovi.
  // daySport / weekSport: "all", "nog" ili "kos" - posebno za prijedlog dana i tjedna
  // Goriona: 3 para s visokom kvotom (5+) ili malom šansom (do 10 %) iz svih sportova, samo današnje
  // utakmice koje još nisu počele (ako danas više nema ničega, prvi sljedeći dan s utakmicama).
  // Unutar tog uvjeta biraju se parovi s najvećom šansom, svaki iz drugog sporta ako je moguće.
  function goriona(mode = "odds", now = new Date()) {
    if (!D) return null;
    const today = localIso(now);
    const open = [
      ...D.fixtures.map(f => ({sport: "nog", f, k: kickoff(f)})),
      ...B.fixtures.filter(f => BL[f.league]).map(f => ({sport: BL[f.league].sport || "kos", f, k: new Date(f.utc)})),
    ].filter(x => x.k > now).sort((a, b) => a.k - b.k);
    const pick = pool => mode === "chance" ? pickFrom(pool, 0, 0.10, 3, false) : pickFrom(pool, 5, 1, 3, false);
    let day = today, r = pick(open.filter(x => localIso(x.k) === today));
    if (!r.picks.length) {   // danas više nema prikladnih parova: prvi sljedeći dan koji ih ima
      for (const d of [...new Set(open.map(x => localIso(x.k)))].filter(d => d > today)) {
        r = pick(open.filter(x => localIso(x.k) === d));
        if (r.picks.length) { day = d; break; }
      }
    }
    return {...r, mode, date: day, isToday: day === today};
  }

  function picks(minOdds = 1.5, maxP = 1, count = 5, daySport = "all", weekSport = "all", now = new Date()) {
    if (!D) return null;
    const today = localIso(now);
    const weekEnd = localIso(new Date(now.getTime() + 6 * 864e5));
    const open = [
      ...D.fixtures.map(f => ({sport: "nog", f, k: kickoff(f)})),
      ...B.fixtures.filter(f => BL[f.league]).map(f => ({sport: BL[f.league].sport || "kos", f, k: new Date(f.utc)})),
    ].filter(x => x.k > now).sort((a, b) => a.k - b.k);
    const bySport = sp => sp === "all" ? open : open.filter(x => x.sport === sp);
    const dayOpen = bySport(daySport);
    const todays = dayOpen.filter(x => localIso(x.k) === today);
    const dayIso = todays.length ? today : (dayOpen[0] ? localIso(dayOpen[0].k) : today);
    const dayPool = todays.length ? todays : dayOpen.filter(x => localIso(x.k) === dayIso);
    const weekPool = bySport(weekSport).filter(x => localIso(x.k) <= weekEnd);
    const lastFixture = open.length ? localIso(open[open.length - 1].k) : null;
    return {
      minOdds, maxP, count, today, daySport, weekSport,
      day: {...pickFrom(dayPool, minOdds, maxP, count, false), date: dayIso, isToday: dayIso === today},
      week: {...pickFrom(weekPool, minOdds, maxP, count, true), from: today, to: weekEnd, lastFixture},
    };
  }
  const hrTime = f => { const k = kickoff(f); return `${String(k.getHours()).padStart(2, "0")}:${String(k.getMinutes()).padStart(2, "0")}`; };

  function initPayload() {
    return {
      uefa: D.uefa || [],
      leagues: D.leagues.map(l => ({code: l.code, name: l.name, flag: l.flag, country: l.country, uefa: !!l.uefa,
        weight: l.weight, accuracy: l.accuracy, teams: l.teams, table: l.table})),
      top5: D.top5 || [], accuracySeason: D.accuracySeason,
      basket: {
        leagues: B.leagues.map(l => ({code: l.code, sport: l.sport || "kos", model: l.model || "points", name: l.name, flag: l.flag, country: l.country, hasOdds: l.hasOdds,
          accuracy: l.accuracy, teams: l.teams, table: l.table, forms: l.forms})),
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
    if (path === "/api/goriona") return goriona(body?.mode || "odds");
    if (path === "/api/picks") return body?.mode === "chance"
      ? picks(0, body?.maxP || 0.5, body?.count || 5, body?.daySport || "all", body?.weekSport || "all")
      : picks(body?.minOdds || 1.5, 1, body?.count || 5, body?.daySport || "all", body?.weekSport || "all");
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

  // Zadnje utakmice kluba (nogomet): sve, kod kuće i u gostima, najnovije prve.
  function teamForm(team, n = 5) {
    // potpuna forma iz svih natjecanja (domaća liga + Europa), isti klub pod različitim imenima
    const name = (D.formAlias || {})[team] || team, full = (D.form || {})[name];
    if (full && full.length) {
      const games = full.map(([d, opp, home, gf, ga]) => ({date: d, home: !!home, opponent: opp, gf, ga, res: gf > ga ? "W" : gf === ga ? "D" : "L"}));
      return {last: games.slice(0, n), home: games.filter(g => g.home).slice(0, n), away: games.filter(g => !g.home).slice(0, n)};
    }
    const games = (byTeam[team] || []).slice().sort((x, y) => y[0].localeCompare(x[0])).map(([d, h, a, hg, ag]) => {
      const home = h === team, gf = home ? hg : ag, ga = home ? ag : hg;
      return {date: d, home, opponent: home ? a : h, gf, ga, res: gf > ga ? "W" : gf === ga ? "D" : "L"};
    });
    return {last: games.slice(0, n), home: games.filter(g => g.home).slice(0, n), away: games.filter(g => !g.home).slice(0, n)};
  }
  return {api, fetchLive, teamForm, exportTickets, importTickets, hrTime, basketLabel, basketProbFor, fixtureProbs, fixtureBetP, _test: {findTeam, settleBet, matrix, betProbability}};
})();
