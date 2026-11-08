(() => {
  'use strict';

  const API = '/api/v2';
  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity };
  const REFRESH_MS = 60e3;
  const NODES_MS = 15e3;
  const FILES_MS = 5 * 60e3;
  const JOB_PAGE = 500;
  const JOB_MAX_PAGES = 40;

  const C = {
    blue: 'hsl(220 70% 50%)',
    green: 'hsl(160 60% 45%)',
    orange: 'hsl(30 80% 55%)',
    purple: 'hsl(280 65% 60%)',
    pink: 'hsl(340 75% 55%)',
    zinc: 'hsl(240 4% 46%)',
  };
  const PALETTE = [C.blue, C.green, C.orange, C.purple, C.pink, C.zinc];

  const OUTCOMES = [
    { key: 'success', label: 'Success', color: C.green },
    { key: 'skipped', label: 'Not required', color: C.blue },
    { key: 'error', label: 'Error', color: C.pink },
    { key: 'cancelled', label: 'Cancelled', color: C.orange },
    { key: 'other', label: 'Other', color: C.purple },
  ];
  const OUTCOME = Object.fromEntries(OUTCOMES.map((o) => [o.key, o]));

  const state = {
    range: localStorage.getItem('insights.range') || '7d',
    jobType: localStorage.getItem('insights.jobType') || 'transcode',
    jobs: [],
    jobsTotal: 0,
    jobsTruncated: false,
    jobsFetchedFor: null,
    files: [],
    filesAt: 0,
    nodes: {},
    libs: new Map(),
    updatedAt: null,
    loading: false,
    pending: false,
  };
  if (!(state.range in RANGES)) state.range = '7d';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const basename = (p) => String(p || '').split(/[\\/]/).pop();

  const nfInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const fmtInt = (n) => nfInt.format(n || 0);
  const fmtPct = (n) => (n == null || !isFinite(n) ? '–' : `${nf1.format(n * 100)}%`);

  function fmtGB(gb, signed = false) {
    if (gb == null || !isFinite(gb)) return '–';
    const sign = signed && gb > 0 ? '+' : gb < 0 ? '−' : '';
    const a = Math.abs(gb);
    if (a === 0) return '0 GB';
    if (a < 1) return `${sign}${nfInt.format(a * 1024)} MB`;
    if (a >= 1024) return `${sign}${(a / 1024).toFixed(2)} TB`;
    return `${sign}${a.toFixed(a < 10 ? 2 : 1)} GB`;
  }

  function fmtDur(ms) {
    if (ms == null || !isFinite(ms)) return '–';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const tfs = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const df = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const fmtDateTime = (ts) => dtf.format(ts);

  async function post(path, data) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return res.json();
  }

  async function get(path) {
    const res = await fetch(API + path, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return res.json();
  }

  async function fetchJobs(cutoff) {
    const byId = new Map();
    let total = 0;
    let truncated = false;
    for (let page = 0; ; page++) {
      if (page >= JOB_MAX_PAGES) { truncated = true; break; }
      const r = await post('/client/jobs', {
        start: page * JOB_PAGE,
        pageSize: JOB_PAGE,
        filters: [],
        sorts: [{ id: 'end', desc: true }],
        opts: {},
      });
      const arr = Array.isArray(r.array) ? r.array : [];
      total = r.totalCount || 0;
      for (const j of arr) byId.set(j._id, j);
      const last = arr[arr.length - 1];
      if (arr.length < JOB_PAGE || (page + 1) * JOB_PAGE >= total) break;
      if (last && last.end > 0 && last.end < cutoff) break;
    }
    return { jobs: [...byId.values()], total, truncated };
  }

  async function fetchFiles() {
    const out = [];
    const pageSize = 1000;
    for (let start = 0; start < 100000; start += pageSize) {
      const r = await post('/client/search', { start, pageSize, filters: [], sorts: [], opts: {} });
      const arr = Array.isArray(r.array) ? r.array : [];
      out.push(...arr);
      if (arr.length < pageSize || out.length >= (r.totalCount || 0)) break;
    }
    return out;
  }

  async function fetchLibs() {
    const r = await post('/cruddb', { collection: 'LibrarySettingsJSONDB', mode: 'getAll' });
    return new Map((Array.isArray(r) ? r : []).map((l) => [l._id, l.name || l._id]));
  }

  function classify(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('not required')) return 'skipped';
    if (s.includes('error') || s.includes('fail')) return 'error';
    if (s.includes('cancel')) return 'cancelled';
    if (s.includes('success')) return 'success';
    return 'other';
  }

  function normalizeJob(j) {
    const type = j.job?.type === 'healthcheck' ? 'healthcheck' : 'transcode';
    const outcome = classify(j.status);
    const startGB = Number(j.fileSizeStartGB) || 0;
    const endGB = Number(j.fileSizeEndGB) || 0;
    const measured = type === 'transcode' && outcome === 'success' && startGB > 0 && endGB > 0;
    return {
      id: j._id,
      type,
      outcome,
      status: j.status || 'Unknown',
      start: j.start,
      end: j.end,
      dur: Number(j.duration) > 0 ? Number(j.duration) : Math.max(0, j.end - j.start),
      file: j.file,
      db: j.DB,
      node: (Array.isArray(j.nodeNames) && j.nodeNames[0]) || j.nodeID || 'Unknown',
      startGB,
      endGB,
      saved: measured ? startGB - endGB : 0,
      ratio: measured ? endGB / startGB : null,
    };
  }

  function rangeStart() {
    const span = RANGES[state.range];
    if (span !== Infinity) return Date.now() - span;
    const first = state.jobs.reduce((m, j) => Math.min(m, j.end), Infinity);
    return isFinite(first) ? first : Date.now() - DAY;
  }

  function buildBuckets() {
    const now = Date.now();
    const from = rangeStart();
    const span = now - from;
    let step;
    let align;
    let label;
    if (span <= 2 * DAY) {
      step = HOUR;
      align = (t) => { const d = new Date(t); d.setMinutes(0, 0, 0); return d.getTime(); };
      label = (t) => tf.format(t);
    } else if (span <= 180 * DAY) {
      step = DAY;
      align = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
      label = (t) => df.format(t);
    } else {
      step = 7 * DAY;
      align = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
      label = (t) => `Wk of ${df.format(t)}`;
    }
    const buckets = [];
    const startT = align(state.range === 'all' ? from : from + 1);
    for (let t = startT; t <= now; ) {
      const next = step === HOUR ? t + HOUR : (() => { const d = new Date(t); d.setDate(d.getDate() + (step === DAY ? 1 : 7)); return d.getTime(); })();
      buckets.push({ t0: t, t1: next, label: label(t), v: {} });
      t = next;
    }
    if (state.range === '24h' && buckets.length > 24) buckets.splice(0, buckets.length - 24);
    const index = (ts) => {
      let lo = 0;
      let hi = buckets.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ts < buckets[mid].t0) hi = mid - 1;
        else if (ts >= buckets[mid].t1) lo = mid + 1;
        else return mid;
      }
      return -1;
    };
    return { buckets, index, step };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // ---------- tooltip ----------
  const tooltip = $('tooltip');
  const tipStore = new WeakMap();

  function tipHTML(t) {
    const rows = (t.rows || []).map((r) =>
      `<div class="t-row">${r.color ? `<i style="background:${r.color}"></i>` : ''}<span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join('');
    return `<div class="t-title">${esc(t.title)}</div>${rows}`;
  }

  function showTip(target, x, y) {
    const list = tipStore.get(target.closest('.chart'));
    const t = list && list[Number(target.dataset.tip)];
    if (!t) return hideTip();
    tooltip.innerHTML = tipHTML(t);
    tooltip.hidden = false;
    const r = tooltip.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function hideTip() { tooltip.hidden = true; }

  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return hideTip();
    const r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.top);
  });
  document.addEventListener('scroll', hideTip, { passive: true });

  // ---------- chart primitives ----------
  const ICON_CHART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>';
  const ICON_TABLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/></svg>';

  function emptyState(title, detail, icon = ICON_CHART) {
    return `<div class="empty">${icon}<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}</div>`;
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function niceScale(max, ticks = 4) {
    if (!(max > 0)) return { max: 1, ticks: [0, 1] };
    const step = niceStep(max / ticks);
    const top = Math.ceil(max / step) * step;
    const out = [];
    for (let v = 0; v <= top + step / 2; v += step) out.push(+v.toFixed(10));
    return { max: top, ticks: out };
  }

  function shortNum(v) {
    if (Math.abs(v) >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
    if (Math.abs(v) >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
    return `${+v.toFixed(2)}`;
  }

  function frame(el, height, margin) {
    const W = Math.max(260, Math.floor(el.clientWidth || 600));
    return { W, H: height, m: margin, iw: W - margin.l - margin.r, ih: height - margin.t - margin.b };
  }

  function axisY(f, scale, fmt, side = 'left') {
    return scale.ticks.map((v) => {
      const y = f.m.t + f.ih - (v / scale.max) * f.ih;
      const line = side === 'left' ? `<line class="grid-line" x1="${f.m.l}" x2="${f.m.l + f.iw}" y1="${y}" y2="${y}"/>` : '';
      const x = side === 'left' ? f.m.l - 8 : f.m.l + f.iw + 8;
      return `${line}<text x="${x}" y="${y}" dy="0.32em" text-anchor="${side === 'left' ? 'end' : 'start'}">${esc(fmt(v))}</text>`;
    }).join('');
  }

  function axisX(f, labels) {
    const n = labels.length;
    const bw = f.iw / n;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(f.iw / 64))));
    let out = `<line class="axis-line" x1="${f.m.l}" x2="${f.m.l + f.iw}" y1="${f.m.t + f.ih}" y2="${f.m.t + f.ih}"/>`;
    labels.forEach((l, i) => {
      if ((n - 1 - i) % every) return;
      out += `<text x="${f.m.l + bw * (i + 0.5)}" y="${f.m.t + f.ih + 16}" text-anchor="middle">${esc(l)}</text>`;
    });
    return out;
  }

  function svg(f, body, label) {
    return `<svg viewBox="0 0 ${f.W} ${f.H}" height="${f.H}" role="img" aria-label="${esc(label)}">${body}</svg>`;
  }

  function stackedBars(el, { labels, rows, series, title, tipTitle, fmtY = shortNum, fmtV = fmtInt, emptyTitle, emptyDetail, height = 240 }) {
    const totals = rows.map((r) => sum(series, (s) => r[s.key]));
    if (!sum(totals)) { el.innerHTML = emptyState(emptyTitle, emptyDetail); tipStore.delete(el); return; }
    const f = frame(el, height, { t: 10, r: 8, b: 26, l: 40 });
    const scale = niceScale(Math.max(...totals));
    const bw = f.iw / labels.length;
    const pad = Math.min(bw * 0.22, 8);
    const tips = [];
    let bars = '';
    rows.forEach((r, i) => {
      let y = f.m.t + f.ih;
      const x = f.m.l + bw * i + pad / 2;
      const w = Math.max(1, bw - pad);
      series.forEach((s) => {
        const v = r[s.key] || 0;
        if (!v) return;
        const h = (v / scale.max) * f.ih;
        y -= h;
        bars += `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(h, 0.5)}" fill="${s.color}" rx="${Math.min(2, w / 4)}"/>`;
      });
      tips.push({
        title: tipTitle ? tipTitle(i) : labels[i],
        rows: [...series.filter((s) => r[s.key]).map((s) => ({ label: s.label, value: fmtV(r[s.key]), color: s.color })),
          ...(series.length > 1 ? [{ label: 'Total', value: fmtV(totals[i]) }] : [])],
      });
      const aria = `${tips[i].title}: ${tips[i].rows.map((t) => `${t.label} ${t.value}`).join(', ') || 'none'}`;
      bars += `<rect class="hit" data-tip="${i}" tabindex="0" aria-label="${esc(aria)}" x="${f.m.l + bw * i}" y="${f.m.t}" width="${bw}" height="${f.ih}"/>`;
    });
    el.innerHTML = svg(f, axisY(f, scale, fmtY) + axisX(f, labels) + bars, title);
    tipStore.set(el, tips);
  }

  function comboChart(el, { labels, rows, series, line, title, tipTitle, emptyTitle, emptyDetail, height = 240 }) {
    const totals = rows.map((r) => sum(series, (s) => r[s.key]));
    const lineVals = rows.map((r) => r[line.key] || 0);
    if (!sum(totals) && !sum(lineVals)) { el.innerHTML = emptyState(emptyTitle, emptyDetail); tipStore.delete(el); return; }
    const f = frame(el, height, { t: 10, r: 52, b: 26, l: 40 });
    const scale = niceScale(Math.max(...totals));
    const lscale = niceScale(Math.max(...lineVals));
    const bw = f.iw / labels.length;
    const pad = Math.min(bw * 0.22, 8);
    let bars = '';
    const tips = [];
    const pts = [];
    rows.forEach((r, i) => {
      let y = f.m.t + f.ih;
      const x = f.m.l + bw * i + pad / 2;
      const w = Math.max(1, bw - pad);
      series.forEach((s) => {
        const v = r[s.key] || 0;
        if (!v) return;
        const h = (v / scale.max) * f.ih;
        y -= h;
        bars += `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(h, 0.5)}" fill="${s.color}" fill-opacity="0.85" rx="${Math.min(2, w / 4)}"/>`;
      });
      pts.push([f.m.l + bw * (i + 0.5), f.m.t + f.ih - (lineVals[i] / lscale.max) * f.ih]);
      tips.push({
        title: tipTitle ? tipTitle(i) : labels[i],
        rows: [...series.map((s) => ({ label: s.label, value: fmtInt(r[s.key]), color: s.color })),
          { label: line.label, value: line.fmt(lineVals[i]), color: line.color }],
      });
    });
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const dots = pts.length <= 40 ? pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="${line.color}"/>`).join('') : '';
    const hits = rows.map((_, i) => {
      const aria = `${tips[i].title}: ${tips[i].rows.map((t) => `${t.label} ${t.value}`).join(', ')}`;
      return `<rect class="hit" data-tip="${i}" tabindex="0" aria-label="${esc(aria)}" x="${f.m.l + bw * i}" y="${f.m.t}" width="${bw}" height="${f.ih}"/>`;
    }).join('');
    el.innerHTML = svg(f,
      axisY(f, scale, shortNum) + axisY(f, lscale, line.axisFmt, 'right') + axisX(f, labels) + bars +
      `<path d="${path}" fill="none" stroke="${line.color}" stroke-width="2" stroke-linejoin="round"/>` + dots + hits, title);
    tipStore.set(el, tips);
  }

  let gradientSeq = 0;
  function areaChart(el, { labels, values, color, title, tipTitle, fmtV, fmtY, emptyTitle, emptyDetail, height = 240, extra }) {
    if (!values.some((v) => v)) { el.innerHTML = emptyState(emptyTitle, emptyDetail); tipStore.delete(el); return; }
    const f = frame(el, height, { t: 10, r: 12, b: 26, l: 52 });
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const scale = niceScale(hi - lo || 1);
    const base = lo < 0 ? -niceScale(-lo).max : 0;
    const span = (lo < 0 ? scale.max + niceScale(-lo).max : scale.max) || 1;
    const yOf = (v) => f.m.t + f.ih - ((v - base) / span) * f.ih;
    const bw = f.iw / labels.length;
    const pts = values.map((v, i) => [f.m.l + bw * (i + 0.5), yOf(v)]);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const area = `${path}L${pts[pts.length - 1][0].toFixed(1)},${yOf(Math.max(base, 0))}L${pts[0][0].toFixed(1)},${yOf(Math.max(base, 0))}Z`;
    const gid = `g${++gradientSeq}`;
    const ticks = [];
    const step = niceStep(span / 4);
    for (let v = base; v <= base + span + step / 2; v += step) ticks.push(+v.toFixed(10));
    const yAxis = ticks.map((v) => `<line class="grid-line" x1="${f.m.l}" x2="${f.m.l + f.iw}" y1="${yOf(v)}" y2="${yOf(v)}"/><text x="${f.m.l - 8}" y="${yOf(v)}" dy="0.32em" text-anchor="end">${esc(fmtY(v))}</text>`).join('');
    const tips = values.map((v, i) => ({ title: tipTitle ? tipTitle(i) : labels[i], rows: [{ label: 'Cumulative', value: fmtV(v), color }, ...(extra ? extra(i) : [])] }));
    const hits = values.map((_, i) => `<rect class="hit" data-tip="${i}" tabindex="0" aria-label="${esc(`${tips[i].title}: ${fmtV(values[i])}`)}" x="${f.m.l + bw * i}" y="${f.m.t}" width="${bw}" height="${f.ih}"/>`).join('');
    const dot = pts.length ? `<circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="3.5" fill="${color}" stroke="var(--card)" stroke-width="2"/>` : '';
    el.innerHTML = svg(f,
      `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.35"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/></linearGradient></defs>` +
      yAxis + axisX(f, labels) + `<path d="${area}" fill="url(#${gid})"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>` + dot + hits, title);
    tipStore.set(el, tips);
  }

  function hbars(el, entries, { total, limit = 8, colorFor, emptyTitle = 'No data' } = {}) {
    if (!entries.length) { el.innerHTML = emptyState(emptyTitle, ''); return; }
    const max = Math.max(...entries.map((e) => e[1]));
    const shown = entries.slice(0, limit);
    const rest = entries.slice(limit);
    const rows = shown.map(([name, n], i) => {
      const pct = total ? n / total : null;
      const color = colorFor ? colorFor(name, i) : PALETTE[i % PALETTE.length];
      return `<div class="hbar" title="${esc(`${name}: ${fmtInt(n)}${pct != null ? ` (${fmtPct(pct)})` : ''}`)}">
        <span class="name">${esc(name)}</span>
        <span class="track"><span class="fill" style="display:block;width:${(n / max) * 100}%;background:${color}"></span></span>
        <span class="val">${fmtInt(n)}</span></div>`;
    }).join('');
    const more = rest.length ? `<div class="hbar-more">+${rest.length} more (${fmtInt(sum(rest, (e) => e[1]))})</div>` : '';
    el.innerHTML = `<div class="hbars">${rows}${more}</div>`;
  }

  function legend(el, items) {
    el.innerHTML = items.map((s) => `<span><i class="${s.line ? 'line' : ''}" style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
  }

  function table(el, columns, rows, empty) {
    if (!rows.length) { el.innerHTML = emptyState(empty[0], empty[1], ICON_TABLE); return; }
    const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}" scope="col">${esc(c.label)}</th>`).join('');
    const body = rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.cls || ''}${c.num ? ' num' : ''}">${c.html ? c.html(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('');
    el.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function badge(outcome, text) {
    const o = OUTCOME[outcome] || OUTCOME.other;
    return `<span class="badge"><i style="background:${o.color}"></i>${esc(text || o.label)}</span>`;
  }

  function fileCell(path, sub) {
    return `<span title="${esc(path)}">${esc(basename(path))}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`;
  }

  const libName = (id) => state.libs.get(id) || id || 'Unknown';
  const fileGB = (f) => (Number(f.file_size) || 0) / 1024;
  const isQueued = (f) => f.TranscodeDecisionMaker === 'Queued';

  // ---------- panels ----------
  function inRange() {
    const from = RANGES[state.range] === Infinity ? -Infinity : Date.now() - RANGES[state.range];
    return state.jobs.filter((j) => j.end >= from);
  }

  function renderKPIs(jobs) {
    const tc = jobs.filter((j) => j.type === 'transcode');
    const hc = jobs.filter((j) => j.type === 'healthcheck');
    const ok = tc.filter((j) => j.outcome === 'success');
    const err = tc.filter((j) => j.outcome === 'error');
    const hcErr = hc.filter((j) => j.outcome === 'error');
    const skipped = tc.filter((j) => j.outcome === 'skipped');
    const saved = sum(ok, (j) => j.saved);
    const queued = state.files.filter(isQueued);
    const hcQueued = state.files.filter((f) => f.HealthCheck === 'Queued');
    const rate = ok.length + err.length ? ok.length / (ok.length + err.length) : null;
    const tiles = [
      { label: 'Transcodes succeeded', value: fmtInt(ok.length), sub: `${fmtInt(skipped.length)} not required`, color: C.green },
      { label: 'Transcode errors', value: fmtInt(err.length), sub: `${fmtInt(tc.filter((j) => j.outcome === 'cancelled').length)} cancelled · ${fmtInt(hcErr.length)} health errors`, color: C.pink },
      { label: 'Success rate', value: fmtPct(rate), sub: 'Succeeded ÷ (succeeded + errors)', color: C.purple },
      { label: 'Space saved', value: fmtGB(saved), sub: ok.length ? `${fmtInt(ok.filter((j) => j.ratio != null).length)} measured transcodes` : 'No successful transcodes yet', color: C.blue },
      { label: 'Health checks', value: fmtInt(hc.length), sub: `${fmtInt(hc.filter((j) => j.outcome === 'success').length)} passed · ${fmtInt(hcQueued.length)} queued`, color: C.orange },
      { label: 'Queue remaining', value: state.filesAt ? fmtInt(queued.length) : '–', sub: state.filesAt ? `${fmtGB(sum(queued, fileGB))} awaiting transcode` : 'Loading files…', color: C.zinc },
    ];
    $('kpis').innerHTML = tiles.map((t) => `<div class="kpi">
      <div class="kpi-label"><span>${esc(t.label)}</span><span class="kpi-dot" style="background:${t.color}"></span></div>
      <div class="kpi-value" title="${esc(t.value)}">${esc(t.value)}</div>
      <div class="kpi-sub" title="${esc(t.sub)}">${esc(t.sub)}</div></div>`).join('');
  }

  function workerLabel(type) {
    const m = /^(transcode|healthcheck)(cpu|gpu)$/i.exec(type || '');
    if (!m) return type || 'Worker';
    return `${m[1] === 'transcode' ? 'Transcode' : 'Health check'} · ${m[2].toUpperCase()}`;
  }

  function renderWorkers() {
    const nodes = Object.entries(state.nodes || {});
    const el = $('workers');
    if (!nodes.length) { el.innerHTML = emptyState('No nodes connected', 'Tdarr reports no registered nodes.'); return; }
    const nodeLine = nodes.map(([, n]) => {
      const wl = n.workerLimits || {};
      const limits = ['transcodegpu', 'transcodecpu', 'healthcheckgpu', 'healthcheckcpu'].filter((k) => wl[k]).map((k) => `${wl[k]}× ${workerLabel(k)}`).join(', ');
      return `<span class="badge" title="${esc(limits || 'No worker limits set')}"><i style="background:${n.nodePaused ? C.orange : C.green}"></i>${esc(n.nodeName || 'Node')}${n.nodePaused ? ' · paused' : ''}</span>`;
    }).join('');
    const workers = nodes.flatMap(([, n]) => Object.values(n.workers || {}).map((w) => ({ ...w, nodeName: n.nodeName })));
    const items = workers.sort((a, b) => String(a.workerType).localeCompare(String(b.workerType))).map((w) => {
      const pct = Math.max(0, Math.min(100, Number(w.percentage) || 0));
      const indeterminate = !pct;
      const color = /^transcode/.test(w.workerType) ? C.blue : C.orange;
      const elapsed = w.startTime ? Date.now() - w.startTime : null;
      const meta = [
        workerLabel(w.workerType),
        w.nodeName,
        w.status,
        Number(w.fps) ? `${fmtInt(w.fps)} fps` : null,
        w.ETA && w.ETA !== 'Calc...' ? `ETA ${w.ETA}` : null,
        elapsed && elapsed > 0 && elapsed < 30 * DAY ? `elapsed ${fmtDur(elapsed)}` : null,
        Number(w.sourcefileSizeInGbytes) ? `${fmtGB(Number(w.sourcefileSizeInGbytes))} source` : null,
        Number(w.estSize) ? `~${fmtGB(Number(w.estSize))} est. output` : null,
      ].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join('');
      return `<div class="worker">
        <div class="worker-top"><span class="worker-file" title="${esc(w.file)}">${esc(basename(w.file) || 'Idle')}</span><span class="num">${indeterminate ? '' : `${pct.toFixed(1)}%`}</span></div>
        <div class="progress${indeterminate ? ' indeterminate' : ''}" role="progressbar" aria-label="${esc(basename(w.file))}" aria-valuemin="0" aria-valuemax="100" ${indeterminate ? '' : `aria-valuenow="${pct.toFixed(1)}"`}><div style="width:${pct}%;background:${color}"></div></div>
        <div class="worker-meta">${meta}</div></div>`;
    }).join('');
    el.innerHTML = `<div class="node-line">${nodeLine}</div>${items ? `<div class="workers">${items}</div>` : emptyState('No active workers', 'Workers appear here while files are being processed.')}`;
  }

  function renderETA() {
    const el = $('eta');
    if (!state.filesAt) { el.innerHTML = emptyState('Loading files…', ''); return; }
    const queued = state.files.filter(isQueued);
    const h264 = queued.filter((f) => f.video_codec_name === 'h264');
    const h264GB = sum(h264, fileGB);
    const done = state.jobs.filter((j) => j.type === 'transcode' && j.outcome === 'success' && j.startGB > 0 && j.dur > 0);
    let secPerGB = null;
    let source = '';
    if (done.length) {
      secPerGB = sum(done, (j) => j.dur) / 1000 / sum(done, (j) => j.startGB);
      source = `from ${fmtInt(done.length)} successful transcode${done.length === 1 ? '' : 's'}`;
    } else {
      const live = Object.values(state.nodes || {}).flatMap((n) => Object.values(n.workers || {}))
        .find((w) => /^transcode/.test(w.workerType) && w.startTime && Number(w.percentage) > 5 && Number(w.sourcefileSizeInGbytes) > 0);
      if (live) {
        secPerGB = (Date.now() - live.startTime) / 1000 / (live.percentage / 100) / Number(live.sourcefileSizeInGbytes);
        source = 'extrapolated from the running transcode (no completed history yet)';
      }
    }
    const slots = Math.max(1, sum(Object.values(state.nodes || {}), (n) => (n.nodePaused ? 0 : (n.workerLimits?.transcodegpu || 0) + (n.workerLimits?.transcodecpu || 0))));
    const etaMs = secPerGB != null ? (h264GB * secPerGB * 1000) / slots : null;
    el.innerHTML = `<div class="stats">
      <div class="stat wide"><div class="label">Estimated time to clear queued h264</div><div class="value">${etaMs != null ? `≈ ${fmtDur(etaMs)}` : '–'}</div></div>
      <div class="stat"><div class="label">Queued files</div><div class="value">${fmtInt(queued.length)}</div></div>
      <div class="stat"><div class="label">Queued h264</div><div class="value">${fmtInt(h264.length)} · ${fmtGB(h264GB)}</div></div>
      <div class="stat"><div class="label">Observed speed</div><div class="value">${secPerGB != null ? `${fmtDur(secPerGB * 1000)} / GB` : '–'}</div></div>
      <div class="stat"><div class="label">Transcode slots</div><div class="value">${fmtInt(slots)}</div></div>
    </div>
    <p class="eta-note">${secPerGB != null ? `Speed ${esc(source)}.` : 'No transcode speed observed yet; the estimate appears after the first transcode makes progress.'} Assumes every queued h264 file is transcoded at the same rate and all slots stay busy; files skipped as "Not required" finish faster.</p>`;
  }

  function renderOutcomes(jobs, B) {
    const type = state.jobType;
    const rows = B.buckets.map(() => ({}));
    for (const j of jobs) {
      if (j.type !== type) continue;
      const i = B.index(j.end);
      if (i >= 0) rows[i][j.outcome] = (rows[i][j.outcome] || 0) + 1;
    }
    const used = OUTCOMES.filter((o) => rows.some((r) => r[o.key]));
    const series = used.length ? used : OUTCOMES.slice(0, 3);
    $('outcomes-desc').textContent = `Completed ${type === 'transcode' ? 'transcode' : 'health check'} jobs per ${B.step === HOUR ? 'hour' : B.step === DAY ? 'day' : 'week'}, by status`;
    stackedBars($('chart-outcomes'), {
      labels: B.buckets.map((b) => b.label),
      rows,
      series,
      title: 'Job outcomes over time',
      tipTitle: (i) => bucketTitle(B, i),
      emptyTitle: `No ${type === 'transcode' ? 'transcode' : 'health check'} jobs in this range`,
      emptyDetail: 'Try a longer time range.',
    });
    legend($('legend-outcomes'), series);
  }

  function bucketTitle(B, i) {
    const b = B.buckets[i];
    if (B.step === HOUR) return `${df.format(b.t0)} ${tf.format(b.t0)}–${tf.format(b.t1)}`;
    if (B.step === DAY) return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(b.t0);
    return `Week of ${df.format(b.t0)}`;
  }

  function renderSaved(jobs, B) {
    const per = B.buckets.map(() => 0);
    const counts = B.buckets.map(() => 0);
    for (const j of jobs) {
      if (j.type !== 'transcode' || j.outcome !== 'success' || j.ratio == null) continue;
      const i = B.index(j.end);
      if (i >= 0) { per[i] += j.saved; counts[i] += 1; }
    }
    let acc = 0;
    const cum = per.map((v) => (acc += v));
    $('saved-desc').textContent = `Cumulative size reduction from successful transcodes · ${fmtGB(acc)} in range`;
    areaChart($('chart-saved'), {
      labels: B.buckets.map((b) => b.label),
      values: cum,
      color: C.green,
      title: 'Cumulative space saved',
      tipTitle: (i) => bucketTitle(B, i),
      fmtV: (v) => fmtGB(v),
      fmtY: (v) => `${shortNum(v)} GB`,
      extra: (i) => [{ label: 'This period', value: fmtGB(per[i], true) }, { label: 'Transcodes', value: fmtInt(counts[i]) }],
      emptyTitle: 'No space saved yet',
      emptyDetail: 'Appears once a transcode finishes successfully with a smaller output.',
    });
  }

  function renderThroughput(jobs, B) {
    const rows = B.buckets.map(() => ({ transcode: 0, healthcheck: 0, gb: 0 }));
    for (const j of jobs) {
      const i = B.index(j.end);
      if (i < 0) continue;
      rows[i][j.type] += 1;
      if (j.type === 'transcode' && j.outcome === 'success') rows[i].gb += j.startGB;
    }
    const hours = Math.max(1, (Date.now() - Math.max(rangeStart(), B.buckets[0]?.t0 || 0)) / HOUR);
    const total = jobs.length;
    const gb = sum(rows, (r) => r.gb);
    $('throughput-desc').textContent = `${nf1.format(total / hours)} jobs/hour average · ${fmtGB(gb)} transcoded`;
    const series = [
      { key: 'transcode', label: 'Transcode jobs', color: C.blue },
      { key: 'healthcheck', label: 'Health check jobs', color: C.orange },
    ];
    const line = { key: 'gb', label: 'GB transcoded (input)', color: C.green, fmt: (v) => fmtGB(v), axisFmt: (v) => `${shortNum(v)} GB` };
    comboChart($('chart-throughput'), {
      labels: B.buckets.map((b) => b.label),
      rows,
      series,
      line,
      title: 'Throughput',
      tipTitle: (i) => bucketTitle(B, i),
      emptyTitle: 'No completed jobs in this range',
      emptyDetail: 'Try a longer time range.',
    });
    legend($('legend-throughput'), [...series, { ...line, line: true }]);
  }

  function renderDurations(jobs) {
    const groups = [
      { label: 'Transcode · success', filter: (j) => j.type === 'transcode' && j.outcome === 'success' },
      { label: 'Transcode · not required', filter: (j) => j.type === 'transcode' && j.outcome === 'skipped' },
      { label: 'Transcode · error', filter: (j) => j.type === 'transcode' && j.outcome === 'error' },
      { label: 'Health check', filter: (j) => j.type === 'healthcheck' },
    ];
    const rows = groups.map((g) => {
      const d = jobs.filter(g.filter).map((j) => j.dur).filter((x) => x > 0).sort((a, b) => a - b);
      return { label: g.label, n: d.length, avg: d.length ? sum(d) / d.length : null, p50: quantile(d, 0.5), p95: quantile(d, 0.95), max: d.length ? d[d.length - 1] : null };
    }).filter((r) => r.n);
    table($('durations'), [
      { label: 'Job type', get: (r) => r.label },
      { label: 'Jobs', num: true, get: (r) => fmtInt(r.n) },
      { label: 'Avg', num: true, get: (r) => fmtDur(r.avg) },
      { label: 'p50', num: true, get: (r) => fmtDur(r.p50) },
      { label: 'p95', num: true, get: (r) => fmtDur(r.p95) },
      { label: 'Max', num: true, get: (r) => fmtDur(r.max) },
    ], rows, ['No completed jobs in this range', 'Try a longer time range.']);
  }

  function renderRatio(jobs) {
    const bins = [];
    for (let i = 0; i < 10; i++) bins.push({ lo: i / 10, hi: (i + 1) / 10, label: `${i * 10}–${(i + 1) * 10}%` });
    bins.push({ lo: 1, hi: Infinity, label: '>100%' });
    const rows = bins.map(() => ({ n: 0 }));
    for (const j of jobs) {
      if (j.ratio == null) continue;
      const i = j.ratio >= 1 ? bins.length - 1 : Math.min(9, Math.floor(j.ratio * 10));
      rows[i].n += 1;
    }
    const measured = sum(rows, (r) => r.n);
    stackedBars($('chart-ratio'), {
      labels: bins.map((b) => (b.hi === Infinity ? '>100' : `${Math.round(b.hi * 100)}`)),
      rows,
      series: [{ key: 'n', label: 'Transcodes', color: C.purple }],
      title: 'Output size as share of original',
      tipTitle: (i) => `Output ${bins[i].label} of original${measured ? ` · ${fmtPct(rows[i].n / measured)} of transcodes` : ''}`,
      emptyTitle: 'No measured transcodes yet',
      emptyDetail: 'Needs successful transcodes with recorded start and end sizes.',
    });
  }

  function renderTop(jobs) {
    const ok = jobs.filter((j) => j.ratio != null);
    const cols = (savedLabel) => [
      { label: 'File', cls: 'file', html: (j) => fileCell(j.file, `${libName(j.db)} · ${fmtDateTime(j.end)}`) },
      { label: 'Before', num: true, get: (j) => fmtGB(j.startGB) },
      { label: 'After', num: true, get: (j) => fmtGB(j.endGB) },
      { label: savedLabel, num: true, html: (j) => `<span class="${j.saved >= 0 ? 'pos' : 'neg'}">${esc(fmtGB(Math.abs(j.saved)))}</span>` },
      { label: 'Ratio', num: true, get: (j) => fmtPct(j.ratio) },
    ];
    table($('top-saved'), cols('Saved'), ok.filter((j) => j.saved > 0).sort((a, b) => b.saved - a.saved).slice(0, 10),
      ['No savings recorded in this range', 'Successful transcodes with a smaller output will be listed here.']);
    table($('top-grew'), cols('Grew by'), ok.filter((j) => j.saved < 0).sort((a, b) => a.saved - b.saved).slice(0, 10),
      ['No files grew in this range', 'Good news: no transcode produced a larger file.']);
  }

  function renderFailures(jobs) {
    const rows = jobs.filter((j) => j.outcome === 'error' || j.outcome === 'cancelled').sort((a, b) => b.end - a.end).slice(0, 25);
    table($('failures'), [
      { label: 'File', cls: 'file', html: (j) => fileCell(j.file, j.file && j.file.split('/').slice(-2, -1)[0]) },
      { label: 'Library', get: (j) => libName(j.db) },
      { label: 'Type', get: (j) => (j.type === 'transcode' ? 'Transcode' : 'Health check') },
      { label: 'Node', get: (j) => j.node },
      { label: 'Time', num: true, get: (j) => fmtDateTime(j.end) },
      { label: 'Ran for', num: true, get: (j) => fmtDur(j.dur) },
      { label: 'Status', html: (j) => badge(j.outcome, j.status) },
    ], rows, ['No failures in this range', 'Errored or cancelled jobs will be listed here.']);
  }

  function renderLibraries(jobs) {
    const ids = new Set([...state.libs.keys(), ...state.files.map((f) => f.DB), ...jobs.map((j) => j.db)].filter(Boolean));
    const rows = [...ids].map((id) => {
      const files = state.files.filter((f) => f.DB === id);
      const tj = jobs.filter((j) => j.db === id && j.type === 'transcode');
      return {
        name: libName(id),
        files: files.length,
        size: sum(files, fileGB),
        queued: files.filter(isQueued).length,
        notRequired: files.filter((f) => f.TranscodeDecisionMaker === 'Not required').length,
        ok: tj.filter((j) => j.outcome === 'success').length,
        err: tj.filter((j) => j.outcome === 'error').length,
        saved: sum(tj, (j) => j.saved),
      };
    }).sort((a, b) => b.files - a.files);
    table($('libraries'), [
      { label: 'Library', get: (r) => r.name },
      { label: 'Files', num: true, get: (r) => fmtInt(r.files) },
      { label: 'Size', num: true, get: (r) => fmtGB(r.size) },
      { label: 'Queued', num: true, get: (r) => fmtInt(r.queued) },
      { label: 'Not required', num: true, get: (r) => fmtInt(r.notRequired) },
      { label: 'Transcoded', num: true, get: (r) => fmtInt(r.ok) },
      { label: 'Errors', num: true, get: (r) => fmtInt(r.err) },
      { label: 'Saved', num: true, get: (r) => fmtGB(r.saved) },
    ], rows, ['No libraries found', '']);
  }

  function renderNodes(jobs) {
    const live = new Map(Object.values(state.nodes || {}).map((n) => [n.nodeName, n]));
    const names = new Set([...live.keys(), ...jobs.map((j) => j.node)]);
    const rows = [...names].map((name) => {
      const nj = jobs.filter((j) => j.node === name);
      const tc = nj.filter((j) => j.type === 'transcode');
      const okDur = tc.filter((j) => j.outcome === 'success').map((j) => j.dur);
      const n = live.get(name);
      return {
        name,
        status: n ? (n.nodePaused ? 'Paused' : 'Online') : 'Not connected',
        workers: n ? Object.keys(n.workers || {}).length : 0,
        jobs: nj.length,
        ok: tc.filter((j) => j.outcome === 'success').length,
        skipped: tc.filter((j) => j.outcome === 'skipped').length,
        err: nj.filter((j) => j.outcome === 'error').length,
        hc: nj.filter((j) => j.type === 'healthcheck').length,
        avg: okDur.length ? sum(okDur) / okDur.length : null,
        saved: sum(tc, (j) => j.saved),
      };
    }).sort((a, b) => b.jobs - a.jobs);
    table($('nodes'), [
      { label: 'Node', get: (r) => r.name },
      { label: 'Status', html: (r) => badge(r.status === 'Online' ? 'success' : r.status === 'Paused' ? 'cancelled' : 'other', r.status) },
      { label: 'Active workers', num: true, get: (r) => fmtInt(r.workers) },
      { label: 'Jobs', num: true, get: (r) => fmtInt(r.jobs) },
      { label: 'Transcoded', num: true, get: (r) => fmtInt(r.ok) },
      { label: 'Not required', num: true, get: (r) => fmtInt(r.skipped) },
      { label: 'Health checks', num: true, get: (r) => fmtInt(r.hc) },
      { label: 'Errors', num: true, get: (r) => fmtInt(r.err) },
      { label: 'Avg transcode', num: true, get: (r) => fmtDur(r.avg) },
      { label: 'Saved', num: true, get: (r) => fmtGB(r.saved) },
    ], rows, ['No nodes or jobs', '']);
  }

  function countBy(items, key) {
    const m = new Map();
    for (const it of items) {
      const k = key(it);
      if (k == null) continue;
      for (const v of Array.isArray(k) ? k : [k]) m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  const LANG_NAMES = (() => {
    try { return new Intl.DisplayNames(undefined, { type: 'language' }); } catch { return null; }
  })();
  const ISO639_2 = { eng: 'en', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', pol: 'pl', hun: 'hu', dut: 'nl', nld: 'nl', swe: 'sv', dan: 'da', fin: 'fi', nob: 'nb', nor: 'no', gre: 'el', ell: 'el', tur: 'tr', ara: 'ar', heb: 'he', hin: 'hi', tha: 'th', vie: 'vi', ukr: 'uk', rum: 'ro', ron: 'ro', ind: 'id', may: 'ms', msa: 'ms', hrv: 'hr', srp: 'sr', bul: 'bg', slv: 'sl', est: 'et', lav: 'lv', lit: 'lt', ice: 'is', isl: 'is', cat: 'ca', baq: 'eu', eus: 'eu', glg: 'gl', fil: 'fil', tam: 'ta', tel: 'te', per: 'fa', fas: 'fa' };
  function langName(code) {
    const c = String(code || '').toLowerCase();
    if (!c || c === 'und') return 'Undefined';
    const two = ISO639_2[c] || (c.length === 2 ? c : null);
    if (two && LANG_NAMES) {
      try { const n = LANG_NAMES.of(two); if (n && n.toLowerCase() !== two) return n; } catch { /* unknown code */ }
    }
    return c;
  }

  function streamLangs(file, type) {
    const streams = file.ffProbeData?.streams;
    if (!Array.isArray(streams)) return null;
    const langs = new Set(streams.filter((s) => s.codec_type === type).map((s) => langName(s.tags?.language)));
    return [...langs];
  }

  function renderComposition() {
    const files = state.files;
    if (!state.filesAt) return;
    $('composition-desc').textContent = `Current state of ${fmtInt(files.length)} scanned files · ${fmtGB(sum(files, fileGB))} total`;
    const total = files.length;
    const codecColor = { hevc: C.green, h264: C.blue, av1: C.purple, Unknown: C.zinc };
    hbars($('comp-codec'), countBy(files, (f) => f.video_codec_name || 'Unknown'), { total, colorFor: (n, i) => codecColor[n] || PALETTE[(i + 2) % PALETTE.length] });
    hbars($('comp-res'), countBy(files, (f) => f.video_resolution || 'Unknown'), { total });
    hbars($('comp-container'), countBy(files, (f) => f.container || 'Unknown'), { total });
    hbars($('comp-audio'), countBy(files, (f) => streamLangs(f, 'audio')), { total, colorFor: () => C.blue });
    hbars($('comp-subs'), countBy(files, (f) => streamLangs(f, 'subtitle')), { total, colorFor: () => C.orange, emptyTitle: 'No subtitle tracks' });
    const hcColor = { Success: C.green, Queued: C.zinc, Error: C.pink, Cancelled: C.orange };
    hbars($('comp-health'), countBy(files, (f) => f.HealthCheck || 'Unknown'), { total, colorFor: (n) => hcColor[n] || C.purple });
  }

  function renderStatus() {
    const parts = [];
    if (state.updatedAt) parts.push(`Updated ${tfs.format(state.updatedAt)}`);
    parts.push(`${fmtInt(state.jobs.length)} completed jobs loaded`);
    if (state.jobsTruncated) parts.push(`history capped at ${fmtInt(JOB_PAGE * JOB_MAX_PAGES)} jobs`);
    parts.push('auto-refresh every 60s');
    $('status-line').textContent = parts.join(' · ');
  }

  function renderAll() {
    const jobs = inRange();
    const B = buildBuckets();
    renderKPIs(jobs);
    renderWorkers();
    renderETA();
    renderOutcomes(jobs, B);
    renderSaved(jobs, B);
    renderThroughput(jobs, B);
    renderDurations(jobs);
    renderRatio(jobs);
    renderTop(jobs);
    renderFailures(jobs);
    renderLibraries(jobs);
    renderNodes(jobs);
    renderComposition();
    renderStatus();
  }

  function renderCharts() {
    const jobs = inRange();
    const B = buildBuckets();
    renderOutcomes(jobs, B);
    renderSaved(jobs, B);
    renderThroughput(jobs, B);
    renderRatio(jobs);
  }

  // ---------- data loading ----------
  function showError(err) {
    const el = $('error');
    if (!err) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = `Could not load data: ${err.message || err}. Showing the last successful snapshot.`;
  }

  async function refresh({ force = false } = {}) {
    if (state.loading) { state.pending = true; return; }
    state.loading = true;
    state.pending = false;
    $('refresh').classList.add('loading');
    try {
      const span = RANGES[state.range];
      const cutoff = span === Infinity ? -Infinity : Date.now() - span;
      const needFiles = force || !state.filesAt || Date.now() - state.filesAt > FILES_MS;
      const [jobsRes, nodes, libs, files] = await Promise.all([
        fetchJobs(cutoff),
        get('/get-nodes').catch(() => state.nodes),
        state.libs.size && !force ? Promise.resolve(state.libs) : fetchLibs().catch(() => state.libs),
        needFiles ? fetchFiles() : Promise.resolve(null),
      ]);
      state.jobs = jobsRes.jobs.filter((j) => j.end > 0).map(normalizeJob);
      state.jobsTotal = jobsRes.total;
      state.jobsTruncated = jobsRes.truncated;
      state.nodes = nodes || {};
      state.libs = libs;
      if (files) { state.files = files; state.filesAt = Date.now(); }
      state.updatedAt = Date.now();
      showError(null);
    } catch (err) {
      showError(err);
    } finally {
      state.loading = false;
      $('refresh').classList.remove('loading');
      renderAll();
      if (state.pending) refresh();
    }
  }

  async function refreshNodes() {
    if (state.loading || document.hidden) return;
    try {
      state.nodes = await get('/get-nodes');
      renderWorkers();
    } catch { /* full refresh reports errors */ }
  }

  function syncControls() {
    document.querySelectorAll('#range button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.range === state.range)));
    document.querySelectorAll('#jobtype button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.type === state.jobType)));
  }

  $('range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b || b.dataset.range === state.range) return;
    state.range = b.dataset.range;
    localStorage.setItem('insights.range', state.range);
    syncControls();
    renderAll();
    refresh();
  });

  $('jobtype').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b || b.dataset.type === state.jobType) return;
    state.jobType = b.dataset.type;
    localStorage.setItem('insights.jobType', state.jobType);
    syncControls();
    renderOutcomes(inRange(), buildBuckets());
  });

  $('refresh').addEventListener('click', () => refresh({ force: true }));

  let resizeTimer;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 120);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.updatedAt && Date.now() - state.updatedAt > REFRESH_MS) refresh();
  });

  syncControls();
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  setInterval(refreshNodes, NODES_MS);
})();
