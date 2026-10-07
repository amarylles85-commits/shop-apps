/* CNC Check vision: find the sheet of paper, correct perspective, find the blank on it and measure it.
   Pure JS, no DOM. Works on {data: RGBA bytes, width, height}. Units: inches. */
(function (root) {
  'use strict';
  const PAPERS = [{ name: 'Letter', w: 8.5, h: 11 }, { name: 'A4', w: 210 / 25.4, h: 297 / 25.4 }];

  // ---------------- math helpers ----------------
  function solveLin(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solveLin(A, b); return h ? h.concat([1]) : null;
  }
  function applyH(H, x, y) { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nrm3 = a => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  const median = arr => { const s = Float64Array.from(arr).sort(); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

  function otsu(vals, lo, hi, bins) {
    bins = bins || 256; const hist = new Float64Array(bins); let n = 0;
    for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (!(v >= lo)) continue; let k = Math.floor((v - lo) / (hi - lo) * bins); if (k >= bins) k = bins - 1; hist[k]++; n++; }
    let sum = 0; for (let k = 0; k < bins; k++) sum += k * hist[k];
    let wB = 0, sB = 0, best = -1, th = 0;
    for (let k = 0; k < bins; k++) {
      wB += hist[k]; if (!wB) continue; const wF = n - wB; if (!wF) break;
      sB += k * hist[k]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; th = k; }
    }
    return lo + (th + 1) / bins * (hi - lo);
  }

  // ---------------- image prep ----------------
  function prep(img) {
    const w = img.width, h = img.height, d = img.data, n = w * h;
    const L = new Float32Array(n), S = new Float32Array(n), Wt = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = d[j], g = d[j + 1], b = d[j + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      L[i] = 0.299 * r + 0.587 * g + 0.114 * b; S[i] = mx > 0 ? (mx - mn) / mx : 0; Wt[i] = L[i] - 1.2 * (mx - mn);
    }
    return { w, h, L, S, Wt };
  }
  function down(A, w, h, k) {
    const W = Math.floor(w / k), H = Math.floor(h / k), out = new Float32Array(W * H), kk = k * k;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let s = 0; for (let j = 0; j < k; j++) { const row = (y * k + j) * w + x * k; for (let i = 0; i < k; i++) s += A[row + i]; }
      out[y * W + x] = s / kk;
    }
    return { a: out, w: W, h: H };
  }
  function bil(A, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (A[i] * (1 - fx) + A[i + 1] * fx) * (1 - fy) + (A[i + w] * (1 - fx) + A[i + w + 1] * fx) * fy;
  }

  // ---------------- binary helpers ----------------
  function largestComponent(mask, w, h, avoidBorder) {
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    let best = 0, bestId = 0, id = 0, bestTouch = false;
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || lab[s]) continue;
      id++; let sp = 0, cnt = 0, touch = 0; stack[sp++] = s; lab[s] = id;
      while (sp) {
        const p = stack[--sp]; cnt++; const x = p % w, y = (p / w) | 0;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touch++;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      const score = avoidBorder ? cnt - touch * 50 : cnt;
      if (score > best) { best = score; bestId = id; bestTouch = touch; }
    }
    const out = new Uint8Array(w * h); let area = 0;
    for (let i = 0; i < w * h; i++) if (lab[i] === bestId && bestId) { out[i] = 1; area++; }
    return { mask: out, area, touch: bestTouch };
  }
  function fillHoles(mask, w, h) {
    const out = new Uint8Array(w * h).fill(1), stack = new Int32Array(w * h); let sp = 0;
    const push = p => { if (!mask[p] && out[p]) { out[p] = 0; stack[sp++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w);
    }
    return out;
  }
  function morph(mask, w, h, r, dilate) {
    // square structuring element, separable
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let k = -r; k <= r; k++) { const xx = x + k; const m = xx < 0 || xx >= w ? (dilate ? 0 : 1) : mask[y * w + xx]; if (dilate ? m : !m) { v = dilate ? 1 : 0; break; } }
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let k = -r; k <= r; k++) { const yy = y + k; const m = yy < 0 || yy >= h ? (dilate ? 0 : 1) : tmp[yy * w + x]; if (dilate ? m : !m) { v = dilate ? 1 : 0; break; } }
      out[y * w + x] = v;
    }
    return out;
  }
  const opening = (m, w, h, r) => morph(morph(m, w, h, r, false), w, h, r, true);
  const closing = (m, w, h, r) => morph(morph(m, w, h, r, true), w, h, r, false);
  function boundary(mask, w, h) {
    const pts = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x; if (!mask[p]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) pts.push([x + 0.5, y + 0.5]);
    }
    return pts;
  }
  function hull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  const polyArea = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  function maxQuad(H) {
    let P = H; if (P.length > 90) { const st = P.length / 90; P = []; for (let i = 0; i < 90; i++) P.push(H[Math.floor(i * st)]); }
    const n = P.length; let best = -1, bq = null;
    const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    for (let i = 0; i < n; i++) for (let k = i + 2; k < n; k++) {
      let b1 = -1, bj = -1, b2 = -1, bl = -1;
      for (let j = i + 1; j < k; j++) { const a = tri(P[i], P[j], P[k]); if (a > b1) { b1 = a; bj = j; } }
      for (let l = k + 1; l < n + i; l++) { const a = tri(P[i], P[k], P[l % n]); if (a > b2) { b2 = a; bl = l % n; } }
      if (bj >= 0 && bl >= 0 && b1 + b2 > best) { best = b1 + b2; bq = [P[i], P[bj], P[k], P[bl]]; }
    }
    return bq;
  }
  function minAreaRect(H) {
    let best = null;
    for (let i = 0; i < H.length; i++) {
      const p = H[i], q = H[(i + 1) % H.length]; const ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey); if (l < 1e-9) continue;
      const ux = ex / l, uy = ey / l; let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const r of H) { const a = r[0] * ux + r[1] * uy, b = -r[0] * uy + r[1] * ux; if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b; }
      const area = (a1 - a0) * (b1 - b0);
      if (!best || area < best.area) best = { area, u: [ux, uy], v: [-uy, ux], a0, a1, b0, b1 };
    }
    if (!best) return null;
    const ca = (best.a0 + best.a1) / 2, cb = (best.b0 + best.b1) / 2;
    best.c = [ca * best.u[0] + cb * best.v[0], ca * best.u[1] + cb * best.v[1]];
    best.la = best.a1 - best.a0; best.lb = best.b1 - best.b0;
    return best;
  }
  // total-least-squares line with outlier rejection. returns {n:[nx,ny], d, rms, pts}
  function fitLine(pts) {
    let P = pts, res = null;
    for (let it = 0; it < 3; it++) {
      if (P.length < 4) return res;
      let mx = 0, my = 0; for (const p of P) { mx += p[0]; my += p[1]; } mx /= P.length; my /= P.length;
      let sxx = 0, syy = 0, sxy = 0; for (const p of P) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); const dir = [Math.cos(ang), Math.sin(ang)], n = [-dir[1], dir[0]];
      const d = n[0] * mx + n[1] * my;
      const r = P.map(p => Math.abs(n[0] * p[0] + n[1] * p[1] - d)); const mad = median(r) * 1.4826 + 1e-6;
      res = { n, d, dir, c: [mx, my], rms: Math.sqrt(r.reduce((a, v) => a + v * v, 0) / r.length), count: P.length, pts: P };
      const keep = P.filter((p, i) => r[i] < Math.max(3 * mad, 1e-4));
      if (keep.length === P.length) break; P = keep;
    }
    return res;
  }
  // RANSAC line (tolerates lots of junk points), then least-squares on the inliers
  function fitLineRansac(pts, tol) {
    if (pts.length < 6) return fitLine(pts);
    let best = null, bc = 0, seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let it = 0; it < 300; it++) {
      const a = pts[Math.floor(rnd() * pts.length)], b = pts[Math.floor(rnd() * pts.length)];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); if (l < 0.2) continue;
      const n = [-dy / l, dx / l], d = n[0] * a[0] + n[1] * a[1];
      let c = 0; for (const p of pts) if (Math.abs(n[0] * p[0] + n[1] * p[1] - d) < tol) c++;
      if (c > bc) { bc = c; best = { n, d }; }
    }
    if (!best || bc < 5) return null;
    const inl = pts.filter(p => Math.abs(best.n[0] * p[0] + best.n[1] * p[1] - best.d) < tol);
    const r = fitLine(inl); if (r) r.inlierFrac = inl.length / pts.length; return r;
  }
  function fitCircle(pts, init) {
    // Kasa then Gauss-Newton with rejection
    let P = pts;
    let cx, cy, r;
    if (init) { [cx, cy, r] = init; } else {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      for (const [x, y] of P) { const row = [x, y, 1], z = x * x + y * y; for (let i = 0; i < 3; i++) { b[i] += row[i] * z; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; } }
      const s = solveLin(A, b); if (!s) return null; cx = s[0] / 2; cy = s[1] / 2; r = Math.sqrt(s[2] + cx * cx + cy * cy);
    }
    for (let round = 0; round < 3; round++) {
      for (let it = 0; it < 8; it++) {
        const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
        for (const [x, y] of P) {
          const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1e-9, e = d - r, J = [-dx / d, -dy / d, -1];
          for (let i = 0; i < 3; i++) { b[i] -= J[i] * e; for (let j = 0; j < 3; j++) A[i][j] += J[i] * J[j]; }
        }
        const s = solveLin(A, b); if (!s) break; cx += s[0]; cy += s[1]; r += s[2];
        if (Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2]) < 1e-7) break;
      }
      const res = P.map(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r)); const mad = median(res) * 1.4826 + 1e-6;
      const keep = P.filter((p, i) => res[i] < Math.max(3 * mad, 1e-4)); if (keep.length === P.length || keep.length < 6) break; P = keep;
    }
    const res = P.map(([x, y]) => Math.hypot(x - cx, y - cy) - r);
    return { c: [cx, cy], r, rms: Math.sqrt(res.reduce((a, v) => a + v * v, 0) / Math.max(1, res.length)), count: P.length };
  }

  // ---------------- paper ----------------
  // Zhang & He (2007): focal length and aspect ratio from the image of a rectangle.
  function zhangHe(q, cx, cy) {
    const m1 = [q[0][0] - cx, q[0][1] - cy, 1], m2 = [q[1][0] - cx, q[1][1] - cy, 1], m4 = [q[2][0] - cx, q[2][1] - cy, 1], m3 = [q[3][0] - cx, q[3][1] - cy, 1];
    const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3), k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
    const n2 = m2.map((v, i) => k2 * v - m1[i]), n3 = m3.map((v, i) => k3 * v - m1[i]);
    const den = n2[2] * n3[2]; const f2 = Math.abs(den) > 1e-12 ? -(n2[0] * n3[0] + n2[1] * n3[1]) / den : NaN;
    const aspect = f => Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / (f * f) + n2[2] ** 2) / Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / (f * f) + n3[2] ** 2);
    return { f: f2 > 0 ? Math.sqrt(f2) : NaN, aspect };
  }
  function pose(H, f, cx, cy) {
    const col = k => [(H[k] - cx * H[6 + k]) / f, (H[3 + k] - cy * H[6 + k]) / f, H[6 + k]];
    const m1 = col(0), m2 = col(1), m3 = col(2);
    let lam = 2 / (Math.hypot(...m1) + Math.hypot(...m2)); if (m3[2] * lam < 0) lam = -lam;
    let r1 = m1.map(v => v * lam), r2 = m2.map(v => v * lam); const t = m3.map(v => v * lam);
    r1 = nrm3(r1); const p = dot(r1, r2); r2 = nrm3(r2.map((v, i) => v - p * r1[i])); const r3 = cross(r1, r2);
    const C = [-dot(r1, t), -dot(r2, t), -dot(r3, t)];
    const sz = C[2] >= 0 ? 1 : -1;
    const tilt = Math.acos(Math.min(1, Math.abs(r3[2]))) * 180 / Math.PI;
    return { f, cx, cy, r1, r2, r3, t, C, sz, N: [C[0], C[1]], Hc: Math.abs(C[2]), tilt };
  }
  function project(P, x, y, z) {
    const zz = P.sz * (z || 0);
    const X = [0, 1, 2].map(i => x * P.r1[i] + y * P.r2[i] + zz * P.r3[i] + P.t[i]);
    return [P.f * X[0] / X[2] + P.cx, P.f * X[1] / X[2] + P.cy];
  }
  function unproject(P, u, v, z) {
    const d = [(u - P.cx) / P.f, (v - P.cy) / P.f, 1];
    const dw = [P.r1[0] * d[0] + P.r1[1] * d[1] + P.r1[2] * d[2], P.r2[0] * d[0] + P.r2[1] * d[1] + P.r2[2] * d[2], P.r3[0] * d[0] + P.r3[1] * d[1] + P.r3[2] * d[2]];
    const tau = (P.sz * (z || 0) - P.C[2]) / dw[2];
    return [P.C[0] + tau * dw[0], P.C[1] + tau * dw[1]];
  }

  // EXIF FocalLengthIn35mmFilm from JPEG bytes (ArrayBuffer). Returns number or null.
  function exifFocal35(buf) {
    try {
      const v = new DataView(buf); if (v.getUint16(0) !== 0xFFD8) return null;
      let o = 2;
      while (o < v.byteLength - 4) {
        const mk = v.getUint16(o), len = v.getUint16(o + 2);
        if (mk === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) {
          const t = o + 10, le = v.getUint16(t) === 0x4949;
          const u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
          const ifd = (p, want) => { const n = u16(p); for (let i = 0; i < n; i++) { const e = p + 2 + i * 12; if (u16(e) === want) return e; } return -1; };
          const e0 = ifd(t + u32(t + 4), 0x8769); if (e0 < 0) return null;
          const ex = t + u32(e0 + 8); const e1 = ifd(ex, 0xA405); if (e1 < 0) return null;
          const val = u16(e1 + 8); return val > 0 ? val : null;
        }
        if ((mk & 0xFF00) !== 0xFF00) break; o += 2 + len;
      }
    } catch (e) {}
    return null;
  }

  function findPaper(work, opts) {
    opts = opts || {};
    const { w, h, L, Wt } = work;
    const k = Math.max(1, Math.round(Math.max(w, h) / 640));
    const sm = down(Wt, w, h, k), sw = sm.w, sh = sm.h;
    const th = otsu(sm.a, -255, 256, 256);
    let mask = new Uint8Array(sw * sh); for (let i = 0; i < sw * sh; i++) mask[i] = sm.a[i] > th ? 1 : 0;
    mask = opening(mask, sw, sh, 1);
    const comp = largestComponent(mask, sw, sh, true);
    if (comp.area < sw * sh * 0.04) return { ok: false, msg: "Couldn't find the paper. Retake on plain white paper with a darker table around it." };
    const filled = fillHoles(comp.mask, sw, sh);
    const H0 = hull(boundary(filled, sw, sh));
    const q0 = maxQuad(H0); if (!q0) return { ok: false, msg: "Couldn't find the paper corners." };
    const hullA = Math.abs(polyArea(H0)), quadA = Math.abs(polyArea(q0));
    let fillA = 0; for (let i = 0; i < sw * sh; i++) fillA += filled[i];
    if (quadA < 0.85 * hullA || fillA < 0.85 * quadA) return { ok: false, msg: "Couldn't find a clean paper outline. Keep the whole sheet in the photo, flat, on a darker surface.", debug: { hullA, quadA, fillA } };
    // order clockwise (image y down => positive polyArea is clockwise on screen)
    let q = q0.map(p => [p[0] * k, p[1] * k]); if (polyArea(q) < 0) q = q.reverse();
    // refine each side by edge sampling on the full working image
    const sideLine = (a, b, range) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
      const nx = uy, ny = -ux; // outward for clockwise-on-screen polygon
      const pts = [];
      for (let s = 0.06; s <= 0.94; s += 0.88 / 80) {
        const px = a[0] + dx * s, py = a[1] + dy * s; let best = 0, bo = null; const prof = [];
        for (let o = -range; o <= range; o += 0.5) prof.push(bil(L, w, h, px + nx * o, py + ny * o));
        for (let i = 1; i < prof.length - 1; i++) {
          const g = prof[i - 1] - prof[i + 1]; // bright inside -> dark outside
          if (g > best) { best = g; bo = i; }
        }
        if (bo === null || best < 8) continue;
        const gm = prof[bo - 2] !== undefined ? prof[bo - 2] - prof[bo] : best, gp = prof[bo + 2] !== undefined ? prof[bo] - prof[bo + 2] : best;
        const den = gm - 2 * best + gp; const sub = den !== 0 ? 0.5 * (gm - gp) / den : 0;
        const o = -range + (bo + Math.max(-1, Math.min(1, sub))) * 0.5;
        pts.push([px + nx * o, py + ny * o]);
      }
      return fitLine(pts);
    };
    let lines;
    for (const range of [3 * k + 4, 4]) {
      lines = [0, 1, 2, 3].map(i => sideLine(q[i], q[(i + 1) % 4], range));
      if (lines.some(l => !l)) return { ok: false, msg: "Couldn't trace the paper edges. Use more contrast between paper and table." };
      const nq = [];
      for (let i = 0; i < 4; i++) {
        const A = lines[(i + 3) % 4], B = lines[i];
        const det = A.n[0] * B.n[1] - A.n[1] * B.n[0]; if (Math.abs(det) < 1e-6) return { ok: false, msg: 'Paper outline is not a rectangle.' };
        nq.push([(A.d * B.n[1] - A.n[1] * B.d) / det, (A.n[0] * B.d - A.d * B.n[0]) / det]);
      }
      q = nq;
    }
    const pm = paperModel(q, w, h, opts);
    if (pm.ok) pm.edgeRms = Math.max(...lines.map(l => l.rms));
    return pm;
  }
  // Paper model from 4 image corners (auto-detected or tapped): paper size, homography, camera pose
  function paperModel(q, w, h, opts) {
    opts = opts || {};
    if (polyArea(q) < 0) q = q.slice().reverse();
    const cx = w / 2, cy = h / 2, long = Math.max(w, h);
    const zh = zhangHe(q, cx, cy);
    let f = null, fsrc = '';
    if (opts.f35) { f = opts.f35 * Math.hypot(w, h) / 43.27; fsrc = 'photo EXIF ' + opts.f35 + ' mm'; }
    else if (zh.f > 0.5 * long && zh.f < 1.8 * long) { f = zh.f; fsrc = 'from paper perspective'; }
    else { f = 0.6 * Math.hypot(w, h); fsrc = 'typical phone camera'; }
    let asp = zh.aspect(f); // side q0q1 / side q0q3
    const ratio = asp >= 1 ? asp : 1 / asp;
    let paper = PAPERS[0];
    if (opts.paper) paper = PAPERS.find(p => p.name === opts.paper) || paper;
    else if (ratio > 1.36) paper = PAPERS[1];
    const long01 = asp >= 1;
    const pw = long01 ? paper.h : paper.w, ph = long01 ? paper.w : paper.h;
    const dst = [[0, 0], [pw, 0], [pw, ph], [0, ph]];
    const H = homography(dst, q); // paper inches -> image px
    if (!H) return { ok: false, msg: 'Paper outline is degenerate.' };
    let P = pose(H, f, cx, cy);
    // Zhang-He gets noisy as the shot gets closer to straight down: blend toward a typical phone lens (26 mm equiv.)
    if (fsrc === 'from paper perspective') {
      const f0 = 0.6 * Math.hypot(w, h), wz = Math.max(0, Math.min(1, (P.tilt - 5) / 15));
      f = Math.exp(wz * Math.log(f) + (1 - wz) * Math.log(f0));
      if (wz < 1) fsrc = wz > 0 ? 'paper perspective + typical lens' : 'typical phone camera';
      P = pose(H, f, cx, cy);
    }
    const ppiImg = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) / pw;
    return { ok: true, corners: q, paper: paper.name, pw, ph, H, Hi: inv3(H), pose: P, f, fsrc, aspectMeasured: ratio, ppiImg, imgW: w, imgH: h, msg: paper.name + ' paper found' };
  }

  // ---------------- blank ----------------
  function rectifyArr(work, A, Hm, pw, ph, ppi) {
    const W = Math.round(pw * ppi), Ht = Math.round(ph * ppi), out = new Float32Array(W * Ht);
    for (let y = 0; y < Ht; y++) for (let x = 0; x < W; x++) {
      const p = applyH(Hm, (x + 0.5) / ppi, (y + 0.5) / ppi); const v = bil(A, work.w, work.h, p[0], p[1]);
      out[y * W + x] = isNaN(v) ? 0 : v;
    }
    return { a: out, w: W, h: Ht };
  }
  function fitQuadratic(vals, w, h, weight) {
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), b = new Array(6).fill(0);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = y * w + x; if (!weight[i]) continue;
      const u = x / w - 0.5, v = y / h - 0.5, r = [1, u, v, u * u, u * v, v * v];
      for (let a = 0; a < 6; a++) { b[a] += r[a] * vals[i]; for (let c = 0; c < 6; c++) A[a][c] += r[a] * r[c]; }
    }
    const s = solveLin(A, b); if (!s) return null;
    return (x, y) => { const u = x / w - 0.5, v = y / h - 0.5; return s[0] + s[1] * u + s[2] * v + s[3] * u * u + s[4] * u * v + s[5] * v * v; };
  }

  // sample image luma along a line in paper coords
  function profiler(work, paper) {
    const H = paper.H, L = work.L, w = work.w, h = work.h;
    return (px, py, nx, ny, o0, o1, step) => {
      const out = [];
      const e = 0.1, X1 = paper.pw - e, Y1 = paper.ph - e;
      for (let o = o0; o <= o1 + 1e-9; o += step) {
        const x = px + nx * o, y = py + ny * o;
        if (x < e || y < e || x > X1 || y > Y1) { out.push(NaN); continue; } // stay on the paper
        const p = applyH(H, x, y); out.push(bil(L, w, h, p[0], p[1]));
      }
      return out;
    };
  }
  // Find edges in a profile. Returns list of {i (subsample index), g (abs gradient)}
  function edgesIn(prof, k) {
    const g = new Float64Array(prof.length);
    for (let i = k; i < prof.length - k; i++) { const a = prof[i - k], b = prof[i + k]; g[i] = isNaN(a) || isNaN(b) ? 0 : Math.abs(b - a); }
    let mx = 0; for (let i = 0; i < g.length; i++) if (g[i] > mx) mx = g[i];
    const peaks = [];
    for (let i = 1; i < g.length - 1; i++) if (g[i] > 0 && g[i] >= g[i - 1] && g[i] > g[i + 1]) {
      const den = g[i - 1] - 2 * g[i] + g[i + 1]; const sub = den !== 0 ? 0.5 * (g[i - 1] - g[i + 1]) / den : 0;
      peaks.push({ i: i + Math.max(-0.5, Math.min(0.5, sub)), g: g[i] });
    }
    return { peaks, max: mx };
  }

  function findBlank(work, paper, opts) {
    opts = opts || {};
    const ppi = 40, pw = paper.pw, ph = paper.ph;
    const RL = rectifyArr(work, work.L, paper.H, pw, ph, ppi), RS = rectifyArr(work, work.S, paper.H, pw, ph, ppi);
    const W = RL.w, Hh = RL.h, n = W * Hh, L = RL.a, S = RS.a;
    const margin = Math.round(0.2 * ppi);
    const inner = new Uint8Array(n);
    for (let y = margin; y < Hh - margin; y++) for (let x = margin; x < W - margin; x++) inner[y * W + x] = 1;
    // background (paper) illumination
    const sorted = []; for (let i = 0; i < n; i += 3) if (inner[i]) sorted.push(L[i]); sorted.sort((a, b) => a - b);
    const p60 = sorted[Math.floor(sorted.length * 0.6)];
    const band = new Uint8Array(n), bw = Math.round(1.5 * ppi);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const e = Math.min(x, y, W - 1 - x, Hh - 1 - y); band[y * W + x] = e >= margin && e < bw ? 1 : 0; }
    let wgt = new Uint8Array(n); for (let i = 0; i < n; i++) wgt[i] = band[i] && L[i] >= p60 ? 1 : 0;
    let B = null;
    for (let it = 0; it < 5; it++) {
      B = fitQuadratic(L, W, Hh, wgt); if (!B) return { ok: false, msg: 'Could not read the paper brightness.' };
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const i = y * W + x; wgt[i] = band[i] && L[i] > 0.95 * B(x, y) ? 1 : 0; }
    }
    const sp = []; for (let i = 0; i < n; i += 5) if (wgt[i]) sp.push(S[i]); const Sp = median(sp) || 0;
    const F = new Float32Array(n);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!inner[i]) { F[i] = -1; continue; }
      const b = B(x, y); F[i] = Math.max(1 - L[i] / b, Math.abs(L[i] / b - 1) * 0.6, 1.5 * (S[i] - Sp - 0.04));
    }
    const fp = []; for (let i = 0; i < n; i += 3) if (wgt[i]) fp.push(F[i]);
    const fmed = median(fp), fsig = median(fp.map(v => Math.abs(v - fmed))) * 1.4826;
    let th = Math.max(0.035, Math.min(0.09, fmed + 6 * fsig));
    let m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = F[i] > th ? 1 : 0;
    m = closing(opening(m, W, Hh, 1), W, Hh, 2);
    const comp = largestComponent(m, W, Hh, false);
    if (comp.area < (0.5 * ppi) ** 2) return { ok: false, msg: "Couldn't find the blank on the paper. Put it in the middle of the sheet." };
    const filled = fillHoles(comp.mask, W, Hh);
    let farea = 0; for (let i = 0; i < n; i++) farea += filled[i];
    const bpts = boundary(filled, W, Hh).map(p => [p[0] / ppi, p[1] / ppi]);
    const hl = hull(bpts), mr = minAreaRect(hl);
    const rectFill = (farea / ppi / ppi) / mr.area;
    const touches = bpts.some(p => p[0] < 0.25 || p[1] < 0.25 || p[0] > pw - 0.25 || p[1] > ph - 0.25);
    // holes inside the blank
    const holes = [];
    {
      const hm = new Uint8Array(n); for (let i = 0; i < n; i++) hm[i] = filled[i] && !comp.mask[i] ? 1 : 0;
      const lab = largestComponent(opening(hm, W, Hh, 1), W, Hh, false);
      if (lab.area > Math.PI * (0.1 * ppi) ** 2) {
        let sx = 0, sy = 0; for (let i = 0; i < n; i++) if (lab.mask[i]) { sx += i % W; sy += (i / W) | 0; }
        holes.push({ c: [(sx / lab.area + 0.5) / ppi, (sy / lab.area + 0.5) / ppi], r: Math.sqrt(lab.area / Math.PI) / ppi });
      }
    }
    const prof = profiler(work, paper);
    const step = Math.max(0.002, 0.35 / paper.ppiImg), kk = Math.max(1, Math.round(0.6 / paper.ppiImg / step));
    // choose the outermost sharp edge along a profile (index grows outward)
    const pickOuter = (pr) => {
      const e = edgesIn(pr, kk); if (!e.max) return null;
      let pick = null; for (const p of e.peaks) if (p.g >= 0.45 * e.max && p.g > 6) pick = p; // last = outermost
      return pick;
    };
    const pickInner = (pr) => {
      const e = edgesIn(pr, kk); if (!e.max) return null;
      for (const p of e.peaks) if (p.g >= 0.45 * e.max && p.g > 6) return p; return null;
    };
    const res = { ok: true, ppi, rectFill, touches, hull: hl, minRect: mr, holes, th, mask: filled, mw: W, mh: Hh };
    // ---- rectangle silhouette ----
    const maxW = Math.max(0.07, 5 / paper.ppiImg);
    const sharpPeaks = (pr) => {
      const g = new Float64Array(pr.length);
      for (let i = kk; i < pr.length - kk; i++) { const a = pr[i - kk], b = pr[i + kk]; g[i] = isNaN(a) || isNaN(b) ? 0 : Math.abs(b - a); }
      const out = [];
      for (let i = 1; i < g.length - 1; i++) {
        if (!(g[i] > 0 && g[i] >= g[i - 1] && g[i] > g[i + 1])) continue;
        let a = i, b = i; while (a > 0 && g[a] > g[i] / 2) a--; while (b < g.length - 1 && g[b] > g[i] / 2) b++;
        if ((b - a) * step > maxW) continue;
        const den = g[i - 1] - 2 * g[i] + g[i + 1]; const sub = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (g[i - 1] - g[i + 1]) / den)) : 0;
        out.push({ i: i + sub, g: g[i], w: (b - a) * step });
      }
      return { peaks: out, g };
    };
    // one side: base point bx,by on the current side, outward normal nrm, along-vector, side length span
    const sideStage1 = (c, nrm, along, span, inR, outR, outermost) => {
      const pts = [];
      for (let t = -0.36; t <= 0.36001; t += 0.72 / 44) {
        const bx = c[0] + along[0] * t * span, by = c[1] + along[1] * t * span;
        const pr = prof(bx, by, nrm[0], nrm[1], -inR, outR, step);
        const sp = sharpPeaks(pr).peaks; if (!sp.length) continue;
        const gm = Math.max(...sp.map(p => p.g)); let pick = null;
        // first pass: outermost clear edge (skips soft shadow); later passes: strongest edge (same physical edge all along)
        for (const p of sp) if ((outermost ? p.g >= 0.4 * gm : p.g === gm) && p.g > 5) pick = p;
        if (!pick) continue; const o = -inR + pick.i * step; pts.push([bx + nrm[0] * o, by + nrm[1] * o]);
      }
      const ln = fitLineRansac(pts, Math.max(0.02, 2 / paper.ppiImg)); if (!ln || ln.count < 8) return null;
      if (Math.abs(ln.n[0] * nrm[0] + ln.n[1] * nrm[1]) < 0.5) return null; // edge must run roughly along this side
      if (ln.n[0] * nrm[0] + ln.n[1] * nrm[1] < 0) { ln.n = [-ln.n[0], -ln.n[1]]; ln.d = -ln.d; }
      return ln;
    };
    const quadOf = (sd) => {
      const order = [0, 2, 1, 3], cs = [];
      for (let i = 0; i < 4; i++) {
        const A = sd[order[i]], Bq = sd[order[(i + 1) % 4]]; const det = A.n[0] * Bq.n[1] - A.n[1] * Bq.n[0];
        if (Math.abs(det) < 1e-6) return null;
        cs.push([(A.d * Bq.n[1] - A.n[1] * Bq.d) / det, (A.n[0] * Bq.d - A.d * Bq.n[0]) / det]);
      }
      return cs; // order: side0∩side2, side2∩side1, side1∩side3, side3∩side0
    };
    // side geometry from a quad (corner list in quadOf order): side k -> [corner a, corner b]
    const sideCorners = [[3, 0], [1, 2], [0, 1], [2, 3]];
    {
      let sides = [];
      const dirs = [mr.u, [-mr.u[0], -mr.u[1]], mr.v, [-mr.v[0], -mr.v[1]]];
      for (let s = 0; s < 4; s++) {
        const half = (s < 2 ? mr.la : mr.lb) / 2, span = s < 2 ? mr.lb : mr.la, along = s < 2 ? mr.v : mr.u;
        const c = [mr.c[0] + dirs[s][0] * half, mr.c[1] + dirs[s][1] * half];
        sides.push(sideStage1(c, dirs[s], along, span, Math.min(4.5, 0.75 * (s < 2 ? mr.la : mr.lb)), 0.35, false));
      }
      // second pass from the traced quad (drops shadow area from the starting box)
      for (let pass = 0; pass < 2 && sides.every(Boolean); pass++) {
        const q = quadOf(sides); if (!q) break;
        const ns = [];
        for (let s = 0; s < 4; s++) {
          const [ia, ib] = sideCorners[s], A = q[ia], Bc = q[ib];
          const c = [(A[0] + Bc[0]) / 2, (A[1] + Bc[1]) / 2], span = Math.hypot(Bc[0] - A[0], Bc[1] - A[1]);
          const along = [(Bc[0] - A[0]) / span, (Bc[1] - A[1]) / span];
          const opp = sides[s ^ 1]; const dim = Math.abs(sides[s].d + opp.d);
          ns.push(sideStage1(c, sides[s].n, along, span, Math.min(0.6, 0.45 * dim), 0.25) || sides[s]);
        }
        sides = ns;
      }
      if (sides.every(Boolean)) {
        // all four outline edges of a box seen from above are parallel/perpendicular: share one orientation
        const ang4 = ln => Math.atan2(ln.n[1], ln.n[0]) * 4, wt = ln => ln.count / (ln.rms + 0.002);
        const ref = sides.reduce((a, b) => wt(b) > wt(a) ? b : a);
        let sx = 0, sy = 0;
        for (const ln of sides) {
          const dA = Math.atan2(Math.sin(ang4(ln) - ang4(ref)), Math.cos(ang4(ln) - ang4(ref))) / 4;
          if (Math.abs(dA) > 3 * Math.PI / 180) { ln.badAngle = true; continue; } // ignore an edge that disagrees
          sx += wt(ln) * Math.cos(ang4(ln)); sy += wt(ln) * Math.sin(ang4(ln));
        }
        const th0 = Math.atan2(sy, sx) / 4;
        sides = sides.map(ln => {
          let best = null;
          for (let m = 0; m < 4; m++) { const a = th0 + m * Math.PI / 2, nv = [Math.cos(a), Math.sin(a)], c = nv[0] * ln.n[0] + nv[1] * ln.n[1]; if (!best || c > best.c) best = { c, nv }; }
          const nv = best.nv, d = median(ln.pts.map(p => nv[0] * p[0] + nv[1] * p[1]));
          return Object.assign({}, ln, { n: nv, d });
        });
        const q = quadOf(sides);
        if (q) sides.forEach((ln, s) => {
          // stage 2: average profiles across the side, list every sharp edge
          const [ia, ib] = sideCorners[s], A = q[ia], Bc = q[ib];
          const sc = [(A[0] + Bc[0]) / 2, (A[1] + Bc[1]) / 2], span = Math.hypot(Bc[0] - A[0], Bc[1] - A[1]);
          const u = [(Bc[0] - A[0]) / span, (Bc[1] - A[1]) / span];
          const dim = Math.abs(ln.d + sides[s ^ 1].d), in2 = Math.min(0.6, 0.45 * dim), out2 = 2.0;
          let avg = null, cnt = null;
          for (let t = -0.35; t <= 0.35001; t += 0.7 / 50) {
            const pr = prof(sc[0] + u[0] * t * span, sc[1] + u[1] * t * span, ln.n[0], ln.n[1], -in2, out2, step);
            if (!avg) { avg = new Float64Array(pr.length); cnt = new Float64Array(pr.length); }
            pr.forEach((v, i) => { if (!isNaN(v)) { avg[i] += v; cnt[i]++; } });
          }
          for (let i = 0; i < avg.length; i++) avg[i] = cnt[i] ? avg[i] / cnt[i] : NaN;
          const sp = sharpPeaks(avg);
          const noise = median(Array.from(sp.g).filter(v => v > 0)) * 1.4826 + 0.3;
          const gmax = Math.max(0, ...sp.peaks.map(p => p.g));
          ln.peaks = sp.peaks.filter(p => p.g >= Math.max(0.12 * gmax, 4 * noise, 2.5)).map(p => {
            const o = -in2 + p.i * step; let sum = 0, c = 0;
            for (let oo = o + 0.04; oo <= o + 0.12; oo += step) { const i = Math.round((oo + in2) / step); if (i < avg.length && !isNaN(avg[i])) { sum += avg[i]; c++; } }
            const px = sc[0] + ln.n[0] * (o + 0.08), py = sc[1] + ln.n[1] * (o + 0.08);
            return { d: ln.d + o, g: p.g, w: p.w, out: c ? sum / c / B(px * ppi, py * ppi) : 1 };
          });
        });
        if (q) res.rect = { sides, corners: q, rms: Math.max(...sides.map(s => s.rms)), inl: Math.min(...sides.map(s => s.count)) };
      }
    }
    // ---- circle silhouette ----
    {
      const c0 = [mr.c[0], mr.c[1]], r0 = (mr.la + mr.lb) / 4; const pts = [];
      const inR = Math.min(1.0, 0.6 * r0), outR = 0.35;
      for (let a = 0; a < 360; a += 3) {
        const ca = Math.cos(a * Math.PI / 180), sa = Math.sin(a * Math.PI / 180);
        const bx = c0[0] + ca * r0, by = c0[1] + sa * r0;
        const pr = prof(bx, by, ca, sa, -inR, outR, step); const pk = pickOuter(pr); if (!pk) continue;
        const o = -inR + pk.i * step; pts.push([bx + ca * o, by + sa * o]);
      }
      const cf = pts.length > 20 ? fitCircle(pts) : null;
      if (cf) res.circle = Object.assign(cf, { pts });
      if (cf) {
        // look for a bore: rays from the middle, first sharp edge on each
        const o = holes.length ? holes[0].c : cf.c, hp = [];
        for (let a = 0; a < 360; a += 3) {
          const ca = Math.cos(a * Math.PI / 180), sa = Math.sin(a * Math.PI / 180);
          const pr = prof(o[0], o[1], ca, sa, 0.03, 0.85 * cf.r, step); const pk = pickInner(pr); if (!pk) continue;
          const r = 0.03 + pk.i * step; hp.push([o[0] + ca * r, o[1] + sa * r]);
        }
        if (hp.length >= 50) res.holePts = hp;
      }
    }
    // choose shape
    const circOk = res.circle && res.circle.rms / res.circle.r < 0.02;
    const rectOk = res.rect && res.rect.rms < 0.03;
    res.shape = rectFill < 0.88 && circOk ? 'round' : rectOk ? 'rect' : circOk ? 'round' : (res.rect ? 'rect' : null);
    if (!res.shape) return { ok: false, msg: "Found something on the paper but couldn't trace a clean outline. Retake with the blank in the middle and no clutter.", debug: res };
    if (touches) res.warn = 'The blank touches the paper edge; the size may be off.';
    return res;
  }

  // Convert the silhouette (outline on the paper plane) into true blank size, for a blank of height h
  function measure(det, paper, h, shapeOverride) {
    const P = paper.pose, N = P.N, s = P.Hc / Math.max(0.1, P.Hc - h);
    const shape = shapeOverride || det.shape;
    if (shape === 'rect' && det.rect) {
      const px = 1 / paper.ppiImg;
      const why = [];
      const b = det.rect.sides.map(l => {
        const nN = l.n[0] * N[0] + l.n[1] * N[1];
        const pk = (l.peaks && l.peaks.length) ? l.peaks : [{ d: l.d, out: 1 }];
        const p1 = pk[pk.length - 1], d1 = p1.d;
        if (d1 >= nN) { why.push('far'); return nN + (d1 - nN) / s; } // far side: outline is the top edge
        const delta = (s - 1) * (nN - d1);
        if (delta < 1.5 * px) { why.push('near-thin'); return d1; }
        const tol = Math.max(0.4 * delta, 1.2 * px);
        const partner = pk.some(p => p !== p1 && Math.abs(p.d - (d1 - delta)) <= tol);
        if (partner || p1.out >= 0.9) { why.push(partner ? 'near-2edges' : 'near-bright'); return d1; } // bottom edge seen
        why.push('near-top'); return nN - (nN - d1) / s; // only the top edge is visible on this side
      });
      const a = b[0] + b[1], c = b[2] + b[3];
      const ang = Math.atan2(det.rect.sides[0].n[1], det.rect.sides[0].n[0]);
      // true footprint corners (paper coords)
      const s0 = det.rect.sides, cs = [];
      const order = [0, 2, 1, 3];
      for (let i = 0; i < 4; i++) {
        const A = s0[order[i]], B = s0[order[(i + 1) % 4]], da = b[order[i]], db = b[order[(i + 1) % 4]]; const det2 = A.n[0] * B.n[1] - A.n[1] * B.n[0];
        cs.push([(da * B.n[1] - A.n[1] * db) / det2, (A.n[0] * db - da * B.n[0]) / det2]);
      }
      return { shape: 'rect', L: Math.max(a, c), W: Math.min(a, c), a, c, ang, footprint: cs, s, why };
    }
    if (shape === 'round' && det.circle) {
      const cf = det.circle; const u0 = [cf.c[0] - N[0], cf.c[1] - N[1]], ul = Math.hypot(u0[0], u0[1]) || 1, u = [u0[0] / ul, u0[1] / ul];
      const far = cf.pts.filter(p => { const dx = p[0] - cf.c[0], dy = p[1] - cf.c[1]; return (dx * u[0] + dy * u[1]) / Math.hypot(dx, dy) > Math.cos(75 * Math.PI / 180); });
      const ff = far.length > 12 ? fitCircle(far, [cf.c[0], cf.c[1], cf.r]) : cf;
      const R = ff.r / s; const ct = [N[0] + (ff.c[0] - N[0]) / s, N[1] + (ff.c[1] - N[1]) / s];
      let Bd = 0;
      const fc = det.holePts ? fitCircle(det.holePts) : null;
      if (fc && fc.rms < 0.012 && fc.count > 0.7 * det.holePts.length && Math.hypot(fc.c[0] - ff.c[0], fc.c[1] - ff.c[1]) < 0.12 && fc.r < 0.9 * ff.r) {
        Bd = 2 * fc.r / s; // whole hole outline is the top edge of the bore (seen through perspective)
      } else if (det.holePts) {
        // far side of the visible hole = bottom edge of the bore, true size; assume concentric
        const hf = det.holePts.filter(p => { const dx = p[0] - ct[0], dy = p[1] - ct[1]; return (dx * u[0] + dy * u[1]) / (Math.hypot(dx, dy) || 1) > Math.cos(60 * Math.PI / 180); });
        if (hf.length > 10) {
          const ds = hf.map(p => Math.hypot(p[0] - ct[0], p[1] - ct[1])), md = median(ds), mad = median(ds.map(v => Math.abs(v - md)));
          if (mad < 0.03 && md > 0.08 && md < 0.9 * R) Bd = 2 * md;
        }
      }
      return { shape: 'round', D: 2 * R, B: Bd, c: ct, s };
    }
    return null;
  }
  // Height from the top photo alone: on a side that faces the camera both the bottom edge (outline)
  // and the top edge show; their spacing is (s-1)*(nN-d) with s = Hc/(Hc-h). Only sides with a long lever are used.
  function estimateHeight(det, paper) {
    if (!det || !det.ok || det.shape !== 'rect' || !det.rect) return null;
    const P = paper.pose, N = P.N, est = [];
    det.rect.sides.forEach(l => {
      const pk = (l.peaks || []).slice().sort((a, b) => a.d - b.d); if (pk.length < 2) return;
      const p1 = pk[pk.length - 1], nN = l.n[0] * N[0] + l.n[1] * N[1], lever = nN - p1.d;
      if (lever < 0.8) return;
      const c = pk.filter(p => p !== p1 && p1.d - p.d > 0.02 && p1.d - p.d < 0.4 * lever && p.g > 0.25 * p1.g).sort((a, b) => b.g - a.g)[0];
      if (!c) return;
      const sv = 1 + (p1.d - c.d) / lever, h = P.Hc * (1 - 1 / sv);
      if (h > 0.1 && h < 6) est.push({ h, w: lever });
    });
    if (!est.length) return null;
    const W = est.reduce((a, e) => a + e.w, 0), h = est.reduce((a, e) => a + e.h * e.w, 0) / W;
    const spread = est.length > 1 ? Math.max(...est.map(e => e.h)) - Math.min(...est.map(e => e.h)) : null;
    if (spread != null && spread > 0.25) return null;
    return { h, n: est.length, spread };
  }
  // Height from a photo of the blank tipped on its side. top: {shape,L,W,D}
  function measureSide(det, paper, top) {
    const cands = top.shape === 'round' ? [top.D] : [top.W, top.L];
    let best = null;
    for (const V of cands) {
      let m = measure(det, paper, V, 'rect'); if (!m) continue;
      const other = top.shape === 'round' ? top.D : (V === top.W ? top.L : top.W);
      // one footprint side should match 'other'; height is the remaining side
      const e1 = Math.abs(m.L - other), e2 = Math.abs(m.W - other);
      const Hh = e1 < e2 ? m.W : m.L, err = Math.min(e1, e2) / other;
      if (!best || err < best.err) best = { H: Hh, err, V, m };
    }
    return best;
  }

  const api = { estimateHeight, PAPERS, prep, findPaper, paperModel, findBlank, measure, measureSide, project, unproject, applyH, inv3, homography, pose, zhangHe, exifFocal35, fitCircle, fitLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CNCVision = api;
})(this);
