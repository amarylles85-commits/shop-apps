/* CNC Check core: G-code interpreter + crash checks. No DOM. */
(function (root) {
  'use strict';
  const HOME_Z = 1e6; // "at Z home" sentinel

  function stripComments(line) {
    return line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '');
  }
  function words(s) {
    const re = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
    const out = []; let m;
    while ((m = re.exec(s))) out.push([m[1].toUpperCase(), parseFloat(m[2])]);
    return out;
  }

  // Pre-scan: tools used, tool diameters from comments, work offsets, units.
  function scan(text) {
    const lines = text.split(/\r?\n/);
    const tools = {}; const wcs = {}; let units = 'in';
    let lastToolComment = null;
    lines.forEach((raw, i) => {
      const cm = raw.match(/\(([^)]*)\)/g) || [];
      cm.forEach(c => {
        const m = c.match(/\(\s*T(\d+)\b[^)]*?\bD(?:IA(?:METER)?)?\s*[=:]?\s*([\d.]+)/i);
        if (m) {
          const t = +m[1];
          tools[t] = tools[t] || { t, used: false };
          if (tools[t].dia == null) tools[t].dia = parseFloat(m[2]);
          if (/PROBE/i.test(c)) tools[t].probe = true;
          tools[t].desc = tools[t].desc || c.replace(/[()]/g, '').trim();
          lastToolComment = t;
        }
      });
      const s = stripComments(raw).toUpperCase();
      if (/\bG0*21\b/.test(s)) units = 'mm';
      const w = words(s);
      let hasM6 = false, t = null;
      w.forEach(([L, v]) => {
        if (L === 'M' && v === 6) hasM6 = true;
        if (L === 'T') t = v;
        if (L === 'G' && v >= 54 && v <= 59.9) wcs['G' + (Math.round(v * 10) / 10)] = true;
      });
      if (hasM6 && t != null) {
        tools[t] = tools[t] || { t };
        tools[t].used = true;
        if (/PROBE/i.test(raw)) tools[t].probe = true;
      }
    });
    if (!Object.keys(wcs).length) wcs.G54 = true;
    return { tools, wcs: Object.keys(wcs).sort(), units, lineCount: lines.length };
  }

  // ---------------- stock model ----------------
  function makeStock(setup) {
    const s = setup.stock;
    const H = +s.height;
    let x0, x1, y0, y1;
    if (s.shape === 'round') {
      const r = s.dia / 2; x0 = -r; x1 = r; y0 = -r; y1 = r;
    } else {
      const L = +s.length, W = +s.width;
      switch (s.xyZero) {
        case 'front-left': x0 = 0; x1 = L; y0 = 0; y1 = W; break;
        case 'front-right': x0 = -L; x1 = 0; y0 = 0; y1 = W; break;
        case 'back-left': x0 = 0; x1 = L; y0 = -W; y1 = 0; break;
        case 'back-right': x0 = -L; x1 = 0; y0 = -W; y1 = 0; break;
        default: x0 = -L / 2; x1 = L / 2; y0 = -W / 2; y1 = W / 2;
      }
    }
    let top, bottom;
    if (s.zZero === 'bottom') { bottom = 0; top = H; }
    else { top = +(s.topAbove || 0); bottom = top - H; }
    const span = Math.max(x1 - x0, y1 - y0);
    const cs = Math.max(span / 360, 0.004);
    const nx = Math.ceil((x1 - x0) / cs) + 1, ny = Math.ceil((y1 - y0) / cs) + 1;
    const hm = new Float32Array(nx * ny);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r2 = ((x1 - x0) / 2) ** 2;
    const bore = s.shape === 'round' ? (+s.bore || 0) / 2 : 0, b2 = bore * bore;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + i * cs, y = y0 + j * cs;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const inside = s.shape === 'round' ? (d2 <= r2 && d2 >= b2) : true;
      hm[j * nx + i] = inside ? top : -Infinity;
    }
    // workholding
    const jaws = [];
    const wh = setup.hold || {};
    if (wh.type && wh.type !== 'none') {
      const grip = +wh.grip || 0, thick = +wh.thick || 1, jtop = bottom + grip;
      const jl = Math.max(+wh.jawLen || 6, 0);
      if (wh.type === 'vise-y') { // jaws on front/back faces
        const ext = Math.max(jl, x1 - x0) / 2, mx = (x0 + x1) / 2;
        jaws.push({ x0: mx - ext, x1: mx + ext, y0: y1, y1: y1 + thick, z0: bottom - 10, z1: jtop, name: 'back vise jaw' });
        jaws.push({ x0: mx - ext, x1: mx + ext, y0: y0 - thick, y1: y0, z0: bottom - 10, z1: jtop, name: 'front vise jaw' });
      } else if (wh.type === 'vise-x') { // jaws on left/right faces
        const ext = Math.max(jl, y1 - y0) / 2, my = (y0 + y1) / 2;
        jaws.push({ x0: x1, x1: x1 + thick, y0: my - ext, y1: my + ext, z0: bottom - 10, z1: jtop, name: 'right vise jaw' });
        jaws.push({ x0: x0 - thick, x1: x0, y0: my - ext, y1: my + ext, z0: bottom - 10, z1: jtop, name: 'left vise jaw' });
      } else if (wh.type === 'chuck') { // ring around the round blank
        jaws.push({ ring: true, cx, cy, r0: (x1 - x0) / 2, r1: (x1 - x0) / 2 + thick, z0: bottom - 10, z1: jtop, name: 'chuck jaws' });
      }
    }
    // table / fixture plate under the blank
    const floor = bottom - (+wh.below || 0);
    return { x0, x1, y0, y1, top, bottom, cs, nx, ny, hm, shape: s.shape, cx, cy, r: (x1 - x0) / 2, bore, jaws, floor };
  }

  function discOffsets(r, cs) {
    const n = Math.ceil(r / cs), out = [];
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++)
      if ((i * cs) ** 2 + (j * cs) ** 2 <= r * r + 1e-9) out.push([i, j]);
    return out;
  }

  // ---------------- interpreter ----------------
  function check(text, setup) {
    const info = scan(text);
    const stock = makeStock(setup);
    const lines = text.split(/\r?\n/);
    const issues = [];
    const seen = {};
    const add = (sev, ln, msg, key, pt) => {
      const k = key || (sev + '|' + ln + '|' + msg);
      if (seen[k]) return; seen[k] = 1;
      issues.push({ sev, line: ln + 1, text: (lines[ln] || '').trim(), msg, pt: pt || null, afterEnd: st.ended, kind: key ? key.split('|')[0] : null });
    };
    const toolDia = t => {
      const e = setup.tools && setup.tools[t];
      if (e && +e.dia > 0) return +e.dia;
      if (info.tools[t] && info.tools[t].dia) return info.tools[t].dia;
      return 0.5;
    };
    const isProbe = t => !!(info.tools[t] && info.tools[t].probe) || !!(setup.tools && setup.tools[t] && setup.tools[t].probe);
    const wcsShift = w => (setup.wcs && setup.wcs[w]) || { x: 0, y: 0, z: 0 };

    const st = {
      abs: true, motion: 0, plane: 17, wcs: 'G54', tool: null, pendT: null, lenOn: false, H: null,
      needG43: false, spindle: 0, S: 0, F: 0, canned: null, retract98: true, ended: false,
      pos: { x: 0, y: 0, z: HOME_Z }, xyKnown: false, ext: null, units: info.units,
      initZ: HOME_Z
    };
    const paths = []; // {tool, kind:'rapid'|'feed', pts:[[x,y,z],...]}
    let cur = null;
    const disc = {};
    const getDisc = t => disc[t] || (disc[t] = discOffsets(toolDia(t) / 2, stock.cs));

    function toStock(p) {
      const s = wcsShift(st.wcs);
      return [p.x + (+s.x || 0), p.y + (+s.y || 0), p.z + (+s.z || 0)];
    }
    function cellIdx(x, y) {
      const i = Math.round((x - stock.x0) / stock.cs), j = Math.round((y - stock.y0) / stock.cs);
      return [i, j];
    }
    function heightUnder(x, y, offs) {
      const [ci, cj] = cellIdx(x, y); let h = -Infinity;
      for (const [di, dj] of offs) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= stock.nx || j >= stock.ny) continue;
        const v = stock.hm[j * stock.nx + i]; if (v > h) h = v;
      }
      return h;
    }
    function stamp(x, y, z, offs) {
      const [ci, cj] = cellIdx(x, y);
      for (const [di, dj] of offs) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= stock.nx || j >= stock.ny) continue;
        const k = j * stock.nx + i; if (stock.hm[k] > z) stock.hm[k] = z;
      }
    }
    function hitsJaw(x, y, z, r) {
      for (const J of stock.jaws) {
        if (z >= J.z1) continue;
        if (J.ring) {
          const d = Math.hypot(x - J.cx, y - J.cy);
          if (d + r > J.r0 && d - r < J.r1) return J;
        } else if (x + r > J.x0 && x - r < J.x1 && y + r > J.y0 && y - r < J.y1) return J;
      }
      return null;
    }
    function track(p) {
      if (p[2] > HOME_Z / 2) return;
      const e = st.ext || (st.ext = { x0: p[0], x1: p[0], y0: p[1], y1: p[1], z0: p[2], z1: p[2] });
      e.x0 = Math.min(e.x0, p[0]); e.x1 = Math.max(e.x1, p[0]);
      e.y0 = Math.min(e.y0, p[1]); e.y1 = Math.max(e.y1, p[1]);
      e.z0 = Math.min(e.z0, p[2]); e.z1 = Math.max(e.z1, p[2]);
    }
    function pushPt(kind, p, ln) {
      if (!cur || cur.kind !== kind || cur.tool !== st.tool) {
        const last = cur && cur.pts[cur.pts.length - 1], lastLn = cur && cur.lns[cur.lns.length - 1];
        cur = { kind, tool: st.tool, probe: isProbe(st.tool), pts: last ? [last] : [], lns: last ? [lastLn] : [] }; paths.push(cur);
      }
      cur.pts.push(p); cur.lns.push(ln + 1);
    }

    // Move along a list of program-frame points (already interpolated) and check.
    function run(kind, ln, ptsProg) {
      if (st.ended) return;
      const t = st.tool, r = toolDia(t) / 2, offs = getDisc(t);
      const probe = isProbe(t);
      let prev = toStock(st.pos);
      if (prev[2] > HOME_Z / 2) prev[2] = Math.max(stock.top + 6, 10);
      if (kind === 'feed' && st.motion !== 'protected') {
        if (st.spindle === 0 && !probe && t != null) add('CRASH', ln, 'Cutting move with the spindle stopped (no M03/M04 since the last tool change or M05).', 'spin|' + ln);
        if (!(st.F > 0)) add('CHECK', ln, 'Feed move with no feed rate (F) set. Most controls alarm here.', 'nof|' + ln);
      }
      for (const pp of ptsProg) {
        let q = toStock(pp);
        if (q[2] > HOME_Z / 2) q = [q[0], q[1], Math.max(stock.top + 6, 10)];
        const d = Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
        const step = Math.max(stock.cs * 0.9, 0.002);
        const n = Math.max(1, Math.ceil(d / step));
        for (let k = 1; k <= n; k++) {
          const f = k / n;
          const x = prev[0] + (q[0] - prev[0]) * f, y = prev[1] + (q[1] - prev[1]) * f, z = prev[2] + (q[2] - prev[2]) * f;
          if (!st.xyKnown) continue;
          const J = hitsJaw(x, y, z, r);
          if (J) add('CRASH', ln, (kind === 'rapid' ? 'Rapid' : 'Feed') + ' move hits the ' + J.name + ' (tool at Z' + z.toFixed(3) + ').', 'jaw|' + ln, [x, y, z]);
          if (z < stock.floor - 1e-4 && x + r > stock.x0 && x - r < stock.x1 && y + r > stock.y0 && y - r < stock.y1)
            add('CRASH', ln, 'Tool goes ' + (stock.floor - z).toFixed(3) + ' below the table/fixture under the blank.', 'floor|' + ln, [x, y, z]);
          const h = heightUnder(x, y, offs);
          if (kind === 'rapid') {
            if (z < h - 0.003) add('CRASH', ln, 'Rapid move into uncut material: tool tip at Z' + z.toFixed(3) + ', blank is at Z' + h.toFixed(3) + ' there' + (probe ? ' (probe would be hit).' : '.'), 'rap|' + ln, [x, y, z]);
          } else {
            if (probe && z < h - 0.003 && st.motion !== 'protected') add('CRASH', ln, 'Probe fed into the blank.', 'pf|' + ln, [x, y, z]);
            if (!probe) stamp(x, y, z, offs);
            if (z < stock.bottom - 1e-4 && h > -Infinity && !probe) add('CHECK', ln, 'Cuts ' + (stock.bottom - z).toFixed(3) + ' below the bottom of the blank. Make sure there is clearance under the part.', 'below|' + t, [x, y, z]);
          }
        }
        track(q); pushPt(kind, q, ln); prev = q;
        st.pos = { x: pp.x, y: pp.y, z: pp.z };
      }
    }

    function arcPoints(from, to, cw, w, ln) {
      // plane mapping
      const ax = st.plane === 18 ? ['z', 'x', 'K', 'I'] : st.plane === 19 ? ['y', 'z', 'J', 'K'] : ['x', 'y', 'I', 'J'];
      const lin = st.plane === 18 ? 'y' : st.plane === 19 ? 'x' : 'z';
      const a0 = from[ax[0]], b0 = from[ax[1]], a1 = to[ax[0]], b1 = to[ax[1]];
      let ca, cb;
      if (w.R != null) {
        const R = w.R, dx = a1 - a0, dy = b1 - b0, dd = Math.hypot(dx, dy);
        if (dd === 0) { add('CHECK', ln, 'Full circle programmed with R. Use I/J for full circles.', 'rfull|' + ln); return [to]; }
        if (dd > 2 * Math.abs(R) + 1e-4) { add('CRASH', ln, 'Arc radius R' + R + ' is too small to reach the end point (control will alarm).', 'rsmall|' + ln); return [to]; }
        const h = Math.sqrt(Math.max(0, R * R - dd * dd / 4));
        const mx = (a0 + a1) / 2, my = (b0 + b1) / 2;
        let sgn = (cw ? -1 : 1) * (R < 0 ? -1 : 1);
        ca = mx - sgn * h * dy / dd; cb = my + sgn * h * dx / dd;
      } else {
        ca = a0 + (w[ax[2]] || 0); cb = b0 + (w[ax[3]] || 0);
        const r0 = Math.hypot(a0 - ca, b0 - cb), r1 = Math.hypot(a1 - ca, b1 - cb);
        if (Math.abs(r0 - r1) > 0.002 * (st.units === 'mm' ? 25.4 : 1))
          add('CRASH', ln, 'Arc start and end radius differ by ' + Math.abs(r0 - r1).toFixed(4) + '. The control will alarm on this arc.', 'arc|' + ln);
      }
      const r = Math.hypot(a0 - ca, b0 - cb);
      let t0 = Math.atan2(b0 - cb, a0 - ca), t1 = Math.atan2(b1 - cb, a1 - ca);
      let sweep = t1 - t0;
      if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; } else { if (sweep <= 1e-9) sweep += 2 * Math.PI; }
      if (Math.abs(a0 - a1) < 1e-6 && Math.abs(b0 - b1) < 1e-6) sweep = cw ? -2 * Math.PI : 2 * Math.PI;
      const segs = Math.max(4, Math.ceil(Math.abs(sweep) * r / Math.max(stock.cs, 0.01)));
      const out = [];
      for (let k = 1; k <= Math.min(segs, 2000); k++) {
        const f = k / Math.min(segs, 2000), a = t0 + sweep * f;
        const p = {}; p[ax[0]] = ca + r * Math.cos(a); p[ax[1]] = cb + r * Math.sin(a);
        p[lin] = from[lin] + (to[lin] - from[lin]) * f;
        out.push(p);
      }
      out[out.length - 1] = to;
      return out;
    }

    function target(w) {
      const p = { x: st.pos.x, y: st.pos.y, z: st.pos.z };
      if (p.z > HOME_Z / 2 && w.Z == null) p.z = HOME_Z;
      ['X', 'Y', 'Z'].forEach(L => {
        if (w[L] == null) return;
        const k = L.toLowerCase();
        if (st.abs) p[k] = w[L];
        else p[k] = (p[k] > HOME_Z / 2 ? 0 : p[k]) + w[L];
      });
      return p;
    }

    let notedMacro = false, notedSub = false, notedRot = false;
    for (let ln = 0; ln < lines.length; ln++) {
      const raw = lines[ln];
      const s = stripComments(raw).toUpperCase().trim();
      if (!s || s === '%') continue;
      if (s.startsWith('O') && /^O\d+/.test(s)) continue;
      if (s.includes('#') && !notedMacro) { notedMacro = true; add('INFO', ln, 'Macro variables (#) are not simulated. Lines using them were skipped.'); }
      const wl = words(s);
      const G = wl.filter(x => x[0] === 'G').map(x => Math.round(x[1] * 10) / 10);
      const M = wl.filter(x => x[0] === 'M').map(x => x[1]);
      const w = {}; wl.forEach(([L, v]) => { if (L !== 'G' && L !== 'M') w[L] = v; });

      if (G.includes(65) || G.includes(66)) { // macro call (probing)
        if (w.P === 9810 && !st.ended) { // Renishaw protected move: treat as safe positioning
          const tp = target(w); const save = st.motion; st.motion = 'protected';
          run('feed', ln, [tp]); st.motion = save;
        }
        continue;
      }
      if (M.includes(98) && !notedSub) { notedSub = true; add('INFO', ln, 'Subprogram calls (M98) are not followed. Check called programs separately.'); }
      if ((G.includes(68) || G.includes(51)) && !notedRot) { notedRot = true; add('INFO', ln, 'Rotation/scaling (G68/G51) is not simulated.'); }

      if (w.S != null) st.S = w.S;
      if (w.F != null) st.F = w.F;
      G.forEach(g => {
        if (g === 90) st.abs = true; else if (g === 91) st.abs = false;
        else if (g === 17 || g === 18 || g === 19) st.plane = g;
        else if (g >= 54 && g <= 59.9) st.wcs = 'G' + g;
        else if (g === 20) st.units = 'in'; else if (g === 21) st.units = 'mm';
        else if (g === 98) st.retract98 = true; else if (g === 99) st.retract98 = false;
        else if (g === 49) { st.lenOn = false; }
        else if (g === 80) st.canned = null;
      });
      // Tool change
      if (w.T != null) st.pendT = w.T;
      if (M.includes(6)) {
        const t = w.T != null ? w.T : st.pendT;
        if (t == null) add('CRASH', ln, 'M06 with no tool number.');
        if (!st.ended && t === st.tool && t != null) add('CHECK', ln, 'Tool change to T' + t + ', which is already in the spindle.');
        st.tool = t; st.pendT = null; st.lenOn = false; st.needG43 = true; st.spindle = 0;
      }
      if (M.includes(3) || M.includes(4)) {
        st.spindle = M.includes(3) ? 3 : 4;
        if (!(st.S > 0) && !isProbe(st.tool)) add('CHECK', ln, 'Spindle started with no speed (S) set.');
      }
      if (M.includes(5)) st.spindle = 0;
      if (G.includes(43) || G.includes(43.4) || G.includes(44)) {
        if (w.H == null) add('CRASH', ln, 'G43 with no H offset number.');
        else {
          st.lenOn = true; st.H = w.H; st.needG43 = false;
          if (st.tool != null && w.H !== st.tool) {
            const other = info.tools[w.H] && info.tools[w.H].used;
            add(other ? 'CRASH' : 'CHECK', ln, 'T' + st.tool + ' is using length offset H' + w.H + (other ? ', which belongs to another tool in this program. Wrong length = crash.' : '. Usually H should match the tool number.') + (st.ended ? ' (This is after M30, so it only runs if someone starts there.)' : ''));
          }
        }
      } else if (w.H != null && !G.includes(43)) {
        add('INFO', ln, 'H' + w.H + ' on a line without G43 does nothing.', 'strayH|' + ln);
      }

      // G28 / G53
      if (G.includes(28)) {
        const hasAx = w.X != null || w.Y != null || w.Z != null;
        if (!hasAx) {
          add('CHECK', ln, 'G28 with no axis words. Depending on the control this does nothing or sends every axis home at once; confirm what yours does.', 'g28|' + ln);
        } else {
          if (st.abs) { // moves through the given point in work coords first
            const tp = target(w); run('rapid', ln, [tp]);
            if (w.Z != null && w.Z < stock.top + 0.05) add('CHECK', ln, 'G28 in absolute mode goes through Z' + w.Z + ' before homing. Use G91 G28 Z0.', 'g28abs|' + ln);
          }
        }
        if (w.Z != null || !hasAx) st.pos.z = HOME_Z;
        if (w.X != null || w.Y != null || !hasAx) st.xyKnown = st.xyKnown && w.X == null && w.Y == null && hasAx;
        continue;
      }
      if (G.includes(53)) { if (w.Z != null) st.pos.z = HOME_Z; if (w.X != null || w.Y != null) st.xyKnown = false; continue; }

      // motion modal
      let motionWord = null;
      G.forEach(g => {
        if (g === 0 || g === 1 || g === 2 || g === 3) { motionWord = g; st.motion = g; st.canned = null; }
        else if ([73, 74, 76, 81, 82, 83, 84, 85, 86, 87, 88, 89].includes(g)) {
          st.canned = { g, R: w.R, Z: w.Z, Q: w.Q, initZ: st.pos.z };
          motionWord = g;
        }
      });
      if (st.ended) continue;
      if (M.includes(30) || M.includes(2)) {
        if (ln < lines.length - 5) add('INFO', ln, 'Program end (M30). Code below this line is only checked for offset mistakes, not simulated.');
        st.ended = true;
        continue;
      }
      const hasXYZ = w.X != null || w.Y != null || w.Z != null;
      if (!hasXYZ) continue;
      if (st.needG43 && st.tool != null && w.Z != null && !st.lenOn && !G.includes(43) && !setup.autoLength) {
        add('CHECK', ln, 'Z move after the T' + st.tool + ' tool change before G43. Only safe if your control applies tool length automatically at M06; otherwise the tool comes down a full tool length too low.', 'noG43|' + ln);
      }

      if (st.canned && (motionWord === null || motionWord === st.canned.g)) {
        const c = st.canned;
        if (w.R != null) c.R = w.R; if (w.Z != null && motionWord !== null) c.Z = w.Z;
        if (c.R == null || c.Z == null) { add('CRASH', ln, 'Drilling cycle missing R or Z.'); continue; }
        if (w.X == null && w.Y == null && motionWord === null) continue;
        const xy = { x: w.X != null ? (st.abs ? w.X : st.pos.x + w.X) : st.pos.x, y: w.Y != null ? (st.abs ? w.Y : st.pos.y + w.Y) : st.pos.y };
        if (w.X != null && w.Y != null || st.xyKnown) st.xyKnown = true;
        const z0 = st.pos.z;
        const clearZ = Math.max(z0 > HOME_Z / 2 ? c.R : z0, c.R);
        if (motionWord !== null) c.initZ = z0;
        if (c.R < stock.top - 1e-4 && heightUnder(...toStock({ x: xy.x, y: xy.y, z: 0 }).slice(0, 2), getDisc(st.tool)) > c.R + (+wcsShift(st.wcs).z || 0))
          add('CRASH', ln, 'Drill cycle R plane (R' + c.R + ') is below the top of the blank here.', 'cR|' + ln);
        run('rapid', ln, [{ x: xy.x, y: xy.y, z: z0 > HOME_Z / 2 ? c.R : z0 }]);
        run('rapid', ln, [{ x: xy.x, y: xy.y, z: c.R }]);
        if (st.spindle === 0 && !isProbe(st.tool) && c.g !== 74 && c.g !== 84) add('CRASH', ln, 'Drilling with the spindle stopped.', 'spin|' + ln);
        run('feed', ln, [{ x: xy.x, y: xy.y, z: c.Z }]);
        const back = st.retract98 ? Math.max(c.initZ > HOME_Z / 2 ? c.R : c.initZ, c.R) : c.R;
        run('rapid', ln, [{ x: xy.x, y: xy.y, z: back }]);
        continue;
      }

      const tp = target(w);
      if (w.X != null && w.Y != null) st.xyKnown = true;
      else if (!st.xyKnown && (w.X != null || w.Y != null)) st.xyKnown = !st.abs ? false : st.xyKnown;
      const m = st.motion;
      if (m === 0) {
        // dogleg warning: XY and Z down together near the part
        const sp = toStock(st.pos), tq = toStock(tp);
        if ((w.X != null || w.Y != null) && w.Z != null && tq[2] < sp[2] - 1e-4 && tq[2] < stock.top + 0.25 && st.xyKnown)
          add('CHECK', ln, 'Rapid moves XY and drops Z at the same time close to the part. Some machines dog-leg this move.', 'dog|' + ln);
        run('rapid', ln, [tp]);
      } else if (m === 1) run('feed', ln, [tp]);
      else if (m === 2 || m === 3) run('feed', ln, arcPoints(st.pos, tp, m === 2, w, ln));
    }

    // travel check
    const mt = setup.machine || {};
    if (st.ext) {
      const e = st.ext, sx = e.x1 - e.x0, sy = e.y1 - e.y0, sz = e.z1 - e.z0;
      [['X', sx, mt.x], ['Y', sy, mt.y], ['Z', sz, mt.z]].forEach(([a, span, lim]) => {
        if (lim && span > lim) issues.push({ sev: 'CRASH', line: 0, text: '', msg: 'Program moves ' + span.toFixed(2) + ' in ' + a + ', more than the machine travel (' + lim + '). It will overtravel.' });
      });
    }
    // group repeats of the same problem
    const groups = {}, grouped = [];
    issues.forEach(it => {
      const g = it.sev + '|' + (it.kind || it.msg) + '|' + (it.afterEnd ? 1 : 0);
      if (groups[g]) { groups[g].lines.push(it.line); if (it.pt) groups[g].pts.push(it.pt); return; }
      it.lines = [it.line]; it.pts = it.pt ? [it.pt] : []; groups[g] = it; grouped.push(it);
    });
    issues.length = 0; grouped.forEach(i => issues.push(i));
    const order = { CRASH: 0, CHECK: 1, INFO: 2 };
    issues.sort((a, b) => (a.afterEnd ? 1 : 0) - (b.afterEnd ? 1 : 0) || order[a.sev] - order[b.sev] || a.line - b.line);
    return { issues, paths, stock, extents: st.ext, info };
  }

  const api = { scan, check, makeStock, words, stripComments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CNCCore = api;
})(this);
