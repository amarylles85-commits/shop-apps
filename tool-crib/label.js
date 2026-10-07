// Tool Crib — label / package text parser. Pure logic (browser: window.LabelRead, node: module.exports).
// parse(ocrText, codes) -> { fields: {key: [{v, show, conf}]}, tool: {...prefill}, name }
(function (root) {
  'use strict';
  const C = root.Crib || (typeof require !== 'undefined' ? require('./crib.js') : null);

  // canonical vendor, [match words]; short (<=3 letter) keys must match a whole word exactly
  const VENDORS = [
    ['Harvey Tool', ['HARVEY', 'HARVEYTOOL']], ['Helical Solutions', ['HELICAL']], ['Kennametal', ['KENNAMETAL', 'KENNA']], ['Sandvik Coromant', ['SANDVIK', 'COROMANT']],
    ['Iscar', ['ISCAR']], ['OSG', ['OSG']], ['Guhring', ['GUHRING', 'GÜHRING', 'GUEHRING']], ['YG-1', ['YG-1', 'YG1']], ['Niagara Cutter', ['NIAGARA']],
    ['Kyocera SGS', ['SGS', 'KYOCERA']], ['Garr Tool', ['GARR']], ['Melin Tool', ['MELIN']], ['Emuge', ['EMUGE']], ['Nachi', ['NACHI']], ['Titan USA', ['TITAN']],
    ['Accupro', ['ACCUPRO']], ['Lakeshore Carbide', ['LAKESHORE']], ['Seco', ['SECO']], ['Mitsubishi Materials', ['MITSUBISHI']], ['Walter', ['WALTER']],
    ['Dormer Pramet', ['DORMER', 'PRAMET']], ['Widia', ['WIDIA']], ['Kodiak Cutting Tools', ['KODIAK']], ['Destiny Tool', ['DESTINY']], ['Data Flute', ['DATAFLUTE', 'DATA FLUTE']],
    ['Hertel', ['HERTEL']], ['Precision Twist Drill', ['PTD', 'PRECISION TWIST']], ['Chicago-Latrobe', ['LATROBE']], ['Cleveland', ['CLEVELAND']], ['Greenfield', ['GREENFIELD']],
    ['Hannibal Carbide', ['HANNIBAL']], ['M.A. Ford', ['MAFORD', 'MA FORD', 'M.A. FORD']], ['Allied Machine', ['ALLIED']], ['Tungaloy', ['TUNGALOY']], ['Korloy', ['KORLOY']],
    ['TaeguTec', ['TAEGUTEC']], ['Ingersoll', ['INGERSOLL']], ['Lyndex-Nikken', ['LYNDEX', 'NIKKEN']], ['Techniks', ['TECHNIKS']], ['Maritool', ['MARITOOL']],
    ['Haimer', ['HAIMER']], ['BIG Kaiser', ['KAISER', 'BIG DAISHOWA', 'DAISHOWA']], ['Rego-Fix', ['REGO-FIX', 'REGOFIX']], ['MSC Industrial', ['MSC']], ['Travers Tool', ['TRAVERS']],
    ['Grainger', ['GRAINGER']], ['Yamawa', ['YAMAWA']], ['Vermont American', ['VERMONT']], ['Fullerton Tool', ['FULLERTON']], ['SC Tool', ['SCTOOL']], ['Union Butterfly', ['BUTTERFLY']],
    ['Dapra', ['DAPRA']], ['Ceratizit', ['CERATIZIT']], ['Mapal', ['MAPAL']], ['Kyocera', ['KYOCERA UNIMERCO']], ['Micro 100', ['MICRO 100', 'MICRO100']], ['Onsrud', ['ONSRUD']],
    ['Monster Tool', ['MONSTER']], ['IMCO', ['IMCO']], ['Regal Cutting Tools', ['REGAL']], ['Morse Cutting Tools', ['MORSE']], ['Triumph Twist Drill', ['TRIUMPH']]
  ];
  const DOMAINS = { harveytool: 'Harvey Tool', helicaltool: 'Helical Solutions', kennametal: 'Kennametal', sandvik: 'Sandvik Coromant', iscar: 'Iscar', osgtool: 'OSG', osg: 'OSG', guhring: 'Guhring', yg1: 'YG-1', niagaracutter: 'Niagara Cutter', kyocera: 'Kyocera SGS', garrtool: 'Garr Tool', melintool: 'Melin Tool', emuge: 'Emuge', nachiamerica: 'Nachi', titanusa: 'Titan USA', lakeshorecarbide: 'Lakeshore Carbide', secotools: 'Seco', mmc: 'Mitsubishi Materials', walter: 'Walter', mscdirect: 'MSC Industrial', widia: 'Widia', tungaloy: 'Tungaloy', allied: 'Allied Machine' };

  const lev = (a, b) => { if (Math.abs(a.length - b.length) > 1) return 9; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };

  const INCH = '(\\d+\\s?-\\s?\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+)';
  const DIM_RE = new RegExp(INCH + '\\s*(MM\\b|"|IN\\b|INCH(?:ES)?\\b)?', 'g');
  const DEN = new Set([2, 4, 8, 16, 32, 64]);

  function clean(t) {
    return String(t || '').replace(/[”″“]|''/g, '"').replace(/[’‘`´]/g, "'").replace(/[—–]/g, '-').replace(/[Ø⌀∅]/g, ' DIA ').toUpperCase();
  }
  function fixNum(s) { return s.replace(/\s+/g, '').replace(/^(\d+)-(\d+\/\d+)$/, '$1-$2'); }
  function inchVal(s) {
    s = fixNum(s); let m;
    if ((m = s.match(/^(\d+)-(\d+)\/(\d+)$/))) return +m[1] + m[2] / m[3];
    if ((m = s.match(/^(\d+)\/(\d+)$/))) return m[1] / m[2];
    return parseFloat(s);
  }
  function fmtLen(s, mm) { s = fixNum(s); return mm ? s + 'mm' : s + '"'; }

  function add(F, key, v, show, conf, why) {
    const L = F[key] || (F[key] = []); const k = String(v).toUpperCase();
    const ex = L.find(c => String(c.v).toUpperCase() === k);
    const rank = { sure: 3, likely: 2, guess: 1 };
    if (ex) { if (rank[conf] > rank[ex.conf]) { ex.conf = conf; ex.why = why; } return; }
    L.push({ v, show: show == null ? String(v) : show, conf, why });
  }

  function parse(text, codes) {
    codes = codes || [];
    const F = {};
    let lines = clean(text).split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // QR / barcode text that is not just a number is label text too
    for (const c of codes) {
      const t = String(c.text || '').trim(); if (!t) continue;
      const url = t.match(/^https?:\/\/(?:www\.)?([a-z0-9-]+)\.[a-z.]+(\/[^?#]*)?/i);
      if (url) { const v = DOMAINS[url[1].toLowerCase().replace(/-/g, '')]; if (v) add(F, 'vendor', v, v, 'likely', 'web address in the code');
        const seg = (url[2] || '').split('/').filter(Boolean).pop(); if (seg && /\d/.test(seg) && seg.length <= 24) add(F, 'pn', seg.toUpperCase(), null, 'guess', 'end of the web address'); continue; }
      if (/[A-Z]{2,}/i.test(t) && /\s/.test(t)) lines.push(clean(t));
    }
    const all = lines.join('\n'), flat = ' ' + lines.join(' | ') + ' ';

    // ---- vendor
    const words = flat.replace(/[^A-Z0-9\-]+/g, ' ').split(' ').filter(Boolean);
    for (const [name, keys] of VENDORS) {
      for (const k of keys) {
        if (k.includes(' ')) { if (flat.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').includes(k.replace(/[^A-Z0-9 ]/g, ''))) add(F, 'vendor', name, name, 'sure', 'name on label'); continue; }
        if (words.includes(k)) { add(F, 'vendor', name, name, 'sure', 'name on label'); continue; }
        if (k.length >= 5 && words.some(w => w.length >= 4 && lev(w, k) === 1)) add(F, 'vendor', name, name, 'likely', 'close to "' + k + '"');
      }
    }

    // ---- insert ISO designation (+ grade)
    let insert = null;
    const ISO = /\b([ABCDEHKLMORSTVW][ABCDEFGNOP][ACEFGHJKLMNU][ABCGHJMNQRTUWX])\s?-?(\d{3,6})([A-Z]{0,4}(?:-[A-Z0-9]{1,6})?)/;
    for (const l of lines) {
      const m = l.match(ISO); if (!m || /^(EDP|CAT|ITEM)$/.test(m[1])) continue;
      insert = { code: m[1] + ' ' + m[2] + (m[3] || ''), short: m[1] + ' ' + m[2] };
      const g = l.slice(l.indexOf(m[0]) + m[0].length).match(/\b([A-Z]{1,4}\d{2,4}[A-Z]?)\b/); if (g && !/^(QTY|PCS|EDP)/.test(g[1])) insert.grade = g[1].replace(/^1I\(?/, 'I').replace(/^I\(/, 'IC');
      break;
    }
    if (insert) { add(F, 'type', 'Insert', 'Insert', 'sure', insert.short); add(F, 'insert', insert.code, insert.code, 'sure', 'ISO insert code'); if (insert.grade) add(F, 'grade', insert.grade, 'Grade ' + insert.grade, 'likely', 'after the insert code'); }

    // ---- part / EDP number
    const PNL = /\b(EDP|E\.D\.P\.?|CAT(?:ALOG)?\.?\s?(?:NO|#|NUMBER)?\.?|ITEM\s?(?:NO|#)?\.?|PART\s?(?:NO|#|NUMBER)\.?|P\/N|PN|ORDER\s?(?:NO|#)\.?|ART(?:ICLE)?\.?\s?(?:NO|#)?\.?|SKU|MODEL|REF\.?|MSC\s?#?)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-.\/]{2,22})/g;
    let m;
    for (const l of lines) { PNL.lastIndex = 0; while ((m = PNL.exec(l))) { const v = m[2].replace(/[.\-\/]+$/, ''); if (/\d/.test(v) && !/^\d{12,13}$/.test(v)) add(F, 'pn', v, v, 'sure', m[1].trim() + ' on label'); } }
    for (const c of codes) {
      const t = String(c.text || '').trim(), fmt = String(c.format || '').toUpperCase();
      if (/EAN|UPC/.test(fmt) || /^\d{12,14}$/.test(t)) continue;
      const tok = t.split(/\s+/).filter(x => /\d/.test(x) && x.length >= 4 && x.length <= 24);
      for (const x of tok) add(F, 'pn', x.toUpperCase(), null, F.pn && F.pn.some(p => p.v === x.toUpperCase()) ? 'sure' : 'likely', 'barcode');
    }
    if (!F.pn && !insert) for (const w of words) if (/^\d{5,10}(-[A-Z0-9]{1,4})?$/.test(w) && !/^\d{12,13}$/.test(w)) { add(F, 'pn', w, w, 'guess', 'number on label'); }
    if (insert && !(F.pn && F.pn.some(p => p.conf === 'sure'))) add(F, 'pn', insert.code, insert.code, 'likely', 'insert code');

    // ---- lengths, radius (labeled numbers) — mark their spans so they are not taken as diameter
    const typeLine = /END ?MILL|DRILL|REAMER|TAP\b|CHAMFER|SPOT|COUNTERSINK|MILL\b|CUTTER|BALL|FLUTE|\bFL\b/;
    const used = [];  // [lineIdx, start, end]
    const LAB = [
      ['loc', /\b(LOC|L\.O\.C\.?|LENGTH OF CUT|CUT(?:TING)? LENGTH|FLUTE LENGTH|FL\.? LEN(?:GTH)?)\s*[:=]?\s*/],
      ['oal', /\b([O0]\.?A\.?L\.?|OVERALL(?: LENGTH)?|O\/A LENGTH|LENGTH|LEN)\s*[:=]?\s*/],
      ['shank', /\b(SHANK(?: DIA(?:METER)?)?|SHK\.?|SH\.? DIA)\s*[:=]?\s*/],
      ['cr', /\b(CORNER RADIUS|CORNER RAD\.?|C\.?R\.?|RADIUS|RAD\.?)\s*[:=]?\s*/],
      ['reach', /\b(REACH|NECK(?: LENGTH)?|LBS)\s*[:=]?\s*/],
      ['dia', /\b(DIA(?:METER)?\.?|CUTTING DIA\.?|D1?\s?=)\s*[:=]?\s*/]
    ];
    lines.forEach((l, li) => {
      for (const [key, re] of LAB) {
        const g = new RegExp(re.source + INCH + '\\s*(MM\\b|"|IN\\b)?', 'g'); let mm;
        while ((mm = g.exec(l))) {
          const raw = fixNum(mm[2]), isMM = !!(mm[3] && mm[3].startsWith('MM')), v = inchVal(raw); if (!(v > 0)) continue;
          used.push([li, mm.index, mm.index + mm[0].length]);
          if (key === 'dia') { add(F, 'dia', isMM ? raw + 'mm' : raw, fmtLen(raw, isMM), 'sure', 'labeled diameter'); continue; }
          if (key === 'cr') { add(F, 'cr', isMM ? raw + 'mm' : raw, 'CR ' + fmtLen(raw, isMM), /CORNER/.test(mm[1]) ? 'sure' : 'likely', 'corner radius'); continue; }
          add(F, key, raw + (isMM ? 'mm' : ''), fmtLen(raw, isMM), 'sure', key.toUpperCase() + ' on label');
        }
      }
    });
    const isUsed = (li, a, b) => used.some(u => u[0] === li && a < u[2] && b > u[1]);
    // suffix labels: 1-1/4" LOC, 3" OAL, 1/2 SHANK ; and D x LOC x OAL strings
    lines.forEach((l, li) => {
      const g = new RegExp(INCH + '\\s*(MM\\b|"|IN\\b)?\\s*(LOC|OAL|O\\.A\\.L\\.?|SHANK|SHK|REACH|LENGTH OF CUT)\\b', 'g'); let mm;
      while ((mm = g.exec(l))) {
        if (isUsed(li, mm.index, mm.index + mm[0].length)) continue;
        const raw = fixNum(mm[1]), isMM = !!(mm[2] && mm[2].startsWith('MM')), key = /^O/.test(mm[3]) ? 'oal' : /^SH/.test(mm[3]) ? 'shank' : mm[3] === 'REACH' ? 'reach' : 'loc';
        if (!(inchVal(raw) > 0)) continue; used.push([li, mm.index, mm.index + mm[0].length]); add(F, key, raw + (isMM ? 'mm' : ''), fmtLen(raw, isMM), 'sure', key.toUpperCase() + ' on label');
      }
      const X = new RegExp(INCH + '\\s*"?\\s*[X×]\\s*' + INCH + '\\s*"?(?:\\s*[X×]\\s*' + INCH + '\\s*"?)?', 'g');
      while ((mm = X.exec(l))) {
        if (isUsed(li, mm.index, mm.index + mm[0].length) || /M\s?$/.test(l.slice(0, mm.index))) continue;
        const a = fixNum(mm[1]), b = fixNum(mm[2]), c = mm[3] && fixNum(mm[3]); if (!(inchVal(a) > 0 && inchVal(b) > inchVal(a) && inchVal(a) <= 6)) continue;
        used.push([li, mm.index, mm.index + mm[0].length]);
        add(F, 'dia', a, a + '"', typeLine.test(l) ? 'sure' : 'likely', 'D × L size');
        if (c) { add(F, 'loc', b, b + '"', 'likely', 'D × LOC × OAL'); add(F, 'oal', c, c + '"', 'likely', 'D × LOC × OAL'); } else add(F, 'oal', b, b + '"', 'guess', 'D × L');
      }
    });

    // ---- taps
    const TAPRE = /(#\s?\d{1,2}|\d+\/\d+|\d*\.\d+|\d+)\s?-\s?(\d{2,3})(?![\d\/])(\s?(?:UNC|UNF|UNEF|NC|NF|UN|NPT|NPTF))?/g;
    const METRIC_TAP = /\bM\s?(\d{1,2}(?:\.\d)?)\s?[X×]\s?(\d?\.\d{1,2}|\d)\b/g;
    lines.forEach((l, li) => {
      let t; TAPRE.lastIndex = 0;
      while ((t = TAPRE.exec(l))) {
        if (isUsed(li, t.index, t.index + t[0].length)) continue;
        const raw = t[1].replace(/\s/g, '') + '-' + t[2], pd = C && C.parseDia(raw + (t[3] || ''));
        if (pd && pd.kind === 'tap' && +t[2] >= 4 && +t[2] <= 80) { add(F, 'dia', raw, raw + (t[3] ? ' ' + t[3].trim() : ''), /TAP|UN|NPT/.test(l) ? 'sure' : 'likely', 'thread size'); used.push([li, t.index, t.index + t[0].length]); }
      }
      METRIC_TAP.lastIndex = 0;
      while ((t = METRIC_TAP.exec(l))) { add(F, 'dia', 'M' + t[1] + 'x' + t[2], 'M' + t[1] + '×' + t[2], 'sure', 'metric thread'); used.push([li, t.index, t.index + t[0].length]); }
    });

    // ---- drills by number / letter
    lines.forEach((l, li) => {
      let t; const nd = /#\s?(\d{1,2})\b(?!\s?-\s?\d)/g;
      while ((t = nd.exec(l))) if (C && C.NUMBER_DRILL[+t[1]] && !isUsed(li, t.index, t.index + t[0].length)) { add(F, 'dia', '#' + (+t[1]), '#' + (+t[1]) + ' drill', /DRILL|DR\b|JOBBER/.test(l) ? 'sure' : 'likely', 'number drill'); used.push([li, t.index, t.index + t[0].length]); }
      const ld = /\b(?:LETTER|LTR\.?)\s?([A-Z])\b|\b([A-Z])\s(?:DRILL|JOBBER)\b/g;
      while ((t = ld.exec(l))) { const L = t[1] || t[2]; if (C && C.LETTER_DRILL[L] && !/^[AI]$/.test(t[2] || '')) add(F, 'dia', L, 'Letter ' + L + ' drill', t[1] ? 'sure' : 'likely', 'letter drill'); }
    });

    // ---- remaining sizes (first plain inch / mm dimension wins)
    lines.forEach((l, li) => {
      let d; DIM_RE.lastIndex = 0;
      while ((d = DIM_RE.exec(l))) {
        const a = d.index, b = a + d[0].length; if (isUsed(li, a, b)) continue;
        const raw = fixNum(d[1]), unit = d[2] || '', v = inchVal(raw); if (!(v > 0)) continue;
        const after = l.slice(b, b + 6), before = l.slice(Math.max(0, a - 1), a);
        if (/^\s?(-?\s?FL|FLUTES?|DEG|°|PCS|PC\b|PK|X\b)/.test(after) || /[A-Z0-9#\/.-]/.test(before)) continue;
        const isMM = unit.startsWith('MM'), fr = raw.match(/\/(\d+)$/);
        if (isMM) { if (v >= 0.1 && v <= 80) add(F, 'dia', raw + 'mm', raw + 'mm', typeLine.test(l) ? 'likely' : 'guess', 'size in mm'); continue; }
        const inchy = unit === '"' || unit.startsWith('IN') || (fr && DEN.has(+fr[1]));
        if (inchy && v > 0 && v <= 6) add(F, 'dia', raw, raw + '"', typeLine.test(l) ? 'sure' : 'likely', 'size on label');
        else if (/^\.\d{3,4}$/.test(raw) && v <= 2) add(F, 'dia', raw, raw + '"', 'guess', 'decimal size');
      }
    });

    // ---- flutes
    const FW = { TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6 };
    { let f; const fr = /\b(\d{1,2}|TWO|THREE|FOUR|FIVE|SIX)\s?-?\s?(?:FL|FLT|FLUTES?|FLUTED)\b/g;
      while ((f = fr.exec(flat))) { const n = FW[f[1]] || +f[1]; if (n >= 1 && n <= 16) add(F, 'flutes', n, n + ' flute' + (n > 1 ? 's' : ''), 'sure', 'flutes on label'); } }

    // ---- coating / material
    const COAT = [['TiAlN', /\bT[I1L][A4][LI1|]N\b/], ['AlTiN', /\b[A4][LI1|]T[I1L]N\b/], ['TiCN', /\bT[I1]C[NM]\b/], ['TiN', /\bT[I1L]N\b/], ['ZrN', /\bZ[RP]N\b/],
      ['AlCrN', /\b[A4][LI1]CR[NM]\b/], ['DLC', /\bDLC\b/], ['Diamond', /\bDIAMOND\b|\bCVD\b/], ['TiB2', /\bT[I1]B2\b/], ['nACo', /\bNACO\b/], ['Black oxide', /\bBLACK OXIDE\b|\bBLK\.? OX/],
      ['Uncoated', /\bUNCOATED\b|\bUNCTD\b|\bBRIGHT(?: FINISH)?\b/]];
    for (const [n, re] of COAT) if (re.test(flat)) add(F, 'coating', n, n, 'sure', 'coating on label');
    if (F.coating && /\bNANO\b/.test(flat)) F.coating.forEach(c => { if (/AlTiN|TiAlN/.test(c.v)) { c.v += ' Nano'; c.show = c.v; } });
    const MAT = [['HSS-E', /\bHSS-?E\b|\bHSS-?CO\b|\bHSCO\b|\bM-?42\b|\bM-?35\b/], ['Cobalt', /\bCOBALT\b|\b(?:5|8)%\s?CO\b/], ['Carbide', /\bCARBIDE\b|\bCARB\b|\bVHM\b|\bSOLID CARB/],
      ['HSS', /\bHSS\b(?!-?E|-?CO)|\bHIGH SPEED\b|\bH\.S\.S\./], ['Cermet', /\bCERMET\b/], ['CBN', /\bCBN\b/], ['PCD', /\bPCD\b/], ['Ceramic', /\bCERAMIC\b/]];
    for (const [n, re] of MAT) if (re.test(flat)) add(F, 'material', n, n, 'sure', 'material on label');
    if (!F.material && insert) add(F, 'material', 'Carbide', 'Carbide', 'guess', 'most inserts are carbide');

    // ---- end style
    if (/\bBALL\b|\bBALL ?NOSE\b|\bBN\b/.test(flat)) add(F, 'end', 'Ball', 'Ball end', 'sure', 'ball on label');
    if (F.cr) add(F, 'end', 'CR', 'Corner radius', 'sure', 'corner radius on label');
    else if (/CORNER RADIUS|BULL ?NOSE/.test(flat)) add(F, 'end', 'CR', 'Corner radius', 'likely', 'corner radius on label');
    else if (/\bSQUARE\b|\bSQ\.? END\b/.test(flat)) add(F, 'end', 'Square', 'Square end', 'sure', 'square on label');

    // ---- type
    const TY = [['Tap', /\bTAPS?\b|SPIRAL POINT|SPIRAL FLUTE|THREAD FORM|ROLL FORM|FORMING TAP|\bGUN TAP\b/], ['Reamer', /\bREAMERS?\b/],
      ['Face mill', /FACE ?MILL|SHELL ?MILL/], ['Spot/Chamfer', /SPOT(?:TING)? DRILL|\bSPOT\b|CHAMFER|COUNTERSINK|CENTER ?DRILL|CTR\.? DR/],
      ['End mill', /END ?MILLS?\b|ENDMILL|\bE\/M\b|ROUGHER|THREAD ?MILL|BALL ?NOSE|\bSLOT(?:TING)? MILL/], ['Drill', /\bDRILLS?\b|JOBBER|SCREW MACHINE|TAPER LENGTH|\bDRL\b/],
      ['Holder', /\bHOLDER\b|COLLET|\bCHUCK\b|\bCAT ?40\b|\bBT ?(?:30|40)\b|\bHSK\b|\bER ?(?:11|16|20|25|32|40)\b|ARBOR|SHRINK FIT/]];
    for (const [n, re] of TY) if (re.test(flat)) add(F, 'type', n, n, n === 'Drill' && /\bTAP DRILL\b/.test(flat) ? 'likely' : 'sure', 'word on label');
    if (!F.type) {
      const pd = F.dia && C ? C.parseDia(F.dia[0].v) : null;
      if (pd && pd.kind === 'tap') add(F, 'type', 'Tap', 'Tap', 'likely', 'thread size');
      else if (pd && pd.kind === 'drill') add(F, 'type', 'Drill', 'Drill', 'likely', 'drill size');
      else if (F.flutes || F.end) add(F, 'type', 'End mill', 'End mill', 'guess', 'has flutes');
    }
    // a tap size makes "Tap" win over "Drill" (a tap drill size is often printed too)
    if (F.type && F.type.length > 1) {
      const pd = F.dia && C ? C.parseDia(F.dia[0].v) : null;
      const pri = { Insert: 9, Tap: pd && pd.kind === 'tap' ? 8 : 5, Reamer: 6, 'Face mill': 6, 'Spot/Chamfer': 5, 'End mill': 4, Drill: 3, Holder: 2 };
      F.type.sort((a, b) => (pri[b.v] || 0) - (pri[a.v] || 0));
    }
    // tap style
    const tapStyle = /SPIRAL POINT/.test(flat) ? 'Spiral Point' : /SPIRAL FLUTE/.test(flat) ? 'Spiral Flute' : /FORM(ING)?\b|ROLL/.test(flat) ? 'Form' : /BOTTOM/.test(flat) ? 'Bottoming' : '';

    // ---- pack quantity
    { let q; const qr = /\bQTY\.?\s?:?\s?(\d{1,4})\b|\b(\d{1,4})\s?(?:PCS|PC|PIECES|PK|EA|\/PK|PER PACK)\b|\bPACK OF (\d{1,4})\b|\b(\d{1,4})\s?PACK\b/g;
      while ((q = qr.exec(flat))) { const n = +(q[1] || q[2] || q[3] || q[4]); if (n >= 1 && n <= 500) add(F, 'pack', n, n + ' in pack', 'likely', 'pack quantity'); } }

    // ---- codes
    for (const c of codes) if (c.text) add(F, 'code', String(c.text).trim(), String(c.text).trim(), 'sure', (c.format || 'code').replace(/_/g, '-'));

    // sort each field: sure > likely > guess (stable)
    const rank = { sure: 0, likely: 1, guess: 2 };
    for (const k in F) if (k !== 'type') F[k].sort((a, b) => rank[a.conf] - rank[b.conf]);
    return { fields: F, tool: toTool(pick(F), { insert, tapStyle }), insert, tapStyle };
  }

  function pick(F, chosen) { const o = {}; for (const k in F) { const c = chosen && k in chosen ? chosen[k] : 0; o[k] = c == null || c < 0 || !F[k][c] ? null : F[k][c].v; } return o; }

  // selected field values -> partial tool object (only keys with values)
  function toTool(v, ctx) {
    ctx = ctx || {};
    const t = {};
    if (v.type) t.type = v.type;
    if (v.dia) t.diaText = String(v.dia);
    if (v.flutes) t.flutes = +v.flutes;
    const mat = [v.material, v.coating, v.grade].filter(Boolean).join(' '); if (mat) t.material = mat;
    const len = [v.oal ? fmtLen(String(v.oal).replace(/mm$/i, ''), /mm$/i.test(v.oal)) + ' OAL' : '', v.loc ? fmtLen(String(v.loc).replace(/mm$/i, ''), /mm$/i.test(v.loc)) + ' LOC' : ''].filter(Boolean).join(', ');
    if (len) t.length = len;
    if (v.vendor) t.vendor = v.vendor;
    if (v.pn) t.pn = String(v.pn);
    if (v.code) t.code = String(v.code);
    const notes = [v.end === 'CR' && v.cr ? 'Corner radius ' + fmtLen(String(v.cr).replace(/mm$/i, ''), /mm$/i.test(v.cr)) : '', v.shank ? 'Shank ' + fmtLen(String(v.shank).replace(/mm$/i, ''), /mm$/i.test(v.shank)) : '', v.pack ? 'Pack of ' + v.pack : ''].filter(Boolean).join('. ');
    if (notes) t.notes = notes + '.';
    t.name = nameOf(v, ctx);
    return t;
  }
  function nameOf(v, ctx) {
    ctx = ctx || {};
    if (v.type === 'Insert' && v.insert) return v.insert + (v.grade ? ' ' + v.grade : '') + ' Insert';
    const parts = [];
    if (v.dia) { const pd = C && C.parseDia(v.dia); const lab = pd ? pd.label : String(v.dia); parts.push(pd && !pd.kind && !pd.mm && /^[\d.\/-]+$/.test(lab) ? lab + '"' : lab); }
    if (v.flutes && v.type !== 'Tap' && v.type !== 'Drill') parts.push(v.flutes + 'FL');
    if (v.end === 'Ball') parts.push('Ball');
    else if (v.end === 'CR') parts.push(v.cr ? 'CR' + String(v.cr).replace(/^0(?=\.)/, '') : 'CR');
    if (v.type === 'Tap' && ctx.tapStyle) parts.push(ctx.tapStyle);
    if (v.type === 'Drill' && !parts.length && v.material) parts.push(v.material);
    parts.push(v.type && v.type !== 'Other' ? v.type : (parts.length ? 'tool' : ''));
    return parts.filter(Boolean).join(' ').trim();
  }

  const FIELD_LABEL = { vendor: 'Brand', pn: 'Part #', dia: 'Size', type: 'Type', flutes: 'Flutes', coating: 'Coating', material: 'Material', end: 'End', cr: 'Radius', oal: 'OAL', loc: 'LOC', shank: 'Shank', insert: 'Insert', grade: 'Grade', pack: 'Pack', code: 'Barcode', reach: 'Reach' };
  const api = { parse, pick, toTool, nameOf, VENDORS, FIELD_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LabelRead = api;
})(this);
