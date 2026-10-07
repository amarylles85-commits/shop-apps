/* Tool Crib logic: diameters, stock status, order list, CSV, and reading tools out of a CNC program. No DOM.
   Program parsing adapted from CNC Check (core.js scan() + auto.js parseToolText()). */
(function (root) {
  'use strict';
  const TYPES = ['End mill', 'Drill', 'Tap', 'Reamer', 'Spot/Chamfer', 'Face mill', 'Insert', 'Holder', 'Other'];
  const ABBR = { 'End mill': 'EM', 'Drill': 'DR', 'Tap': 'TAP', 'Reamer': 'RM', 'Spot/Chamfer': 'SP', 'Face mill': 'FM', 'Insert': 'INS', 'Holder': 'HLD', 'Other': '•' };
  // number drills #1-#80 and letter drills, inches
  const NUMBER_DRILL = [0, .228, .221, .213, .209, .2055, .204, .201, .199, .196, .1935, .191, .189, .185, .182, .18, .177, .173, .1695, .166, .161, .159, .157, .154, .152, .1495, .147, .144, .1405, .136, .1285, .12, .116, .113, .111, .11, .1065, .104, .1015, .0995, .098, .096, .0935, .089, .086, .082, .081, .0785, .076, .073, .07, .067, .0635, .0595, .055, .052, .0465, .043, .042, .041, .04, .039, .038, .037, .036, .035, .033, .032, .031, .0292, .028, .026, .025, .024, .0225, .021, .02, .018, .016, .0145, .0135];
  const LETTER_DRILL = { A: .234, B: .238, C: .242, D: .246, E: .25, F: .257, G: .261, H: .266, I: .272, J: .277, K: .281, L: .29, M: .295, N: .302, O: .316, P: .323, Q: .332, R: .339, S: .348, T: .358, U: .368, V: .377, W: .386, X: .397, Y: .404, Z: .413 };
  const SCREW = { 0: .06, 1: .073, 2: .086, 3: .099, 4: .112, 5: .125, 6: .138, 8: .164, 10: .19, 12: .216 };
  const NUM = '(\\d+\\s*-\\s*\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+(?:\\.\\d+)?)';

  function num(s) {
    if (s == null) return NaN; s = String(s).trim();
    let m = s.match(/^(\d+)\s*[- ]\s*(\d+)\s*\/\s*(\d+)$/); if (m) return +m[1] + m[2] / m[3];
    m = s.match(/^(\d+)\s*\/\s*(\d+)$/); if (m) return m[1] / m[2];
    s = s.replace(/\s+/g, '');
    return /^\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
  }
  const r4 = v => Math.round(v * 10000) / 10000;
  // inches -> 1/2, 1-1/4, .201
  function fmtIn(v) {
    if (v == null || !isFinite(v)) return '';
    const w = Math.floor(v + 1e-9), f = v - w, n = Math.round(f * 64);
    if (Math.abs(f * 64 - n) < 0.0064 && v > 0) {
      if (n === 0) return String(w);
      if (n === 64) return String(w + 1);
      let a = n, b = 64; while (a % 2 === 0) { a /= 2; b /= 2; }
      return (w ? w + '-' : '') + a + '/' + b;
    }
    let s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (s.startsWith('0.')) s = s.slice(1);
    if (/^\.\d{1,2}$/.test(s)) s = s.padEnd(4, '0');
    return s;
  }
  function fmtDec(v) { if (v == null || !isFinite(v)) return ''; let s = v.toFixed(4); if (v < 1) s = s.slice(1); return s; }

  // Diameter text -> {in, label, kind}. Accepts 1/2, 1/2", 1-1/4, 1 1/4, .5, 0.500, #7, F, LTR F, 12mm, M6x1, 1/4-20, #10-32
  function parseDia(raw) {
    if (raw == null) return null;
    let s = String(raw).toUpperCase().replace(/[Ø⌀∅]/g, '').replace(/[”″“]/g, '"').replace(/\bDIA\.?\b/g, '').trim();
    if (!s) return null;
    let m;
    if ((m = s.match(/^M\s*(\d+(?:\.\d+)?)(?:\s*X\s*(\d*\.?\d+))?\s*(TAP)?$/))) return { in: r4(+m[1] / 25.4), label: 'M' + m[1] + (m[2] ? 'x' + m[2] : ''), kind: 'tap', mm: +m[1] };
    if ((m = s.match(/^(#\s*\d{1,2}|\d+\s*\/\s*\d+|\d*\.\d+|\d+)\s*-\s*(\d+)(?!\s*\/)\s*(UNC|UNF|UNEF|UN|NC|NF)?\s*(TAP)?\s*"?$/))) {
      const v = m[1].startsWith('#') ? SCREW[m[1].replace(/\D/g, '')] : num(m[1]);
      if (v && +m[2] >= 4) return { in: r4(v), label: m[1].replace(/\s+/g, '') + '-' + m[2] + (m[3] ? ' ' + m[3] : ''), kind: 'tap' };
    }
    if ((m = s.match(/^#\s*(\d{1,2})(?:\s*(?:DRILL|DRL|DR))?$/)) && NUMBER_DRILL[+m[1]]) return { in: NUMBER_DRILL[+m[1]], label: '#' + (+m[1]), kind: 'drill' };
    if ((m = s.match(/^(?:LTR\.?|LETTER)?\s*([A-Z])(?:\s*(?:DRILL|DRL|DR))?$/)) && LETTER_DRILL[m[1]]) return { in: LETTER_DRILL[m[1]], label: m[1], kind: 'drill' };
    if ((m = s.match(/^(\d*\.?\d+)\s*MM$/))) return { in: r4(+m[1] / 25.4), label: (+m[1]) + 'mm', mm: +m[1] };
    s = s.replace(/\s*(?:"|IN\.?|INCH(?:ES)?)$/, '').trim();
    const v = num(s);
    if (v > 0 && v < 40) return { in: r4(v), label: fmtIn(v) };
    return null;
  }
  // what to show for a tool's diameter: 1/2  |  #7 (.201)  |  12mm (.4724)
  function diaShow(t) {
    if (!t.diaText) return '';
    const p = parseDia(t.diaText);
    if (!p) return t.diaText;
    const exactFrac = /^\d+(-\d+\/\d+)?$|^\d+\/\d+$/.test(p.label);
    if (exactFrac || /^\.\d+$/.test(p.label) || /^\d+\.\d+$/.test(p.label)) return p.label + '"';
    return p.label + ' (' + fmtDec(p.in) + ')';
  }

  function status(t, th) {
    if (t.track === false) return 'na';
    const q = +t.qty || 0, rp = +t.rp || 0;
    if (q <= 0) return 'out';
    if (q <= rp + (th == null ? 2 : th)) return 'soon';
    return 'ok';
  }
  const STATUS_LABEL = { ok: 'OK', soon: 'Order soon', out: 'Out', na: 'Not tracked' };
  const STATUS_RANK = { out: 0, soon: 1, ok: 2, na: 3 };
  function orderUpTo(t, th) {
    const rp = +t.rp || 0, tgt = (t.target == null || t.target === '') ? rp + 5 : +t.target;
    return Math.max(tgt, rp + (th == null ? 2 : th) + 1);
  }
  function suggest(t, th) { return Math.max(1, orderUpTo(t, th) - (+t.qty || 0)); }

  function autoName(t) {
    const parts = [];
    const d = t.diaText ? (parseDia(t.diaText) || {}).label || t.diaText : '';
    if (d) { const pd = parseDia(t.diaText); parts.push(pd && !pd.kind && !pd.mm && /^[\d.\/-]+$/.test(d) ? d + '"' : d); }
    if (t.flutes) parts.push(t.flutes + 'FL');
    if (t.material) parts.push(t.material);
    parts.push(t.type && t.type !== 'Other' ? t.type : (parts.length ? 'tool' : ''));
    return parts.filter(Boolean).join(' ').trim();
  }

  // ---------- order list ----------
  function orderList(tools, th) {
    const low = tools.filter(t => { const s = status(t, th); return s === 'out' || s === 'soon'; });
    const g = {};
    low.forEach(t => { const v = (t.vendor || '').trim() || 'No vendor'; (g[v] = g[v] || []).push(t); });
    return Object.keys(g).sort((a, b) => (a === 'No vendor') - (b === 'No vendor') || a.localeCompare(b)).map(v => {
      const items = g[v].sort((a, b) => STATUS_RANK[status(a, th)] - STATUS_RANK[status(b, th)] || a.name.localeCompare(b.name))
        .map(t => { const q = suggest(t, th), p = t.price == null || t.price === '' ? null : +t.price; return { tool: t, qty: q, status: status(t, th), cost: p == null ? null : r2(p * q) }; });
      const total = items.some(i => i.cost != null) ? r2(items.reduce((s, i) => s + (i.cost || 0), 0)) : null;
      return { vendor: v, items, total };
    });
  }
  const r2 = v => Math.round(v * 100) / 100;
  const money = v => v == null ? '' : '$' + v.toFixed(2);
  function orderText(groups, dateStr) {
    if (!groups.length) return 'Nothing to order.';
    const out = ['Tool order list' + (dateStr ? ' - ' + dateStr : ''), ''];
    let grand = 0, anyCost = false;
    groups.forEach(g => {
      out.push(g.vendor.toUpperCase());
      g.items.forEach(i => {
        const t = i.tool;
        let l = '  ' + i.qty + ' x ' + t.name + (t.pn ? '  P/N ' + t.pn : '');
        if (i.cost != null) l += '  @ ' + money(+t.price) + ' = ' + money(i.cost);
        l += '  (have ' + (+t.qty || 0) + (i.status === 'out' ? ', OUT' : '') + ')';
        out.push(l);
      });
      if (g.total != null) { out.push('  Subtotal: ' + money(g.total)); grand += g.total; anyCost = true; }
      out.push('');
    });
    if (anyCost) out.push('Total: ' + money(r2(grand)));
    return out.join('\n').trim();
  }
  function orderCSV(groups) {
    const rows = [['Vendor', 'Part #', 'Tool', 'Type', 'Diameter', 'Order qty', 'On hand', 'Reorder point', 'Status', 'Unit price', 'Line total', 'Location']];
    groups.forEach(g => g.items.forEach(i => { const t = i.tool; rows.push([g.vendor, t.pn || '', t.name, t.type || '', t.diaText || '', i.qty, +t.qty || 0, +t.rp || 0, STATUS_LABEL[i.status], t.price == null || t.price === '' ? '' : (+t.price).toFixed(2), i.cost == null ? '' : i.cost.toFixed(2), t.loc || '']); }));
    return toCSV(rows);
  }

  // ---------- CSV ----------
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function toCSV(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
  function parseCSV(text) {
    text = String(text).replace(/^\uFEFF/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delim = (first.split(';').length > first.split(',').length && first.split(';').length > 1) ? ';' : (first.split('\t').length > first.split(',').length ? '\t' : ',');
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }
  const COLS = [['name', 'Name'], ['type', 'Type'], ['diaText', 'Diameter'], ['dia', 'Diameter (in)'], ['flutes', 'Flutes'], ['material', 'Material/Coating'], ['length', 'Length'], ['vendor', 'Vendor'], ['pn', 'Part #'], ['price', 'Price'], ['loc', 'Location'], ['qty', 'Qty on hand'], ['rp', 'Reorder point'], ['target', 'Order up to'], ['track', 'Track stock'], ['tnum', 'T#'], ['code', 'Barcode'], ['notes', 'Notes'], ['id', 'ID']];
  function toolsToCSV(tools) {
    return toCSV([COLS.map(c => c[1])].concat(tools.map(t => COLS.map(([k]) => {
      if (k === 'dia') { const p = parseDia(t.diaText); return p ? fmtDec(p.in) : ''; }
      if (k === 'track') return t.track === false ? 'no' : 'yes';
      if (k === 'price') return t.price == null || t.price === '' ? '' : (+t.price).toFixed(2);
      return t[k] == null ? '' : t[k];
    }))));
  }
  const ALIAS = {
    name: ['name', 'description', 'desc', 'tool', 'toolname', 'item', 'tooldescription'], type: ['type', 'category', 'tooltype', 'kind'],
    diaText: ['diameter', 'dia', 'size', 'cutterdiameter'], dia: ['diameterin', 'diain', 'diadecimal', 'decimal'], flutes: ['flutes', 'fl', 'flute', 'noflutes', 'numberofflutes'],
    material: ['materialcoating', 'material', 'coating', 'grade', 'materialandcoating'], length: ['length', 'oal', 'overalllength', 'loc', 'lengthofcut'],
    vendor: ['vendor', 'supplier', 'brand', 'manufacturer', 'mfr', 'mfg', 'make'], pn: ['part', 'partnumber', 'pn', 'partno', 'sku', 'edp', 'catalog', 'catalognumber', 'item'],
    price: ['price', 'cost', 'unitprice', 'unitcost', 'each'], loc: ['location', 'bin', 'locationbin', 'binlocation', 'drawer', 'shelf'],
    qty: ['qtyonhand', 'qty', 'quantity', 'onhand', 'count', 'stock', 'inventory', 'instock'], rp: ['reorderpoint', 'reorder', 'min', 'minimum', 'rop', 'reorderat', 'minqty'],
    target: ['orderupto', 'target', 'max', 'maximum', 'maxqty', 'orderto'], track: ['trackstock', 'track', 'tracked'], tnum: ['t', 'tnum', 'toolnumber', 'pocket', 'tno'],
    code: ['barcode', 'code', 'upc', 'ean', 'qr', 'scancode'], notes: ['notes', 'note', 'comments', 'comment', 'memo'], id: ['id']
  };
  function normType(s) {
    s = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!s) return 'Other';
    for (const t of TYPES) if (t.toLowerCase().replace(/[^a-z]/g, '') === s) return t;
    if (/spot|chamf|center|ctr|csink|countersink/.test(s)) return 'Spot/Chamfer';
    if (/face|shell/.test(s)) return 'Face mill';
    if (/endmill|^em$|ball|bull|rough|finish|corner|slot|thread/.test(s)) return 'End mill';
    if (/tap/.test(s)) return 'Tap'; if (/ream/.test(s)) return 'Reamer'; if (/drill|^dr$/.test(s)) return 'Drill';
    if (/insert/.test(s)) return 'Insert'; if (/holder|collet|chuck|arbor|cat40|bt40|hsk/.test(s)) return 'Holder';
    return 'Other';
  }
  const numOrNull = v => { v = String(v == null ? '' : v).replace(/[$,\s]/g, ''); if (v === '') return null; const n = parseFloat(v); return isFinite(n) ? n : null; };
  // -> {tools:[partial tool objects], errors:[]}
  function csvToTools(text) {
    const rows = parseCSV(text), errors = [];
    if (rows.length < 1) return { tools: [], errors: ['The file is empty.'] };
    const head = rows[0].map(h => String(h).toLowerCase().replace(/[^a-z]/g, ''));
    const map = {};
    head.forEach((h, i) => { for (const k in ALIAS) if (map[k] == null && ALIAS[k].includes(h)) { map[k] = i; break; } });
    if (map.name == null && map.diaText == null && map.pn == null) return { tools: [], errors: ['No Name / Description column found in the first row.'] };
    const tools = [];
    rows.slice(1).forEach((r, ri) => {
      const g = k => map[k] == null ? '' : String(r[map[k]] == null ? '' : r[map[k]]).trim();
      const t = { name: g('name'), type: g('type') ? normType(g('type')) : '', diaText: g('diaText') || (g('dia') ? fmtIn(+g('dia')) : ''), flutes: numOrNull(g('flutes')),
        material: g('material'), length: g('length'), vendor: g('vendor'), pn: g('pn'), price: numOrNull(g('price')), loc: g('loc'),
        qty: numOrNull(g('qty')) == null ? null : Math.max(0, Math.round(numOrNull(g('qty')))), rp: numOrNull(g('rp')) == null ? null : Math.max(0, Math.round(numOrNull(g('rp')))), target: numOrNull(g('target')),
        track: g('track') === '' ? null : !/^(no|n|false|0|off)$/i.test(g('track')), tnum: numOrNull(g('tnum')), notes: g('notes'), id: g('id') || null };
      if (map.code != null) t.code = g('code');
      if (!t.type) { const p = parseDia(t.diaText); if (p && p.kind === 'tap') t.type = 'Tap'; else if (p && p.kind === 'drill') t.type = 'Drill'; else if (t.name && normType(t.name) !== 'Other') t.type = normType(t.name); }
      if (!t.name) t.name = autoName(t) || t.pn;
      if (!t.name) { errors.push('Row ' + (ri + 2) + ': no name, skipped'); return; }
      tools.push(t);
    });
    return { tools, errors };
  }
  // find an existing tool that a CSV row should update (by ID, then vendor + part #, then name + size); skips tools in `used`
  function findMatch(t, tools, used) {
    const pool = used ? tools.filter(x => !used.has(x)) : tools;
    if (t.id) { const m = pool.find(x => x.id === t.id); if (m) return m; }
    if (t.code) { const k = normCode(t.code); const m = pool.find(x => x.code && normCode(x.code) === k); if (m) return m; }
    if (t.pn) { const m = pool.find(x => x.pn && x.pn.toLowerCase() === t.pn.toLowerCase() && (x.vendor || '').toLowerCase() === (t.vendor || '').toLowerCase()); if (m) return m; }
    return pool.find(x => (x.name || '').toLowerCase() === (t.name || '').toLowerCase() && (x.diaText || '') === (t.diaText || '')) || null;
  }
  // one-to-one plan: each existing tool is updated by at most one row; rows never match tools added by the same import
  function planImport(rows, tools) {
    const used = new Set();
    return rows.map(t => { const m = findMatch(t, tools, used); if (m) used.add(m); return { t, m }; });
  }

  // ---------- barcodes ----------
  // same code read as EAN-13 or UPC-A, any spacing/case -> one key
  function normCode(c) { let s = String(c == null ? '' : c).trim().toUpperCase().replace(/\s+/g, ' '); if (/^0\d{12}$/.test(s)) s = s.slice(1); return s; }
  const alnum = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // tool whose stored code matches; else whose part # is the code (or is a whole word inside it, e.g. QR "OSG 1300207708")
  function findByCode(tools, code) {
    const k = normCode(code); if (!k) return null;
    const byCode = tools.find(t => t.code && normCode(t.code) === k); if (byCode) return byCode;
    const a = alnum(k); if (a.length < 4) return null;
    const byPn = tools.find(t => t.pn && alnum(t.pn) === a); if (byPn) return byPn;
    const words = k.split(/[\s,;|]+/).map(alnum).filter(w => w.length >= 5);
    return tools.find(t => t.pn && alnum(t.pn).length >= 5 && words.includes(alnum(t.pn))) || null;
  }

  // ---------- CNC program -> tools ----------
  const KIND = '(E\\/M|EM|END\\s*MILL|ENDMILL|ROUGHER|FINISHER|DRILL|DRL|DR|SPOT(?:\\s*DRILL)?|SPOTDRILL|CTR\\s*DRILL|CENTER\\s*DRILL|C\\/D|CHAMFER(?:\\s*MILL)?|CHAM|CSINK|C\'SINK|COUNTERSINK|REAMER|REAM|TAP|FACE\\s*MILL|FACEMILL|SHELL\\s*MILL|F\\/M|FM|BORING\\s*BAR|THREAD\\s*MILL|SLOT(?:\\s*CUTTER)?|KEY\\s*CUTTER|BALL(?:\\s*EM|\\s*MILL)?|BULL(?:\\s*NOSE)?|ENGRAV\\w*|LOLLIPOP)';
  function kindOf(k) {
    k = (k || '').toUpperCase();
    if (/SPOT|CTR|CENTER|C\/D|CHAM|SINK/.test(k)) return 'Spot/Chamfer'; if (/REAM/.test(k)) return 'Reamer';
    if (/TAP/.test(k)) return 'Tap'; if (/DR/.test(k)) return 'Drill'; if (/FACE|SHELL|F\/M|^FM$/.test(k)) return 'Face mill';
    if (/BOR/.test(k)) return 'Other'; if (!k) return null; return 'End mill';
  }
  // comment text -> {in, label, type} or null
  function parseToolText(c, mm) {
    const s = ' ' + c.toUpperCase().replace(/[Ø⌀∅]/g, ' DIA ') + ' ';
    const conv = (v, isMM) => (isMM && !mm) ? v / 25.4 : (!isMM && mm) ? v * 25.4 : v;
    const kindIn = () => kindOf((s.match(new RegExp(KIND)) || [])[1]);
    let m;
    if ((m = s.match(/\bD(?:IA(?:METER)?)?\.?\s*[=:]\s*(\d*\.?\d+)\s*(MM)?/))) { const v = conv(+m[1], !!m[2]); return { in: v, label: m[2] ? (+m[1]) + 'mm' : fmtIn(v), type: /PROBE/.test(s) ? 'Other' : kindIn(), probe: /PROBE/.test(s) }; }
    if ((m = s.match(/#\s*(\d{1,2})\s*(?:DRILL|DRL|DR)\b/)) && NUMBER_DRILL[+m[1]]) return { in: NUMBER_DRILL[+m[1]], label: '#' + (+m[1]), type: 'Drill' };
    if ((m = s.match(/\b(?:LTR\.?|LETTER)?\s*\b([A-Z])\s*(?:DRILL|DRL)\b/)) && LETTER_DRILL[m[1]] && !/\bEM\b/.test(s)) return { in: LETTER_DRILL[m[1]], label: m[1], type: 'Drill' };
    if ((m = s.match(/(?<![\w.\/])(\d+\/\d+|#\d+|\d*\.\d+|\d+)\s*-\s*(\d+)\s*(UNC|UNF|UN)?\s*(?:SPIRAL\s*(?:POINT|FLUTE)\s*|FORM(?:ING)?\s*|ROLL\s*|PLUG\s*|BOTTOM(?:ING)?\s*|HSS\s*)*TAP/))) {
      const v = m[1].startsWith('#') ? SCREW[m[1].slice(1)] : num(m[1]);
      if (v) return { in: v, label: m[1] + '-' + m[2], type: 'Tap' };
    }
    if ((m = s.match(/\bM(\d+(?:\.\d+)?)\s*X\s*([\d.]+)\s*TAP/))) return { in: +m[1] / 25.4, label: 'M' + m[1] + 'x' + m[2], type: 'Tap' };
    const re1 = new RegExp('(?<![A-Z\\d.#\\/=-])' + NUM + '\\s*(MM|"|IN\\b|INCH)?\\s*(?:DIA\\.?\\s*)?(?:(?:\\d\\s*FL(?:UTE)?S?|FLAT|SQ(?:UARE)?|CARB(?:IDE)?|HSS|COBALT|STUB|JOBBER|LONG|X?\\d+\\s*DEG|90|82|60|120|118)\\s*)*' + KIND + '\\b');
    if ((m = s.match(re1))) { const v = num(m[1].replace(/\s*-\s*/, '-')); if (v > 0 && v < 12 * (m[2] === 'MM' ? 25.4 : 1)) { const iv = conv(v, m[2] === 'MM'); return { in: iv, label: m[2] === 'MM' ? v + 'mm' : fmtIn(iv), type: kindOf(m[3]) }; } }
    const re2 = new RegExp(KIND + '\\s*[-:,]?\\s*(?:DIA\\.?\\s*)?' + NUM + '\\s*(MM)?');
    if ((m = s.match(re2))) { const v = num(m[2].replace(/\s*-\s*/, '-')); if (v > 0 && v < 12 * (m[3] ? 25.4 : 1) && !/^\s*(DEG|FL)/.test(s.slice(s.indexOf(m[0]) + m[0].length))) { const iv = conv(v, !!m[3]); return { in: iv, label: m[3] ? v + 'mm' : fmtIn(iv), type: kindOf(m[1]) }; } }
    if ((m = s.match(/\bDIA\.?\s*(\d*\.\d+|\d+\/\d+)/))) { const iv = conv(num(m[1]), false); return { in: iv, label: fmtIn(iv), type: kindIn() }; }
    // no size, but the kind is there (e.g. "(T5 SPOT DRILL)", "(T9 CHAMFER)")
    const k = kindIn(); if (k) return { in: null, label: '', type: k };
    return null;
  }
  const stripC = l => l.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '');
  const comments = l => (l.match(/\(([^)]*)\)/g) || []).map(c => c.slice(1, -1).trim()).filter(Boolean);
  const JUNK = /SETUP\s*\d|ESTIMATED|MACHINE TIME|FEATURECAM|MASTERCAM|FUSION|BACKUP|UPPERCASE|^REV|EDIT\s+\d|PROBE\s*WCS|VENDOR|MODEL|^MACHINE$|LOOK FOR|FANUC|^O\d+|^\s*[A-Z]{2,5}\d{5,}\s*$|^\d+[-\/]\d+[-\/]\d+|DATE|PROGRAM|PART\s*(NO|NAME|#)|MADE IN|^%/i;
  // -> [{t, in, label, type, probe, ops:[], comment, files:[]}]
  function programTools(text, fileName) {
    const lines = String(text).split(/\r?\n/); let mm = false;
    const tools = {}, listCmt = {};
    lines.forEach(l => { if (/\bG0*21\b/i.test(stripC(l))) mm = true; });
    // tool list / tool comments: (T1 1/2 FLAT EM), (T19 D=0.24 ... PROBE), (TOOL 3 - 3/8 DRILL)
    lines.forEach(l => comments(l).forEach(c => {
      const m = c.match(/^(?:T|TOOL\s*#?\s*)(\d+)\b\s*[-:=]?\s*(.*)$/i);
      if (m && m[2] && !listCmt[+m[1]]) { const p = parseToolText(m[2], mm); if (p) listCmt[+m[1]] = Object.assign(p, { comment: c }); }
    }));
    lines.forEach((l, i) => {
      const s = stripC(l).toUpperCase();
      const w = [...s.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)].map(m => [m[1], parseFloat(m[2])]);
      const t = (w.find(x => x[0] === 'T') || [])[1];
      if (t == null || !w.some(x => x[0] === 'M' && x[1] === 6)) return;
      const T = tools[t] = tools[t] || { t, in: null, label: '', type: null, probe: false, ops: [], comment: '', files: fileName ? [fileName] : [] };
      // size from: tool list comment, same line, or comments up to 3 lines around
      let p = null;
      const near = [0, -1, 1, -2, 2, -3, 3];
      if (listCmt[t]) p = listCmt[t];
      for (const k of near) { if (p && p.in != null) break; const ll = lines[i + k]; if (!ll || (k && /\bM0*6\b/i.test(stripC(ll)))) continue; const c = comments(ll).filter(x => !JUNK.test(x)).join(' '); if (!c) continue; const q = parseToolText(c, mm); if (q && (q.in != null || (!p && k === 0))) p = Object.assign(q, { comment: c }); }
      if (/PROBE/i.test(l) || (listCmt[t] && listCmt[t].probe)) { T.probe = true; }
      if (p) { if (p.in != null && T.in == null) { T.in = p.in; T.label = p.label; } if (p.type && !T.type) T.type = p.type; if (p.comment && !T.comment) T.comment = p.comment; }
      // operation name: same-line comment, else the nearest comment above (stop at another tool change)
      let op = comments(l).filter(c => !JUNK.test(c))[0] || '';
      for (let k = 1; !op && k <= 6; k++) { const ll = lines[i - k]; if (ll == null || /\bM0*6\b/i.test(stripC(ll))) break; const c = comments(ll).filter(x => !JUNK.test(x) && !/^T\d+\b/i.test(x)); if (c.length) op = c[c.length - 1]; }
      op = op.replace(/\s+/g, ' ').trim();
      if (op && !T.ops.includes(op) && !/^(SELECT THE )?PROBE/i.test(op)) T.ops.push(op);
    });
    return Object.values(tools).sort((a, b) => a.t - b.t).map(T => {
      if (T.probe) T.type = 'Other';
      if (!T.type) T.type = T.in != null ? 'End mill' : 'Other';
      T.in = T.in == null ? null : r4(T.in);
      return T;
    });
  }
  function mergeProgramTools(lists) {
    const out = {};
    lists.flat().forEach(T => {
      const o = out[T.t];
      if (!o) { out[T.t] = Object.assign({}, T, { ops: T.ops.slice(), files: T.files.slice() }); return; }
      if (o.in == null && T.in != null) { o.in = T.in; o.label = T.label; o.type = T.type; }
      T.ops.forEach(x => { if (!o.ops.includes(x)) o.ops.push(x); });
      T.files.forEach(x => { if (!o.files.includes(x)) o.files.push(x); });
      o.probe = o.probe || T.probe; if (!o.comment) o.comment = T.comment;
    });
    return Object.values(out).sort((a, b) => a.t - b.t);
  }
  function progCandToTool(T) {
    const diaText = T.in != null ? T.label : '';
    let name;
    if (T.probe) name = 'T' + T.t + ' Probe' + (T.in != null ? ' (' + fmtDec(T.in) + ' stylus)' : '');
    else if (T.in != null) name = 'T' + T.t + ' ' + autoName({ diaText, type: T.type });
    else name = 'T' + T.t + (T.type && T.type !== 'Other' ? ' ' + T.type : '') + (T.ops[0] ? ' - ' + T.ops[0] : (T.type && T.type !== 'Other' ? '' : ' tool'));
    const notes = ['From ' + T.files.join(', ') + '.', T.ops.length ? 'Ops: ' + T.ops.join('; ') + '.' : '', T.comment ? 'Comment: (' + T.comment + ')' : '', T.in == null && !T.probe ? 'Size not in program.' : ''].filter(Boolean).join(' ');
    return { name, type: T.type, diaText: T.probe ? (T.in != null ? fmtDec(T.in) : '') : diaText, tnum: T.t, qty: 0, rp: 0, notes, track: !T.probe };
  }
  // is a program tool already in the catalog? by T#, or same type + same diameter
  function catalogMatch(T, tools) {
    const compat = x => { const p = parseDia(x.diaText); return (T.in == null || !p || Math.abs(p.in - T.in) < 0.0006) && (!T.type || T.type === 'Other' || !x.type || x.type === 'Other' || x.type === T.type); };
    return tools.find(x => x.tnum != null && x.tnum !== '' && +x.tnum === T.t && compat(x)) ||
      (T.in != null ? tools.find(x => { const p = parseDia(x.diaText); return p && Math.abs(p.in - T.in) < 0.0006 && x.type === T.type; }) : null) || null;
  }

  const api = { TYPES, ABBR, NUMBER_DRILL, LETTER_DRILL, parseDia, fmtIn, fmtDec, diaShow, status, STATUS_LABEL, STATUS_RANK, orderUpTo, suggest, autoName,
    orderList, orderText, orderCSV, money, toCSV, parseCSV, toolsToCSV, csvToTools, normType, findMatch, planImport, parseToolText, programTools, mergeProgramTools, progCandToTool, catalogMatch, normCode, findByCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Crib = api;
})(typeof window !== 'undefined' ? window : this);
