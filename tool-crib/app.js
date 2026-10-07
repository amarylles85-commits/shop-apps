/* Tool Crib UI. Data lives on this device: tools/history/settings in localStorage, photos in IndexedDB. */
(function () {
  'use strict';
  const C = window.Crib;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const K = { tools: 'toolcrib.tools', hist: 'toolcrib.hist', set: 'toolcrib.set', photos: 'toolcrib.photos' };
  const S = { tools: [], hist: [], set: { th: 2, lastSummary: '', grid: false }, pv: null, found: null, scanStop: null, view: 'list', f: { q: '', st: 'all', type: '', loc: '' }, sort: 'status', undo: [], photos: {}, edit: null, imp: null, histN: 150 };
  let SWREG = null;
  const ICON = (document.querySelector('link[rel=icon]') || {}).href || '';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const today = () => new Date().toDateString();
  const st = t => t.uncounted ? 'count' : C.status(t, S.set.th);
  const LABEL = Object.assign({}, C.STATUS_LABEL, { count: 'Not counted' });
  const RANK = { out: 0, soon: 1, ok: 2, count: 3, na: 4 };
  const isLow = t => { const s = st(t); return s === 'out' || s === 'soon'; };
  const lowList = () => S.tools.filter(isLow);

  // ---------------- storage ----------------
  function load() {
    const j = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
    S.tools = j(K.tools, []); S.hist = j(K.hist, []); S.set = Object.assign({ th: 2, lastSummary: '' }, j(K.set, {}));
  }
  function save() {
    try {
      if (S.hist.length > 3000) S.hist = S.hist.slice(-3000);
      localStorage.setItem(K.tools, JSON.stringify(S.tools)); localStorage.setItem(K.hist, JSON.stringify(S.hist)); localStorage.setItem(K.set, JSON.stringify(S.set));
    } catch (e) { toast('Could not save: this phone\'s storage for the app is full. Back up and remove photos.'); }
  }
  const PDB = {
    db: null,
    open() { return new Promise(res => { try { const r = indexedDB.open('toolcrib', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos'); r.onsuccess = () => { PDB.db = r.result; res(true); }; r.onerror = () => res(false); r.onblocked = () => res(false); } catch (e) { res(false); } }); },
    all() {
      return new Promise(res => {
        if (!PDB.db) { try { return res(JSON.parse(localStorage.getItem(K.photos) || '{}')); } catch (e) { return res({}); } }
        const out = {}; try { const rq = PDB.db.transaction('photos').objectStore('photos').openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); }; rq.onerror = () => res(out); } catch (e) { res(out); }
      });
    },
    put(id, url) { if (url) S.photos[id] = url; else delete S.photos[id]; if (!PDB.db) { try { localStorage.setItem(K.photos, JSON.stringify(S.photos)); } catch (e) { toast('Photo not saved: storage full'); } return; } try { const os = PDB.db.transaction('photos', 'readwrite').objectStore('photos'); url ? os.put(url, id) : os.delete(id); } catch (e) { } }
  };

  // ---------------- changes, undo, history, alerts ----------------
  const statusMap = () => { const m = {}; S.tools.forEach(t => m[t.id] = st(t)); return m; };
  function logDiff(oldTools, why, logZeroIds) {
    const om = new Map(oldTools.map(t => [t.id, t])), nm = new Map(S.tools.map(t => [t.id, t])), ts = new Date().toISOString();
    S.tools.forEach(t => {
      const o = om.get(t.id), q = +t.qty || 0;
      if (!o) S.hist.push({ ts, id: t.id, name: t.name, d: q, q, why: why === 'Edited' ? 'New tool' : why });
      else if ((+o.qty || 0) !== q) S.hist.push({ ts, id: t.id, name: t.name, d: q - (+o.qty || 0), q, why });
      else if (logZeroIds && logZeroIds.includes(t.id)) S.hist.push({ ts, id: t.id, name: t.name, d: 0, q, why });
    });
    oldTools.forEach(o => { if (!nm.has(o.id)) S.hist.push({ ts, id: o.id, name: o.name, d: -(+o.qty || 0), q: 0, why: why === 'Undo' ? 'Undo (removed)' : 'Deleted' }); });
  }
  // every data change goes through here: undo snapshot, history, save, re-render, status-crossing alerts
  function commit(label, fn, why, opts) {
    opts = opts || {};
    const before = statusMap(), old = JSON.parse(JSON.stringify(S.tools)), oldTh = S.set.th;
    if (fn() === false) return false;
    S.undo.push({ label, tools: old, th: oldTh }); if (S.undo.length > 30) S.undo.shift();
    logDiff(old, why || label, opts.logZero);
    save(); after(before);
    if (opts.toast !== false) toast(opts.toast || label, true);
    return true;
  }
  function undo() {
    const u = S.undo.pop(); if (!u) return;
    const before = statusMap(), old = S.tools;
    S.tools = u.tools; S.set.th = u.th;
    logDiff(old, 'Undo', null);
    S.hist.forEach(h => { if (h.why === 'Undo') h.why = 'Undo: ' + u.label; });
    save(); after(before); toast('Undone: ' + u.label);
  }
  function after(before) {
    renderAll();
    const worse = S.tools.filter(t => before[t.id] && before[t.id] !== 'count' && RANK[st(t)] < Math.min(RANK[before[t.id]], 2));
    if (worse.length) crossAlert(worse);
    setBadge();
  }
  function crossAlert(list) {
    const out = list.filter(t => st(t) === 'out');
    let title, body, cls = out.length ? 'red' : 'amb';
    if (list.length === 1) {
      const t = list[0];
      title = (st(t) === 'out' ? 'Out: ' : 'Order soon: ') + t.name;
      body = (+t.qty || 0) + ' left, reorder point ' + (+t.rp || 0) + (t.loc ? ' · ' + t.loc : '') + (t.vendor ? ' · ' + t.vendor : '');
    } else {
      title = list.length + ' tools need ordering';
      body = list.map(t => t.name + ' (' + (+t.qty || 0) + ')').join(', ');
    }
    const bar = $('#alertBar');
    bar.innerHTML = '<button class="banner ' + cls + '" data-act="goOrder" id="alertBtn">⚠ ' + esc(title) + '<small>' + esc(body) + ' · Tap for the order list</small></button>';
    bar.classList.add('on'); clearTimeout(crossAlert.tm); crossAlert.tm = setTimeout(() => bar.classList.remove('on'), 7000);
    notify(title, body, 'toolcrib-cross');
    if (navigator.vibrate) try { navigator.vibrate(120); } catch (e) { }
  }
  function notify(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const o = { body, tag: tag || 'toolcrib', icon: ICON, badge: ICON, renotify: true };
    try { if (SWREG && SWREG.showNotification) { SWREG.showNotification(title, o).catch(() => { try { new Notification(title, o); } catch (e) { } }); return true; } } catch (e) { }
    try { new Notification(title, o); return true; } catch (e) { return false; }   // Android Chrome needs the service worker path above
  }
  function setBadge() {
    const n = lowList().length;
    try { if (n && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => { }); else if (!n && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => { }); } catch (e) { }
  }
  function dailySummary() {
    const low = lowList(); if (!low.length || S.set.lastSummary === today()) return false;
    const out = low.filter(t => st(t) === 'out').length;
    const ok = notify('Tool Crib: ' + low.length + ' tool' + (low.length > 1 ? 's' : '') + ' to order', (out ? out + ' out, ' : '') + (low.length - out) + ' order soon. ' + low.slice(0, 4).map(t => t.name).join(', ') + (low.length > 4 ? '…' : ''), 'toolcrib-daily');
    if (ok) { S.set.lastSummary = today(); save(); }
    return ok;
  }
  function toast(msg, withUndo) {
    $('#toastMsg').textContent = msg; $('#toastUndo').style.display = withUndo && S.undo.length ? '' : 'none';
    $('#toast').classList.add('on'); clearTimeout(toast.tm); toast.tm = setTimeout(() => $('#toast').classList.remove('on'), 4500);
  }

  // ---------------- views ----------------
  function go(v) {
    S.view = v; $('#toast').classList.remove('on'); $('#alertBar').classList.remove('on');
    document.querySelectorAll('main>section').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    $('#fab').style.display = (v === 'list' && S.tools.length) ? '' : 'none';
    if (v !== 'edit' && v !== 'paper') stopJobs();
    renderAll(); window.scrollTo(0, 0);
  }
  function renderAll() {
    const low = lowList(), out = low.filter(t => st(t) === 'out').length;
    $('#orderBadge').innerHTML = low.length ? '<span class="badge' + (out ? '' : ' amb') + '" id="badgeN">' + low.length + '</span>' : '';
    $('#undoBtn').disabled = !S.undo.length;
    $('#fab').style.display = (S.view === 'list' && S.tools.length) ? '' : 'none';
    ({ list: renderList, order: renderOrder, history: renderHist, more: renderMore, edit: () => { }, import: () => { }, paper: renderPaper })[S.view]();
    if (S.found && $('#sheetBg').classList.contains('on')) renderFound();
  }
  function bannerHTML() {
    const low = lowList(), out = low.filter(t => st(t) === 'out');
    if (!S.tools.length) return '';
    if (!low.length) return '<div class="banner grn" id="banner">✓ Everything is stocked<small>' + S.tools.length + ' tools · alerts at reorder point + ' + S.set.th + '</small></div>';
    const soon = low.length - out.length;
    return '<button class="banner ' + (out.length ? 'red' : 'amb') + '" id="banner" data-act="goOrder">⚠ ' + low.length + ' tool' + (low.length > 1 ? 's' : '') + ' to order' +
      '<small>' + [out.length ? out.length + ' out' : '', soon ? soon + ' order soon' : ''].filter(Boolean).join(', ') + ' · Tap to see the order list</small></button>';
  }
  function renderList() {
    if (!S.tools.length) {
      $('#listTop').innerHTML = '';
      $('#listBody').innerHTML = `<div class="card welcome" id="welcome"><div class="big">🧰</div><h2>Your tool crib is empty</h2>
        <p class="hint">Keep count of end mills, drills, taps and inserts. Tap −1 when you pull one and the app tells you when it's time to order.</p>
        <button class="btn" data-act="addPhoto">📷 Add from photo<small>Snap the label or box. I read the brand, size, part # and barcode</small></button>
        <button class="btn sec" data-act="add">＋ Type it in<small>A few taps: type, size, how many</small></button>
        <button class="btn sec" data-act="pickNC">📄 Import from a program<small>Reads the T numbers and sizes out of .nc files</small></button>
        <button class="btn sec" data-act="pickCSV">📊 Import a spreadsheet (CSV)<small>From Excel, Google Sheets or another phone</small></button>
        <button class="btn sec" data-act="sample">🧪 Load sample data<small>10 example tools so you can try it out</small></button>
        <button class="btn sec" data-act="pickJSON">♻️ Restore a backup</button></div>`;
      return;
    }
    const cnt = s => S.tools.filter(t => s === 'low' ? isLow(t) : st(t) === s).length;
    const chips = [['all', 'All', S.tools.length], ['low', 'To order', cnt('low')], ['out', 'Out', cnt('out')], ['ok', 'OK', cnt('ok')]];
    if (cnt('count')) chips.push(['count', 'Not counted', cnt('count')]);
    if (cnt('na')) chips.push(['na', 'Not tracked', cnt('na')]);
    const types = C.TYPES.filter(t => S.tools.some(x => x.type === t));
    const locs = [...new Set(S.tools.map(t => (t.loc || '').trim()).filter(Boolean))].sort();
    $('#listTop').innerHTML = bannerHTML() + `
      <div class="search"><input id="q" type="search" placeholder="Search name, size, P/N, bin…" value="${esc(S.f.q)}" autocomplete="off"><button class="scanBtn" data-act="scan" id="scanBtn" title="Scan a barcode or QR">▥ Scan</button></div>
      <div class="fchips">${chips.map(c => `<button class="fchip${S.f.st === c[0] ? ' on' : ''}" data-act="fst" data-v="${c[0]}">${c[1]} ${c[2]}</button>`).join('')}</div>
      <div class="selrow">
        <select id="fType"><option value="">All types</option>${types.map(t => `<option${S.f.type === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select id="fLoc"><option value="">All bins</option>${locs.map(t => `<option${S.f.loc === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <select id="fSort"><option value="status"${S.sort === 'status' ? ' selected' : ''}>Sort: status</option><option value="name"${S.sort === 'name' ? ' selected' : ''}>Sort: name</option><option value="qty"${S.sort === 'qty' ? ' selected' : ''}>Sort: qty</option></select>
        <button class="gridBtn" data-act="grid" id="gridBtn" title="${S.set.grid ? 'List view' : 'Photo grid'}">${S.set.grid ? '☰' : '▦'}</button>
      </div>`;
    renderRows();
  }
  function filtered() {
    const q = S.f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let a = S.tools.filter(t => {
      const s = st(t);
      if (S.f.st === 'low' ? !isLow(t) : (S.f.st !== 'all' && s !== S.f.st)) return false;
      if (S.f.type && t.type !== S.f.type) return false;
      if (S.f.loc && (t.loc || '').trim() !== S.f.loc) return false;
      if (q.length) { const hay = [t.name, t.type, t.diaText, C.diaShow(t), t.material, t.vendor, t.pn, t.code, t.loc, t.notes, t.tnum != null ? 'T' + t.tnum : ''].join(' ').toLowerCase(); if (!q.every(w => hay.includes(w))) return false; }
      return true;
    });
    const byName = (x, y) => x.name.localeCompare(y.name, undefined, { numeric: true });
    if (S.sort === 'name') a.sort(byName);
    else if (S.sort === 'qty') a.sort((x, y) => (+x.qty || 0) - (+y.qty || 0) || byName(x, y));
    else a.sort((x, y) => RANK[st(x)] - RANK[st(y)] || byName(x, y));
    return a;
  }
  function rowHTML(t) {
    const s = st(t), ph = S.photos[t.id];
    const sub = [C.diaShow(t), t.flutes ? t.flutes + ' FL' : '', t.material].filter(Boolean).join(' · ');
    const sub2 = [t.loc ? '📍 ' + t.loc : '', t.vendor, t.tnum != null && t.tnum !== '' ? 'T' + t.tnum : ''].filter(Boolean).join(' · ');
    return `<div class="tool ${s === 'count' ? 'na' : s}" data-id="${t.id}">
      <div class="top"><div class="ph">${ph ? `<img src="${ph}" alt="">` : esc(C.ABBR[t.type] || '•')}</div>
        <button class="info" data-act="open"><div class="nm">${esc(t.name)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${sub2 ? `<div class="sub">${esc(sub2)}</div>` : ''}<span class="st ${s === 'count' ? 'na' : s}">${LABEL[s]}</span></button>
        <div class="qty"><b>${+t.qty || 0}</b><small>on hand</small>${t.track === false ? '' : `<small>reorder at ${+t.rp || 0}</small>`}</div></div>
      <div class="acts"><button class="use" data-act="use">−1 Used one</button><button class="plus" data-act="plus">+1</button><button data-act="restock">Restock</button></div></div>`;
  }
  function cellHTML(t) {
    const s = st(t), ph = S.photos[t.id];
    return `<button class="cell ${s === 'count' ? 'na' : s}" data-id="${t.id}" data-act="open"><div class="cimg">${ph ? `<img src="${ph}" alt="">` : `<span>${esc(C.ABBR[t.type] || '•')}</span>`}</div>
      <div class="cq">${+t.qty || 0}</div><div class="cn">${esc(t.name)}</div></button>`;
  }
  function renderRows() {
    const a = filtered();
    $('#listBody').innerHTML = !a.length ? '<div class="empty">No tools match. <button class="btn small sec" data-act="clearF">Clear filters</button></div>'
      : S.set.grid ? '<div class="grid" id="grid">' + a.map(cellHTML).join('') + '</div>' : a.map(rowHTML).join('');
  }

  // ---------- order view ----------
  function renderOrder() {
    const groups = C.orderList(S.tools.filter(t => !t.uncounted), S.set.th);
    if (!groups.length) { $('#orderBody').innerHTML = '<div class="card empty" id="orderEmpty"><div style="font-size:40px">✓</div><h2>Nothing to order</h2><p class="hint">Tools show up here when they drop to their reorder point + ' + S.set.th + '.</p></div>'; return; }
    const n = groups.reduce((s, g) => s + g.items.length, 0), grand = groups.reduce((s, g) => s + (g.total || 0), 0);
    $('#orderBody').innerHTML = `<div class="card"><h2>Order list · ${n} tool${n > 1 ? 's' : ''}</h2><p class="hint">Order qty brings each tool up to its "order up to" number (reorder point + 5 unless you set it).${grand ? ' Estimated total <b>' + C.money(Math.round(grand * 100) / 100) + '</b>.' : ''}</p>
      <div class="row"><button class="btn sec" data-act="copyOrder">📋 Copy as text</button><button class="btn sec" data-act="csvOrder">⬇ Export CSV</button></div></div>` +
      groups.map(g => `<div class="card vgroup"><h3><span>${esc(g.vendor)}</span><span class="muted">${g.total != null ? C.money(g.total) : ''}</span></h3>` +
        g.items.map(i => { const t = i.tool; return `<div class="oitem" data-id="${t.id}"><div class="oq">${i.qty}<small>order</small></div><div class="od"><b>${esc(t.name)}</b>
          <span class="muted">${[t.pn ? 'P/N ' + esc(t.pn) : '', 'have ' + (+t.qty || 0), i.cost != null ? C.money(+t.price) + ' ea' : ''].filter(Boolean).join(' · ')}</span><br><span class="st ${i.status}">${LABEL[i.status]}</span></div>
          <button class="btn small sec" data-act="restock" data-q="${i.qty}">Got it</button></div>`; }).join('') + '</div>').join('');
  }
  const orderGroups = () => C.orderList(S.tools.filter(t => !t.uncounted), S.set.th);
  const dateStr = () => new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fileDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // ---------- history ----------
  function renderHist() {
    const h = S.hist.slice().reverse();
    if (!h.length) { $('#histBody').innerHTML = '<div class="card empty">No changes yet. Every −1, +1, restock and edit shows up here.</div>'; return; }
    const fmt = ts => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    $('#histBody').innerHTML = `<div class="card"><h2>History</h2><p class="hint">${h.length} change${h.length > 1 ? 's' : ''} on this phone, newest first.</p><div id="histList">` +
      h.slice(0, S.histN).map(e => `<div class="hist"><div class="d ${e.d < 0 ? 'neg' : e.d > 0 ? 'pos' : ''}">${e.d > 0 ? '+' : e.d < 0 ? '−' : ''}${Math.abs(e.d)}</div><div class="w"><b>${esc(e.name)}</b> → ${e.q}<small>${esc(e.why)} · ${fmt(e.ts)}</small></div></div>`).join('') +
      `</div>${h.length > S.histN ? '<button class="btn sec" data-act="moreHist">Show more</button>' : ''}<div class="row"><button class="btn sec" data-act="csvHist">⬇ Export history CSV</button><button class="btn red" data-act="clearHist">Clear history</button></div></div>`;
  }

  // ---------- more ----------
  function notifState() {
    if (!('Notification' in window)) return ['none', 'Not available here. On iPhone this needs the hosted app added to the Home Screen; local files can\'t send phone alerts.'];
    if (location.protocol === 'file:') return [Notification.permission, 'Opened as a local file. Chrome usually blocks phone alerts for local files; in-app alerts still work.'];
    return [Notification.permission, ({ granted: 'Phone alerts are on.', denied: 'Blocked. Turn notifications back on for this site in your phone\'s browser settings.', default: 'Off. Tap the button to allow them.' })[Notification.permission]];
  }
  function renderMore() {
    const [ns, nmsg] = notifState();
    $('#moreBody').innerHTML = `
      <div class="card"><h2>When to warn me</h2><p class="hint">A tool shows <b>Order soon</b> when the count is at or below its reorder point + this number, and <b>Out</b> at 0.</p>
        <div class="stepper"><button data-act="th" data-d="-1">−</button><div class="val" id="thVal">${S.set.th}<small>above reorder point</small></div><button data-act="th" data-d="1">+</button></div></div>
      <div class="card"><h2>Phone notifications</h2><p class="hint" id="notifState">${esc(nmsg)}</p>
        ${ns === 'default' ? '<button class="btn" data-act="askNotif" id="askNotif">🔔 Turn on phone alerts</button>' : ''}
        ${ns === 'granted' ? '<button class="btn sec" data-act="testNotif">Send a test alert</button>' : ''}
        <div class="warn" style="margin-top:12px">What to expect: the app checks your counts only while it's open. It alerts (banner on screen, plus a phone notification if allowed) the moment a tool crosses into Order soon or Out, and once a day when you open it if anything is low. It can't wake up and notify you in the background: there's no server behind it yet.<br><br><b>iPhone:</b> phone notifications only work from a hosted copy added to the Home Screen (iOS 16.4+), opened from that icon. A file opened from Files can't notify.<br><b>Android:</b> works in Chrome from a hosted copy; a local file shows in-app alerts only.</div></div>
      <div class="card"><h2>Add tools</h2>
        <button class="btn sec" data-act="pickNC">📄 Import from a CNC program</button>
        <button class="btn sec" data-act="pickCSV">📊 Import CSV</button>
        <button class="btn sec" data-act="sample">🧪 Load sample data</button></div>
      <div class="card"><h2>Move data between phones</h2><p class="hint">Everything is saved <b>on this phone only</b>. Another phone won't see it until the app is hosted with sync. Use a backup to move it, and make one now and then.</p>
        <button class="btn sec" data-act="csvAll">⬇ Export tools as CSV</button>
        <button class="btn sec" data-act="backup">💾 Back up everything (JSON, with photos)</button>
        <button class="btn sec" data-act="pickJSON">♻️ Restore a backup</button></div>
      <div class="card"><h2>Danger zone</h2><button class="btn red" data-act="wipe">Erase all data on this phone</button></div>
      <p class="muted" style="text-align:center">Tool Crib · ${S.tools.length} tools · ${Object.keys(S.photos).length} photos</p>`;
  }

  // ---------- add / edit ----------
  const MATS = ['Carbide', 'HSS', 'Cobalt', 'AlTiN', 'TiAlN', 'TiN', 'TiCN', 'ZrN', 'DLC', 'Uncoated'];
  const DIAS = { 'Tap': ['4-40', '6-32', '8-32', '10-32', '1/4-20', '5/16-18', '3/8-16', '1/2-13', 'M6x1'], 'Drill': ['#7', '#21', '#29', '#36', 'F', '1/8', '1/4', '5/16', '3/8', '1/2'], 'Face mill': ['1-1/2', '2', '2-1/2', '3', '4'], 'Insert': [], 'Holder': [] };
  const DEF_DIAS = ['1/8', '3/16', '1/4', '5/16', '3/8', '7/16', '1/2', '5/8', '3/4', '1'];
  function openEdit(t, opts) {
    opts = opts || {}; closeSheet();
    S.edit = { isNew: !t, d: t ? JSON.parse(JSON.stringify(t)) : { name: '', type: 'End mill', diaText: '', flutes: null, material: '', length: '', vendor: '', pn: '', code: '', price: null, loc: '', qty: 1, rp: 0, target: null, track: true, tnum: null, notes: '' },
      photos: t ? photosOf(t.id) : [], jobs: t ? photosOf(t.id).map(() => ({ done: true })) : [], F: null, ch: {}, auto: new Set(), user: new Set(), photoMode: !!opts.photo, offline: false, err: '' };
    go('edit'); renderEdit();
  }
  function stepper(f, val, small) { return `<div class="stepper"><button data-act="step" data-f="${f}" data-d="-1">−</button><div class="val" id="sv-${f}">${val}${small ? '<small>' + small + '</small>' : ''}</div><button data-act="step" data-f="${f}" data-d="1">+</button></div>`; }
  function renderEdit() {
    const ae = document.activeElement, af = ae && ae.dataset && ae.closest && ae.closest('#editBody') ? ae.dataset.f : null, ass = af ? ae.selectionStart : null;
    renderEdit0();
    if (af) { const n = document.querySelector('#editBody [data-f="' + af + '"]'); if (n) { n.focus(); try { if (ass != null) n.setSelectionRange(ass, ass); } catch (e) { } } }
  }
  function renderEdit0() {
    const E = S.edit, d = E.d;
    const used = k => [...new Set(S.tools.map(t => (t[k] || '').trim()).filter(Boolean))].slice(0, 10);
    const dias = DIAS[d.type] || DEF_DIAS, p = C.parseDia(d.diaText);
    const auto = C.autoName(d), tgtAuto = d.target == null;
    $('#editBody').innerHTML = `<div id="photoCard">${photoPanelHTML()}</div><div class="card" id="formCard"><h2>${E.isNew ? (E.photos.length ? 'Check and save' : 'Add a tool') : 'Edit tool'}</h2>
      ${E.err ? `<div class="warn" id="editErr">${esc(E.err)}</div>` : ''}
      <label>Type</label><div class="tchips">${C.TYPES.map(t => `<button data-act="type" data-v="${t}" class="${d.type === t ? 'on' : ''}">${t}</button>`).join('')}</div>
      <label>Diameter / size</label><input data-f="diaText" id="fDia" value="${esc(d.diaText)}" placeholder='1/2, .500, #7, F, 12mm, 1/4-20' autocomplete="off" autocapitalize="characters">
      <div class="parsed${d.diaText && !p ? ' bad' : ''}" id="diaParsed">${diaMsg(d.diaText)}</div>
      ${dias.length ? `<div class="qchips">${dias.map(v => `<button data-act="dia" data-v="${v}" class="${d.diaText === v ? 'on' : ''}">${v}</button>`).join('')}</div>` : ''}
      <label>Flutes</label><div class="qchips">${[null, 1, 2, 3, 4, 5, 6, 8].map(v => `<button data-act="fl" data-v="${v == null ? '' : v}" class="${(d.flutes || null) === v ? 'on' : ''}">${v == null ? '—' : v}</button>`).join('')}</div>
      <label>Material / coating</label><input data-f="material" value="${esc(d.material)}" placeholder="Carbide AlTiN">
      <div class="qchips">${MATS.map(m => `<button data-act="mat" data-v="${m}" class="${(' ' + d.material + ' ').toLowerCase().includes(' ' + m.toLowerCase() + ' ') ? 'on' : ''}">${m}</button>`).join('')}</div>
      <label>On hand</label>${stepper('qty', +d.qty || 0)}
      ${d.uncounted ? '<div class="warn">Not counted yet. Set how many you have (tap + or −), or <button class="btn small sec" data-act="counted0">There are 0</button></div>' : ''}
      <label>Reorder point <span class="muted">(order when it gets down to this)</span></label>${stepper('rp', +d.rp || 0)}
      <label class="toggle"><input type="checkbox" data-f="track" ${d.track !== false ? 'checked' : ''}> Track stock and warn me when low</label>
      <label>Name <span class="muted">(blank = "${esc(auto || 'pick a type and size')}")</span></label><input data-f="name" id="fName" value="${esc(d.name)}" placeholder="${esc(auto || 'e.g. 1/2&quot; 4FL Carbide End mill')}">
      <details style="margin-top:14px"${E.isNew && !E.photos.length ? '' : ' open'}><summary class="muted">Vendor, part #, barcode, price, bin, more</summary>
        <label>Location / bin</label><input data-f="loc" value="${esc(d.loc)}" placeholder="Drawer A1">
        ${used('loc').length ? `<div class="qchips">${used('loc').map(v => `<button data-act="setf" data-f="loc" data-v="${esc(v)}" class="${d.loc === v ? 'on' : ''}">${esc(v)}</button>`).join('')}</div>` : ''}
        <label>Vendor</label><input data-f="vendor" value="${esc(d.vendor)}" placeholder="Harvey Tool">
        ${used('vendor').length ? `<div class="qchips">${used('vendor').map(v => `<button data-act="setf" data-f="vendor" data-v="${esc(v)}" class="${d.vendor === v ? 'on' : ''}">${esc(v)}</button>`).join('')}</div>` : ''}
        <div class="row"><div><label>Part #</label><input data-f="pn" value="${esc(d.pn)}" autocapitalize="characters"></div><div><label>Price each ($)</label><input data-f="price" value="${d.price == null ? '' : d.price}" inputmode="decimal"></div></div>
        <label>Order up to <span class="muted">(how many to have after an order)</span></label>${stepper('target', tgtAuto ? 'Auto' : d.target, tgtAuto ? '= ' + ((+d.rp || 0) + 5) : '')}
        ${tgtAuto ? '' : '<button class="btn small sec" data-act="tgtAuto">Back to auto</button>'}
        <div class="row"><div><label>Length</label><input data-f="length" value="${esc(d.length)}" placeholder='3" OAL'></div><div><label>T# (pocket)</label><input data-f="tnum" value="${d.tnum == null ? '' : d.tnum}" inputmode="numeric"></div></div>
        <label>Barcode / QR</label><input data-f="code" id="fCode" value="${esc(d.code || '')}" placeholder="Scanned from the box" autocomplete="off">
        ${codeDupHTML()}
        <label>Notes</label><textarea data-f="notes">${esc(d.notes)}</textarea>
      </details></div>
      <div class="formbar"><button class="btn sec" data-act="cancelEdit">Cancel</button><button class="btn" data-act="saveEdit" id="saveBtn">${E.isNew ? 'Add tool' : 'Save'}</button></div>
      ${E.isNew ? '' : '<button class="btn red" data-act="delTool" id="delBtn">Delete this tool</button>'}`;
  }
  function diaMsg(s) {
    if (!s) return '';
    const p = C.parseDia(s); if (!p) return 'Not a size I know. It will be saved as typed.';
    return '= ' + C.fmtDec(p.in) + ' in' + (p.mm ? ' (' + p.mm + ' mm)' : '') + (p.kind === 'tap' ? ' major dia' : '');
  }
  function saveEdit() {
    const E = S.edit, d = E.d;
    d.name = (d.name || '').trim() || C.autoName(d);
    if (!d.code) delete d.codeFormat;
    if (!d.name) { E.err = 'Give it a name, or pick a type and size so I can name it.'; renderEdit(); window.scrollTo(0, 0); return; }
    const n = v => { v = String(v == null ? '' : v).replace(/[$,\s]/g, ''); return v === '' || !isFinite(+v) ? null : +v; };
    d.price = n(d.price); d.tnum = n(d.tnum); d.flutes = n(d.flutes); d.qty = Math.max(0, Math.round(+d.qty || 0)); d.rp = Math.max(0, Math.round(+d.rp || 0));
    ['diaText', 'material', 'length', 'vendor', 'pn', 'code', 'loc', 'notes'].forEach(k => d[k] = (d[k] || '').trim());
    if (!d.code) { delete d.code; delete d.codeFormat; }
    d.updated = new Date().toISOString();
    if (E.isNew) {
      d.id = uid(); d.created = d.updated;
      commit('Added ' + d.name, () => { S.tools.push(d); }, 'New tool');
    } else {
      commit('Saved ' + d.name, () => { const i = S.tools.findIndex(t => t.id === d.id); if (i < 0) return false; S.tools[i] = d; }, 'Edited', { logZero: [d.id] });
    }
    photoKeys(d.id).forEach((k, i) => { const u = E.photos[i] || null; if ((S.photos[k] || null) !== u) PDB.put(k, u); });
    S.edit = null; go('list');
  }
  function downscale(file) {
    if (file && file.getContext) { const M = 640, k = Math.min(1, M / Math.max(file.width, file.height)), c = document.createElement('canvas'); c.width = Math.round(file.width * k); c.height = Math.round(file.height * k); c.getContext('2d').drawImage(file, 0, 0, c.width, c.height); return Promise.resolve(c.toDataURL('image/jpeg', 0.72)); }
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { const M = 640, k = Math.min(1, M / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.72)); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that photo')); };
      img.src = url;
    });
  }

  // ---------------- photo-first add: photos, label reading, barcodes, measure & count ----------------
  const PK = window.PhotoKit, TV = window.ToolVision, LR = window.LabelRead;
  const MAXPH = 3;
  const pause = (ms) => new Promise(r => setTimeout(r, ms || 30));
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg || 'timed out')), ms))]);
  function photoKeys(id) { return [id, id + '#1', id + '#2']; }
  function photosOf(id) { return photoKeys(id).map(k => S.photos[k]).filter(Boolean); }
  const READ_ORDER = ['type', 'dia', 'vendor', 'pn', 'flutes', 'material', 'coating', 'end', 'cr', 'oal', 'loc', 'shank', 'insert', 'grade', 'pack', 'count', 'code'];
  const FIELD_OF = { dia: 'diaText', type: 'type', flutes: 'flutes', material: 'material', coating: 'material', grade: 'material', oal: 'length', loc: 'length', vendor: 'vendor', pn: 'pn', code: 'code', end: 'name', cr: 'notes', shank: 'notes', pack: 'qty', count: 'qty', insert: 'name' };
  const fieldKey = f => FIELD_OF[f] || f;
  function stopJobs() { /* running jobs check S.edit identity and drop their results once the form is closed */ }
  function chosenIdx(E, f) { const L = (E.F || {})[f] || []; if (E.ch[f] === undefined) return L.length ? 0 : -1; if (E.ch[f] === null) return -1; const i = L.findIndex(c => String(c.v) === E.ch[f]); return i < 0 ? 0 : i; }
  function chipAdd(F, key, v, show, conf, why) {
    const L = F[key] || (F[key] = []), rank = { sure: 3, likely: 2, guess: 1 };
    const ex = L.find(c => String(c.v).toUpperCase() === String(v).toUpperCase());
    if (ex) { if (/measured/.test(why) && !/✓/.test(ex.show)) ex.show += ' ✓ photo'; if (rank[conf] > rank[ex.conf]) ex.conf = conf; return; }
    L.push({ v, show, conf, why });
    L.sort((a, b) => rank[b.conf] - rank[a.conf]);
  }
  function snapsFor(m, type) { return TV ? TV.snapDia(m.dia, undefined, type === 'Drill' ? 'drill' : undefined) : []; }
  function snapShow(sn) { return /^[\d-]+\/\d+$|^\d+$/.test(sn.label) ? sn.label + '"' : /^#|^[A-Z]$/.test(sn.label) ? sn.label + ' drill' : sn.label; }
  function tipHint(E) {
    const ty = (E.user.has('type') || E.auto.has('type')) ? E.d.type : null;
    if (ty === 'Drill' || ty === 'Spot/Chamfer') return 'point';
    if (E.v && E.v.end === 'Ball') return 'ball';
    return undefined;
  }

  function addPhotos(files, opts) {
    const E = S.edit; if (!E) return Promise.resolve(); opts = opts || {};
    const room = MAXPH - E.photos.length;
    if (room <= 0) { toast('Up to 3 photos per tool'); return Promise.resolve(); }
    if (files.length > room) toast('Up to 3 photos per tool. Using the first ' + room + '.');
    return (async () => {
      for (const f of files.slice(0, room)) {
        let url; try { url = await downscale(f); } catch (e) { toast(e.message); continue; }
        if (S.edit !== E) return;
        E.photos.push(url); E.jobs.push({ src: f, codes: opts.codes || null, st: 'Waiting…', p: 0, done: false });
      }
      E.photoMode = true; renderEdit(); runJobs(E);
    })();
  }
  async function runJobs(E) {
    if (E.running) return; E.running = true;
    try { for (let k = 0; k < E.jobs.length; k++) { const j = E.jobs[k]; if (!j.done && j.src) await processPhoto(E, j); } } finally { E.running = false; }
    if (E.jobs.some(j => !j.done && j.src) && S.edit === E) runJobs(E);
  }
  async function processPhoto(E, j) {
    const live = () => S.edit === E && E.jobs.includes(j);
    const upd = (st, p) => { j.st = st; j.p = p; if (live()) renderPhotoPanel(); };
    let img;
    try { img = j.src.getContext ? j.src : await PK.loadImage(j.src); } catch (e) { j.done = true; j.st = ''; j.err = e.message; if (live()) renderPhotoPanel(); return; }
    // 1) tool(s) on paper? measure or count (runs on the phone, no internet needed)
    if (!j.visTried && TV) {
      j.visTried = true; upd('Looking for paper to measure on…', 0.05); await pause();
      try {
        const c = PK.toCanvas(img, 2000), f35 = j.src.getContext ? null : await PK.f35(j.src);
        const r = TV.analyze(PK.imageData(c), { f35, tip: tipHint(E) });
        if (r.ok && r.count) { j.vis = r; j.visCanvas = c; }
      } catch (e) { console.warn('measure', e); }
    }
    if (!live()) return;
    // 2) barcode / QR
    if (!j.codes) { upd('Looking for a barcode…', 0.15); try { j.codes = await withTimeout(PK.readCodes(img, { fast: !!j.vis }), 60000); j.needNetCode = false; } catch (e) { j.codes = null; j.needNet = j.needNetCode = true; E.offline = true; } }
    if (!live()) return;
    // 3) label text (skip for a measuring shot of a bare tool on paper)
    if (!j.vis && !j.ocr) {
      upd('Reading the label…', 0.25);
      try { j.ocr = await withTimeout(PK.ocr(img, (f, m) => upd(m || 'Reading the label…', 0.25 + 0.75 * f)), 120000); j.needNet = !!j.needNetCode; }
      catch (e) { j.needNet = true; E.offline = true; }
    }
    j.done = true; j.st = '';
    if (!live()) return;
    if (!E.jobs.some(x => x.needNet)) E.offline = false;
    mergeReads(E); renderEdit();
  }
  function mergeReads(E) {
    if (!LR) return;
    const done = E.jobs.filter(j => j.done && j.src);
    const text = done.map(j => j.ocr ? j.ocr.text : '').filter(Boolean).join('\n');
    const codes = [].concat(...done.map(j => j.codes || []));
    const r = LR.parse(text, codes), F = r.fields; E.rctx = { insert: r.insert, tapStyle: r.tapStyle };
    const mj = done.find(j => j.vis && j.vis.count === 1 && j.vis.measure && j.vis.measure.ok);
    if (mj) {
      const m = mj.vis.measure, type = E.user.has('type') ? E.d.type : (F.type ? F.type[0].v : null);
      snapsFor(m, type).slice(0, 3).forEach((sn, i) => chipAdd(F, 'dia', sn.label, snapShow(sn) + ' · meas. ' + C.fmtDec(m.dia), i === 0 && Math.abs(sn.err) <= 0.004 ? 'likely' : 'guess', 'measured on paper'));
      chipAdd(F, 'oal', String(+m.oal.toFixed(2)), m.oal.toFixed(2) + '" measured', 'likely', 'measured on paper');
      if (!F.type) chipAdd(F, 'type', m.tip === 'point' ? 'Drill' : 'End mill', m.tip === 'point' ? 'Drill' : 'End mill', 'guess', 'shape on paper');
    }
    const cj = done.find(j => j.vis && j.vis.count > 1);
    if (cj) chipAdd(F, 'count', cj.vis.count, cj.vis.count + ' counted', 'likely', 'counted on paper');
    E.F = F; applyReads(E);
  }
  function applyReads(E) {
    if (!LR || !E.F) return;
    const F = E.F, d = E.d, idx = {}; for (const f in F) idx[f] = chosenIdx(E, f);
    const v = LR.pick(F, idx); E.v = v;
    const t = LR.toTool(v, E.rctx || {});
    const set = (k, val) => {
      if (E.user.has(k)) return;
      const cur = d[k], empty = cur == null || cur === '' || (k === 'type' && E.isNew);
      if (!(empty || E.auto.has(k))) return;
      if (val != null && val !== '') { d[k] = val; E.auto.add(k); }
      else if (E.auto.has(k)) { d[k] = k === 'flutes' ? null : k === 'type' ? 'End mill' : ''; E.auto.delete(k); }
    };
    ['type', 'diaText', 'flutes', 'material', 'length', 'vendor', 'pn', 'code', 'notes', 'name'].forEach(k => set(k, t[k]));
    const ci = idx.code; d.codeFormat = d.code && F.code && F.code[ci] ? F.code[ci].why : d.codeFormat;
    const n = v.count != null ? +v.count : v.pack != null ? +v.pack : null;
    if ((E.isNew || E.auto.has('qty')) && !E.user.has('qty')) { if (n) { d.qty = n; E.auto.add('qty'); } else if (E.auto.has('qty')) { d.qty = 1; E.auto.delete('qty'); } }
    renameAuto(E);
  }
  function renameAuto(E) {
    if (!E || !LR || !E.auto.has('name')) return;
    const v = Object.assign({}, E.v || {}, { dia: E.d.diaText || null, flutes: E.d.flutes, type: E.d.type });
    E.d.name = LR.nameOf(v, E.rctx || {}); const n = $('#fName'); if (n) n.value = E.d.name;
  }
  function dupTool(E) {
    const others = S.tools.filter(t => t.id !== E.d.id), d = E.d;
    if (d.code) { const t = C.findByCode(others, d.code); if (t) return t; }
    if (E.isNew && d.pn && d.pn.length >= 4) return others.find(t => t.pn && t.pn.toUpperCase().replace(/[^A-Z0-9]/g, '') === d.pn.toUpperCase().replace(/[^A-Z0-9]/g, '')) || null;
    return null;
  }
  function codeDupHTML() {
    const E = S.edit; if (!E) return '<span id="codeDup"></span>';
    const t = E.d.code ? C.findByCode(S.tools.filter(x => x.id !== E.d.id), E.d.code) : null;
    return t ? `<div class="warn" id="codeDup">This code is already on <b>${esc(t.name)}</b>. <button class="btn small sec" data-act="openTool" data-id="${t.id}">Open it</button></div>` : '<span id="codeDup"></span>';
  }
  function renderPhotoPanel() { const pc = $('#photoCard'); if (pc && S.view === 'edit' && S.edit) pc.innerHTML = photoPanelHTML(); }
  function photoPanelHTML() {
    const E = S.edit; if (!E) return '';
    const n = E.photos.length;
    if (!n && !E.photoMode) return `<div class="card photoMini"><div class="row"><label class="btn sec filebtn">📷 Add photos<small>I'll read the label</small><input type="file" id="photoIn" accept="image/*" capture="environment"></label>
      <label class="btn sec filebtn">🖼 Gallery<small>Up to 3</small><input type="file" id="photoGal" accept="image/*" multiple></label></div></div>`;
    if (!n) return `<div class="card photoHero" id="photoHero"><h2>📷 Add from photo</h2>
      <p class="hint">Take a photo of the label, the box or the tool. I'll read the brand, size, flutes, coating, part # and barcode for you. Up to 3 photos.</p>
      <label class="btn filebtn bigcam" id="camBtn">📷 Take a photo<input type="file" id="photoIn" accept="image/*" capture="environment"></label>
      <label class="btn sec filebtn">🖼 Choose from gallery<input type="file" id="photoGal" accept="image/*" multiple></label>
      <p class="hint tipline">📏 <b>Measure:</b> lay the tool on a sheet of letter or A4 paper and shoot straight down with all 4 corners showing. <b>Count:</b> spread several on the paper.</p>
      <button class="btn small sec" data-act="typeIn">⌨ Type it in instead</button></div>`;
    const busy = E.jobs.filter(j => j.src && !j.done);
    let h = `<div class="card photoCard"><div class="phStrip">` + E.photos.map((u, i) => `<div class="phT${i ? '' : ' main'}"><img class="photoPrev" src="${u}" alt="" data-act="mainPhoto" data-i="${i}">${i ? '' : '<span class="phMain">Main</span>'}<button class="phX" data-act="rmPhoto" data-i="${i}" aria-label="Remove photo">×</button></div>`).join('') +
      (n < MAXPH ? `<label class="phAdd filebtn">📷<small>Camera</small><input type="file" id="photoIn" accept="image/*" capture="environment"></label><label class="phAdd filebtn">🖼<small>Gallery</small><input type="file" id="photoGal" accept="image/*" multiple></label>` : '') + `</div>`;
    h += busy.map(j => `<div class="job"><span class="spin"></span><span>${esc(j.st || 'Waiting…')}</span><div class="bar"><i style="width:${Math.round((j.p || 0) * 100)}%"></i></div></div>`).join('');
    if (E.offline) h += `<div class="warn" id="offlineNote">📶 Reading labels needs internet the first time. Your photo is saved; fill in the rest below, or <button class="btn small sec" data-act="retryRead">Try again</button> when you have signal.</div>`;
    E.jobs.forEach((j, i) => {
      if (!j.vis) return; const r = j.vis, m = r.measure;
      if (r.count > 1) h += `<button class="btn sec measBtn" data-act="showPaper" data-i="${i}" id="countBtn${i}">🔢 Counted <b>${r.count}</b> tools on the paper · check on photo</button>`;
      else if (m && m.ok) { const sn = snapsFor(m, E.d.type)[0]; h += `<button class="btn sec measBtn" data-act="showPaper" data-i="${i}" id="measBtn${i}">📏 Measured Ø${C.fmtDec(m.dia)}${sn ? ' → <b>' + esc(snapShow(sn)) + '</b>' : ''} · ${m.oal.toFixed(2)}" long · check on photo</button>`; }
    });
    const F = E.F || {}, rows = READ_ORDER.filter(f => F[f] && F[f].length);
    if (rows.length) {
      h += `<div class="reads" id="reads"><h3>Read from your photo <small>tap to pick · tap again to clear</small></h3>` + rows.map(f => {
        const ci = chosenIdx(E, f);
        return `<div class="rf" data-f="${f}"><span class="rk">${esc((LR.FIELD_LABEL || {})[f] || (f === 'count' ? 'Count' : f))}</span><div class="rcs">${F[f].map((c, i) => `<button class="rchip ${c.conf}${ci === i ? ' on' : ''}" data-act="chip" data-f="${f}" data-i="${i}" title="${esc(c.why || '')}">${esc(c.show)}<i>${c.conf}</i></button>`).join('')}</div></div>`;
      }).join('') + `<p class="legend"><i class="sure">sure</i> on the label · <i class="likely">likely</i> · <i class="guess">guess</i>, check it</p></div>`;
    } else if (!busy.length && E.jobs.some(j => j.src && j.done) && !E.offline) h += `<p class="hint" id="noReads">I couldn't read anything useful. Try a closer, sharper photo of the label, or fill it in below.</p>`;
    const dup = dupTool(E);
    if (dup) h += `<div class="warn" id="dupTool">Looks like you already have this: <b>${esc(dup.name)}</b> (${+dup.qty || 0} on hand). <button class="btn small sec" data-act="openTool" data-id="${dup.id}">Open it</button></div>`;
    return h + '</div>';
  }

  // ---------- scan: live camera -> find tool / add new ----------
  async function openScan() {
    closeSheet();
    openSheet(`<h2>Scan a barcode or QR</h2><div class="scanBox" id="scanBox"><video id="scanVid" playsinline muted></video><div class="scanAim"></div></div>
      <p class="hint" id="scanMsg">Point the camera at the code on the box or label.</p>
      <label class="btn sec filebtn">📷 Take a photo instead<input type="file" id="scanPhoto" accept="image/*" capture="environment"></label>
      <button class="btn sec" data-act="closeSheet">Cancel</button>`);
    const vid = $('#scanVid');
    try {
      const stop = await PK.scanLive(vid, (code, frame) => onScanned(code, frame));
      if (!$('#scanVid') || $('#scanVid') !== vid) { stop(); return; }   // sheet closed while the camera was starting
      S.scanStop = stop;
    } catch (e) {
      console.warn('camera: ' + (e && (e.name + ' ' + e.message)));
      const box = $('#scanBox'); if (box) box.style.display = 'none';
      const msg = $('#scanMsg'); if (msg) msg.textContent = (/internet/.test(e.message) ? 'Reading codes needs internet the first time. ' : 'The live camera isn\'t available here. ') + 'Take a photo of the code instead.';
    }
  }
  async function scanFromPhoto(file) {
    const msg = $('#scanMsg'); if (msg) msg.textContent = 'Reading the code…';
    try {
      const img = await PK.loadImage(file), codes = await PK.readCodes(img);
      if (codes.length) return onScanned(codes[0], file);
      if (msg) msg.textContent = 'No barcode or QR found in that photo. Get closer so the code fills the middle, hold steady, and avoid glare.';
    } catch (e) { if (msg) msg.textContent = /internet/.test(e.message) ? 'Reading codes needs internet the first time.' : e.message; }
  }
  function onScanned(code, frame) {
    if (S.scanStop) { try { S.scanStop(); } catch (e) { } S.scanStop = null; }
    try { navigator.vibrate && navigator.vibrate(50); } catch (e) { }
    const t = C.findByCode(S.tools, code.text);
    if (t) { S.found = { id: t.id, code }; S.scanNew = null; renderFound(); }
    else { S.found = null; S.scanNew = { code, frame }; renderUnknown(); }
  }
  function renderFound() {
    const t = S.tools.find(x => x.id === S.found.id); if (!t) { closeSheet(); return; }
    const keep = S.found; openSheet(`<h2>✓ Found it</h2><p class="hint">Code ${esc(keep.code.text)}</p><div id="foundTool">${rowHTML(t)}</div>
      <div class="row"><button class="btn sec" data-act="scanAgain">Scan another</button><button class="btn" data-act="closeSheet">Done</button></div>`); S.found = keep;
  }
  function renderUnknown() {
    const n = S.scanNew, opts = S.tools.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    openSheet(`<h2>New code</h2><p class="hint"><b id="newCode">${esc(n.code.text)}</b> · ${esc(String(n.code.format || '').replace(/_/g, '-'))}<br>This isn't on any tool in your crib yet.</p>
      <button class="btn" data-act="scanAdd" id="scanAddBtn">＋ Add new tool<small style="display:block;font-weight:500;font-size:12px">I'll read the label in the same picture</small></button>
      ${opts.length ? `<label>Or put this code on a tool you already have</label><div class="row"><select id="linkSel">${opts.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><button class="btn small sec" data-act="scanLink" style="flex:none;margin:0">Link</button></div>` : ''}
      <div class="row"><button class="btn sec" data-act="scanAgain">Scan again</button><button class="btn sec" data-act="closeSheet">Close</button></div>`);
    S.scanNew = n;
  }
  function scanAdd() {
    const n = S.scanNew; if (!n) return; closeSheet();
    openEdit(null, { photo: true }); const E = S.edit;
    E.d.code = n.code.text; E.d.codeFormat = n.code.format; E.user.add('code');
    if (n.frame) addPhotos([n.frame], { codes: [n.code] }); else renderEdit();
  }
  function scanLink() {
    const n = S.scanNew, id = ($('#linkSel') || {}).value, t = S.tools.find(x => x.id === id); if (!n || !t) return;
    closeSheet(); commit('Linked code to ' + t.name, () => { t.code = n.code.text; t.codeFormat = n.code.format; }, 'Barcode linked', { toast: 'Code saved on ' + t.name + '. Scanning it will find this tool.' });
  }

  // ---------- measure / count view ----------
  async function countFromPhoto(file, toolId) {
    closeSheet(); toast('Counting…');
    const j = { src: file };
    try {
      const img = await PK.loadImage(file), c = PK.toCanvas(img, 2000); await pause();
      j.vis = TV.analyze(PK.imageData(c), { f35: await PK.f35(file) }); j.visCanvas = c;
      if (!j.vis.ok || !j.vis.count) {   // no paper: maybe it's the box label ("QTY 10")
        try { const codes = await PK.readCodes(img, { quiet: true }); const o = await withTimeout(PK.ocr(img), 120000); const r = LR.parse(o.text, codes); if (r.fields.pack) j.labelQty = +r.fields.pack[0].v; } catch (e) { j.offline = true; }
      }
    } catch (e) { toast(e.message); return; }
    $('#toast').classList.remove('on');
    openPaper(j, { from: 'restock', toolId });
  }
  function openPaper(j, ctx) {
    const r = j.vis || {}, m = r.measure;
    S.pv = { j, from: ctx.from, toolId: ctx.toolId || null, n: r.ok && r.count ? r.count : (j.labelQty || 0), tip: m && m.ok ? m.tip : 'flat', snap: 0 };
    go('paper');
  }
  function pvMeasure() { const r = S.pv.j.vis || {}; return r.ok && r.count === 1 && r.measure && r.measure.ok ? r.measure : null; }
  function pvOal() { const m = pvMeasure(); if (!m) return null; const v = S.pv.tip === m.tip ? m.oal : TV.oalFor(m.geo, S.pv.tip); return isFinite(v) ? v : m.oal; }
  function renderPaper() {
    const P = S.pv; if (!P) { go('list'); return; }
    const r = P.j.vis || {}, m = pvMeasure(), counting = P.from === 'restock' || (r.ok && r.count > 1);
    const t = P.toolId ? S.tools.find(x => x.id === P.toolId) : null, type = S.edit ? S.edit.d.type : (t && t.type);
    let h = `<div class="card"><h2>${counting ? '🔢 Count' : '📏 Measure'} from photo${t ? ': ' + esc(t.name) : ''}</h2>`;
    if (P.j.visCanvas && r.ok) h += `<div class="pvWrap"><canvas id="pvCan"></canvas></div>`;
    if (!r.ok && !P.j.labelQty) h += `<div class="warn" id="pvWarn">${esc(r.msg || 'No paper found')}. Lay the tools on a sheet of letter or A4 paper, spread apart, and shoot from above with all four corners showing.${P.j.offline ? ' (Reading the box label needs internet the first time.)' : ''}</div>`;
    if (m) {
      const oal = pvOal(), snaps = snapsFor(m, type).slice(0, 5), sn = snaps[P.snap];
      h += `<div class="meas" id="measOut"><div><span>Diameter</span><b id="mDia">${C.fmtDec(m.dia)}"</b><small>measured</small></div>
        <div><span>Nearest size</span><b id="mSnap">${sn ? esc(snapShow(sn)) : '—'}</b><small>${sn ? (sn.err >= 0 ? '+' : '−') + Math.abs(sn.err).toFixed(4) + '"' : 'no standard size close'}</small></div>
        <div><span>Length</span><b id="mOal">${oal.toFixed(2)}"</b><small>overall</small></div></div>
        ${snaps.length ? `<label>Nearest standard sizes</label><div class="qchips">${snaps.map((s, i) => `<button data-act="pvSnap" data-i="${i}" class="${P.snap === i ? 'on' : ''}">${esc(snapShow(s))}</button>`).join('')}</div>` : ''}
        <label>Tip shape <span class="muted">(changes the length)</span></label><div class="qchips">${[['flat', 'Flat end'], ['point', 'Drill point'], ['ball', 'Ball']].map(([k, l]) => `<button data-act="pvTip" data-v="${k}" class="${P.tip === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <p class="muted">Good to about ±0.005" on diameter and ±0.03" on length when the paper is flat and the whole sheet is in the shot.</p>`;
    }
    if (counting) {
      h += `<label>How many ${r.ok && r.count ? '(numbered on the photo)' : ''}</label><div class="stepper"><button data-act="pvStep" data-d="-1">−</button><div class="val" id="pvN">${P.n}</div><button data-act="pvStep" data-d="1">+</button></div>`;
      if (r.merged) h += '<div class="warn">Some tools were touching, so I counted those by size. Check the number.</div>';
      if (P.j.labelQty) h += `<p class="hint" id="pvLabelQty">From the box label: ${P.j.labelQty} in the pack.</p>`;
    }
    if (P.from === 'restock' && t) h += `<div class="row"><button class="btn sec" data-act="pvSet" id="pvSet">Set on hand to ${P.n}</button><button class="btn" data-act="pvAdd" id="pvAdd">Add ${P.n}</button></div><button class="btn sec" data-act="pvBack">Cancel</button>`;
    else h += `<div class="row"><button class="btn sec" data-act="pvBack">Back</button><button class="btn" data-act="pvUse" id="pvUse">Use these</button></div>`;
    $('#paperBody').innerHTML = h + '</div>';
    drawPaper();
  }
  function drawPaper() {
    const cv = $('#pvCan'), P = S.pv; if (!cv || !P || !P.j.visCanvas) return;
    const src = P.j.visCanvas, r = P.j.vis, m = pvMeasure(), dpr = window.devicePixelRatio || 1;
    // show the sheet of paper, not the whole bench
    let X0 = 0, Y0 = 0, X1 = src.width, Y1 = src.height;
    if (r.paper && r.paper.corners) { const xs = r.paper.corners.map(p => p[0]), ys = r.paper.corners.map(p => p[1]), pad = 0.05 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      X0 = Math.max(0, Math.min(...xs) - pad); Y0 = Math.max(0, Math.min(...ys) - pad); X1 = Math.min(src.width, Math.max(...xs) + pad); Y1 = Math.min(src.height, Math.max(...ys) + pad); }
    const cssW = Math.max(200, cv.parentNode.clientWidth || 360), k = cssW / (X1 - X0), cssH = Math.min(Math.round((Y1 - Y0) * k), 560), kk = Math.min(k, cssH / (Y1 - Y0)), cw = Math.round((X1 - X0) * kk);
    cv.style.width = cw + 'px'; cv.style.height = Math.round((Y1 - Y0) * kk) + 'px'; cv.style.margin = '0 auto'; cv.width = Math.round(cw * dpr); cv.height = Math.round((Y1 - Y0) * kk * dpr);
    const x = cv.getContext('2d'), s = kk * dpr; x.drawImage(src, X0, Y0, X1 - X0, Y1 - Y0, 0, 0, cv.width, cv.height);
    const P2 = p => [(p[0] - X0) * s, (p[1] - Y0) * s];
    if (r.paper && r.paper.corners) { x.strokeStyle = '#3ea6ff'; x.lineWidth = 2 * dpr; x.beginPath(); r.paper.corners.forEach((p, i) => { const q = P2(p); i ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1]); }); x.closePath(); x.stroke(); }
    if (m) {
      x.strokeStyle = '#2ecc71'; x.lineWidth = 1.5 * dpr;
      (m.edges || []).forEach(e => { const a = P2(e[0]), b = P2(e[1]); x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke(); });
      if (m.ends && m.ends.length === 2) {
        const a = P2(m.ends[0]), b = P2(m.ends[1]); x.strokeStyle = '#ffb020'; x.lineWidth = 2.5 * dpr; x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke();
        [a, b].forEach(q => { x.fillStyle = '#ff4d4f'; x.beginPath(); x.arc(q[0], q[1], 5 * dpr, 0, 7); x.fill(); });
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, lab = 'Ø' + C.fmtDec(m.dia) + '"  ×  ' + pvOal().toFixed(2) + '"';
        x.font = 'bold ' + Math.round(15 * dpr) + 'px sans-serif'; const w = x.measureText(lab).width + 12 * dpr;
        x.fillStyle = '#000c'; x.fillRect(mx - w / 2, my - 34 * dpr, w, 22 * dpr); x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(lab, mx, my - 23 * dpr);
      }
    }
    if (r.count > 1 || (P.from === 'restock' && r.marks)) (r.marks || []).forEach(mk => {
      const q = P2(mk.at), rad = 13 * dpr; x.fillStyle = mk.k > 1 ? '#ffb020' : '#3ea6ff'; x.beginPath(); x.arc(q[0], q[1], rad, 0, 7); x.fill();
      x.fillStyle = '#001'; x.font = 'bold ' + Math.round(14 * dpr) + 'px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(mk.k > 1 ? mk.n + '×' + mk.k : String(mk.n), q[0], q[1] + dpr);
    });
  }
  function paperUse() {
    const P = S.pv, E = S.edit; if (!E) { S.pv = null; go('list'); return; }
    const m = pvMeasure(), r = P.j.vis || {};
    if (m) {
      const sn = snapsFor(m, E.d.type)[P.snap];
      E.d.diaText = sn ? sn.label : C.fmtDec(m.dia); E.user.add('diaText'); E.auto.delete('diaText');
      E.d.length = pvOal().toFixed(2) + '" OAL' + (E.d.length && /LOC/.test(E.d.length) ? ', ' + E.d.length.split(',').filter(x => /LOC/.test(x)).join('').trim() : ''); E.user.add('length');
      if (P.tip === 'point' && !E.user.has('type') && (E.d.type === 'End mill' || E.isNew)) { E.d.type = 'Drill'; E.auto.add('type'); }
      if (P.tip === 'ball' && E.v) E.v.end = 'Ball';
    }
    if (r.count > 1) { E.d.qty = P.n; E.user.add('qty'); delete E.d.uncounted; }
    if (!E.d.name || E.auto.has('name')) { E.auto.add('name'); renameAuto(E); }
    S.pv = null; go('edit'); renderEdit();
  }
  function paperBack() { const from = S.pv && S.pv.from; S.pv = null; if (from === 'edit' && S.edit) { go('edit'); renderEdit(); } else go('list'); }
  function paperRestock(mode) {
    const P = S.pv, t = P && S.tools.find(x => x.id === P.toolId); if (!t) return paperBack(); const n = P.n;
    S.pv = null; go('list');
    if (mode === 'add') commit('Restocked ' + n + ': ' + t.name, () => { t.qty = (+t.qty || 0) + n; delete t.uncounted; }, 'Restock (counted from photo)', { toast: t.name + ': +' + n + ', now ' + ((+t.qty || 0) + n) });
    else commit('Counted ' + n + ': ' + t.name, () => { t.qty = n; delete t.uncounted; }, 'Counted from photo', { toast: t.name + ': ' + n + ' on hand' });
  }

  // ---------- restock sheet ----------
  function openSheet(html) { $('#sheet').innerHTML = html; $('#sheetBg').classList.add('on'); }
  function closeSheet() { if (S.scanStop) { try { S.scanStop(); } catch (e) { } S.scanStop = null; } $('#sheetBg').classList.remove('on'); $('#sheet').innerHTML = ''; S.rs = null; S.found = null; S.scanNew = null; }
  function openRestock(t, q) {
    S.found = null; const s = st(t); S.rs = { id: t.id, n: Math.max(1, q || (s === 'out' || s === 'soon' ? C.suggest(t, S.set.th) : 5)) };
    renderRestock();
  }
  function renderRestock() {
    const t = S.tools.find(x => x.id === S.rs.id); if (!t) return closeSheet();
    openSheet(`<h2>Restock: ${esc(t.name)}</h2><p class="hint">You have ${+t.qty || 0}. How many came in?</p>
      <div class="stepper"><button data-act="rsStep" data-d="-1">−</button><div class="val" id="rsVal">+${S.rs.n}</div><button data-act="rsStep" data-d="1">+</button></div>
      <div class="qchips">${[1, 5, 10, 25].map(v => `<button data-act="rsAdd" data-d="${v}">+${v}</button>`).join('')}<button data-act="rsSet" data-d="1">Reset</button></div>
      <p class="muted" id="rsAfter">New count: <b>${(+t.qty || 0) + S.rs.n}</b></p>
      <label class="btn sec filebtn" id="countBtn">🔢 Count from photo<small style="display:block;font-weight:500;font-size:12px;opacity:.8">Tools spread out on letter/A4 paper, or the box label</small><input type="file" id="countIn" accept="image/*" capture="environment"></label>
      <div class="row"><button class="btn sec" data-act="closeSheet">Cancel</button><button class="btn" data-act="rsGo" id="rsGo">Add ${S.rs.n}</button></div>`);
  }

  // ---------- program import ----------
  function readFile(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(f); }); }
  async function importPrograms(files) {
    const lists = [];
    for (const f of files) { try { lists.push(C.programTools(await readFile(f), f.name)); } catch (e) { toast('Could not read ' + f.name); } }
    showImport(C.mergeProgramTools(lists), files.map(f => f.name));
  }
  function showImport(cands, names) {
    S.imp = { names, rows: cands.map(T => { const m = C.catalogMatch(T, S.tools); return { T, tool: C.progCandToTool(T), match: m, on: !m }; }) };
    go('import'); renderImport();
  }
  function renderImport() {
    const I = S.imp, n = I.rows.filter(r => r.on && !r.match).length;
    $('#importBody').innerHTML = `<div class="card"><h2>Tools in ${esc(I.names.join(', '))}</h2>
      <p class="hint">Found ${I.rows.length} tool${I.rows.length === 1 ? '' : 's'}. New ones are added with 0 on hand and marked "Not counted" until you count them, so they don't set off alerts.</p>
      ${I.rows.length ? '' : '<div class="warn">No tool changes (T__ M6) found in that file.</div>'}
      <div id="impList">${I.rows.map((r, i) => `<div class="imp" data-i="${i}"><input type="checkbox" data-act="impOn" ${r.on && !r.match ? 'checked' : ''} ${r.match ? 'disabled' : ''}>
        <div class="w"><b>T${r.T.t}</b> ${r.T.in != null ? '· ' + esc(r.T.label) + (r.T.probe ? ' stylus' : '') : '<span class="muted">· size not in program</span>'}
          ${r.T.ops.length ? `<div class="muted">${esc(r.T.ops.slice(0, 3).join(' · '))}</div>` : ''}
          ${r.match ? `<div class="st ok">Already in catalog: ${esc(r.match.name)}</div>` : `<input type="text" data-imp="name" value="${esc(r.tool.name)}">
          <div class="row"><select data-imp="type">${C.TYPES.map(t => `<option${r.tool.type === t ? ' selected' : ''}>${t}</option>`).join('')}</select><input type="text" data-imp="diaText" value="${esc(r.tool.diaText)}" placeholder="size"></div>`}</div></div>`).join('')}</div></div>
      <div class="formbar"><button class="btn sec" data-act="cancelImp">Cancel</button><button class="btn" data-act="doImp" id="doImp" ${n ? '' : 'disabled'}>Add ${n} tool${n === 1 ? '' : 's'}</button></div>`;
  }
  function doImport() {
    const add = S.imp.rows.filter(r => r.on && !r.match).map(r => Object.assign({ id: uid(), created: new Date().toISOString(), material: '', length: '', vendor: '', pn: '', price: null, loc: '', target: null, flutes: null, uncounted: true }, r.tool));
    if (!add.length) return;
    commit('Imported ' + add.length + ' tool' + (add.length > 1 ? 's' : '') + ' from program', () => { S.tools.push(...add); }, 'Imported from program');
    S.imp = null; S.f.st = 'all'; go('list');
  }

  // ---------- CSV / JSON ----------
  function download(name, text, mime) {
    window.__lastDownload = { name, text };
    const blob = new Blob([text], { type: mime });
    const dl = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); };
    try {
      const f = new File([blob], name, { type: mime });
      if (/iPhone|iPad|Android/i.test(navigator.userAgent) && navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: name }).catch(e => { if (e && e.name !== 'AbortError') dl(); }); return; }
    } catch (e) { }
    dl();
  }
  async function copyText(t) {
    window.__lastCopy = t;
    try { await navigator.clipboard.writeText(t); toast('Order list copied. Paste it into a text or email.'); return; } catch (e) { }
    openSheet(`<h2>Copy the order list</h2><p class="hint">Press and hold in the box, then Select All and Copy.</p><textarea readonly style="height:240px;font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(t)}</textarea><button class="btn sec" data-act="closeSheet">Done</button>`);
    const ta = $('#sheet textarea'); ta.focus(); ta.select(); try { if (document.execCommand('copy')) toast('Copied'); } catch (e) { }
  }
  function importCSVText(text) {
    const r = C.csvToTools(text);
    if (!r.tools.length) { toast(r.errors[0] || 'No tools found in that file'); return; }
    const plan = C.planImport(r.tools, S.tools), nUpd = plan.filter(x => x.m).length, nNew = plan.length - nUpd;
    S.csvPending = r;
    openSheet(`<h2>Import spreadsheet</h2><p class="hint">${r.tools.length} tool${r.tools.length > 1 ? 's' : ''} in the file: <b id="csvNew">${nNew}</b> new, <b id="csvUpd">${nUpd}</b> already here (those get updated, including the count).</p>
      ${r.errors.length ? `<div class="warn">${r.errors.slice(0, 5).map(esc).join('<br>')}</div>` : ''}
      <div class="row"><button class="btn sec" data-act="closeSheet">Cancel</button><button class="btn" data-act="csvGo" id="csvGo">Import</button></div>`);
  }
  function applyCSV() {
    const r = S.csvPending; if (!r) return; S.csvPending = null; closeSheet();
    commit('Imported ' + r.tools.length + ' tools from CSV', () => {
      const now = new Date().toISOString();
      C.planImport(r.tools, S.tools).forEach(({ t, m }) => {
        const clean = {}; Object.keys(t).forEach(k => { const v = t[k]; if (k !== 'id' && v !== '' && v != null) clean[k] = v; });
        if (m) { Object.assign(m, clean); if (clean.qty != null) delete m.uncounted; m.updated = now; }
        else S.tools.push(Object.assign({ name: '', type: 'Other', diaText: '', flutes: null, material: '', length: '', vendor: '', pn: '', price: null, loc: '', qty: 0, rp: 0, target: null, track: true, tnum: null, notes: '', created: now }, clean, { updated: now, id: t.id && !S.tools.some(x => x.id === t.id) ? t.id : uid() }));
      });
    }, 'CSV import');
    go('list');
  }
  async function backup() {
    const data = { app: 'ToolCrib', version: 1, exported: new Date().toISOString(), settings: { th: S.set.th }, tools: S.tools, history: S.hist, photos: S.photos };
    download('toolcrib-backup-' + fileDate() + '.json', JSON.stringify(data), 'application/json');
  }
  function restoreText(text) {
    let d; try { d = JSON.parse(text); } catch (e) { toast('That file isn\'t a Tool Crib backup'); return; }
    if (!d || d.app !== 'ToolCrib' || !Array.isArray(d.tools)) { toast('That file isn\'t a Tool Crib backup'); return; }
    S.restorePending = d;
    openSheet(`<h2>Restore backup</h2><p class="hint">From ${esc(new Date(d.exported).toLocaleString())}: <b>${d.tools.length}</b> tools, ${(d.history || []).length} history entries, ${Object.keys(d.photos || {}).length} photos.</p>
      <div class="warn">This replaces the ${S.tools.length} tools on this phone.</div>
      <div class="row"><button class="btn sec" data-act="closeSheet">Cancel</button><button class="btn" data-act="restoreGo" id="restoreGo">Replace with backup</button></div>`);
  }
  function applyRestore() {
    const d = S.restorePending; if (!d) return; S.restorePending = null; closeSheet();
    commit('Restored backup', () => { S.tools = d.tools; if (d.settings && d.settings.th != null) S.set.th = d.settings.th; }, 'Restore', { toast: 'Backup restored' });
    S.hist = (d.history || []).concat([{ ts: new Date().toISOString(), id: '', name: 'Backup restored (' + d.tools.length + ' tools)', d: 0, q: d.tools.length, why: 'Restore' }]); save();
    Object.keys(S.photos).forEach(id => PDB.put(id, null));
    Object.entries(d.photos || {}).forEach(([id, u]) => PDB.put(id, u));
    go('list');
  }

  // ---------- sample data ----------
  function sample() {
    const T = (name, type, diaText, flutes, material, length, vendor, pn, price, loc, qty, rp, extra) => Object.assign({ name, type, diaText, flutes, material, length, vendor, pn, price, loc, qty, rp, target: null, track: true, tnum: null, notes: '' }, extra || {});
    return [
      T('1/2" 4FL Carbide End mill', 'End mill', '1/2', 4, 'Carbide AlTiN', '3" OAL, 1-1/4" LOC', 'Helical Solutions', '82540', 64.80, 'Drawer A1', 7, 3, { tnum: 1 }),
      T('3/8" 3FL Aluminum End mill', 'End mill', '3/8', 3, 'Carbide ZrN', '2-1/2" OAL', 'Harvey Tool', '33796-C6', 48.25, 'Drawer A2', 4, 2),
      T('1/4" 2FL Ball End mill', 'End mill', '1/4', 2, 'Carbide TiAlN', '2-1/2" OAL', 'Harvey Tool', '46516-C3', 39.90, 'Drawer A3', 0, 2),
      T('#7 Jobber Drill', 'Drill', '#7', 2, 'Cobalt', '', 'MSC Industrial', '01178347', 3.62, 'Drill index B', 9, 4, { notes: 'Tap drill for 1/4-20' }),
      T('1/4-20 Spiral Point Tap', 'Tap', '1/4-20', 3, 'HSS-E TiN', '', 'OSG', '1700207708', 21.40, 'Drawer C1', 3, 2),
      T('1/2" 90° Spot Drill', 'Spot/Chamfer', '1/2', 2, 'Carbide', '', 'MSC Industrial', '88126743', 27.15, 'Drawer A4', 5, 1),
      T('3" 45° Face mill body', 'Face mill', '3', 5, '', '', 'Kennametal', 'KSSM45-3', 412.00, 'Shelf 2', 1, 0, { track: false, notes: 'Body only, inserts tracked separately' }),
      T('APKT 1604 Inserts (aluminum)', 'Insert', '', null, 'Carbide IC28', '', 'Iscar', 'APKT 1604PDR-HM', 9.85, 'Shelf 2 box', 12, 10, { target: 30 }),
      T('.2500 Carbide Reamer', 'Reamer', '.2500', 6, 'Carbide', '', 'MSC Industrial', '08012523', 32.70, 'Drawer C2', 4, 1),
      T('CAT40 ER32 Collet chuck', 'Holder', '', null, '', '2.36" gage', 'Techniks', '22232-2.36', 89.00, 'Tool cart', 6, 0, { track: false })
    ].map(t => Object.assign(t, { id: uid(), created: new Date().toISOString() }));
  }
  function loadSample() {
    if (S.tools.length && !confirm('Add the 10 sample tools to your ' + S.tools.length + ' tools?')) return;
    commit('Loaded sample data', () => { S.tools.push(...sample()); }, 'Sample data');
    go('list');
  }

  // ---------------- events ----------------
  function toolOf(el) { const r = el.closest('[data-id]'); return r && S.tools.find(t => t.id === r.dataset.id); }
  const ACT = {
    goOrder: () => { $('#alertBar').classList.remove('on'); go('order'); },
    add: () => openEdit(null), open: el => openEdit(toolOf(el)),
    addPhoto: () => { openEdit(null, { photo: true }); const i = $('#camIn'); i.value = ''; i.click(); },
    pickGal: () => { const i = $('#galIn'); i.value = ''; i.click(); },
    typeIn: () => { S.edit.photoMode = false; renderEdit(); },
    rmPhoto: el => { const E = S.edit, i = +el.dataset.i; E.photos.splice(i, 1); E.jobs.splice(i, 1); mergeReads(E); renderEdit(); },
    mainPhoto: el => { const E = S.edit, i = +el.dataset.i; if (!i) return; E.photos.unshift(E.photos.splice(i, 1)[0]); E.jobs.unshift(E.jobs.splice(i, 1)[0]); renderEdit(); },
    chip: el => { const E = S.edit, f = el.dataset.f, i = +el.dataset.i, k = fieldKey(f); E.ch[f] = chosenIdx(E, f) === i ? null : String(E.F[f][i].v); E.user.delete(k); E.auto.add(k); if (k !== 'name') { E.user.delete('name'); if (!E.d.name) E.auto.add('name'); } applyReads(E); renameAuto(E); renderEdit(); },
    retryRead: () => { const E = S.edit; E.offline = false; E.jobs.forEach(j => { if (j.needNet) j.done = false; }); runJobs(E); renderPhotoPanel(); },
    showPaper: el => { const E = S.edit, j = E.jobs[+el.dataset.i]; if (j && j.vis) openPaper(j, { from: 'edit' }); },
    openTool: el => { const t = S.tools.find(x => x.id === el.dataset.id); if (t) openEdit(t); },
    grid: () => { S.set.grid = !S.set.grid; save(); renderList(); },
    scan: () => openScan(),
    scanAdd: () => scanAdd(), scanLink: () => scanLink(), scanAgain: () => openScan(),
    pvSnap: el => { S.pv.snap = +el.dataset.i; renderPaper(); },
    pvTip: el => { S.pv.tip = el.dataset.v; renderPaper(); },
    pvStep: el => { S.pv.n = Math.max(0, S.pv.n + +el.dataset.d); renderPaper(); },
    pvUse: () => paperUse(), pvBack: () => paperBack(),
    pvAdd: () => paperRestock('add'), pvSet: () => paperRestock('set'),
    use: el => { const t = toolOf(el); if (!t) return; if ((+t.qty || 0) <= 0) { toast(t.name + ' is already at 0'); return; } commit('Used one: ' + t.name, () => { t.qty = (+t.qty || 0) - 1; delete t.uncounted; }, 'Used', { toast: t.name + ': ' + ((+t.qty || 0) - 1) + ' left' }); },
    plus: el => { const t = toolOf(el); if (!t) return; commit('+1: ' + t.name, () => { t.qty = (+t.qty || 0) + 1; delete t.uncounted; }, 'Added one', { toast: t.name + ': ' + ((+t.qty || 0) + 1) + ' on hand' }); },
    restock: el => { const t = toolOf(el); if (t) openRestock(t, +el.dataset.q || 0); },
    rsStep: el => { S.rs.n = Math.max(1, S.rs.n + +el.dataset.d); renderRestock(); },
    rsAdd: el => { S.rs.n += +el.dataset.d; renderRestock(); }, rsSet: () => { S.rs.n = 1; renderRestock(); },
    rsGo: () => { const t = S.tools.find(x => x.id === S.rs.id), n = S.rs.n; closeSheet(); if (!t) return; commit('Restocked ' + n + ': ' + t.name, () => { t.qty = (+t.qty || 0) + n; delete t.uncounted; }, 'Restock', { toast: t.name + ': +' + n + ', now ' + ((+t.qty || 0) + n) }); },
    closeSheet,
    fst: el => { S.f.st = el.dataset.v; renderList(); },
    clearF: () => { S.f = { q: '', st: 'all', type: '', loc: '' }; renderList(); },
    pickNC: () => { $('#pickNC').value = ''; $('#pickNC').click(); }, pickCSV: () => { $('#pickCSV').value = ''; $('#pickCSV').click(); }, pickJSON: () => { $('#pickJSON').value = ''; $('#pickJSON').click(); },
    sample: loadSample,
    copyOrder: () => copyText(C.orderText(orderGroups(), dateStr())),
    csvOrder: () => download('tool-order-' + fileDate() + '.csv', C.orderCSV(orderGroups()), 'text/csv'),
    csvAll: () => download('toolcrib-tools-' + fileDate() + '.csv', C.toolsToCSV(S.tools), 'text/csv'),
    csvHist: () => download('toolcrib-history-' + fileDate() + '.csv', C.toCSV([['Date', 'Tool', 'Change', 'New qty', 'What']].concat(S.hist.map(h => [new Date(h.ts).toLocaleString(), h.name, h.d, h.q, h.why]))), 'text/csv'),
    clearHist: () => { if (confirm('Clear all history on this phone? Tool counts stay.')) { S.hist = []; save(); renderAll(); } },
    moreHist: () => { S.histN += 300; renderHist(); },
    backup, restoreGo: applyRestore, csvGo: applyCSV,
    th: el => { const v = Math.max(0, Math.min(50, S.set.th + +el.dataset.d)); if (v === S.set.th) return; commit('Alert setting ' + v, () => { S.set.th = v; }, 'Alert setting', { toast: 'Order soon now means reorder point + ' + v }); },
    askNotif: async () => {
      if (!('Notification' in window)) { toast('This browser can\'t show phone notifications here'); return; }
      try { const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Phone alerts are on' : 'Phone alerts not allowed'); if (p === 'granted') { S.set.lastSummary = ''; dailySummary(); } } catch (e) { toast('Could not ask for permission'); }
      renderAll();
    },
    testNotif: () => { toast(notify('Tool Crib test', 'Alerts are working. You\'ll get one when a tool hits Order soon or Out.', 'toolcrib-test') ? 'Test alert sent' : 'Could not send. Check notification settings.'); },
    wipe: () => { if (!confirm('Erase all tools, history and photos on this phone? Make a backup first if you might want them.')) return; commit('Erased all data', () => { S.tools = []; }, 'Erased', { toast: 'All tools erased (Undo brings them back, photos are gone)' }); Object.keys(S.photos).forEach(id => PDB.put(id, null)); go('list'); },
    // edit form
    type: el => { S.edit.d.type = el.dataset.v; S.edit.user.add('type'); renameAuto(S.edit); if (el.dataset.v === 'Holder' || el.dataset.v === 'Face mill') { /* bodies/holders usually aren't consumed */ } renderEdit(); },
    dia: el => { S.edit.d.diaText = el.dataset.v; S.edit.user.add('diaText'); renameAuto(S.edit); const p = C.parseDia(el.dataset.v); if (p && p.kind === 'tap' && S.edit.d.type !== 'Tap') S.edit.d.type = 'Tap'; renderEdit(); },
    fl: el => { S.edit.d.flutes = el.dataset.v === '' ? null : +el.dataset.v; S.edit.user.add('flutes'); renameAuto(S.edit); renderEdit(); },
    mat: el => { const d = S.edit.d, m = el.dataset.v, w = (d.material || '').split(/\s+/).filter(Boolean); const i = w.findIndex(x => x.toLowerCase() === m.toLowerCase()); if (i >= 0) w.splice(i, 1); else w.push(m); d.material = w.join(' '); renderEdit(); },
    setf: el => { S.edit.d[el.dataset.f] = el.dataset.v; renderEdit(); },
    step: el => { const d = S.edit.d, f = el.dataset.f, dd = +el.dataset.d; S.edit.user.add(f); if (f === 'target') d.target = Math.max(1, (d.target == null ? (+d.rp || 0) + 5 : +d.target) + dd); else { d[f] = Math.max(0, (+d[f] || 0) + dd); if (f === 'qty') delete d.uncounted; } renderEdit(); },
    counted0: () => { delete S.edit.d.uncounted; S.edit.d.qty = 0; renderEdit(); },
    tgtAuto: () => { S.edit.d.target = null; renderEdit(); },
    noPhoto: () => { S.edit.photos = []; S.edit.jobs = []; mergeReads(S.edit); renderEdit(); },
    saveEdit, cancelEdit: () => { S.edit = null; go('list'); },
    delTool: () => { const d = S.edit.d; if (!confirm('Delete ' + d.name + '?')) return; commit('Deleted ' + d.name, () => { S.tools = S.tools.filter(t => t.id !== d.id); }, 'Deleted'); S.edit = null; go('list'); },
    // import
    impOn: el => { const r = S.imp.rows[+el.closest('[data-i]').dataset.i]; r.on = el.checked; const n = S.imp.rows.filter(r => r.on && !r.match).length; const b = $('#doImp'); b.textContent = 'Add ' + n + ' tool' + (n === 1 ? '' : 's'); b.disabled = !n; },
    doImp: doImport, cancelImp: () => { S.imp = null; go('list'); }
  };
  document.addEventListener('click', e => {
    const tab = e.target.closest('#tabs button'); if (tab) { go(tab.dataset.v); return; }
    if (e.target.id === 'sheetBg') { closeSheet(); return; }
    const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
    if (el.type === 'checkbox' && el.dataset.act !== 'impOn') return;
    const f = ACT[el.dataset.act]; if (f) f(el, e);
  });
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'q') { S.f.q = el.value; renderRows(); return; }
    if (S.view === 'edit' && el.dataset.f) {
      const d = S.edit.d, f = el.dataset.f;
      d[f] = el.type === 'checkbox' ? el.checked : el.value; S.edit.user.add(f); S.edit.auto.delete(f);
      if (f === 'diaText' || f === 'material') renameAuto(S.edit);
      if (f === 'code') { const w = $('#codeDup'); if (w) w.outerHTML = codeDupHTML(); else $('#fCode').insertAdjacentHTML('afterend', codeDupHTML()); }
      if (f === 'diaText') { const pe = $('#diaParsed'); pe.textContent = diaMsg(el.value); pe.className = 'parsed' + (el.value && !C.parseDia(el.value) ? ' bad' : ''); }
      if (f === 'diaText' || f === 'material') { const auto = C.autoName(d); $('#fName').placeholder = auto || 'e.g. 1/2" 4FL Carbide End mill'; }
    }
    if (S.view === 'import' && el.dataset.imp) { const r = S.imp.rows[+el.closest('[data-i]').dataset.i]; r.tool[el.dataset.imp] = el.value; }
  });
  document.addEventListener('change', async e => {
    const el = e.target;
    if (el.id === 'fType') { S.f.type = el.value; renderRows(); }
    else if (el.id === 'fLoc') { S.f.loc = el.value; renderRows(); }
    else if (el.id === 'fSort') { S.sort = el.value; renderRows(); }
    else if ((el.id === 'photoIn' || el.id === 'camIn' || el.id === 'galIn' || el.id === 'photoGal') && el.files.length && S.edit) addPhotos([...el.files]);
    else if (el.id === 'scanPhoto' && el.files[0]) scanFromPhoto(el.files[0]);
    else if (el.id === 'countIn' && el.files[0]) countFromPhoto(el.files[0], S.rs && S.rs.id);
    else if (el.id === 'pickNC' && el.files.length) importPrograms([...el.files]);
    else if (el.id === 'pickCSV' && el.files[0]) importCSVText(await readFile(el.files[0]));
    else if (el.id === 'pickJSON' && el.files[0]) restoreText(await readFile(el.files[0]));
  });
  $('#undoBtn').addEventListener('click', undo);
  $('#toastUndo').addEventListener('click', () => { $('#toast').classList.remove('on'); undo(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { setBadge(); dailySummary(); } });

  // test / automation hooks (harmless in normal use)
  window.ToolCrib = { S, commit, undo, go, importPrograms, importCSVText, applyCSV, restoreText, applyRestore, dailySummary, notify, sample, addPhotos, onScanned, openScan, countFromPhoto, openPaper };

  // ---------------- start ----------------
  async function start() {
    load();
    await PDB.open();
    S.photos = await PDB.all();
    Object.keys(S.photos).forEach(k => { const id = k.split('#')[0]; if (!S.tools.some(t => t.id === id)) PDB.put(k, null); });   // tidy photos of deleted tools
    if ('serviceWorker' in navigator && !window.TOOLCRIB_SINGLE_FILE && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => { });
      navigator.serviceWorker.ready.then(r => { SWREG = r; });
      navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.go) go(e.data.go); });
    }
    go(location.hash === '#order' ? 'order' : 'list');
    setBadge(); dailySummary();
  }
  start();
})();
