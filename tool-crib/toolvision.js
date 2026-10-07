/* Tool Crib vision: measure a tool lying on a sheet of letter/A4 paper (diameter + overall length) and count tools on paper.
   Paper detection + camera pose come from CNC Check's vision.js (CNCVision). Pure JS, no DOM. Units: inches.
   Input image: {data: RGBA bytes, width, height}. */
(function (root) {
  'use strict';
  const V = root.CNCVision || (typeof require !== 'undefined' ? require('./vision.js') : null);
  const median = a => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  function bil(A, w, h, x, y) {
    if (!(x >= 0 && y >= 0 && x <= w - 1.001 && y <= h - 1.001)) return NaN;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (A[i] * (1 - fx) + A[i + 1] * fx) * (1 - fy) + (A[i + w] * (1 - fx) + A[i + w + 1] * fx) * fy;
  }
  function solveLin(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null; const t = M[c]; M[c] = M[p]; M[p] = t;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function fitQuadratic(vals, w, h, wt) {
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), b = new Array(6).fill(0);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) { const i = y * w + x; if (!wt[i]) continue; const u = x / w - .5, v = y / h - .5, r = [1, u, v, u * u, u * v, v * v]; for (let a = 0; a < 6; a++) { b[a] += r[a] * vals[i]; for (let c = 0; c < 6; c++) A[a][c] += r[a] * r[c]; } }
    const s = solveLin(A, b); if (!s) return null;
    return (x, y) => { const u = x / w - .5, v = y / h - .5; return s[0] + s[1] * u + s[2] * v + s[3] * u * u + s[4] * u * v + s[5] * v * v; };
  }
  function morph(m, w, h, r, dil) {
    const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { let row = y * w; for (let x = 0; x < w; x++) { let v = dil ? 0 : 1; for (let k = -r; k <= r; k++) { const xx = x + k; const q = xx < 0 || xx >= w ? (dil ? 0 : 1) : m[row + xx]; if (dil ? q : !q) { v = dil ? 1 : 0; break; } } t[row + x] = v; } }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = dil ? 0 : 1; for (let k = -r; k <= r; k++) { const yy = y + k; const q = yy < 0 || yy >= h ? (dil ? 0 : 1) : t[yy * w + x]; if (dil ? q : !q) { v = dil ? 1 : 0; break; } } o[y * w + x] = v; }
    return o;
  }
  function fillHoles(m, w, h) {
    const out = new Uint8Array(w * h).fill(1), st = new Int32Array(w * h); let sp = 0;
    const push = p => { if (!m[p] && out[p]) { out[p] = 0; st[sp++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); } for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) { const p = st[--sp], x = p % w, y = (p / w) | 0; if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w); }
    return out;
  }
  function components(m, w, h) {
    const lab = new Int32Array(w * h), st = new Int32Array(w * h), comps = []; let id = 0;
    for (let s = 0; s < w * h; s++) {
      if (!m[s] || lab[s]) continue; id++; let sp = 0; st[sp++] = s; lab[s] = id;
      const c = { id, n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, x0: 1e9, x1: -1, y0: 1e9, y1: -1 };
      while (sp) {
        const p = st[--sp], x = p % w, y = (p / w) | 0;
        c.n++; c.sx += x; c.sy += y; c.sxx += x * x; c.syy += y * y; c.sxy += x * y; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = id; st[sp++] = p - 1; } if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = id; st[sp++] = p + 1; }
        if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = id; st[sp++] = p - w; } if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = id; st[sp++] = p + w; }
      }
      comps.push(c);
    }
    return { lab, comps };
  }

  // ---------------- standard sizes ----------------
  const NUMBER_DRILL = [0, .228, .221, .213, .209, .2055, .204, .201, .199, .196, .1935, .191, .189, .185, .182, .18, .177, .173, .1695, .166, .161, .159, .157, .154, .152, .1495, .147, .144, .1405, .136, .1285, .12, .116, .113, .111, .11, .1065, .104, .1015, .0995, .098, .096, .0935, .089, .086, .082, .081, .0785, .076, .073, .07, .067, .0635, .0595, .055, .052, .0465, .043, .042, .041, .04, .039, .038, .037, .036, .035, .033, .032, .031, .0292, .028, .026, .025, .024, .0225, .021, .02, .018, .016, .0145, .0135];
  const LETTER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', LETTER_DRILL = [.234, .238, .242, .246, .25, .257, .261, .266, .272, .277, .281, .29, .295, .302, .316, .323, .332, .339, .348, .358, .368, .377, .386, .397, .404, .413];
  function frac(n, d) { let a = n, b = d; while (a % 2 === 0 && b % 2 === 0) { a /= 2; b /= 2; } const w = Math.floor(a / b), r = a % b; return (w ? w + (r ? '-' : '') : '') + (r ? r + '/' + b : ''); }
  let SIZES = null;
  function sizes() {
    if (SIZES) return SIZES; SIZES = [];
    for (let n = 1; n <= 64 * 3; n++) { const v = n / 64; const den = n % 16 === 0 ? 16 : n % 8 === 0 ? 8 : n % 4 === 0 ? 4 : n % 2 === 0 ? 32 : 64; if (v > 1 && den === 64) continue; SIZES.push({ v, label: frac(n, 64), fam: 'frac', pri: den <= 16 ? 0 : den === 32 ? 1 : 2 }); }
    NUMBER_DRILL.forEach((v, i) => { if (i) SIZES.push({ v, label: '#' + i, fam: 'num', pri: 3 }); });
    LETTER_DRILL.forEach((v, i) => SIZES.push({ v, label: LETTER[i], fam: 'ltr', pri: 3 }));
    for (let mm = 1; mm <= 50; mm += 0.5) SIZES.push({ v: mm / 25.4, label: (mm % 1 ? mm.toFixed(1) : mm) + 'mm', fam: 'mm', pri: mm % 1 ? 5 : 4 });
    return SIZES;
  }
  // nearest standard sizes to a measured diameter. tol in inches. Returns sorted candidates (best first).
  function snapDia(d, tol, prefer) {
    tol = tol || Math.max(0.006, 0.012 * d);
    const c = sizes().filter(s => Math.abs(s.v - d) <= tol).map(s => {
      let score = Math.abs(s.v - d) / tol + s.pri * 0.12;
      if (prefer === 'drill' && (s.fam === 'num' || s.fam === 'ltr')) score -= 0.25;
      if (prefer === 'metric' && s.fam === 'mm') score -= 0.4;
      return Object.assign({ err: s.v - d, score }, s);
    });
    return c.sort((a, b) => a.score - b.score);
  }

  // True overall length from the apparent end positions. The farthest-out point of an end in the photo is not its tip:
  // parts of the end that sit higher above the paper project farther out. End shapes: flat, point (118 deg), ball.
  function endSamples(kind, r) {
    const out = [];
    if (kind === 'point') { const h = 0.6 * r; for (let k = 0; k <= 20; k++) { const d = h * k / 20, rho = r * d / h; out.push([d, r - rho], [d, r + rho]); } }
    else if (kind === 'ball') { for (let k = 0; k <= 20; k++) { const d = r * k / 20, rho = Math.sqrt(Math.max(0, r * r - (r - d) ** 2)); out.push([d, r - rho], [d, r + rho]); } }
    else out.push([0, 0], [0, 2 * r]);
    return out;
  }
  function trueEnd(q, sgn, kind, Ns, Hc, r) {
    const smp = endSamples(kind, r);
    const app = st => { let m = -1e9; for (const [d, z] of smp) { const s = st - sgn * d, p = Ns + (s - Ns) * Hc / (Hc - z); if (sgn * p > m) m = sgn * p; } return m; };
    let lo = sgn * q - 1.5, hi = sgn * q + 1.5;   // app() grows with sgn*st
    for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2; if (app(sgn * mid) > sgn * q) hi = mid; else lo = mid; }
    return sgn * (lo + hi) / 2;
  }
  function oalFor(g, tip) {
    const k0 = tip !== 'flat' && g.tipEnd === 0 ? tip : 'flat', k1 = tip !== 'flat' && g.tipEnd === 1 ? tip : 'flat';
    return trueEnd(g.ends[1], 1, k1, g.Ns, g.Hc, g.r) - trueEnd(g.ends[0], -1, k0, g.Ns, g.Hc, g.r);
  }

  // ---------------- analysis ----------------
  function analyze(img, opts) {
    opts = opts || {};
    const work = V.prep(img);
    const paper = V.findPaper(work, { f35: opts.f35 });
    if (!paper.ok) return { ok: false, msg: paper.msg, paper };
    // a label or box can pass for paper; a real sheet measures close to its known shape (letter 1.29, A4 1.41)
    if (paper.aspectMeasured) { const want = Math.max(paper.pw, paper.ph) / Math.min(paper.pw, paper.ph), got = paper.aspectMeasured >= 1 ? paper.aspectMeasured : 1 / paper.aspectMeasured;
      if (Math.abs(got / want - 1) > 0.15) return { ok: false, label: true, msg: 'No sheet of paper found (this looks like a label or box)', paper: Object.assign({}, paper, { ok: false }) }; }
    const P = paper.pose, H = paper.H, pw = paper.pw, ph = paper.ph;
    const ppiImg = paper.ppiImg, ppi = Math.max(40, Math.min(90, Math.round(ppiImg * 0.8)));
    const W = Math.round(pw * ppi), Hh = Math.round(ph * ppi), n = W * Hh;
    const L = new Float32Array(n), S = new Float32Array(n);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const p = V.applyH(H, (x + .5) / ppi, (y + .5) / ppi), i = y * W + x;
      const l = bil(work.L, work.w, work.h, p[0], p[1]); L[i] = isNaN(l) ? 0 : l; const s = bil(work.S, work.w, work.h, p[0], p[1]); S[i] = isNaN(s) ? 0 : s;
    }
    const margin = Math.round(0.18 * ppi), inner = new Uint8Array(n);
    for (let y = margin; y < Hh - margin; y++) for (let x = margin; x < W - margin; x++) inner[y * W + x] = 1;
    // paper brightness model (quadratic), fitted on bright pixels
    const smp = []; for (let i = 0; i < n; i += 7) if (inner[i]) smp.push(L[i]); const m50 = median(smp), p70 = median(smp.filter(v => v >= m50));
    let wt = new Uint8Array(n); for (let i = 0; i < n; i++) wt[i] = inner[i] && L[i] > 0.85 * p70 ? 1 : 0;
    let B = null;
    for (let it = 0; it < 4; it++) { B = fitQuadratic(L, W, Hh, wt); if (!B) return { ok: false, msg: 'Could not read the paper brightness.', paper }; for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const i = y * W + x; wt[i] = inner[i] && L[i] > 0.9 * B(x, y) ? 1 : 0; } }
    const sp = []; for (let i = 0; i < n; i += 5) if (wt[i]) sp.push(S[i]); const Sp = median(sp) || 0;
    // tool mask: clearly darker than the paper (shadows are lighter and get dropped), or clearly colored (TiN gold)
    const R = new Float32Array(n), core = new Uint8Array(n);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!inner[i]) { R[i] = 1; continue; }
      R[i] = L[i] / B(x, y); core[i] = (R[i] < 0.5 || (S[i] - Sp > 0.22 && R[i] < 0.97)) ? 1 : 0;
    }
    let mask = morph(morph(core, W, Hh, 1, false), W, Hh, 1, true);              // drop specks
    mask = morph(morph(mask, W, Hh, 2, true), W, Hh, 2, false);                  // bridge highlight stripes
    mask = fillHoles(mask, W, Hh);
    const { lab, comps } = components(mask, W, Hh);
    const minA = 0.012 * ppi * ppi;
    let objs = comps.filter(c => c.n >= minA).map(c => {
      const mx = c.sx / c.n, my = c.sy / c.n, cxx = c.sxx / c.n - mx * mx, cyy = c.syy / c.n - my * my, cxy = c.sxy / c.n - mx * my;
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy), l1 = (cxx + cyy) / 2 + Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy), l2 = (cxx + cyy) / 2 - Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
      const touch = c.x0 <= margin + 1 || c.y0 <= margin + 1 || c.x1 >= W - margin - 2 || c.y1 >= Hh - margin - 2;
      return { id: c.id, area: c.n / ppi / ppi, c: [(mx + .5) / ppi, (my + .5) / ppi], ang, elong: Math.sqrt(l1 / Math.max(l2, 1e-6)), lenEst: Math.sqrt(12 * l1) / ppi, widEst: Math.sqrt(12 * Math.max(l2, 0)) / ppi, touch };
    });
    if (!objs.length) return { ok: true, paper, count: 0, objects: [], msg: 'Paper found, but nothing on it.', ppi };
    // tools are long and thin; letters, logos and barcodes on a label (which can pass for a small sheet of paper) are not
    const toolish = objs.filter(o => o.elong >= 2.5 && o.lenEst >= 0.5), other = objs.length - toolish.length;
    if (!toolish.length || (other >= 6 && other > toolish.length)) return { ok: false, paper, count: 0, objects: [], label: other >= 3, msg: other >= 3 ? 'This looks like a printed label, not tools on paper' : 'Paper found, but no long tool on it', ppi };
    objs = toolish;
    // count: similar objects; one blob ~2x the typical size probably is two touching tools
    const big = objs.filter(o => o.area >= 0.25 * Math.max(...objs.map(q => q.area)));
    const medA = median(big.map(o => o.area));
    let count = 0; const marks = [];
    big.forEach(o => { const k = o.area > 1.6 * medA ? Math.round(o.area / medA) : 1; o.k = k; count += k; });
    big.sort((a, b) => (a.c[1] - b.c[1]) || (a.c[0] - b.c[0]));
    // number left-to-right in the photo
    const toImg = (x, y) => V.applyH(H, x, y);
    big.forEach(o => { o.img = toImg(o.c[0], o.c[1]); });
    big.sort((a, b) => a.img[0] - b.img[0]);
    big.forEach((o, i) => marks.push({ n: i + 1, k: o.k, at: o.img, area: o.area }));
    const res = { ok: true, paper, ppi, count, marks, objects: big, merged: big.some(o => o.k > 1), msg: '' };
    // measure the biggest object
    const target = big.slice().sort((a, b) => b.area - a.area)[0];
    res.measure = measureObj(work, paper, lab, W, Hh, ppi, target, opts);
    return res;
  }

  // precise measurement of one elongated object: edges sampled in the original photo, cylinder-on-paper fit per slice
  function measureObj(work, paper, lab, W, Hh, ppi, o, opts) {
    const H = paper.H, P = paper.pose, Hc = P.Hc, N = P.N;
    const u = [Math.cos(o.ang), Math.sin(o.ang)], v = [-u[1], u[0]];
    // coarse extents from the label image along u and v
    let s0 = 1e9, s1 = -1e9; const vext = {};
    const binS = 0.05;
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      if (lab[y * W + x] !== o.id) continue;
      const px = (x + .5) / ppi - o.c[0], py = (y + .5) / ppi - o.c[1], s = px * u[0] + py * u[1], t = px * v[0] + py * v[1];
      if (s < s0) s0 = s; if (s > s1) s1 = s;
      const k = Math.round(s / binS); const e = vext[k] || (vext[k] = [1e9, -1e9]); if (t < e[0]) e[0] = t; if (t > e[1]) e[1] = t;
    }
    const len0 = s1 - s0; if (len0 < 0.3) return { ok: false, msg: 'Too small to measure.' };
    const pxIn = 1 / paper.ppiImg;                              // one photo pixel, in paper inches
    const step = Math.min(0.004, pxIn / 3), kd = Math.max(1, Math.round(0.7 * pxIn / step)), off = Math.max(2, Math.round(2.5 * pxIn / step));
    const sample = (cx, cy, dx, dy, a, b) => { const out = []; for (let t = a; t <= b + 1e-9; t += step) { const q = V.applyH(H, cx + dx * t, cy + dy * t); out.push(bil(work.L, work.w, work.h, q[0], q[1])); } return out; };
    // edge = strongest rise (dark inside -> bright outside) near the coarse edge, located at the local half-level, sub-sample
    function edgeOut(prof, i0, i1, dirSign) {
      // prof index increases outward when dirSign>0
      let best = -1, bi = -1;
      for (let i = Math.max(kd, i0); i <= Math.min(prof.length - 1 - kd, i1); i++) { const g = dirSign * (prof[i + kd] - prof[i - kd]); if (g > best) { best = g; bi = i; } }
      if (bi < 0 || !(best > 6)) return null;
      const a = prof[Math.max(0, bi - dirSign * off)], b = prof[Math.min(prof.length - 1, Math.max(0, bi + dirSign * off))];
      if (isNaN(a) || isNaN(b)) return null;
      const mid = (a + b) / 2;
      for (let i = bi - off; i <= bi + off; i++) { const j = i + 1; if (j < 0 || i < 0 || j >= prof.length) continue; const p0 = prof[i], p1 = prof[j]; if ((p0 - mid) * (p1 - mid) <= 0 && p0 !== p1) { if (dirSign * (p1 - p0) > 0) return i + (mid - p0) / (p1 - p0); } }
      return bi;
    }
    // ---- slices across the tool
    const slices = [], nS = Math.max(12, Math.min(90, Math.round(len0 / 0.04)));
    for (let k = 0; k < nS; k++) {
      const s = s0 + len0 * (0.06 + 0.88 * (k + .5) / nS), e = vext[Math.round(s / binS)]; if (!e || e[1] - e[0] < 0.03) continue;
      const cx = o.c[0] + u[0] * s, cy = o.c[1] + u[1] * s, mid = (e[0] + e[1]) / 2, half = (e[1] - e[0]) / 2, win = 0.06 + 2 * pxIn;
      const ta = mid - half - win - 3 * off * step, tb = mid + half + win + 3 * off * step;
      const prof = sample(cx, cy, v[0], v[1], ta, tb), idx = t => Math.round((t - ta) / step);
      const iR = edgeOut(prof, idx(e[1] - win), idx(e[1] + win), 1), iL = edgeOut(prof, idx(e[0] - win), idx(e[0] + win), -1);
      if (iR == null || iL == null) continue;
      const e1 = ta + iL * step, e2 = ta + iR * step; if (e2 - e1 < 0.02) continue;
      // cylinder lying on the paper (center height = r), tangent to the two camera rays through the edges
      const kv = (N[0] - cx) * v[0] + (N[1] - cy) * v[1];
      const nrm = (ex, toward) => { let dx = ex - kv, dy = 0 - Hc; const l = Math.hypot(dx, dy); dx /= l; dy /= l; let nx = -dy, ny = dx; if (nx * (toward - ex) < 0) { nx = -nx; ny = -ny; } return [nx, ny]; };
      const n1 = nrm(e1, e2), n2 = nrm(e2, e1);
      const sol = solveLin([[n1[0], n1[1] - 1], [n2[0], n2[1] - 1]], [n1[0] * e1, n2[0] * e2]);
      if (!sol || !(sol[1] > 0)) continue;
      slices.push({ s, e1, e2, a: sol[0], r: sol[1], cx, cy, app: e2 - e1 });
    }
    if (slices.length < 6) return { ok: false, msg: "Couldn't trace the tool's edges. Use plain paper and keep shadows soft." };
    // main diameter: the biggest group of slices that agree within 0.008"
    const ds = slices.map(q => 2 * q.r).sort((a, b) => a - b);
    let bestG = null;
    for (let i = 0; i < ds.length; i++) { let j = i; while (j + 1 < ds.length && ds[j + 1] - ds[i] <= 0.012) j++; if (!bestG || j - i > bestG[1] - bestG[0]) bestG = [i, j]; }
    const grp = ds.slice(bestG[0], bestG[1] + 1), dia = median(grp);
    const others = ds.filter(d => Math.abs(d - dia) > 0.03);
    let dia2 = null; if (others.length >= Math.max(4, 0.2 * ds.length)) dia2 = median(others);
    const spread = (grp[grp.length - 1] - grp[0]) / 2;
    // ---- length: profile along the apparent centerline, beyond both ends
    const mids = slices.map(q => [q.cx + v[0] * (q.e1 + q.e2) / 2, q.cy + v[1] * (q.e1 + q.e2) / 2]);
    let mxm = 0, mym = 0; mids.forEach(p => { mxm += p[0]; mym += p[1]; }); mxm /= mids.length; mym /= mids.length;
    let sxx = 0, sxy = 0, syy = 0; mids.forEach(p => { const dx = p[0] - mxm, dy = p[1] - mym; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; });
    const ang2 = 0.5 * Math.atan2(2 * sxy, sxx - syy); let ua = [Math.cos(ang2), Math.sin(ang2)]; if (ua[0] * u[0] + ua[1] * u[1] < 0) ua = [-ua[0], -ua[1]];
    const cs = (o.c[0] - mxm) * ua[0] + (o.c[1] - mym) * ua[1];
    const endWin = 0.12 + 2 * pxIn;
    const ta = cs + s0 - endWin - 3 * off * step, tb = cs + s1 + endWin + 3 * off * step;
    // average a few parallel lines (robust to flutes/highlights on the centerline)
    const appR = median(slices.map(q => q.app)) / 2, lines = [-0.35, 0, 0.35].map(f => sample(mxm + v[0] * f * appR, mym + v[1] * f * appR, ua[0], ua[1], ta, tb));
    const idx = t => Math.round((t - ta) / step);
    const ends = []; if (opts.debug) opts.debug.endProf = { lines, ta, step, s0: cs + s0, s1: cs + s1 };
    for (const [dirS, sc] of [[-1, cs + s0], [1, cs + s1]]) {
      const got = lines.map(pr => edgeOut(pr, idx(sc - endWin), idx(sc + endWin), dirS)).filter(x => x != null).map(i => ta + i * step);
      if (!got.length) return { ok: false, msg: "Couldn't find the ends of the tool." };
      ends.push(dirS > 0 ? Math.max(...got) : Math.min(...got));
    }
    // does the near end (camera can see its tip) look pointed?
    const appD = 2 * appR;
    function profWidth(t) {
      const cx = mxm + ua[0] * t, cy = mym + ua[1] * t, a = -appR - 0.1, b = appR + 0.1;
      const pr = sample(cx, cy, v[0], v[1], a - 3 * off * step, b + 3 * off * step), base = a - 3 * off * step, ix = x => Math.round((x - base) / step);
      const iR = edgeOut(pr, ix(0), ix(b), 1), iL = edgeOut(pr, ix(a), ix(0), -1); return iR == null || iL == null ? null : (iR - iL) * step;
    }
    const endW = ends.map((q, i) => [0.12, 0.25].map(f => profWidth(q + (i ? -1 : 1) * f * appD)));
    const looksPointed = endW.map(ws => (ws[0] != null && ws[0] < 0.75 * appD) || (ws[1] != null && ws[1] < 0.85 * appD));
    const r = dia / 2, Ns = (N[0] - mxm) * ua[0] + (N[1] - mym) * ua[1];
    const geo = { ends, Ns, Hc, r, looksPointed };
    let tip = opts.tip || (looksPointed.some(Boolean) ? 'point' : 'flat');
    // a point the camera can see wins; otherwise it's the far end (a point on the near end would have shown)
    const tipEnd = looksPointed[0] && !looksPointed[1] ? 0 : looksPointed[1] && !looksPointed[0] ? 1 : (Math.abs(ends[0] - Ns) > Math.abs(ends[1] - Ns) ? 0 : 1);
    geo.tipEnd = tipEnd;
    const oal = oalFor(geo, tip);
    const toImg = (x, y) => V.applyH(H, x, y);
    const edgePts = slices.map(q => [toImg(q.cx + v[0] * q.e1, q.cy + v[1] * q.e1), toImg(q.cx + v[0] * q.e2, q.cy + v[1] * q.e2)]);
    return {
      ok: true, dia, dia2, spread, oal, tip, geo, oalFlat: oalFor(geo, 'flat'), oalPoint: oalFor(geo, 'point'), oalBall: oalFor(geo, 'ball'), appWidth: appD, endW, nSlices: slices.length, camHeight: Hc, tilt: P.tilt, fsrc: paper.fsrc, paper: paper.paper,
      ends: ends.map(q => toImg(mxm + ua[0] * q, mym + ua[1] * q)), edges: edgePts, snap: snapDia(dia), snapDrill: snapDia(dia, null, 'drill')
    };
  }

  const api = { analyze, snapDia, sizes, oalFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ToolVision = api;
})(typeof window !== 'undefined' ? window : this);
