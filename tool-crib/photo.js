/* Tool Crib photo kit (needs a browser): load photos, read barcodes/QR codes, read label text (Tesseract.js), live scan.
   CDN libraries load on first use; window.TOOLCRIB_LIBS can point them at local copies. */
(function (root) {
  'use strict';
  const LIBS = Object.assign({
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
    zxing: 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'
  }, root.TOOLCRIB_LIBS || {});
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = res; s.onerror = () => { delete loaded[src]; s.remove(); rej(new Error('needs internet the first time')); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  // ---------- images ----------
  function loadImage(src) {
    return new Promise((res, rej) => {
      const url = typeof src === 'string' ? src : URL.createObjectURL(src), img = new Image();
      img.onload = () => { if (typeof src !== 'string') URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { if (typeof src !== 'string') URL.revokeObjectURL(url); rej(new Error('Could not open that photo')); };
      img.src = url;
    });
  }
  function toCanvas(img, maxSide, minSide) {
    const w0 = img.naturalWidth || img.videoWidth || img.width, h0 = img.naturalHeight || img.videoHeight || img.height;
    let k = Math.min(1, maxSide / Math.max(w0, h0)); if (minSide && Math.max(w0, h0) * k < minSide) k = minSide / Math.max(w0, h0);
    const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height); return c;
  }
  const imageData = c => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
  function rotate(c, deg) {
    if (!deg) return c;
    const o = document.createElement('canvas'), q = deg % 180 !== 0; o.width = q ? c.height : c.width; o.height = q ? c.width : c.height;
    const x = o.getContext('2d'); x.translate(o.width / 2, o.height / 2); x.rotate(deg * Math.PI / 180); x.drawImage(c, -c.width / 2, -c.height / 2); return o;
  }
  // grayscale + contrast stretch (2nd..98th percentile) for OCR
  function prepOCR(c) {
    const o = document.createElement('canvas'); o.width = c.width; o.height = c.height;
    const x = o.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0);
    const id = x.getImageData(0, 0, o.width, o.height), d = id.data, n = o.width * o.height, hist = new Uint32Array(256), g = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) | 0; g[i] = v; hist[v]++; }
    let lo = 0, hi = 255, acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
    acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
    const sc = 255 / Math.max(20, hi - lo);
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = Math.max(0, Math.min(255, (g[i] - lo) * sc)); d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
    x.putImageData(id, 0, 0); return o;
  }
  async function f35(file) { try { const buf = await file.slice(0, 196608).arrayBuffer(); return root.CNCVision ? root.CNCVision.exifFocal35(buf) : null; } catch (e) { return null; } }

  // ---------- barcodes ----------
  let bd = null, bdChecked = false;
  async function nativeDetector() {
    if (bdChecked) return bd; bdChecked = true;
    try { if ('BarcodeDetector' in root) { const f = await root.BarcodeDetector.getSupportedFormats(); if (f && f.length) bd = new root.BarcodeDetector({ formats: f }); } } catch (e) { bd = null; }
    return bd;
  }
  // zxing-js 0.21.x bug: Code128Reader.findStartPattern shrinks its Int32Array window with slice(2),
  // so any dark run left of the barcode (label edge, bench) makes Code 128 undetectable. Fixed port:
  function patchZX(Z) {
    const C = Z && Z.Code128Reader; if (!C || C.__tcFixed || typeof C.findStartPattern !== 'function') return;
    C.findStartPattern = function (row) {
      const width = row.getSize(), off = row.getNextSet(0); let pos = 0, cnt = new Int32Array(6), start = off, white = false;
      for (let i = off; i < width; i++) {
        if (row.get(i) !== white) cnt[pos]++;
        else {
          if (pos === 5) {
            let best = C.MAX_AVG_VARIANCE, m = -1;
            for (let k = C.CODE_START_A; k <= C.CODE_START_C; k++) { const v = C.patternMatchVariance(cnt, C.CODE_PATTERNS[k], C.MAX_INDIVIDUAL_VARIANCE); if (v < best) { best = v; m = k; } }
            if (m >= 0 && row.isRange(Math.max(0, start - (i - start) / 2), start, false)) return Int32Array.from([start, i, m]);
            start += cnt[0] + cnt[1]; cnt.copyWithin(0, 2, 6); cnt[4] = 0; cnt[5] = 0; pos--;
          } else pos++;
          cnt[pos] = 1; white = !white;
        }
      }
      throw new Z.NotFoundException();
    };
    C.__tcFixed = true;
  }
  let zx = null;
  async function zxingReader() {
    if (zx) return zx;
    await loadScript(LIBS.zxing); const Z = root.ZXing;
    patchZX(Z);
    const hints = new Map(); hints.set(Z.DecodeHintType.TRY_HARDER, true);
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93, Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX]);
    const r = new Z.MultiFormatReader(); r.setHints(hints); zx = { Z, r }; return zx;
  }
  function zxDecode(z, c) {
    try { const src = new z.Z.HTMLCanvasElementLuminanceSource(c), bmp = new z.Z.BinaryBitmap(new z.Z.HybridBinarizer(src)); const res = z.r.decode(bmp); return { text: res.getText(), format: z.Z.BarcodeFormat[res.getBarcodeFormat()] || String(res.getBarcodeFormat()) }; }
    catch (e) { return null; } finally { try { z.r.reset(); } catch (e) { } }
  }
  // -> [{text, format, via}] ; tries native BarcodeDetector, then zxing on a few sizes/rotations
  // unsharp mask on grayscale: helps blurred thin bars
  function sharpen(c, amt) {
    const w = c.width, h = c.height, o = document.createElement('canvas'); o.width = w; o.height = h;
    const x = o.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0);
    const id = x.getImageData(0, 0, w, h), d = id.data, n = w * h, g = new Float32Array(n), t = new Float32Array(n), bl = new Float32Array(n), r = 2;
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    for (let y = 0; y < h; y++) { let acc = 0; const row = y * w; for (let k = -r; k <= r; k++) acc += g[row + Math.min(w - 1, Math.max(0, k))];
      for (let xx = 0; xx < w; xx++) { t[row + xx] = acc / (2 * r + 1); acc += g[row + Math.min(w - 1, xx + r + 1)] - g[row + Math.max(0, xx - r)]; } }
    for (let xx = 0; xx < w; xx++) { let acc = 0; for (let k = -r; k <= r; k++) acc += t[Math.min(h - 1, Math.max(0, k)) * w + xx];
      for (let y = 0; y < h; y++) { bl[y * w + xx] = acc / (2 * r + 1); acc += t[Math.min(h - 1, y + r + 1) * w + xx] - t[Math.max(0, y - r) * w + xx]; } }
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = Math.max(0, Math.min(255, g[i] + amt * (g[i] - bl[i]))); d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
    x.putImageData(id, 0, 0); return o;
  }
  // -> [{text, format, via}] ; tries native BarcodeDetector, then zxing: whole photo, the flattened label (plain + sharpened), more sizes/angles
  async function readCodes(img, opts) {
    opts = opts || {};
    const out = [], seen = new Set(), add = (t, f, via) => { if (t && !seen.has(t)) { seen.add(t); out.push({ text: t, format: f, via }); } };
    const det = await nativeDetector();
    if (det) { try { (await det.detect(img)).forEach(b => add(b.rawValue, b.format, 'native')); } catch (e) { } if (out.length) return out; }
    let z; try { z = await zxingReader(); } catch (e) { if (opts.quiet) return out; throw e; }
    const tryC = (c, degs) => { for (const deg of degs) { const r = zxDecode(z, deg % 90 === 0 ? rotate(c, deg) : rotFree(c, deg)); if (r) { add(r.text, r.format, 'zxing'); return true; } } return false; };
    if (opts.fast) { tryC(toCanvas(img, 1000), [0, 90]); return out; }
    const base = toCanvas(img, 1400);
    if (tryC(base, [0, 90])) return out;
    let L = null; try { L = findLabel(toCanvas(img, 2400), 1600); } catch (e) { L = null; }
    if (L && (tryC(L, [0, 90]) || tryC(sharpen(L, 1.5), [0, 90]))) return out;
    if (tryC(sharpen(base, 1.5), [0, 90])) return out;
    for (const side of [900, 2000]) if (tryC(toCanvas(img, side), [0, 90])) return out;
    tryC(base, [15, -15, 45, -45]);
    return out;
  }

  function rotFree(c, deg) {
    const a = deg * Math.PI / 180, W = Math.ceil(Math.abs(c.width * Math.cos(a)) + Math.abs(c.height * Math.sin(a))), H = Math.ceil(Math.abs(c.width * Math.sin(a)) + Math.abs(c.height * Math.cos(a)));
    const o = document.createElement('canvas'); o.width = W; o.height = H; const x = o.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.translate(W / 2, H / 2); x.rotate(a); x.drawImage(c, -c.width / 2, -c.height / 2); return o;
  }

  // ---------- OCR ----------
  // ---------- label finder: largest bright quad -> flattened, deskewed canvas (or null) ----------
  function findLabel(c, outLong) {
    const V = root.CNCVision; if (!V) return null;
    const sm = toCanvas(c, 480), w = sm.width, h = sm.height, n = w * h;
    const d = sm.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data, g = new Float32Array(n);
    let mx = 0; for (let i = 0, j = 0; i < n; i++, j += 4) { const r = d[j], gg = d[j + 1], b = d[j + 2]; g[i] = Math.min(r, gg, b) * 0.6 + (r + gg + b) / 7.5; if (g[i] > mx) mx = g[i]; }
    const th = otsuF(g, mx); const m = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) { const hi = Math.max(d[j], d[j + 1], d[j + 2]), lo = Math.min(d[j], d[j + 1], d[j + 2]); m[i] = g[i] > th || (hi > 70 && hi - lo > 0.45 * hi) ? 1 : 0; }   // bright paper or printed color band
    // largest 4-connected bright component
    const lab = new Int32Array(n).fill(-1), st = new Int32Array(n); let best = null;
    for (let s = 0; s < n; s++) {
      if (!m[s] || lab[s] >= 0) continue; let top = 0, cnt = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0; st[top++] = s; lab[s] = s;
      while (top) { const p = st[--top], x = p % w, y = (p / w) | 0; cnt++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (x > 0 && m[p - 1] && lab[p - 1] < 0) { lab[p - 1] = s; st[top++] = p - 1; } if (x < w - 1 && m[p + 1] && lab[p + 1] < 0) { lab[p + 1] = s; st[top++] = p + 1; }
        if (y > 0 && m[p - w] && lab[p - w] < 0) { lab[p - w] = s; st[top++] = p - w; } if (y < h - 1 && m[p + w] && lab[p + w] < 0) { lab[p + w] = s; st[top++] = p + w; } }
      if (!best || cnt > best.cnt) best = { s, cnt, sx, sy, sxx, syy, sxy };
    }
    if (!best || best.cnt < n * 0.04 || best.cnt > n * 0.9) return null;
    const cx = best.sx / best.cnt, cy = best.sy / best.cnt, a = best.sxx / best.cnt - cx * cx, b = best.sxy / best.cnt - cx * cy, cc = best.syy / best.cnt - cy * cy;
    const th0 = 0.5 * Math.atan2(2 * b, a - cc), co = Math.cos(th0), si = Math.sin(th0);
    const ext = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(() => ({ v: -1e18, p: null }));
    for (let p = 0; p < n; p++) { if (lab[p] !== best.s) continue; const x = p % w, y = (p / w) | 0, u = (x - cx) * co + (y - cy) * si, v = -(x - cx) * si + (y - cy) * co;
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach((k, i) => { const sc = k[0] * u + k[1] * v; if (sc > ext[i].v) { ext[i].v = sc; ext[i].p = [x + 0.5, y + 0.5]; } }); }
    const f = c.width / w, q = ext.map(e => [e.p[0] * f, e.p[1] * f]);
    const L = (i, j) => Math.hypot(q[i][0] - q[j][0], q[i][1] - q[j][1]);
    const wq = (L(0, 1) + L(3, 2)) / 2, hq = (L(0, 3) + L(1, 2)) / 2; if (wq < 40 || hq < 20) return null;
    // fill ratio check: must look like a quad
    const areaQ = Math.abs(((q[0][0] * q[1][1] - q[1][0] * q[0][1]) + (q[1][0] * q[2][1] - q[2][0] * q[1][1]) + (q[2][0] * q[3][1] - q[3][0] * q[2][1]) + (q[3][0] * q[0][1] - q[0][0] * q[3][1])) / 2) / (f * f);
    if (best.cnt / areaQ < 0.75) return null;
    const W = Math.round(Math.min(outLong || 1600, Math.max(wq, 600) * 1.2)), H = Math.round(W * hq / wq);
    const Hm = V.homography([[0, 0], [W, 0], [W, H], [0, H]], q); if (!Hm) return null;
    const src = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height), sd = src.data, SW = c.width, SH = c.height;
    const o = document.createElement('canvas'); o.width = W; o.height = H; const ox = o.getContext('2d'), od = ox.createImageData(W, H), dd = od.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ww = Hm[6] * x + Hm[7] * y + Hm[8], X = (Hm[0] * x + Hm[1] * y + Hm[2]) / ww - 0.5, Y = (Hm[3] * x + Hm[4] * y + Hm[5]) / ww - 0.5;
      const x0 = Math.max(0, Math.min(SW - 2, X | 0)), y0 = Math.max(0, Math.min(SH - 2, Y | 0)), fx = Math.min(1, Math.max(0, X - x0)), fy = Math.min(1, Math.max(0, Y - y0)), k = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) { const i0 = (y0 * SW + x0) * 4 + ch; dd[k + ch] = (sd[i0] * (1 - fx) + sd[i0 + 4] * fx) * (1 - fy) + (sd[i0 + SW * 4] * (1 - fx) + sd[i0 + SW * 4 + 4] * fx) * fy; }
      dd[k + 3] = 255;
    }
    ox.putImageData(od, 0, 0); o.quad = q; return o;
  }
  function otsuF(g, mx) {
    const hist = new Float64Array(64); for (let i = 0; i < g.length; i++) hist[Math.min(63, (g[i] / (mx + 1e-6) * 64) | 0)]++;
    let sum = 0, n = g.length; for (let k = 0; k < 64; k++) sum += k * hist[k];
    let wB = 0, sB = 0, bv = -1, t = 0; for (let k = 0; k < 64; k++) { wB += hist[k]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += k * hist[k]; const v = wB * wF * Math.pow(sB / wB - (sum - sB) / wF, 2); if (v > bv) { bv = v; t = k; } }
    return (t + 1) / 64 * mx;
  }
  let worker = null, workerP = null;
  async function getWorker(progress) {
    if (worker) return worker;
    if (!workerP) workerP = (async () => {
      await loadScript(LIBS.tesseract);
      const w = await root.Tesseract.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text' && getWorker.onp) getWorker.onp(m.progress); } });
      await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
      worker = w; return w;
    })().catch(e => { workerP = null; throw e; });
    return workerP;
  }
  const score = d => (d.words || []).filter(w => w.confidence >= 55 && /[A-Z0-9]{2,}/i.test(w.text)).reduce((s, w) => s + w.confidence * Math.min(4, w.text.replace(/[^A-Z0-9]/gi, '').length), 0);
  function invert(c) {
    const o = document.createElement('canvas'); o.width = c.width; o.height = c.height; const x = o.getContext('2d', { willReadFrequently: true }); x.drawImage(c, 0, 0);
    const id = x.getImageData(0, 0, o.width, o.height), d = id.data; for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
    x.putImageData(id, 0, 0); return o;
  }
  const linesOf = r => (r.data.lines || []).map(l => ({ text: l.text.replace(/\s+/g, ' ').trim(), conf: Math.round(l.confidence) })).filter(l => l.text);
  const normT = t => t.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S');
  // -> {text, lines:[{text, conf}], rot, conf, label:bool}
  async function ocr(img, progress) {
    const p = (f, msg) => progress && progress(f, msg);
    p(0.02, 'Loading the label reader…');
    const w = await getWorker();
    const big = toCanvas(img, 2400);
    p(0.08, 'Finding the label…');
    let L = null; try { L = findLabel(big, 1600); } catch (e) { L = null; }
    const src = L || toCanvas(big, 2000, 1600);
    await w.setParameters({ tessedit_pageseg_mode: L ? '3' : '11' });
    const quick = prepOCR(toCanvas(src, 1000));
    let best = null; const rots = L ? (L.height > L.width * 1.15 ? [90, 270, 0, 180] : [0, 180, 90, 270]) : [0, 90, 180, 270];
    for (const [i, deg] of rots.entries()) {
      p(0.12 + 0.1 * i, 'Finding which way is up…');
      const r = await w.recognize(rotate(quick, deg)); const sc = score(r.data);
      if (!best || sc > best.sc) best = { deg, sc };
      if (L && i === 1 && best.sc > 600) break;     // clear winner between the two likely orientations
    }
    p(0.55, 'Reading the label…');
    getWorker.onp = f => p(0.55 + 0.3 * f, 'Reading the label…');
    const full = prepOCR(rotate(L ? src : toCanvas(big, 2000, 1600), best.deg));
    const r = await w.recognize(full); getWorker.onp = null;
    let lines = linesOf(r); const conf = r.data.confidence;
    // white-on-color print (brand bands): read the negative and keep confident new lines
    if (L) {
      p(0.88, 'Reading light-on-dark print…');
      const ri = await w.recognize(invert(full)); const have = lines.map(l => normT(l.text));
      const extra = linesOf(ri).filter(l => l.conf >= 70 && normT(l.text).length >= 3 && !have.some(h => h.includes(normT(l.text))));
      lines = extra.concat(lines);
    }
    p(1, 'Done');
    return { text: lines.map(l => l.text).join('\n'), lines, rot: best.deg, conf, label: !!L, quad: L ? L.quad : null };
  }

  // ---------- live scanning ----------
  async function scanLive(video, onCode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('No live camera here');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream; video.setAttribute('playsinline', ''); video.muted = true; await video.play();
    let stop = false, busy = false, last = null;
    const tick = async () => {
      if (stop) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) {
        busy = true;
        try {
          const c = toCanvas(video, 1280);
          const codes = await readCodes(c, { fast: true, quiet: true });
          if (codes.length && !stop) { last = c; stop = true; onCode(codes[0], c); }
        } catch (e) { } busy = false;
      }
      if (!stop) setTimeout(tick, 250);
    };
    tick();
    return () => { stop = true; stream.getTracks().forEach(t => t.stop()); video.srcObject = null; };
  }

  root.PhotoKit = { _worker: getWorker, findLabel, LIBS, loadScript, loadImage, toCanvas, imageData, rotate, prepOCR, f35, readCodes, ocr, scanLive, hasNativeBarcode: () => nativeDetector().then(d => !!d) };
})(window);
