/* CNC Check app: zero-typing flow (program -> drawing -> blank photos -> results) */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const V = window.CNCVision, A = window.CNCAuto, C = window.CNCCore;
  const LS = 'cnccheck.setup.v2';
  const state = { text: '', info: null, tools: null, prog: null, drawing: null, ruler: null, auto: null, result: null, sel: -1, edited: false, formShape: 'rect', toolEdits: {} };
  const f3 = v => (+v).toFixed(3);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function loadSaved() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }
  function save(patch) { try { localStorage.setItem(LS, JSON.stringify(Object.assign(loadSaved(), patch))); } catch (e) {} }
  // CDN libraries (loaded only when a drawing is read). window.CNCCHECK_LIBS can point them at local copies.
  const LIBS = Object.assign({
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
  }, window.CNCCHECK_LIBS || {});

  // ---------- navigation ----------
  function go(n) {
    document.querySelectorAll('main section').forEach(s => s.classList.toggle('on', s.id === 's' + n));
    document.querySelectorAll('#steps button').forEach(b => b.classList.toggle('on', +b.dataset.s === n));
    window.scrollTo(0, 0);
    if (n === 3) { topV.resize(); sideV.resize(); ruler.resize(); }
    if (n === 4) { view.fit(); }
  }
  document.querySelectorAll('#steps button').forEach(b => b.onclick = () => {
    const n = +b.dataset.s;
    if (n > 1 && !state.text.trim()) { alert('Load a program first.'); return; }
    if (n === 4) { showResults(); return; }
    go(n);
  });
  function showResults() {
    if (!state.text.trim()) { alert('Load a program first.'); return; }
    if (!state.result) autoRun(true);
    if (state.result) go(4);
  }

  // ---------- step 1: program ----------
  function setProgram(t) {
    state.text = t; state.result = null; state.toolEdits = {};
    if (!t.trim()) { $('ncSummary').textContent = ''; return; }
    try {
      const info = C.scan(t); state.info = info;
      state.tools = A.toolTable(t);
      state.prog = A.analyzeProgram(t, state.tools);
      const tl = Object.entries(state.tools).filter(([k, v]) => !v.probe).map(([k, v]) => 'T' + k + (v.conf === 'guess' ? ' (size ?)' : ' Ø' + f3(v.dia)));
      const p = state.prog, ex = p.ext;
      $('ncSummary').innerHTML = '<b>' + info.lineCount + ' lines</b> · ' + (info.units === 'mm' ? 'mm (G21)' : 'inch (G20)') +
        '<br>Tools: ' + (tl.join(', ') || 'none found') + '<br>Work offsets: ' + info.wcs.join(', ') +
        (ex ? '<br>Cuts span ' + f3(ex.sx) + ' × ' + f3(ex.sy) + ', deepest Z' + f3(-p.depth) : '');
    } catch (e) { $('ncSummary').textContent = 'Could not read this program: ' + e.message; }
    markDone(1, true);
    refreshPhotos();
  }
  $('ncFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { $('ncText').value = r.result.length > 400000 ? '(file loaded: ' + f.name + ')' : r.result; setProgram(r.result); };
    r.readAsText(f);
  };
  let pasteT = 0;
  $('ncText').oninput = () => { clearTimeout(pasteT); pasteT = setTimeout(() => setProgram($('ncText').value), 400); };
  $('to2').onclick = () => { if (!state.text.trim()) { alert('Load a program first.'); return; } go(2); };
  function markDone(n, on) { const b = document.querySelector('#steps button[data-s="' + n + '"]'); if (b) b.classList.toggle('done', !!on); }

  // ---------- script loader ----------
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error('could not load ' + src.replace(/^https?:\/\/([^/]+).*/, '$1') + ' (needs internet the first time)')); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  // ---------- image helpers ----------
  async function fileToCanvas(file, maxSide) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      src = await new Promise((res, rej) => { const im = new Image(), u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => rej(new Error('not an image')); im.src = u; });
    }
    const w0 = src.width, h0 = src.height, k = Math.min(1, maxSide / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return c;
  }
  function scaled(cv, maxSide) {
    const k = Math.min(1, maxSide / Math.max(cv.width, cv.height));
    if (k === 1) return { c: cv, k: 1 };
    const c = document.createElement('canvas'); c.width = Math.round(cv.width * k); c.height = Math.round(cv.height * k);
    c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height); return { c, k };
  }
  function prepCanvas(c) { return V.prep(c.getContext('2d').getImageData(0, 0, c.width, c.height)); }
  async function readF35(file) { try { return V.exifFocal35(await file.slice(0, 256 * 1024).arrayBuffer()); } catch (e) { return null; } }

  // ---------- step 2: drawing ----------
  function dwgStatus(t, p) {
    $('dwgStatus').innerHTML = t;
    const bar = $('dwgProg'); bar.style.display = p == null ? 'none' : 'block'; if (p != null) bar.firstElementChild.style.width = Math.round(p * 100) + '%';
  }
  $('dwgFile').onchange = e => { const f = e.target.files[0]; if (f) readDrawing(f); };
  $('to3').onclick = () => go(3);
  $('skip2').onclick = () => { state.drawing = null; $('dwgChips').innerHTML = ''; dwgStatus(''); refreshPhotos(); go(3); };

  async function readDrawing(file) {
    $('dwgChips').innerHTML = ''; $('dwgThumb').style.display = 'none';
    dwgStatus('Reading the drawing…', 0.03);
    try {
      let text = '', source = 'ocr', thumb = null, note = '';
      const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
      if (isPdf) {
        await loadScript(LIBS.pdf);
        const lib = window.pdfjsLib;
        if (!lib.GlobalWorkerOptions.workerSrc) {
          try { const wt = await (await fetch(LIBS.pdfWorker)).text(); lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wt], { type: 'text/javascript' })); }
          catch (e) { lib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker; }
        }
        const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        for (let p = 1; p <= Math.min(3, doc.numPages); p++) text += pdfText(await (await doc.getPage(p)).getTextContent()) + '\n';
        const page = await doc.getPage(1), vp0 = page.getViewport({ scale: 1 });
        const ocrNeeded = text.replace(/\s/g, '').length < 25;
        const sc = (ocrNeeded ? 2600 : 900) / Math.max(vp0.width, vp0.height), vp = page.getViewport({ scale: sc });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: cx, viewport: vp }).promise;
        thumb = c;
        if (!ocrNeeded) { source = 'pdf'; note = 'Read the text in the PDF.'; }
        else { dwgStatus('Scanned PDF, reading the text from the picture…', 0.1); text = await ocr(c); note = 'Scanned PDF, text read by OCR.'; }
      } else {
        const full = await fileToCanvas(file, 3200);
        let img = full;
        const rect = rectifySheet(full);
        if (rect) { img = rect; note = 'Found the sheet and straightened it. '; }
        thumb = img;
        dwgStatus('Reading the text on the drawing…', 0.1);
        text = await ocr(img); note += 'Text read by OCR.';
      }
      const d = A.parseDrawing(text, { source });
      state.drawing = { text, source, d };
      showThumb(thumb);
      renderChips(d);
      const n = ['units', 'stock', 'part', 'thk', 'material'].filter(k => d[k]).length + (d.holes.length ? 1 : 0);
      dwgStatus(n ? note + ' Found ' + n + ' thing' + (n > 1 ? 's' : '') + ' I can use.' : note + ' I could not find any sizes I trust on this drawing. You can carry on without it.');
      markDone(2, !!n);
      refreshPhotos();
    } catch (e) {
      console.error(e);
      dwgStatus('Could not read the drawing: ' + esc(e.message || e) + '. You can skip it.');
    }
  }
  function pdfText(tc) {
    const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], vert: Math.abs(it.transform[1]) > Math.abs(it.transform[0]) }));
    const vert = items.filter(i => i.vert).map(i => i.s), hor = items.filter(i => !i.vert).sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = []; let cur = null;
    hor.forEach(i => { if (!cur || Math.abs(i.y - cur.y) > 3) { cur = { y: i.y, parts: [] }; lines.push(cur); } cur.parts.push(i); });
    return lines.map(l => l.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(' ')).concat(vert).join('\n');
  }
  let tessWorker = null;
  async function ocr(canvas) {
    await loadScript(LIBS.tesseract);
    let phase = 0;
    if (!tessWorker) {
      dwgStatus('Loading the text reader (first time needs internet, about 10 MB)…', 0.12);
      tessWorker = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text') dwgStatus('Reading the text on the drawing…', 0.2 + 0.4 * phase + 0.4 * m.progress); } });
    }
    await tessWorker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
    const r1 = await tessWorker.recognize(canvas);
    const good = (r, minC) => (r.data.lines && r.data.lines.length ? r.data.lines.filter(l => l.confidence >= minC).map(l => l.text.trim()) : [r.data.text]);
    // vertical dimension text: find stacked character columns, turn each one upright and read it as one line
    phase = 1;
    const vert = [];
    const crops = verticalTextCrops(canvas);
    if (crops.length) {
      await tessWorker.setParameters({ tessedit_pageseg_mode: '7' });
      for (const cr of crops) {
        let best = null;
        for (const dir of [1, -1]) {
          const up = Math.max(1, Math.min(3, 90 / cr.w)); // text about 30-40 px tall reads best
          const rc = document.createElement('canvas'); rc.width = Math.round(cr.h * up); rc.height = Math.round(cr.w * up);
          const x = rc.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, rc.width, rc.height);
          if (dir > 0) { x.translate(rc.width, 0); x.rotate(Math.PI / 2); } else { x.translate(0, rc.height); x.rotate(-Math.PI / 2); }
          x.drawImage(canvas, cr.x, cr.y, cr.w, cr.h, 0, 0, cr.w * up, cr.h * up);
          const r = await tessWorker.recognize(rc), txt = r.data.text.trim();
          if (/\d*[.,]\d{2,4}/.test(txt) && (!best || r.data.confidence > best.c)) best = { t: txt, c: r.data.confidence };
          if (best && best.c > 80) break;
        }
        if (best && (best.c >= 60 || (best.c >= 45 && /^[\s\-—_|]*[Ø]?\d*[.,]\d{2,4}[\s\-—_|]*$/.test(best.t)))) vert.push(best.t.replace(/^[\s\-—_|]+|[\s\-—_|]+$/g, ''));
      }
    }
    const lines1 = r1.data.lines && r1.data.lines.length ? r1.data.lines.filter(l => l.confidence >= 35 || (l.confidence >= 10 && /MAT|STOCK|BLANK|THK|THICK|INCH|MILLIM/i.test(l.text))).map(l => l.text.trim()) : [r1.data.text];
    return lines1.join('\n') + '\n' + vert.join('\n');
  }
  // Boxes around columns of stacked small dark blobs (text printed sideways, as on vertical dimensions)
  function verticalTextCrops(canvas) {
    const k = Math.min(1, 1400 / Math.max(canvas.width, canvas.height));
    const w = Math.round(canvas.width * k), h = Math.round(canvas.height * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    const d = c.getContext('2d').getImageData(0, 0, w, h).data, n = w * h;
    let sum = 0; const g = new Uint8Array(n); for (let i = 0; i < n; i++) { g[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11); sum += g[i]; }
    const th = Math.min(160, sum / n * 0.65);
    const lab = new Int32Array(n).fill(-1), comps = [], stack = [];
    for (let i = 0; i < n; i++) {
      if (lab[i] >= 0 || g[i] >= th) continue;
      const id = comps.length; let x0 = w, y0 = h, x1 = 0, y1 = 0, cnt = 0; lab[i] = id; stack.push(i);
      while (stack.length) {
        const p = stack.pop(), px = p % w, py = (p / w) | 0; cnt++;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (const q of [p - 1, p + 1, p - w, p + w]) { if (q < 0 || q >= n || lab[q] >= 0 || g[q] >= th) continue; if ((q === p - 1 && px === 0) || (q === p + 1 && px === w - 1)) continue; lab[q] = id; stack.push(q); }
      }
      comps.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, cnt });
    }
    const ch = comps.filter(o => { const bw = o.x1 - o.x0, bh = o.y1 - o.y0; return bw >= 2 && bh >= 2 && bw <= 45 && bh <= 45 && Math.max(bw, bh) >= 5 && o.cnt >= 6; });
    // characters with a neighbor on the same row belong to normal horizontal text
    ch.forEach(o => { const bh = o.y1 - o.y0, bw = o.x1 - o.x0; o.hn = ch.some(p => p !== o && Math.min(o.y1, p.y1) - Math.max(o.y0, p.y0) > 0.5 * Math.min(bh, p.y1 - p.y0) && Math.max(p.x0 - o.x1, o.x0 - p.x1) < 0.8 * Math.max(bh, bw) && Math.abs((p.y1 - p.y0) - bh) < 0.5 * bh); });
    ch.sort((a, b) => a.y0 - b.y0);
    const groups = [];
    ch.forEach(o => {
      for (const G of groups) {
        const gw = G.x1 - G.x0, ox = Math.min(G.x1, o.x1) - Math.max(G.x0, o.x0);
        if (ox > 0.3 * Math.min(gw, o.x1 - o.x0) && o.y0 - G.y1 < 0.7 * Math.max(gw, 8) && o.y0 - G.y1 > -3) { G.x0 = Math.min(G.x0, o.x0); G.x1 = Math.max(G.x1, o.x1); G.y1 = Math.max(G.y1, o.y1); G.m.push(o); return; }
      }
      groups.push({ x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, m: [o] });
    });
    return groups.filter(G => { const gw = G.x1 - G.x0, gh = G.y1 - G.y0; return G.m.length >= 3 && G.m.length <= 14 && gh > 1.8 * gw && gw >= 6 && gw <= 45 && G.m.filter(o => o.hn).length <= G.m.length * 0.34; })
      .sort((a, b) => b.m.length - a.m.length).slice(0, 12)
      .map(G => { const gw = G.x1 - G.x0, pad = Math.round(gw * 1.0); const x = Math.max(0, G.x0 - pad), y = Math.max(0, G.y0 - pad); return { x: Math.round(x / k), y: Math.round(y / k), w: Math.round((Math.min(w, G.x1 + pad) - x) / k), h: Math.round((Math.min(h, G.y1 + pad) - y) / k) }; });
  }
  function rectifySheet(full) {
    const { c: small, k } = scaled(full, 1600);
    const pap = V.findPaper(prepCanvas(small));
    if (!pap.ok) return null;
    const q = pap.corners, area = Math.abs(polyArea(q)), frac = area / (small.width * small.height);
    if (frac > 0.9 || frac < 0.12) return null;
    // order the sheet corners as they appear in the photo: top-left first, clockwise
    const corners = [[0, 0], [pap.pw, 0], [pap.pw, pap.ph], [0, pap.ph]].map(p => V.applyH(pap.H, p[0], p[1]).map(v => v / k));
    let i0 = 0; corners.forEach((p, i) => { if (p[0] + p[1] < corners[i0][0] + corners[i0][1]) i0 = i; });
    let ord = [0, 1, 2, 3].map(i => corners[(i0 + i) % 4]);
    if (polyArea(ord) < 0) ord = [ord[0], ord[3], ord[2], ord[1]];
    const wIn = (dist(ord[0], ord[1]) + dist(ord[3], ord[2])) / 2, hIn = (dist(ord[1], ord[2]) + dist(ord[0], ord[3])) / 2;
    const landscape = wIn >= hIn, longIn = Math.max(pap.pw, pap.ph), shortIn = Math.min(pap.pw, pap.ph);
    const Wo = 2600, ppo = Wo / longIn, Ho = Math.round(shortIn * ppo);
    const ow = landscape ? Wo : Ho, oh = landscape ? Ho : Wo;
    const Hm = V.homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], ord);
    const sd = full.getContext('2d').getImageData(0, 0, full.width, full.height), sw = full.width, sh = full.height, s = sd.data;
    const out = document.createElement('canvas'); out.width = ow; out.height = oh;
    const ox = out.getContext('2d'), od = ox.createImageData(ow, oh), o = od.data;
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const w = Hm[6] * x + Hm[7] * y + Hm[8], u = (Hm[0] * x + Hm[1] * y + Hm[2]) / w, v = (Hm[3] * x + Hm[4] * y + Hm[5]) / w;
      const j = (y * ow + x) * 4; let g = 255;
      if (u >= 0 && v >= 0 && u < sw - 1 && v < sh - 1) {
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i = (y0 * sw + x0) * 4, r = sw * 4;
        const L = (p) => 0.299 * s[p] + 0.587 * s[p + 1] + 0.114 * s[p + 2];
        g = (L(i) * (1 - fx) + L(i + 4) * fx) * (1 - fy) + (L(i + r) * (1 - fx) + L(i + r + 4) * fx) * fy;
      }
      o[j] = o[j + 1] = o[j + 2] = g; o[j + 3] = 255;
    }
    // stretch contrast (photos of prints come out gray)
    const hist = new Uint32Array(256); for (let j = 0; j < o.length; j += 4) hist[o[j] | 0]++;
    const tot = ow * oh; let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc < tot * 0.01) lo = v; if (acc < tot * 0.6) hi = v; }
    const sc = 255 / Math.max(30, hi - lo);
    for (let j = 0; j < o.length; j += 4) { const v = Math.max(0, Math.min(255, (o[j] - lo) * sc)); o[j] = o[j + 1] = o[j + 2] = v; }
    ox.putImageData(od, 0, 0);
    return out;
  }
  function polyArea(q) { let a = 0; for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p[0] * n[1] - n[0] * p[1]; } return a / 2; }
  function showThumb(c) {
    const t = $('dwgThumb'); if (!c) { t.style.display = 'none'; return; }
    const k = Math.min(1, 800 / c.width); t.width = Math.round(c.width * k); t.height = Math.round(c.height * k);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height); t.style.display = 'block';
  }
  function chip(label, val, conf) { return '<span class="fchip">' + esc(label) + ' <b>' + esc(val) + '</b><i class="c-' + conf + '">' + conf + '</i></span>'; }
  function renderChips(d) {
    const h = [];
    if (d.units) h.push(chip('Units', d.units.v === 'mm' ? 'mm' : 'inch', d.units.conf));
    if (d.stock) h.push(chip('Stock', d.stock.shape === 'round' ? 'Ø' + f3(d.stock.D) + (d.stock.H ? ' × ' + f3(d.stock.H) : '') : f3(d.stock.L) + ' × ' + f3(d.stock.W) + (d.stock.H ? ' × ' + f3(d.stock.H) : ''), d.stock.conf));
    if (d.part) h.push(chip('Part', d.part.shape === 'round' ? 'Ø' + f3(d.part.D) : [d.part.L, d.part.W].filter(Boolean).map(f3).join(' × '), d.part.conf));
    if (d.thk) h.push(chip('Thickness', f3(d.thk.v), d.thk.conf));
    d.holes.forEach(o => h.push(chip('Holes', (o.n > 1 ? o.n + '× ' : '') + 'Ø' + f3(o.d), o.conf)));
    if (d.bore) h.push(chip('Center bore', 'Ø' + f3(d.bore.d), d.bore.conf));
    if (d.material) h.push(chip('Material', d.material.v, d.material.conf));
    $('dwgChips').innerHTML = h.join('') || '<span class="muted">Nothing usable found.</span>';
  }
  const dwg = () => state.drawing && state.drawing.d;

  // ---------- step 3: photo views with auto detection ----------
  function PhotoView(kind, cv) {
    this.kind = kind; this.cv = cv; this.ctx = cv.getContext('2d'); this.img = null; this.drag = null; this.touch = null; this.dpr = 1; this.scale = 1;
    this.tapShape = 'rect';
    const self = this;
    const pos = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (cv.width / r.width), (e.clientY - r.top) * (cv.height / r.height)]; };
    cv.addEventListener('pointerdown', e => {
      if (!self.img) return; e.preventDefault(); cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      const p = pos(e), ip = [p[0] / self.scale, p[1] / self.scale];
      let best = null, bd = 26 * self.dpr / self.scale;
      self.handles().forEach(hd => { const d = dist(hd.p, ip); if (d < bd) { bd = d; best = hd; } });
      if (!best && self.tap && self.tap.pts.length < self.tapNeed()) { self.tap.pts.push(ip); best = { type: 'tap', i: self.tap.pts.length - 1, p: ip }; }
      if (best) { self.drag = best; self.touch = p; self.draw(); }
    });
    cv.addEventListener('pointermove', e => {
      if (!self.drag) return; e.preventDefault();
      const p = pos(e), ip = [p[0] / self.scale, p[1] / self.scale]; self.touch = p; self.moveHandle(self.drag, ip); self.draw();
    });
    const up = () => { if (!self.drag) return; const d = self.drag; self.drag = null; self.touch = null; self.dropHandle(d); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  }
  PhotoView.prototype.load = async function (file) {
    this.img = await fileToCanvas(file, 1800);
    this.f35 = await readF35(file);
    this.work = prepCanvas(this.img);
    this.paper = null; this.det = null; this.meas = null; this.manual = null; this.tap = null; this.err = '';
    this.paper = V.findPaper(this.work, { f35: this.f35 });
    if (!this.paper.ok) { this.startTap('paper', "Couldn't find the paper; retake on plain paper with contrast. Or tap the 4 corners of the sheet."); }
    else this.detect();
    this.resize();
  };
  PhotoView.prototype.detect = function () {
    this.det = V.findBlank(this.work, this.paper); this.manual = null;
    if (!this.det.ok) this.startTap('blank', (this.det.msg || "Couldn't find the blank.") + ' Tap its corners, or 3 points on a round edge.');
    else this.tap = null;
  };
  PhotoView.prototype.startTap = function (mode, msg) { this.tap = { mode, pts: [], msg }; };
  PhotoView.prototype.tapNeed = function () { return this.tap ? (this.tap.mode === 'paper' ? 4 : (this.tapShape === 'round' && this.kind === 'top' ? 3 : 4)) : 0; };
  PhotoView.prototype.height = function () { return this.kind === 'top' ? heightNow().h : (this.sideV || 0); };
  // handles in image coords
  PhotoView.prototype.handles = function () {
    const out = [];
    if (this.tap) { this.tap.pts.forEach((p, i) => out.push({ type: 'tap', i, p })); if (this.tap.mode === 'paper') return out; }
    if (this.paper && this.paper.ok) this.paper.corners.forEach((p, i) => out.push({ type: 'paper', i, p }));
    if (this.manual) this.manual.pts.forEach((p, i) => out.push({ type: 'blank', i, p }));
    else if (this.meas && this.paper && this.paper.ok) this.blankOutline().handles.forEach((p, i) => out.push({ type: 'blank', i, p }));
    return out;
  };
  PhotoView.prototype.blankOutline = function () {
    const P = this.paper.pose, m = this.meas, z = this.height(), hd = [], rings = [];
    if (!m) return { handles: hd, rings };
    if (m.shape === 'rect' && m.footprint) {
      const top = m.footprint.map(p => V.project(P, p[0], p[1], z)), bot = m.footprint.map(p => V.project(P, p[0], p[1], 0));
      rings.push({ pts: bot, dash: true }); rings.push({ pts: top }); top.forEach(p => hd.push(p));
    } else if (m.shape === 'round' && m.c) {
      const ring = (r, zz) => { const a = []; for (let k = 0; k < 72; k++) { const t = k / 72 * 2 * Math.PI; a.push(V.project(P, m.c[0] + r * Math.cos(t), m.c[1] + r * Math.sin(t), zz)); } return a; };
      rings.push({ pts: ring(m.D / 2, 0), dash: true }); rings.push({ pts: ring(m.D / 2, z) });
      if (m.B) rings.push({ pts: ring(m.B / 2, z), c: '#ff7ad9' });
      [90, 210, 330].forEach(a => { const t = a * Math.PI / 180; hd.push(V.project(P, m.c[0] + m.D / 2 * Math.cos(t), m.c[1] + m.D / 2 * Math.sin(t), z)); });
    }
    return { handles: hd, rings };
  };
  PhotoView.prototype.moveHandle = function (h, ip) {
    if (h.type === 'tap') this.tap.pts[h.i] = ip;
    else if (h.type === 'paper') this.paper.corners[h.i] = ip;
    else if (h.type === 'blank') {
      if (!this.manual) this.manual = { shape: this.meas.shape, pts: this.blankOutline().handles.map(p => p.slice()) };
      this.manual.pts[h.i] = ip;
    }
    h.p = ip;
  };
  PhotoView.prototype.dropHandle = function (h) {
    if (h.type === 'paper') {
      const pm = V.paperModel(this.paper.corners.map(p => p.slice()), this.work.w, this.work.h, { f35: this.f35 });
      if (pm.ok) { this.paper = pm; this.detect(); }
    } else if (h.type === 'tap' && this.tap.pts.length >= this.tapNeed()) {
      if (this.tap.mode === 'paper') {
        const pm = V.paperModel(this.tap.pts.map(p => p.slice()), this.work.w, this.work.h, { f35: this.f35 });
        if (pm.ok) { this.paper = pm; this.tap = null; this.detect(); }
        else this.tap.msg = 'Those corners do not make a sheet of paper. Start over and tap the 4 corners of the sheet.';
      } else { this.manual = { shape: this.kind === 'top' ? this.tapShape : 'rect', pts: this.tap.pts.map(p => p.slice()) }; this.tap = null; }
    }
    refreshPhotos();
  };
  // measurement from hand-placed points (top face of the blank at height z)
  PhotoView.prototype.manualMeasure = function (z) {
    const P = this.paper.pose, q = this.manual.pts.map(p => V.unproject(P, p[0], p[1], z));
    if (this.manual.shape === 'round' && q.length === 3) {
      const cc = circle3(q[0], q[1], q[2]); if (!cc) return null;
      const B = this.meas && this.meas.shape === 'round' && !this.meas.manual ? this.meas.B : 0;
      return { shape: 'round', D: 2 * cc[2], B, c: [cc[0], cc[1]], manual: true };
    }
    if (q.length !== 4) return null;
    const a = (dist(q[0], q[1]) + dist(q[2], q[3])) / 2, c = (dist(q[1], q[2]) + dist(q[3], q[0])) / 2;
    const fp = this.manual.pts.map(p => V.unproject(P, p[0], p[1], z));
    return { shape: 'rect', L: Math.max(a, c), W: Math.min(a, c), footprint: fp, manual: true };
  };
  PhotoView.prototype.resize = function () {
    if (!this.img) return;
    const w = this.cv.clientWidth || this.cv.parentElement.clientWidth || 340; this.dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(w * this.dpr * this.img.height / this.img.width);
    this.scale = this.cv.width / this.img.width; this.draw();
  };
  PhotoView.prototype.draw = function () {
    const c = this.ctx, d = this.dpr, S = this.scale; if (!this.img) return;
    c.drawImage(this.img, 0, 0, this.cv.width, this.cv.height);
    const T = p => [p[0] * S, p[1] * S];
    const poly = (pts, color, w, dash, close) => {
      if (pts.length < 2) return; c.strokeStyle = color; c.lineWidth = w * d; c.setLineDash(dash ? [5 * d, 4 * d] : []);
      c.beginPath(); pts.map(T).forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); if (close !== false) c.closePath(); c.stroke(); c.setLineDash([]);
    };
    const label = (p, txt, color) => {
      c.font = 'bold ' + (13 * d) + 'px -apple-system,sans-serif'; const tw = c.measureText(txt).width;
      const [x, y] = T(p); c.fillStyle = 'rgba(0,0,0,0.72)'; c.fillRect(x - tw / 2 - 5 * d, y - 10 * d, tw + 10 * d, 20 * d);
      c.fillStyle = color; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(txt, x, y); c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    };
    if (this.paper && this.paper.ok) {
      const q = this.paper.corners; poly(q, '#2ecc71', 2.5);
      const cen = q.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]), tc = q.slice().sort((a, b) => a[1] - b[1])[0];
      label([tc[0] + (cen[0] - tc[0]) * 0.22, tc[1] + (cen[1] - tc[1]) * 0.22], (this.paper.paper === 'A4' ? 'A4' : 'Letter') + ' paper', '#8ff0b6');
    }
    if (this.paper && this.paper.ok && this.meas) {
      const m = this.meas, z = this.height();
      if (this.manual) {
        const pts = this.manual.pts;
        if (this.manual.shape === 'round') { const cc = circle3(pts[0], pts[1], pts[2]); if (cc) { const ring = []; for (let k = 0; k < 72; k++) { const t = k / 72 * 2 * Math.PI; ring.push([cc[0] + cc[2] * Math.cos(t), cc[1] + cc[2] * Math.sin(t)]); } poly(ring, '#00e5ff', 2.5); } }
        else poly(pts, '#00e5ff', 2.5);
      } else this.blankOutline().rings.forEach(r => poly(r.pts, r.c || '#00e5ff', r.dash ? 1.3 : 2.5, r.dash));
      const P = this.paper.pose;
      if (m.shape === 'rect' && m.footprint) {
        const fp = m.footprint, e = [0, 1, 2, 3].map(i => [fp[i], fp[(i + 1) % 4]]);
        const lens = e.map(([a, b]) => dist(a, b));
        const iL = lens[0] >= lens[1] ? 0 : 1, iW = 1 - iL;
        const cen = fp.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
        const lab = (i, txt) => { const [a, b] = e[i]; const mp = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const k = 0.35; const p = [mp[0] + (cen[0] - mp[0]) * k, mp[1] + (cen[1] - mp[1]) * k]; label(V.project(P, p[0], p[1], z), txt, '#7ff3ff'); };
        if (this.kind === 'top') { lab(iL, 'L ' + f3(m.L)); lab(iW, 'W ' + f3(m.W)); }
        else if (this.sideRes) { const hI = Math.abs(lens[0] - this.sideRes.H) < Math.abs(lens[1] - this.sideRes.H) ? 0 : 1; lab(hI, 'H ' + f3(this.sideRes.H)); }
      } else if (m.shape === 'round' && m.c) {
        label(V.project(P, m.c[0], m.c[1] - m.D * 0.33, z), 'Ø' + f3(m.D), '#7ff3ff');
        if (m.B) label(V.project(P, m.c[0], m.c[1] + Math.max(m.B / 2 + 0.25, m.D * 0.2), z), 'hole Ø' + f3(m.B), '#ffb3ec');
      }
    }
    this.handles().forEach(h => {
      const [x, y] = T(h.p); const col = h.type === 'paper' ? '#2ecc71' : h.type === 'tap' ? '#ffd400' : '#00e5ff';
      c.strokeStyle = col; c.lineWidth = 2 * d; c.beginPath(); c.arc(x, y, 9 * d, 0, Math.PI * 2); c.stroke();
      c.fillStyle = col; c.beginPath(); c.arc(x, y, 2 * d, 0, Math.PI * 2); c.fill();
    });
    if (this.tap && this.tap.pts.length > 1) poly(this.tap.pts, '#ffd400', 2, false, this.tap.pts.length === this.tapNeed());
    if (this.touch) { // magnifier
      const [x, y] = this.touch, R = 55 * d, zoom = 3;
      const lx = Math.min(Math.max(x, R + 4), this.cv.width - R - 4), ly = y - R - 40 * d < R ? y + R + 40 * d : y - R - 40 * d;
      c.save(); c.beginPath(); c.arc(lx, ly, R, 0, Math.PI * 2); c.clip();
      const ix = x / S, iy = y / S, src = R / (S * zoom);
      c.drawImage(this.img, ix - src, iy - src, src * 2, src * 2, lx - R, ly - R, R * 2, R * 2);
      c.strokeStyle = '#ff0'; c.lineWidth = 1.5 * d; c.beginPath(); c.moveTo(lx - 12 * d, ly); c.lineTo(lx + 12 * d, ly); c.moveTo(lx, ly - 12 * d); c.lineTo(lx, ly + 12 * d); c.stroke();
      c.restore(); c.strokeStyle = '#fff'; c.lineWidth = 2 * d; c.beginPath(); c.arc(lx, ly, R, 0, Math.PI * 2); c.stroke();
    }
  };
  function circle3(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
    const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    return [x, y, Math.hypot(a[0] - x, a[1] - y)];
  }

  const topV = new PhotoView('top', $('topCv')), sideV = new PhotoView('side', $('sideCv'));
  function heightNow() {
    if (sideV.sideRes && sideV.sideRes.H > 0) return { h: sideV.sideRes.H, src: 'side photo' };
    const d = dwg();
    if (d && d.stock && d.stock.H) return A.heightGuess(d, state.prog);
    const w = topV.paper && topV.paper.ok && topV.det && topV.det.ok ? V.estimateHeight(topV.det, topV.paper) : null;
    if (w) return { h: w.h, src: 'side wall seen in the top photo, rough' };
    return A.heightGuess(d, state.prog);
  }
  function topDims() {
    const m = topV.meas;
    if (m) return m.shape === 'round' ? { shape: 'round', D: m.D } : { shape: 'rect', L: m.L, W: m.W };
    if (state.ruler) return state.ruler;
    const d = dwg(); if (!d) return null;
    if (d.stock && (d.stock.D || d.stock.L)) return d.stock.shape === 'round' ? { shape: 'round', D: d.stock.D } : { shape: 'rect', L: d.stock.L, W: d.stock.W };
    return null;
  }
  function computeTop() {
    const v = topV; v.meas = null;
    if (!v.img || !v.paper || !v.paper.ok) return;
    const h = heightNow().h;
    if (v.manual) v.meas = v.manualMeasure(h);
    else if (v.det && v.det.ok) v.meas = V.measure(v.det, v.paper, h);
  }
  function computeSide() {
    const v = sideV; v.meas = null; v.sideRes = null; v.err = '';
    if (!v.img || !v.paper || !v.paper.ok) return;
    const td = topDims();
    if (!td) { v.err = 'Add the top photo first; I need it to tell the height apart from the length.'; return; }
    if (v.manual) {
      const cands = td.shape === 'round' ? [td.D] : [td.W, td.L]; let best = null;
      cands.forEach(Vv => { const m = v.manualMeasure(Vv); if (!m) return; const other = td.shape === 'round' ? td.D : (Vv === td.W ? td.L : td.W); const e1 = Math.abs(m.L - other), e2 = Math.abs(m.W - other); const r = { H: e1 < e2 ? m.W : m.L, err: Math.min(e1, e2) / other, V: Vv, m }; if (!best || r.err < best.err) best = r; });
      if (best) { v.sideV = best.V; v.meas = best.m; v.sideRes = best; }
    } else if (v.det && v.det.ok) {
      const r = V.measureSide(v.det, v.paper, td);
      if (r) { v.sideV = r.V; v.meas = r.m; v.sideRes = r; }
    }
    // (a disc standing on its rim doesn't look like a box from above, so only check the length on rectangular blanks)
    if (v.sideRes && td.shape === 'rect' && v.sideRes.err > 0.06) v.err = 'The side photo does not match the top sizes well (' + Math.round(v.sideRes.err * 100) + '% off). Is the blank tipped on its side?';
  }
  function refreshPhotos() {
    // top size depends on the height (perspective) and the side photo needs the top size: iterate
    for (let i = 0; i < 3; i++) { computeTop(); computeSide(); }
    computeTop();
    showPhotoText(); topV.draw(); sideV.draw();
    autoRun();
  }
  function showPhotoText() {
    const t = topV;
    if (t.img) {
      $('topBox').style.display = 'block';
      const m = t.meas, P = t.paper;
      $('topMeas').textContent = !m ? '' : m.shape === 'rect' ? 'Blank: ' + f3(m.L) + ' × ' + f3(m.W) + ' in' : 'Blank: Ø' + f3(m.D) + ' in' + (m.B ? ', hole Ø' + f3(m.B) : '');
      const h = heightNow();
      $('topNote').textContent = !P || !P.ok ? '' : (P.paper === 'A4' ? 'A4' : 'Letter') + ' paper found · ' + (m ? (m.manual ? 'outline placed by hand' : (m.shape === 'round' ? 'round blank' : 'rectangular blank') + ' found automatically') : '') +
        ' · corrected for a ' + f3(h.h) + ' in tall blank (' + h.src + ')' + (P.fsrc && /EXIF/.test(P.fsrc) ? ' · lens from photo info' : '') + sensNote(h);
      const tap = t.tap;
      $('topTap').style.display = tap ? 'block' : 'none';
      if (tap) {
        const need = t.tapNeed(), n = tap.pts.length;
        $('topTapMsg').textContent = tap.msg + (n < need ? ' (' + n + ' of ' + need + ' tapped)' : '');
        $('tapShape').style.display = tap.mode === 'blank' ? 'flex' : 'none';
      }
    }
    const s = sideV;
    if (s.img) {
      $('sideBox').style.display = 'block';
      $('sideMeas').textContent = s.sideRes ? 'Height: ' + f3(s.sideRes.H) + ' in' : '';
      $('sideNote').textContent = s.err || (!s.paper || !s.paper.ok ? "Couldn't find the paper; retake on plain paper with contrast." : !s.det || !s.det.ok ? (s.det && s.det.msg) || "Couldn't find the blank." : '');
    }
    const h = heightNow();
    $('hNote').textContent = 'Blank height used: ' + f3(h.h) + ' in, from ' + h.src + '.';
  }
  // how much the photo size moves if the height guess is off by 0.25
  function sensNote(h) {
    if (/side photo|stock note/.test(h.src) || !topV.meas || topV.manual || !topV.det || !topV.det.ok) return '';
    const m2 = V.measure(topV.det, topV.paper, h.h + 0.25), m = topV.meas; if (!m2) return '';
    const dd = m.shape === 'round' ? Math.abs(m2.D - m.D) : Math.max(Math.abs(m2.L - m.L), Math.abs(m2.W - m.W));
    return dd > 0.01 ? '. The height is only a guess, and 0.25 in of height changes this size by about ' + f3(dd) + ' in. Add the side photo below to pin it down.' : '';
  }
  async function loadPhoto(v, file) {
    $(v.kind + 'Box').style.display = 'block';
    $(v.kind + 'Meas').textContent = 'Looking for the paper and the blank…';
    await new Promise(r => setTimeout(r, 30));
    try { await v.load(file); } catch (e) { console.error(e); $(v.kind + 'Meas').textContent = 'Could not open that photo: ' + e.message; return; }
    v.resize(); refreshPhotos(); markDone(3, !!topV.meas);
  }
  $('topPhoto').onchange = e => { const f = e.target.files[0]; if (f) loadPhoto(topV, f); };
  $('sidePhoto').onchange = e => { const f = e.target.files[0]; if (f) loadPhoto(sideV, f); };
  $('topUndo').onclick = () => { if (topV.tap) { topV.tap.pts.pop(); topV.draw(); showPhotoText(); } };
  $('topRedo').onclick = () => { if (topV.tap) { topV.tap.pts = []; topV.draw(); showPhotoText(); } };
  document.querySelectorAll('#tapShape button').forEach(b => b.onclick = () => {
    topV.tapShape = b.dataset.v; document.querySelectorAll('#tapShape button').forEach(x => x.classList.toggle('on', x === b));
    if (topV.tap) topV.tap.pts = topV.tap.pts.slice(0, topV.tapNeed()); topV.draw(); showPhotoText();
  });
  $('to4').onclick = showResults;

  // ---------- ruler fallback (hidden) ----------
  const ruler = (function () {
    const cv = $('rulerCv'); let shape = 'rect';
    const v = new PhotoView('ruler', cv);
    v.handles = function () { return (this.pts || []).map((p, i) => ({ type: 'tap', i, p })); };
    v.tapNeed = () => 2 + (shape === 'round' ? 3 : 4);
    v.moveHandle = function (h, ip) { this.pts[h.i] = ip; };
    v.dropHandle = function () { update(); };
    v.draw = function () {
      const c = this.ctx, d = this.dpr, S = this.scale; if (!this.img) return;
      c.drawImage(this.img, 0, 0, cv.width, cv.height);
      const pts = (this.pts || []).map(p => [p[0] * S, p[1] * S]);
      c.lineWidth = 2.5 * d;
      if (pts.length >= 2) { c.strokeStyle = '#ffd400'; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); c.lineTo(pts[1][0], pts[1][1]); c.stroke(); }
      const b = pts.slice(2); c.strokeStyle = '#00e5ff';
      if (shape === 'round' && b.length === 3) { const cc = circle3(b[0], b[1], b[2]); if (cc) { c.beginPath(); c.arc(cc[0], cc[1], cc[2], 0, 7); c.stroke(); } }
      else if (b.length > 1) { c.beginPath(); b.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); if (b.length === 4) c.closePath(); c.stroke(); }
      pts.forEach((p, i) => { c.strokeStyle = i < 2 ? '#ffd400' : '#00e5ff'; c.beginPath(); c.arc(p[0], p[1], 8 * d, 0, 7); c.stroke(); });
    };
    v.tap = { pts: [] }; Object.defineProperty(v, 'pts', { get() { return v.tap.pts; } });
    function update() {
      const n = v.pts.length, need = v.tapNeed();
      const msgs = ['Tap one end of the ruler.', 'Tap the other end of the ruler.'].concat(shape === 'rect' ? ['Tap a corner of the blank.', 'Next corner.', 'Next corner.', 'Last corner.'] : ['Tap a point on the round edge.', 'A second point, a third of the way around.', 'A third point.']);
      $('rulerInstr').style.display = 'block'; $('rulerInstr').textContent = n < need ? msgs[n] : 'Done. Drag any point to fine-tune.';
      const len = parseFloat($('refLen').value); state.ruler = null;
      if (n === need && len > 0) {
        const ppi = dist(v.pts[0], v.pts[1]) / len, b = v.pts.slice(2);
        if (shape === 'round') { const cc = circle3(b[0], b[1], b[2]); if (cc) state.ruler = { shape: 'round', D: 2 * cc[2] / ppi }; }
        else { const a = (dist(b[0], b[1]) + dist(b[2], b[3])) / 2 / ppi, c = (dist(b[1], b[2]) + dist(b[3], b[0])) / 2 / ppi; state.ruler = { shape: 'rect', L: Math.max(a, c), W: Math.min(a, c) }; }
      }
      $('rulerMeas').textContent = !state.ruler ? '' : state.ruler.shape === 'rect' ? 'Blank: ' + f3(state.ruler.L) + ' × ' + f3(state.ruler.W) + ' in' : 'Blank: Ø' + f3(state.ruler.D) + ' in';
      v.draw(); if (state.ruler) refreshPhotos();
    }
    $('rulerPhoto').onchange = async e => { const f = e.target.files[0]; if (!f) return; cv.style.display = 'block'; v.img = await fileToCanvas(f, 1800); v.tap.pts = []; v.resize(); update(); };
    document.querySelectorAll('#rulerShape button').forEach(b => b.onclick = () => { shape = b.dataset.v; document.querySelectorAll('#rulerShape button').forEach(x => x.classList.toggle('on', x === b)); v.tap.pts = v.tap.pts.slice(0, 2); update(); });
    $('refLen').oninput = update;
    return { resize: () => v.resize() };
  })();
  window.addEventListener('resize', () => { topV.resize(); sideV.resize(); ruler.resize(); view.draw(); });

  // ---------- automatic setup + check ----------
  function photoInput() {
    const m = topV.meas || null, ph = {};
    if (m) { Object.assign(ph, m.shape === 'round' ? { shape: 'round', D: m.D, B: m.B || 0 } : { shape: 'rect', L: m.L, W: m.W }); }
    else if (state.ruler) Object.assign(ph, state.ruler);
    if (sideV.sideRes && sideV.sideRes.H > 0) { ph.H = sideV.sideRes.H; ph.hSrc = 'side photo'; }
    return Object.keys(ph).length ? ph : null;
  }
  function autoRun(force) {
    if (!state.text.trim()) return;
    const anyInput = topV.meas || sideV.sideRes || state.drawing || state.ruler;
    if (!anyInput && !force && !state.result) return;
    try {
      const photo = photoInput();
      const b = A.buildSetup({ text: state.text, photo, drawing: dwg(), saved: loadSaved() });
      Object.entries(state.toolEdits).forEach(([t, v]) => { if (b.setup.tools[t]) b.setup.tools[t].dia = v; });
      state.auto = b; state.photo = photo; state.edited = false;
      fillForm(b.setup); buildTables(b.setup);
      runCheck(b.setup);
    } catch (e) { console.error(e); $('miniBanner').className = 'banner amb'; $('miniBanner').textContent = 'Could not check: ' + e.message; $('mini').style.display = 'block'; }
  }
  function runCheck(setup) {
    setup = setup || readSetup();
    const r = C.check(state.text, setup);
    const extra = A.crossCheck(r, { setup, drawing: dwg(), photo: state.photo, prog: state.auto && state.auto.prog });
    r.issues = extra.filter(i => i.sev !== 'INFO').concat(r.issues, extra.filter(i => i.sev === 'INFO'));
    state.result = r; state.setup = setup; state.sel = -1;
    renderResults(); renderAssumptions();
    if ($('s4').classList.contains('on')) view.fit();
  }
  function bannerText(r) {
    const live = r.issues.filter(i => !i.afterEnd);
    const nc = live.filter(i => i.sev === 'CRASH').length, nk = live.filter(i => i.sev === 'CHECK').length;
    if (nc) return ['red', '⚠ Likely crash: ' + nc + ' problem' + (nc > 1 ? 's' : '') + (nk ? ', plus ' + nk + ' to check' : '')];
    if (nk) return ['amb', 'No crash found. ' + nk + ' thing' + (nk > 1 ? 's' : '') + ' to check'];
    return ['grn', '✓ No crash found with this setup'];
  }

  // ---------- form (only shown when she wants to change something) ----------
  function setShape2(v) {
    state.formShape = v;
    document.querySelectorAll('#shapeSeg2 button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    $('rectDims').style.display = v === 'rect' ? 'flex' : 'none';
    $('roundDims').style.display = v === 'round' ? 'flex' : 'none';
    $('xyZeroBox').style.display = v === 'rect' ? 'block' : 'none';
  }
  const setv = (id, v) => { $(id).value = typeof v === 'number' ? +v.toFixed(4) : v; };
  function fillForm(s) {
    setShape2(s.stock.shape);
    if (s.stock.shape === 'rect') { setv('dL', s.stock.length); setv('dW', s.stock.width); } else { setv('dD', s.stock.dia); setv('dB', s.stock.bore || 0); }
    setv('dH', s.stock.height); setv('dTop', s.stock.topAbove || 0); $('xyZero').value = s.stock.xyZero; $('zZero').value = s.stock.zZero;
    $('hold').value = s.hold.type; setv('grip', s.hold.grip); setv('thick', s.hold.thick); setv('jawLen', s.hold.jawLen || 6); setv('below', s.hold.below || 0);
    setv('mx', s.machine.x); setv('my', s.machine.y); setv('mz', s.machine.z); $('autoLen').checked = !!s.autoLength;
  }
  function buildTables(s) {
    const tw = $('wcsTbl'); tw.innerHTML = '<tr><th>Offset</th><th>X</th><th>Y</th><th>Z</th></tr>';
    Object.entries(s.wcs).forEach(([w, v]) => {
      tw.insertAdjacentHTML('beforeend', '<tr><td>' + w + '</td>' + ['x', 'y', 'z'].map(a => '<td><input data-w="' + w + '" data-a="' + a + '" type="number" step="0.001" inputmode="decimal" value="' + (v[a] || 0) + '"></td>').join('') + '</tr>');
    });
    const tt = $('toolTbl'); tt.innerHTML = '<tr><th>Tool</th><th>Diameter (in)</th><th>Probe</th></tr>';
    Object.entries(s.tools).sort((a, b) => a[0] - b[0]).forEach(([t, v]) => {
      const g = state.auto && state.auto.tools[t] && state.auto.tools[t].conf === 'guess';
      tt.insertAdjacentHTML('beforeend', '<tr><td>T' + t + (g ? ' ?' : '') + '</td><td><input data-t="' + t + '" type="number" step="0.001" inputmode="decimal" value="' + (+(+v.dia).toFixed(4)) + '"></td><td><input data-p="' + t + '" type="checkbox" style="width:auto"' + (v.probe ? ' checked' : '') + '></td></tr>');
    });
  }
  function num(id, d) { const v = parseFloat($(id).value); return isFinite(v) ? v : d; }
  function readSetup() {
    const wcs = {}; document.querySelectorAll('#wcsTbl input').forEach(i => { (wcs[i.dataset.w] = wcs[i.dataset.w] || {})[i.dataset.a] = parseFloat(i.value) || 0; });
    const tools = {};
    document.querySelectorAll('#toolTbl input[data-t]').forEach(i => { tools[i.dataset.t] = { dia: parseFloat(i.value) || 0 }; });
    document.querySelectorAll('#toolTbl input[data-p]').forEach(i => { (tools[i.dataset.p] = tools[i.dataset.p] || {}).probe = i.checked; });
    return {
      stock: { shape: state.formShape, length: num('dL', 0), width: num('dW', 0), dia: num('dD', 0), bore: num('dB', 0), height: num('dH', 0), topAbove: num('dTop', 0), xyZero: $('xyZero').value, zZero: $('zZero').value },
      hold: { type: $('hold').value, grip: num('grip', 0.5), thick: num('thick', 1), jawLen: num('jawLen', 6), below: num('below', 0) },
      machine: { x: num('mx', 42), y: num('my', 24), z: num('mz', 24) }, wcs, tools, autoLength: $('autoLen').checked
    };
  }
  function onEdit(e) {
    const s = readSetup(), st = s.stock;
    if (st.shape === 'rect' ? !(st.length > 0 && st.width > 0) : !(st.dia > 0)) return;
    if (!(st.height > 0)) return;
    if (e && e.target && e.target.dataset && e.target.dataset.t) state.toolEdits[e.target.dataset.t] = parseFloat(e.target.value) || 0;
    if (e && e.target && /^m[xyz]$/.test(e.target.id)) save({ machine: s.machine });
    state.edited = true;
    runCheck(s);
  }
  $('editBox').addEventListener('change', onEdit);
  document.querySelectorAll('#shapeSeg2 button').forEach(b => b.onclick = () => { setShape2(b.dataset.v); onEdit(); });
  $('editBtn').onclick = () => { const b = $('editBox'); const on = b.style.display === 'none'; b.style.display = on ? 'block' : 'none'; $('editBtn').textContent = on ? 'Hide' : 'Change something'; };
  $('resetAuto').onclick = () => { state.toolEdits = {}; autoRun(true); };

  // ---------- results ----------
  const confWord = { sure: 'sure', likely: 'likely', guess: 'guess' };
  function renderAssumptions() {
    const b = state.auto; if (!b) return;
    const items = b.assumptions.map(a => '<li><b>' + esc(a.label) + ':</b> ' + esc(a.value) + ' <span class="fchip" style="padding:1px 0;border:0"><i class="c-' + a.conf + '">' + confWord[a.conf] + '</i></span><span class="s">' + esc(a.src) + '</span></li>');
    if (state.edited) items.unshift('<li><b>You changed the setup by hand.</b><span class="s">Results below use your values. Tap “Go back to my automatic setup” to undo.</span></li>');
    const d = dwg();
    if (d && d.material) items.push('<li><b>Material:</b> ' + esc(d.material.v) + '<span class="s">from the drawing (not used by the check)</span></li>');
    $('assumeList').innerHTML = items.join('');
  }
  function renderResults() {
    const r = state.result;
    const [cls, txt] = bannerText(r);
    const b = $('banner'); b.className = 'banner ' + cls; b.textContent = txt;
    const mb = $('miniBanner'); mb.className = 'banner ' + cls; mb.innerHTML = esc(txt) + '<small>' + (state.edited ? 'Using your edited setup.' : 'Checked automatically from ' + sourcesText() + '.') + '</small>';
    $('mini').style.display = 'block';
    const box = $('issues'); box.innerHTML = '';
    if (!r.issues.length) box.innerHTML = '<p class="muted">Nothing found.</p>';
    r.issues.forEach((it, idx) => {
      const ln = (it.lines || []).filter(x => x > 0);
      const where = ln.length ? (ln.length > 1 ? 'Lines ' + ln.slice(0, 8).join(', ') + (ln.length > 8 ? ' … (' + ln.length + ' places)' : '') : 'Line ' + ln[0]) : '';
      const d = document.createElement('div'); d.className = 'issue ' + it.sev;
      d.innerHTML = '<div class="t ' + it.sev + '">' + (it.sev === 'CRASH' ? 'CRASH' : it.sev === 'CHECK' ? 'CHECK' : 'NOTE') + (it.kind === 'setup' ? ' · setup' : '') + (where ? ' · ' + where : '') +
        (it.afterEnd ? '<span class="chip">after M30</span>' : '') + (it.pts && it.pts.length ? '<span class="chip">show</span>' : '') + '</div>' +
        '<div>' + esc(it.msg) + '</div>' + (it.text ? '<code>' + esc(it.text) + '</code>' : '');
      d.onclick = () => { state.sel = idx; document.querySelectorAll('#issues .issue').forEach((e, k) => e.classList.toggle('sel', k === idx)); if (it.pts && it.pts.length) { view.draw(); $('view').scrollIntoView({ behavior: 'smooth', block: 'center' }); } };
      box.appendChild(d);
    });
    const tools = [...new Set(r.paths.filter(p => p.kind === 'feed').map(p => p.tool))];
    $('legend').innerHTML = tools.map(t => '<span><i style="background:' + toolColor(t) + '"></i>T' + t + '</span>').join('') +
      '<span><i style="background:#667"></i>rapid</span><span><i style="background:#ff4d4f"></i>problem</span>';
  }
  function sourcesText() {
    const s = ['the program'];
    if (state.drawing) s.push('the drawing');
    if (topV.meas) s.push('the top photo'); else if (state.ruler) s.push('the ruler photo');
    if (sideV.sideRes) s.push('the side photo');
    return s.length > 1 ? s.slice(0, -1).join(', ') + ' and ' + s[s.length - 1] : s[0];
  }
  const palette = ['#3ea6ff', '#2ecc71', '#ffb020', '#c56cf0', '#ff7a45', '#13c2c2', '#f759ab', '#a0d911', '#ffd666', '#69c0ff'];
  const toolColor = t => palette[(Math.abs(t | 0)) % palette.length];

  // ---------- 3D view ----------
  const view = (function () {
    const cv = $('view'), ctx = cv.getContext('2d');
    let yaw = -0.6, pitch = 0.95, zoom = 1, panX = 0, panY = 0, base = null;
    function proj(p) {
      const ca = Math.cos(yaw), sa = Math.sin(yaw), cb = Math.cos(pitch), sb = Math.sin(pitch);
      const xr = p[0] * ca - p[1] * sa, yr = p[0] * sa + p[1] * ca;
      return [xr, -(yr * cb + p[2] * sb), yr * sb - p[2] * cb];
    }
    function box(x0, x1, y0, y1, z0, z1, c, w, out) {
      const P = (x, y, z) => [x, y, z];
      [z0, z1].forEach(z => out.push({ pts: [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z), P(x0, y0, z)], c, w }));
      [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(([x, y]) => out.push({ pts: [P(x, y, z0), P(x, y, z1)], c, w: w * 0.7 }));
    }
    function geometry() {
      const r = state.result; if (!r) return [];
      const s = r.stock, lines = [], zt = s.top, zb = s.bottom;
      if (s.shape === 'round') {
        [[s.cx, s.cy, s.r], ...(s.bore ? [[s.cx, s.cy, s.bore]] : [])].forEach(([cx, cy, rr]) => {
          [zt, zb].forEach(z => { const ring = []; for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; ring.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a), z]); } lines.push({ pts: ring, c: '#9fb3c8', w: 1.5 }); });
          for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; lines.push({ pts: [[cx + rr * Math.cos(a), cy + rr * Math.sin(a), zt], [cx + rr * Math.cos(a), cy + rr * Math.sin(a), zb]], c: '#56687a', w: 1 }); }
        });
      } else box(s.x0, s.x1, s.y0, s.y1, zb, zt, '#9fb3c8', 1.5, lines);
      s.jaws.forEach(J => {
        if (J.ring) { [J.r0, J.r1].forEach(rr => { const ring = []; for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; ring.push([J.cx + rr * Math.cos(a), J.cy + rr * Math.sin(a), J.z1]); } lines.push({ pts: ring, c: '#8c6d3f', w: 1.5 }); }); }
        else box(J.x0, J.x1, J.y0, J.y1, Math.max(J.z0, zb - 0.5), J.z1, '#8c6d3f', 1.5, lines);
      });
      return lines;
    }
    function clampPts(pts, s) { const zc = s.top + 3; return pts.map(p => [p[0], p[1], Math.min(p[2], zc)]); }
    function fit() {
      const r = state.result; if (!r) return;
      const s = r.stock; let pts = [[s.x0, s.y0, s.bottom], [s.x1, s.y1, s.top + 1]];
      r.paths.forEach(p => { if (p.kind === 'feed') pts = pts.concat([p.pts[0], p.pts[p.pts.length - 1]]); });
      base = pts; zoom = 1; panX = panY = 0; draw();
    }
    function draw() {
      const r = state.result; if (!r || !cv.clientWidth) return;
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = Math.round(W * 0.85);
      cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
      ctx.fillStyle = '#05090d'; ctx.fillRect(0, 0, cv.width, cv.height);
      const s = r.stock, bb = (base || []).map(proj);
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      bb.forEach(p => { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); });
      const sc = Math.min(cv.width / (maxx - minx || 1), cv.height / (maxy - miny || 1)) * 0.85 * zoom;
      const ox = cv.width / 2 - (minx + maxx) / 2 * sc + panX * dpr, oy = cv.height / 2 - (miny + maxy) / 2 * sc + panY * dpr;
      const S = p => { const q = proj(p); return [ox + q[0] * sc, oy + q[1] * sc]; };
      const poly = (pts, color, w, dash) => {
        if (pts.length < 2) return; ctx.strokeStyle = color; ctx.lineWidth = w * dpr; ctx.setLineDash(dash ? [4 * dpr, 4 * dpr] : []);
        ctx.beginPath(); let a = S(pts[0]); ctx.moveTo(a[0], a[1]);
        const step = Math.max(1, Math.floor(pts.length / 4000));
        for (let k = step; k < pts.length; k += step) { a = S(pts[k]); ctx.lineTo(a[0], a[1]); }
        a = S(pts[pts.length - 1]); ctx.lineTo(a[0], a[1]); ctx.stroke();
      };
      geometry().forEach(l => poly(l.pts, l.c, l.w));
      r.paths.forEach(p => { if (p.kind === 'rapid') poly(clampPts(p.pts, s), 'rgba(140,150,170,0.55)', 1, true); });
      r.paths.forEach(p => { if (p.kind === 'feed') poly(clampPts(p.pts, s), toolColor(p.tool), 1.4); });
      ctx.setLineDash([]);
      r.issues.forEach((it, idx) => (it.pts || []).forEach(pt => {
        const a = S(pt), big = idx === state.sel;
        ctx.fillStyle = big ? '#ff4d4f' : 'rgba(255,77,79,0.8)';
        ctx.beginPath(); ctx.arc(a[0], a[1], (big ? 8 : 4) * dpr, 0, Math.PI * 2); ctx.fill();
        if (big) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
      }));
      const o = [26 * dpr, cv.height - 26 * dpr];
      [['X', [1, 0, 0], '#ff6b6b'], ['Y', [0, 1, 0], '#51cf66'], ['Z', [0, 0, 1], '#4dabf7']].forEach(([n, v, c]) => {
        const q = proj(v); ctx.strokeStyle = c; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(o[0], o[1]);
        ctx.lineTo(o[0] + q[0] * 18 * dpr, o[1] + q[1] * 18 * dpr); ctx.stroke();
        ctx.fillStyle = c; ctx.font = (11 * dpr) + 'px sans-serif'; ctx.fillText(n, o[0] + q[0] * 24 * dpr - 3 * dpr, o[1] + q[1] * 24 * dpr + 4 * dpr);
      });
    }
    let last = null, pinch = null;
    cv.addEventListener('touchstart', e => {
      e.preventDefault();
      if (e.touches.length === 2) pinch = { d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY), z: zoom };
      else last = [e.touches[0].clientX, e.touches[0].clientY];
    }, { passive: false });
    cv.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 2 && pinch) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); zoom = Math.max(0.3, Math.min(30, pinch.z * d / pinch.d)); draw(); }
      else if (last && e.touches.length === 1) { const x = e.touches[0].clientX, y = e.touches[0].clientY; yaw += (x - last[0]) * 0.01; pitch = Math.max(0, Math.min(Math.PI / 2, pitch + (y - last[1]) * 0.01)); last = [x, y]; draw(); }
    }, { passive: false });
    cv.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; if (!e.touches.length) last = null; });
    let mdown = null;
    cv.addEventListener('mousedown', e => { mdown = [e.clientX, e.clientY]; });
    window.addEventListener('mousemove', e => { if (!mdown) return; yaw += (e.clientX - mdown[0]) * 0.01; pitch = Math.max(0, Math.min(Math.PI / 2, pitch + (e.clientY - mdown[1]) * 0.01)); mdown = [e.clientX, e.clientY]; draw(); });
    window.addEventListener('mouseup', () => { mdown = null; });
    cv.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.max(0.3, Math.min(30, zoom * (e.deltaY < 0 ? 1.15 : 0.87))); draw(); }, { passive: false });
    document.querySelectorAll('#viewBtns [data-v]').forEach(b => b.onclick = () => {
      const v = b.dataset.v;
      if (v === 'top') { yaw = 0; pitch = 0; } else if (v === 'front') { yaw = 0; pitch = Math.PI / 2; } else if (v === 'side') { yaw = -Math.PI / 2; pitch = Math.PI / 2; } else { yaw = -0.6; pitch = 0.95; }
      zoom = 1; draw();
    });
    return { draw, fit };
  })();

  // test hook (read-only state for automated checks)
  window.CNCApp = { state, topV, sideV, autoRun, go, _vtc: verticalTextCrops };
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
