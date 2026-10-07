/* CNC Check auto setup: read tool sizes from comments, read a drawing's text, infer the setup from the program,
   and cross-check drawing vs photo vs program. No DOM. Depends on CNCCore (core.js). */
(function (root) {
  'use strict';
  const Core = root.CNCCore || (typeof require !== 'undefined' ? require('./core.js') : null);
  const NUM = '(\\d+\\s*-\\s*\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+(?:\\.\\d+)?)';
  function num(s) {
    if (s == null) return NaN; s = String(s).replace(/\s+/g, '');
    let m = s.match(/^(\d+)-(\d+)\/(\d+)$/); if (m) return +m[1] + m[2] / m[3];
    m = s.match(/^(\d+)\/(\d+)$/); if (m) return m[1] / m[2];
    return parseFloat(s);
  }
  // number drills #1-#80 and letter drills, inches
  const NUMBER_DRILL = [0, .228, .221, .213, .209, .2055, .204, .201, .199, .196, .1935, .191, .189, .185, .182, .18, .177, .173, .1695, .166, .161, .159, .157, .154, .152, .1495, .147, .144, .1405, .136, .1285, .12, .116, .113, .111, .11, .1065, .104, .1015, .0995, .098, .096, .0935, .089, .086, .082, .081, .0785, .076, .073, .07, .067, .0635, .0595, .055, .052, .0465, .043, .042, .041, .04, .039, .038, .037, .036, .035, .033, .032, .031, .0292, .028, .026, .025, .024, .0225, .021, .02, .018, .016, .0145, .0135];
  const LETTER_DRILL = { A: .234, B: .238, C: .242, D: .246, E: .25, F: .257, G: .261, H: .266, I: .272, J: .277, K: .281, L: .29, M: .295, N: .302, O: .316, P: .323, Q: .332, R: .339, S: .348, T: .358, U: .368, V: .377, W: .386, X: .397, Y: .404, Z: .413 };
  const KIND = '(E\\/M|EM|END\\s*MILL|ENDMILL|ROUGHER|FINISHER|DRILL|DRL|DR|SPOT(?:\\s*DRILL)?|SPOTDRILL|CTR\\s*DRILL|CENTER\\s*DRILL|C\\/D|CHAMFER(?:\\s*MILL)?|CHAM|CSINK|C\'SINK|COUNTERSINK|REAMER|REAM|TAP|FACE\\s*MILL|FACEMILL|FACE|SHELL\\s*MILL|F\\/M|FM|BORING\\s*BAR|BORE|THREAD\\s*MILL|SLOT(?:\\s*CUTTER)?|KEY\\s*CUTTER|BALL(?:\\s*EM|\\s*MILL)?|BULL(?:\\s*NOSE)?|ENGRAV\\w*|LOLLIPOP)';
  function kindOf(k) {
    k = (k || '').toUpperCase();
    if (/SPOT|CTR|CENTER|C\/D/.test(k)) return 'spot'; if (/CHAM|SINK/.test(k)) return 'chamfer'; if (/REAM/.test(k)) return 'reamer';
    if (/TAP/.test(k)) return 'tap'; if (/DR/.test(k)) return 'drill'; if (/FACE|SHELL|F\/M|^FM$/.test(k)) return 'face mill';
    if (/BOR/.test(k)) return 'boring bar'; if (/THREAD/.test(k)) return 'thread mill'; if (/BALL/.test(k)) return 'ball mill';
    if (/ENGRAV/.test(k)) return 'engraver'; return 'end mill';
  }
  // Parse a tool diameter from comment text. Returns {dia, kind, how} or null. mm values converted when progUnits==='in'.
  function parseToolText(c, progUnits) {
    const s = ' ' + c.toUpperCase().replace(/[Ø⌀∅]/g, ' DIA ') + ' ';
    const conv = (v, mm) => (mm && progUnits !== 'mm') ? v / 25.4 : (!mm && progUnits === 'mm') ? v * 25.4 : v;
    let m;
    if ((m = s.match(/\bD(?:IA(?:METER)?)?\.?\s*[=:]\s*(\d*\.?\d+)\s*(MM)?/))) return { dia: conv(+m[1], !!m[2]), kind: kindOf((s.match(new RegExp(KIND)) || [])[1]), how: 'D=' };
    if ((m = s.match(/#\s*(\d{1,2})\s*(?:DRILL|DRL|DR)\b/)) && NUMBER_DRILL[+m[1]]) return { dia: conv(NUMBER_DRILL[+m[1]], false), kind: 'drill', how: '#' + m[1] + ' drill' };
    if ((m = s.match(/\b(?:LTR\.?|LETTER)?\s*\b([A-Z])\s*(?:DRILL|DRL)\b/)) && LETTER_DRILL[m[1]] && !/\bEM\b/.test(s)) return { dia: conv(LETTER_DRILL[m[1]], false), kind: 'drill', how: m[1] + ' drill' };
    if ((m = s.match(/\b(\d+\/\d+|#\d+|\d*\.\d+|\d+)\s*-\s*\d+\s*(?:UNC|UNF|UN)?\s*TAP/))) {
      const v = m[1].startsWith('#') ? ({ 0: .06, 1: .073, 2: .086, 3: .099, 4: .112, 5: .125, 6: .138, 8: .164, 10: .19, 12: .216 })[m[1].slice(1)] : num(m[1]);
      if (v) return { dia: conv(v, false), kind: 'tap', how: 'tap size' };
    }
    if ((m = s.match(/\bM(\d+(?:\.\d+)?)\s*X\s*[\d.]+\s*TAP/))) return { dia: conv(+m[1], true), kind: 'tap', how: 'metric tap' };
    // number then kind:  1/2 EM, .500 FLAT EM, 3/8 DRILL, 12MM EM, 2.0 FACE MILL, 1/2" 90DEG SPOT
    const re1 = new RegExp('(?<![A-Z\\d.#\\/=-])' + NUM + '\\s*(MM|"|IN\\b|INCH)?\\s*(?:DIA\\.?\\s*)?(?:(?:\\d\\s*FL(?:UTE)?S?|FLAT|SQ(?:UARE)?|CARB(?:IDE)?|HSS|COBALT|STUB|JOBBER|LONG|X?\\d+\\s*DEG|90|82|60|120|118)\\s*)*' + KIND + '\\b');
    if ((m = s.match(re1))) { const v = num(m[1]); if (v > 0 && v < 12 * (m[2] === 'MM' ? 25.4 : 1)) return { dia: conv(v, m[2] === 'MM'), kind: kindOf(m[3]), how: m[0].trim() }; }
    // kind then number:  EM 1/2, DRILL .201, FACE MILL 3.0 DIA
    const re2 = new RegExp(KIND + '\\s*[-:,]?\\s*(?:DIA\\.?\\s*)?' + NUM + '\\s*(MM)?');
    if ((m = s.match(re2))) { const v = num(m[2]); if (v > 0 && v < 12 * (m[3] ? 25.4 : 1) && !/^\s*(DEG|FL)/.test(s.slice(s.indexOf(m[0]) + m[0].length))) return { dia: conv(v, !!m[3]), kind: kindOf(m[1]), how: m[0].trim() }; }
    if ((m = s.match(/\bDIA\.?\s*(\d*\.\d+|\d+\/\d+)/))) return { dia: conv(num(m[1]), false), kind: kindOf((s.match(new RegExp(KIND)) || [])[1]), how: 'DIA' };
    return null;
  }
  // Tools: diameter from comments near each tool change or in a tool list
  function toolTable(text) {
    const info = Core.scan(text), lines = text.split(/\r?\n/), out = {};
    const cm = l => (l.match(/\(([^)]*)\)/g) || []).map(c => c.slice(1, -1)).join(' ');
    // tool list lines like (T1 1/2 FLAT EM) anywhere
    const list = {};
    lines.forEach(l => (l.match(/\(([^)]*)\)/g) || []).forEach(c => {
      const m = c.match(/^\(\s*(?:T|TOOL\s*#?\s*)(\d+)\b\s*[-:=]?\s*(.*)\)$/i);
      if (m && !list[+m[1]]) { const p = parseToolText(m[2], info.units); if (p) list[+m[1]] = Object.assign(p, { text: c }); }
    }));
    Object.values(info.tools).filter(t => t.used).forEach(t => {
      let found = null;
      if (t.dia) found = { dia: t.dia, kind: t.probe ? 'probe' : 'tool', how: 'D=' };
      if (!found && list[t.t]) found = list[t.t];
      if (!found) {
        // comments on the tool-change line, then up to 3 lines before / 3 after
        const idx = lines.findIndex(l => new RegExp('\\bT0*' + t.t + '\\s*M0*6\\b|\\bM0*6\\s*T0*' + t.t + '\\b', 'i').test(l.replace(/\([^)]*\)/g, '')));
        if (idx >= 0) for (const k of [0, -1, 1, -2, 2, -3, 3]) {
          const l = lines[idx + k]; if (!l) continue; const c = cm(l); if (!c) continue;
          const p = parseToolText(c, info.units); if (p) { found = Object.assign(p, { text: c }); break; }
        }
      }
      out[t.t] = found ? { dia: +found.dia.toFixed(4), kind: found.kind, src: found.how || 'comment', conf: 'sure', probe: !!t.probe || found.kind === 'probe' }
        : { dia: 0.5, kind: t.probe ? 'probe' : '?', src: 'no size in program', conf: 'guess', probe: !!t.probe };
    });
    return out;
  }

  // ---------------- drawing text ----------------
  function normDrawingText(t) {
    return t.toUpperCase()
      .replace(/[Ø⌀∅ø]/g, 'Ø').replace(/[“”″]/g, '"').replace(/[×✕]/g, 'X').replace(/\u00B1|\+\/-|£/g, '±')
      .replace(/(^|[\s(])[@©®¢%&](?=\s*\.?\d)/g, '$1Ø')            // common OCR misreads of the diameter sign
      .replace(/(\d)\s*[Xx]\s*(?=[Ø.\d])/g, '$1 X ')
      .replace(/(\d),(\d{3})\b/g, '$1.$2')                            // 3,750 -> 3.750 (OCR comma)
      .replace(/[ \t]+/g, ' ');
  }
  function parseDrawing(raw, opt) {
    opt = opt || {};
    const src = opt.source || 'text'; const t = normDrawingText(raw || '');
    const out = { units: null, stock: null, part: null, thk: null, holes: [], bore: null, material: null, notes: [], numbers: [] };
    const sure = src === 'pdf' ? 'sure' : 'likely';
    // units
    if (/\b(INCH(ES)?|IN\.)\b/.test(t) && !/\bMILLIMET/.test(t)) out.units = { v: 'in', conf: 'sure', why: 'drawing says inches' };
    else if (/\bMILLIMET(ER|RE)S?\b|DIMENSIONS?\s+(ARE\s+)?IN\s+MM|\bMETRIC\b/.test(t)) out.units = { v: 'mm', conf: 'sure', why: 'drawing says millimeters' };
    // material
    let m = t.match(/\b(?:MAT(?:ERIAL|'L|L)?\.?\s*[:\-]?\s*)?((?:ALUMINUM|ALUM\.?|AL\.?)\s*-?\s*(?:6061|7075|2024|5052|6063|MIC-?6)(?:\s*-?\s*T\d+)?|(?:6061|7075|2024|5052|6063)-T\d+|(?:CRS|HRS|STEEL)\s*\d{4}|\d{4}\s*(?:STEEL|CRS|HRS)|(?:1018|1045|4140|4130|12L14|A36)(?:\s*STEEL)?|(?:303|304|316|17-4)\s*(?:SS|STAINLESS)?|STAINLESS(?:\s*STEEL)?|BRASS(?:\s*360)?|BRONZE|COPPER|DELRIN|ACETAL|UHMW|NYLON|PEEK|TITANIUM(?:\s*6AL-?4V)?|TOOL\s*STEEL|[ADO][12]\s*TOOL\s*STEEL)\b/);
    if (m) out.material = { v: m[1].replace(/\s+/g, ' ').trim(), conf: sure };
    const used = []; // character ranges consumed by labeled values
    const blankLines = (str, re) => str.split('\n').map(l => re.test(l) ? ' '.repeat(l.length) : l).join('\n');
    const tH = blankLines(t, /\bTOL|ANGLES?\b|\bSCALE\b|\bDATE\b|\bREV\b|DWG/);
    const tN = blankLines(tH, /BREAK|EDGES?\b|DEBURR|CHAMFER|UNLESS|FINISH|\bRA\b|SURFACE/);
    const mark = (mm) => used.push([mm.index, mm.index + mm[0].length]);
    // stock / blank size note
    const stockRe = new RegExp('\\b(?:STOCK|BLANK|RAW[ \\t]*(?:MAT(?:ERIAL|\'L)?)?|CUT[ \\t]*SIZE|SAW[ \\t]*CUT|BAR[ \\t]*SIZE|MAT(?:ERIAL|\'L)?[ \\t]*SIZE)[ \\t]*(?:SIZE)?[ \\t]*[:=\\-]?[ \\t]*' +
      '(Ø[ \\t]*)?' + NUM + '[ \\t]*(?:"|IN\\.?)?[ \\t]*(DIA\\.?|RD\\.?|ROUND)?[ \\t]*X[ \\t]*(Ø[ \\t]*)?' + NUM + '[ \\t]*(?:"|IN\\.?)?[ \\t]*(?:(DIA\\.?|RD\\.?)[ \\t]*)?(?:X[ \\t]*' + NUM + ')?', 'g');
    while ((m = stockRe.exec(t))) {
      const a = num(m[2]), b = num(m[5]), c = m[7] ? num(m[7]) : null;
      const round = !!(m[1] || m[3] || m[4] || m[6]);
      if (round) { const D = (m[1] || m[3]) ? a : (m[4] ? a : b), H = (m[1] || m[3]) ? b : (m[4] ? b : a); out.stock = { shape: 'round', D: m[4] || m[1] || m[3] ? a : b, H: m[4] || m[1] || m[3] ? b : a, conf: sure, raw: m[0].trim() }; }
      else if (c != null) { const d = [a, b, c].sort((x, y) => y - x); out.stock = { shape: 'rect', L: d[0], W: d[1], H: d[2], conf: sure, raw: m[0].trim() }; }
      else { out.stock = { shape: 'rect', L: Math.max(a, b), W: Math.min(a, b), H: null, conf: 'likely', raw: m[0].trim() }; }
      mark(m); break;
    }
    // thickness
    const thkA = new RegExp('\\b(?:THK|THICK(?:NESS)?)\\.?[ \\t]*[:=]?[ \\t]*' + NUM, 'g'), thkB = new RegExp(NUM + '[ \\t]*(?:"|IN\\.?)?[ \\t]*(?:THK|THICK)\\b', 'g');
    if ((m = thkA.exec(t)) || (m = thkB.exec(t))) { out.thk = { v: num(m[1]), conf: sure, raw: m[0].trim() }; mark(m); }
    // holes: 4X Ø.500 THRU | Ø.500 THRU 4 PL | Ø.500 (4X)
    const holeRe = new RegExp('(?:(\\d+)[ \\t]*X[ \\t]*)?Ø[ \\t]*' + NUM + '(?![ \\t]*°|\\d)(?:[ \\t]*(?:"|IN\\.?|MM))?(?:[ \\t]*(?:THRU|THROUGH|TH\\.?|DRILL|DP\\.?|DEEP|±[ \\t]*[\\d.]+))*(?:[ \\t]*\\(?[ \\t]*(\\d+)[ \\t]*(?:X|PL\\.?|PLCS\\.?|PLACES|HOLES)[ \\t]*\\)?)?', 'g');
    const dias = [];
    while ((m = holeRe.exec(tH))) { if (used.some(u => m.index < u[1] && m.index + m[0].length > u[0])) continue; const d = num(m[2]); if (!(d > 0)) continue; dias.push({ d, n: +(m[1] || m[3] || 1), raw: m[0].trim(), thru: /THRU|THROUGH/.test(m[0]) }); mark(m); }
    // OCR fallback: "4X 0.500 THRU" with a lost diameter sign
    const holeRe2 = new RegExp('(\\d+)[ \\t]*X[ \\t]*0?' + NUM + '[ \\t]*(?:THRU|THROUGH|DRILL)', 'g');
    while ((m = holeRe2.exec(tH))) { if (used.some(u => m.index >= u[0] && m.index < u[1])) continue; const d = num(m[2]); if (d > 0 && d < 10) { dias.push({ d, n: +m[1], raw: m[0].trim(), thru: true, ocr: true }); mark(m); } }
    // linear numbers not consumed above, skipping tolerances, dates, scales, counts, angles, revisions, part numbers
    const numRe = /(±\s*)?(?<![\d\/.\-#A-Z])(\d*\.\d{1,4}|\d{1,4})(?![\d\/]|\s*°|\s*DEG|\s*X\s*\d|\s*:\s*\d|\s*-\s*\.?\d)/g;
    const skipCtx = /(SCALE|REV|DWG|DRAWING\s*NO|PART\s*NO|P\/N|SHEET|DATE|QTY|TOL|ANGLES|SIZE\s*[A-E]\b|FSCM|CAGE|ITEM|FINISH|RA|\.XX+|±|\bOF\b|Y14|ASME|ANSI)\s*[:#.]?\s*$/;
    while ((m = numRe.exec(tN))) {
      if (m[1]) continue; const i = m.index + (m[1] ? m[1].length : 0);
      if (used.some(u => i >= u[0] && i < u[1])) continue;
      const before = t.slice(Math.max(0, i - 18), i);
      if (skipCtx.test(before) || /[±+\-]\s*$/.test(before) || /\.X+\s*$/.test(before)) continue;
      const after = t.slice(i + m[2].length, i + m[2].length + 6);
      if (/^\s*(X\b|PL|PLCS|HOLES|REQ|°|DEG|THRU)/.test(after) && !m[2].includes('.')) continue;
      const v = num(m[2]); if (!(v > 0)) continue;
      if (!m[2].includes('.') && v > 60) continue; // part numbers, years
      out.numbers.push({ v, s: m[2], dec: m[2].includes('.') });
    }
    if (!out.units) {
      const decs = out.numbers.filter(x => x.dec);
      const three = decs.filter(x => /\.\d{3,4}$/.test(x.s)).length, big = out.numbers.filter(x => x.v > 40).length;
      out.units = three >= 2 || (decs.length && big === 0) ? { v: 'in', conf: 'likely', why: '3-place decimals' } : big > 2 ? { v: 'mm', conf: 'likely', why: 'large numbers' } : { v: 'in', conf: 'guess', why: 'default' };
    }
    // overall part size: biggest linear dimensions (prefer decimals)
    const lin = out.numbers.filter(x => x.dec || out.units.v === 'mm').map(x => x.v).filter(v => v < (out.units.v === 'mm' ? 1500 : 60));
    const uniq = [...new Set(lin.map(v => +v.toFixed(4)))].sort((a, b) => b - a);
    const stockVals = out.stock ? [out.stock.L, out.stock.W, out.stock.H, out.stock.D].filter(Boolean) : [];
    const cand = uniq.filter(v => !stockVals.some(sv => Math.abs(sv - v) < 1e-6) && !(out.thk && Math.abs(out.thk.v - v) < 1e-6));
    const bigDia = dias.slice().sort((a, b) => b.d - a.d)[0];
    if (bigDia && (cand.length === 0 || bigDia.d >= cand[0] * 0.95) && bigDia.n === 1) {
      out.part = { shape: 'round', D: bigDia.d, conf: 'likely', raw: bigDia.raw };
      out.holes = dias.filter(d => d !== bigDia);
      const inner = out.holes.filter(d => d.n === 1).sort((a, b) => b.d - a.d)[0];
      if (inner && inner.d > 0.15 * bigDia.d) { out.bore = { d: inner.d, conf: 'likely', raw: inner.raw }; out.holes = out.holes.filter(d => d !== inner); }
    } else {
      out.holes = dias;
      if (cand.length >= 2) out.part = { shape: 'rect', L: cand[0], W: cand[1], conf: cand.length >= 3 ? 'likely' : 'guess' };
      else if (cand.length === 1) out.part = { shape: 'rect', L: cand[0], W: null, conf: 'guess' };
    }
    // OCR often reads the Ø sign as a 2, 3, 8, 0...: "4X 2.500 THRU" on a 3.75 x 2.75 plate can't be right
    const small = out.part && out.part.shape === 'rect' && out.part.W ? out.part.W : out.stock && out.stock.shape === 'rect' ? out.stock.W : null;
    out.holes.forEach(h => {
      const mm = h.ocr && /X[ \t]*([023689])(\.\d{2,4})/.exec(h.raw);
      if (mm && small && h.n > 1 && h.d > 0.4 * small) { h.d = num(mm[2]); h.fixed = true; }
    });
    out.holes = out.holes.map(h => ({ d: h.d, n: h.n, conf: h.fixed ? 'guess' : h.ocr ? 'likely' : sure, raw: h.raw }));
    if (out.units.v === 'mm') out.notes.push('Drawing is in millimeters.');
    return out;
  }

  // ---------------- program analysis ----------------
  function analyzeProgram(text, tools) {
    const info = Core.scan(text);
    const big = { stock: { shape: 'rect', length: 200, width: 200, height: 1, topAbove: 0, xyZero: 'center', zZero: 'top' }, hold: { type: 'none' }, machine: {}, tools: tools || {}, wcs: {} };
    const r = Core.check(text, big);
    let below = 0, above = 0, minZ = Infinity, maxCutZ = -Infinity;
    const cutPts = [], faceZ = []; let wentDeep = false;
    for (const p of r.paths) {
      if (p.kind !== 'feed' || p.probe) continue;
      for (let i = 1; i < p.pts.length; i++) {
        const a = p.pts[i - 1], b = p.pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (b[2] < 0.001) below += len; else above += len;
        if (b[2] < minZ) minZ = b[2];
        // facing above Z0 only counts when it comes before any cut below Z0 (facing is done first)
        if (!wentDeep && Math.abs(b[2] - a[2]) < 1e-5 && Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.25) faceZ.push(b[2]);
        if (b[2] < -0.001) wentDeep = true;
      }
    }
    const zZero = below >= above || minZ < -0.05 ? 'top' : 'bottom';
    const topGuess = zZero === 'top' ? 0 : null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of r.paths) {
      if (p.kind !== 'feed' || p.probe) continue;
      for (let i = 0; i < p.pts.length; i++) {
        const q = p.pts[i]; if (zZero === 'top' && q[2] > 0.05) continue;
        cutPts.push([q[0], q[1], q[2], p.tool, p.lns[i]]);
        if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
        if (q[2] > maxCutZ) maxCutZ = q[2];
      }
    }
    const has = cutPts.length > 0;
    const sx = x1 - x0, sy = y1 - y0;
    let xyZero = 'center', xyWhy = 'toolpath is centered on X0 Y0';
    if (has) {
      const cx = Math.abs(x0 + x1) <= 0.3 * sx + 0.05, cy = Math.abs(y0 + y1) <= 0.3 * sy + 0.05;
      const xs = x0 >= -0.15 * sx - 0.3 ? 'left' : x1 <= 0.15 * sx + 0.3 ? 'right' : null;
      const ys = y0 >= -0.15 * sy - 0.3 ? 'front' : y1 <= 0.15 * sy + 0.3 ? 'back' : null;
      if (cx && cy) { xyZero = 'center'; }
      else if (xs && ys) { xyZero = ys + '-' + xs; xyWhy = 'toolpath stays ' + (xs === 'left' ? '+X' : '−X') + ' ' + (ys === 'front' ? '+Y' : '−Y') + ' of zero'; }
      else { xyZero = 'center'; xyWhy = 'toolpath is not clearly centered or at a corner; assumed center'; }
    }
    // roundness of the cut region (for program-only blank guess)
    let round = false;
    if (has && Math.abs(sx - sy) < 0.12 * Math.max(sx, sy)) {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.max(sx, sy) / 2; let corner = 0;
      for (const q of cutPts) if (Math.hypot(q[0] - cx, q[1] - cy) > R * 1.02) corner++;
      round = corner < 0.01 * cutPts.length && cutPts.some(q => Math.hypot(q[0] - cx, q[1] - cy) > 0.9 * R);
    }
    const facePos = faceZ.filter(z => z > 0.0005 && z < 0.3);
    const topAbove = zZero === 'top' && facePos.length ? Math.max(...facePos) : 0;
    const depth = zZero === 'top' ? -Math.min(0, minZ) : null;
    return { info, zZero, xyZero, xyWhy, ext: has ? { x0, x1, y0, y1, sx, sy } : null, minZ, depth, topAbove, round, cutPts, units: info.units };
  }

  // blank height when there is no side photo
  function heightGuess(dr, prog) {
    if (dr && dr.stock && dr.stock.H) return { h: dr.stock.H, src: 'drawing stock note' };
    if (dr && dr.thk) return { h: dr.thk.v + ((prog && prog.topAbove) || 0) + 0.06, src: 'drawing thickness + facing stock + 0.06' };
    const deep = (prog && prog.depth) || 0;
    return { h: Math.max(0.5, Math.ceil((deep + 0.35) * 8) / 8), src: 'deepest cut + clamping (guess)' };
  }
  // ---------------- build the setup ----------------
  // inputs: {text, photo:{shape,L,W,D,B,H,hSrc}, drawing (parseDrawing output), saved:{machine}}
  function buildSetup(inp) {
    const tools = toolTable(inp.text);
    const prog = analyzeProgram(inp.text, tools);
    const dr = inp.drawing || null, ph = inp.photo || null;
    const A = []; // assumptions shown to the user
    const add = (key, label, value, src, conf) => A.push({ key, label, value, src, conf });
    const f3 = v => (+v).toFixed(3);
    let shape, L, W, D, B = 0, H, hSrc, dimSrc, conf;
    const ex = prog.ext;
    if (ph && (ph.shape === 'rect' ? ph.L : ph.D)) {
      shape = ph.shape; L = ph.L; W = ph.W; D = ph.D; B = ph.B || 0; dimSrc = 'blank photo'; conf = 'likely';
    } else if (dr && dr.stock) {
      shape = dr.stock.shape; L = dr.stock.L; W = dr.stock.W; D = dr.stock.D; dimSrc = 'drawing stock note'; conf = dr.stock.conf;
    } else if (dr && dr.part && (dr.part.shape === 'round' ? dr.part.D : dr.part.L && dr.part.W)) {
      shape = dr.part.shape; L = dr.part.L && dr.part.L + 0.25; W = dr.part.W && dr.part.W + 0.25; D = dr.part.D && dr.part.D + 0.25; B = dr.bore ? Math.max(0, dr.bore.d - 0.25) : 0;
      dimSrc = 'drawing part size + 0.125 per side'; conf = 'guess';
    } else if (ex) {
      const m = 0.25;
      if (prog.round) { shape = 'round'; D = Math.max(ex.sx, ex.sy) + m; } else { shape = 'rect'; L = Math.max(ex.sx, ex.sy) + m; W = Math.min(ex.sx, ex.sy) + m; }
      dimSrc = 'toolpath size + margin (no photo or drawing)'; conf = 'guess';
    } else { shape = 'rect'; L = 4; W = 4; dimSrc = 'default'; conf = 'guess'; }
    // height
    const deep = prog.depth || 0;
    if (ph && ph.H) { H = ph.H; hSrc = ph.hSrc || 'side photo'; }
    else { const g = heightGuess(dr, prog); H = g.h; hSrc = g.src; }
    // orientation: long side of the blank along the axis where the toolpath is longer
    let longX = true; if (ex && shape === 'rect') longX = ex.sx >= ex.sy * 0.98;
    const len = shape === 'rect' ? (longX ? Math.max(L, W) : Math.min(L, W)) : D, wid = shape === 'rect' ? (longX ? Math.min(L, W) : Math.max(L, W)) : D;
    const xyZero = shape === 'round' ? 'center' : prog.xyZero;
    const zZero = prog.zZero;
    const topAbove = zZero === 'top' ? prog.topAbove : 0;
    // workholding
    const holdType = shape === 'round' ? 'chuck' : (longX ? 'vise-y' : 'vise-x');
    const deepest = zZero === 'top' ? deep + topAbove : 0;
    // deepest cut close to where the jaws are (holes in the middle don't limit the grip)
    let cutDepth = 0;
    if (zZero === 'top') {
      const bx = { center: [-len / 2, len / 2, -wid / 2, wid / 2], 'front-left': [0, len, 0, wid], 'front-right': [-len, 0, 0, wid], 'back-left': [0, len, -wid, 0], 'back-right': [-len, 0, -wid, 0] }[xyZero];
      for (const q of prog.cutPts) {
        const r = ((tools[q[3]] || {}).dia || 0.5) / 2; let near;
        if (shape === 'round') near = Math.hypot(q[0], q[1]) + r > D / 2 - 0.1;
        else if (holdType === 'vise-y') near = q[1] - r < bx[2] + 0.1 || q[1] + r > bx[3] - 0.1;
        else near = q[0] - r < bx[0] + 0.1 || q[0] + r > bx[1] - 0.1;
        if (near && topAbove - q[2] > cutDepth) cutDepth = topAbove - q[2];
      }
    }
    let grip = Math.max(0.125, Math.min(0.5, H - cutDepth - 0.1));
    if (!isFinite(grip)) grip = 0.25;
    const saved = (inp.saved && inp.saved.machine) || { x: 42, y: 24, z: 24 };
    const setup = {
      stock: { shape, length: len, width: wid, dia: D, bore: B, height: H, topAbove, xyZero, zZero },
      hold: { type: holdType, grip: +grip.toFixed(3), thick: 1.0, jawLen: shape === 'round' ? 0 : 6, below: shape === 'round' ? 0 : (deepest > H - 0.001 ? 0.25 : 0) },
      machine: { x: saved.x, y: saved.y, z: saved.z }, wcs: {}, tools: {}, autoLength: false
    };
    prog.info.wcs.forEach(w => { setup.wcs[w] = { x: 0, y: 0, z: 0 }; });
    Object.entries(tools).forEach(([t, v]) => { setup.tools[t] = { dia: v.dia, probe: v.probe }; });
    // assumptions list
    add('blank', 'Blank', shape === 'round' ? 'Ø' + f3(D) + (B ? ' with Ø' + f3(B) + ' hole' : '') + ' × ' + f3(H) + ' tall' : f3(len) + ' X × ' + f3(wid) + ' Y × ' + f3(H) + ' tall', dimSrc + (hSrc ? '; height from ' + hSrc : ''), conf);
    if (shape === 'rect') add('orient', 'Blank direction', 'long side along ' + (longX ? 'X' : 'Y'), ex ? 'toolpath is longer in ' + (longX ? 'X' : 'Y') : 'default', ex ? 'likely' : 'guess');
    add('xy', 'Program X0 Y0', { center: 'center of the blank', 'front-left': 'front-left corner', 'front-right': 'front-right corner', 'back-left': 'back-left corner', 'back-right': 'back-right corner' }[xyZero], shape === 'round' ? 'round blank' : prog.xyWhy, 'likely');
    add('z', 'Program Z0', zZero === 'top' ? 'top of the blank' : 'bottom of the blank', zZero === 'top' ? 'cuts go below Z0' : 'cuts stay above Z0', 'likely');
    add('face', 'Facing stock above Z0', f3(topAbove), topAbove ? 'first face pass at Z' + f3(topAbove) : 'no face pass above Z0 found', 'likely');
    add('hold', 'Held in', holdType === 'chuck' ? 'chuck / round jaws, ' + f3(grip) + ' of the blank in the jaws' : 'vise, jaws on ' + (holdType === 'vise-y' ? 'front & back' : 'left & right') + ' (long sides), ' + f3(grip) + ' in the jaws',
      'blank height ' + f3(H) + ' − deepest cut near the jaws ' + f3(cutDepth) + ' − 0.1 clearance, kept between 0.125 and 0.5', 'guess');
    if (setup.hold.below) add('below', 'Under the blank', 'parallels, ' + f3(setup.hold.below) + ' clearance', 'the program cuts through the bottom of the blank', 'guess');
    const wl = Object.keys(setup.wcs); if (wl.length > 1) add('wcs', 'Work offsets', wl.join(', ') + ' all at the same zero', 'no way to know them from the program', 'guess');
    const tl = Object.entries(tools).filter(([t, v]) => !v.probe).map(([t, v]) => 'T' + t + ' ' + f3(v.dia) + (v.conf === 'guess' ? '?' : ''));
    if (tl.length) add('tools', 'Tool sizes', tl.join(', '), Object.values(tools).some(v => v.conf === 'guess') ? '? = no size in the program, 0.500 assumed' : 'from tool comments', Object.values(tools).some(v => v.conf === 'guess') ? 'guess' : 'sure');
    add('machine', 'Machine travel', saved.x + ' × ' + saved.y + ' × ' + saved.z, 'Hurco VMX42T', 'sure');
    add('len', 'Tool length at M06', 'not automatic (G43 needed)', 'Fanuc-style default', 'likely');
    return { setup, assumptions: A, tools, prog, longX };
  }

  // ---------------- cross-checks ----------------
  function crossCheck(result, ctx) {
    const issues = [], s = ctx.setup.stock, dr = ctx.drawing, ph = ctx.photo, prog = ctx.prog;
    const f3 = v => (+v).toFixed(3);
    const push = (sev, msg, lines, pts) => issues.push({ sev, line: lines && lines[0] || 0, lines: lines || [0], text: '', msg, pts: pts || [], afterEnd: false, kind: 'setup' });
    const blank = s.shape === 'round' ? [s.dia, s.dia, s.height] : [Math.max(s.length, s.width), Math.min(s.length, s.width), s.height];
    if (dr && dr.units && prog && dr.units.v !== (prog.units === 'mm' ? 'mm' : 'in') && dr.units.conf === 'sure') push('CHECK', 'The drawing is in ' + (dr.units.v === 'mm' ? 'millimeters' : 'inches') + ' but the program is in ' + (prog.units === 'mm' ? 'mm (G21)' : 'inches (G20)') + '. Make sure the sizes line up.');
    if (dr && dr.part) {
      const p = dr.part;
      const pd = p.shape === 'round' ? [p.D, p.D] : [p.L, p.W].filter(Boolean).sort((a, b) => b - a);
      const big = pd.some((v, i) => v > blank[i] + 0.005), thkBig = dr.thk && dr.thk.v > blank[2] + 0.005;
      if (big || thkBig) push('CHECK', 'The finished part on the drawing (' + (p.shape === 'round' ? 'Ø' + f3(p.D) : pd.map(f3).join(' × ')) + (dr.thk ? ' × ' + f3(dr.thk.v) + ' thick' : '') + ') is bigger than the blank (' + blank.map(f3).join(' × ') + '). Wrong blank, or the photo/drawing was misread.');
      if (p.shape && s.shape && p.shape !== s.shape && ph) push('INFO', 'The drawing looks like a ' + (p.shape === 'round' ? 'round' : 'rectangular') + ' part but the blank in the photo is ' + (s.shape === 'round' ? 'round' : 'rectangular') + '.');
    }
    if (dr && dr.stock && ph) {
      const st = dr.stock, sd = st.shape === 'round' ? [st.D, st.D, st.H] : [st.L, st.W, st.H];
      const diff = sd.map((v, i) => v ? Math.abs(v - blank[i]) : 0);
      if (diff.some(d => d > 0.06)) push('INFO', 'Drawing stock note says ' + st.raw + '; the photos measured ' + blank.map(f3).join(' × ') + '. Using the photo sizes.');
    }
    // toolpath vs blank footprint
    if (prog && prog.cutPts.length && result && result.stock) {
      const st = result.stock; let worst = 0, wl = [], wp = null;
      for (const q of prog.cutPts) {
        if (q[2] > st.top - 0.001) continue;
        const r = ((ctx.setup.tools[q[3]] || {}).dia || 0.5) / 2;
        let out;
        if (st.shape === 'round') out = Math.hypot(q[0] - st.cx, q[1] - st.cy) - st.r - r;
        else out = Math.max(st.x0 - q[0], q[0] - st.x1, st.y0 - q[1], q[1] - st.y1) - r;
        if (out > 0.05) { if (out > worst) { worst = out; wp = [q[0], q[1], q[2]]; } if (wl.length < 50 && !wl.includes(q[4])) wl.push(q[4]); }
      }
      if (worst > 0.5) {
        push(worst > 1.0 ? 'CHECK' : 'INFO', 'Cutting moves reach ' + f3(worst) + ' in past the edge of the blank (beyond the tool radius). Either the zero is not where I assumed, the blank is a different size, or the program cuts air there.', wl.sort((a, b) => a - b), wp ? [wp] : []);
      }
    }
    return issues;
  }

  const api = { heightGuess, parseToolText, toolTable, parseDrawing, normDrawingText, analyzeProgram, buildSetup, crossCheck, NUMBER_DRILL, LETTER_DRILL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CNCAuto = api;
})(this);
