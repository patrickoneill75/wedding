// Small SVG charts for the finance page, drawn here so no outside library ever sees the
// numbers. Each takes a container and plain arrays, and calls onHover(index, event).

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of kids) if (c != null) n.append(c);
  return n;
};

export function compact(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
}

function niceTicks(min, max, count = 5) {
  if (min === max) max = min + 1;
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= step0) || step0;
  const out = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function frame(el, { height = 320, labels, min, max }) {
  const width = Math.max(320, el.clientWidth || 800);
  const pad = { l: 58, r: 12, t: 26, b: 28 };
  const w = width - pad.l - pad.r;
  const hgt = height - pad.t - pad.b;
  const ticks = niceTicks(min, max);
  const lo = Math.min(ticks[0], min);
  const hi = Math.max(ticks[ticks.length - 1], max);
  const y = (v) => pad.t + hgt - ((v - lo) / (hi - lo || 1)) * hgt;
  const n = labels.length;
  const x = (i) => pad.l + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  for (const t of ticks) {
    svg.append(s("line", { x1: pad.l, x2: pad.l + w, y1: y(t), y2: y(t), class: "gridline", ...(t === 0 ? { style: "stroke: var(--text-muted)" } : {}) }));
    svg.append(s("text", { x: pad.l - 6, y: y(t) + 4, "text-anchor": "end", class: "axis-label" }, compact(t)));
  }
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 60))));
  // Every few years, plus the last, never closer than 36px to the one before.
  let lastX = -Infinity;
  labels.forEach((lab, i) => {
    if (!(i % every === 0 || i === n - 1) || x(i) - lastX < 36) return;
    lastX = x(i);
    svg.append(s("text", { x: x(i), y: height - 8, "text-anchor": "middle", class: "axis-label" }, String(lab)));
  });
  return { svg, x, y, w, hgt, pad, width, height, n };
}

function hoverLayer(f, onHover, onLeave) {
  const band = f.n > 1 ? f.w / (f.n - 1) : f.w;
  const guide = s("line", { y1: f.pad.t, y2: f.pad.t + f.hgt, stroke: "var(--text-muted)", "stroke-dasharray": "3 3", visibility: "hidden" });
  f.svg.append(guide);
  for (let i = 0; i < f.n; i++) {
    const r = s("rect", { x: f.x(i) - band / 2, y: f.pad.t, width: band, height: f.hgt, fill: "transparent" });
    const show = (ev) => {
      guide.setAttribute("x1", f.x(i));
      guide.setAttribute("x2", f.x(i));
      guide.setAttribute("visibility", "visible");
      onHover?.(i, ev);
    };
    r.addEventListener("mousemove", show);
    r.addEventListener("touchstart", (ev) => show(ev.touches[0]), { passive: true });
    r.addEventListener("mouseleave", () => {
      guide.setAttribute("visibility", "hidden");
      onLeave?.();
    });
    f.svg.append(r);
  }
}

function legend(items) {
  const box = document.createElement("div");
  box.className = "legend";
  for (const it of items) {
    const sp = document.createElement("span");
    sp.style.setProperty("--swatch", it.color);
    sp.textContent = it.label;
    if (it.dashed) sp.className = "dashed";
    box.append(sp);
  }
  return box;
}

/**
 * Stacked areas: `up` series stack above zero, `down` series below it. `line` (net
 * worth) and `compare` (another scenario) draw on top. `markers`: [{ index, label }].
 */
export function stackedArea(el, { labels, up, down = [], line, compare, markers = [], onHover, onLeave, height = 340 }) {
  const n = labels.length;
  const tops = Array.from({ length: n }, (_, i) => up.reduce((t, sr) => t + Math.max(0, sr.values[i] || 0), 0));
  const bottoms = Array.from({ length: n }, (_, i) => -down.reduce((t, sr) => t + Math.max(0, sr.values[i] || 0), 0));
  const all = [...tops, ...bottoms, ...(line?.values || []), ...(compare?.values || []), 0];
  const f = frame(el, { height, labels, min: Math.min(...all), max: Math.max(...all) });
  const stack = (series, sign) => {
    let base = new Array(n).fill(0);
    for (const sr of series) {
      const next = base.map((b, i) => b + sign * Math.max(0, sr.values[i] || 0));
      const pts = next.map((v, i) => `${f.x(i)},${f.y(v)}`).join(" ");
      const back = base.map((v, i) => `${f.x(i)},${f.y(v)}`).reverse().join(" ");
      f.svg.append(s("polygon", { points: `${pts} ${back}`, fill: sr.color, "fill-opacity": 0.78, stroke: sr.color, "stroke-width": 0.5 }));
      base = next;
    }
  };
  stack(up, 1);
  stack(down, -1);
  const path = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${f.x(i)},${f.y(v)}`).join("");
  if (compare) f.svg.append(s("path", { d: path(compare.values), fill: "none", stroke: compare.color || "var(--text-primary)", "stroke-width": 2, "stroke-dasharray": "6 4" }));
  if (line) f.svg.append(s("path", { d: path(line.values), fill: "none", stroke: line.color || "var(--text-primary)", "stroke-width": 2.2 }));
  for (const m of markers) {
    const x = f.x(m.index);
    const g = s("g", {});
    g.append(s("line", { x1: x, x2: x, y1: f.pad.t - 4, y2: f.pad.t + f.hgt, stroke: m.color || "var(--text-muted)", "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0.7 }));
    g.append(s("circle", { cx: x, cy: f.pad.t - 8, r: 5, fill: m.color || "var(--accent)" }, s("title", {}, m.label)));
    f.svg.append(g);
  }
  hoverLayer(f, onHover, onLeave);
  const items = [...up, ...down].map((sr) => ({ label: sr.label, color: sr.color }));
  if (line) items.push({ label: line.label, color: line.color || "var(--text-primary)" });
  if (compare) items.push({ label: compare.label, color: compare.color || "var(--text-primary)", dashed: true });
  el.replaceChildren(legend(items), f.svg);
}

/** Stacked bars per year, with an optional line (income) across them. */
export function stackedBars(el, { labels, series, line, onHover, onLeave, height = 320 }) {
  const n = labels.length;
  const tops = Array.from({ length: n }, (_, i) => series.reduce((t, sr) => t + Math.max(0, sr.values[i] || 0), 0));
  const f = frame(el, { height, labels, min: 0, max: Math.max(1, ...tops, ...(line?.values || [])) });
  const bw = Math.max(1.5, Math.min(18, (f.w / Math.max(1, n)) * 0.7));
  for (let i = 0; i < n; i++) {
    let base = 0;
    for (const sr of series) {
      const v = Math.max(0, sr.values[i] || 0);
      if (!v) continue;
      f.svg.append(s("rect", { x: f.x(i) - bw / 2, y: f.y(base + v), width: bw, height: Math.max(0, f.y(base) - f.y(base + v)), fill: sr.color }));
      base += v;
    }
  }
  if (line) f.svg.append(s("path", { d: line.values.map((v, i) => `${i ? "L" : "M"}${f.x(i)},${f.y(v)}`).join(""), fill: "none", stroke: line.color || "var(--text-primary)", "stroke-width": 2 }));
  hoverLayer(f, onHover, onLeave);
  el.replaceChildren(legend([...series.map((sr) => ({ label: sr.label, color: sr.color })), ...(line ? [{ label: line.label, color: line.color || "var(--text-primary)" }] : [])]), f.svg);
}

/** The Monte Carlo range: a shaded 10th to 90th percentile band and the median line. */
export function bandChart(el, { labels, low, mid, high, onHover, onLeave, height = 300 }) {
  const all = [...low, ...mid, ...high, 0];
  const f = frame(el, { height, labels, min: Math.min(...all), max: Math.max(...all) });
  const pts = (vals) => vals.map((v, i) => `${f.x(i)},${f.y(v)}`);
  f.svg.append(s("polygon", { points: [...pts(high), ...pts(low).reverse()].join(" "), fill: "var(--series-1)", "fill-opacity": 0.22 }));
  f.svg.append(s("path", { d: mid.map((v, i) => `${i ? "L" : "M"}${f.x(i)},${f.y(v)}`).join(""), fill: "none", stroke: "var(--series-1)", "stroke-width": 2.2 }));
  hoverLayer(f, onHover, onLeave);
  el.replaceChildren(legend([{ label: "Middle outcome", color: "var(--series-1)" }, { label: "Range of 8 in 10 outcomes", color: "color-mix(in srgb, var(--series-1) 30%, transparent)" }]), f.svg);
}

/**
 * A Sankey chart in columns. nodes: [{ id, label, col, color, value }]; links:
 * [{ source, target, value, color }]. Node heights follow their value; links are bands
 * whose width is their value. fmt(n) formats amounts; onHover(text, rows, ev).
 */
export function sankey(el, { nodes, links, fmt, onHover, onLeave }) {
  const width = Math.max(720, el.clientWidth || 900);
  const cols = Math.max(...nodes.map((n) => n.col)) + 1;
  const nodeW = 14;
  const gap = 10;
  const minSlot = 15;
  // Room for the longest label on each side (about 7px a character).
  const longest = (c) => Math.max(0, ...nodes.filter((n) => n.col === c).map((n) => `${n.label}  ${fmt(n.value)}`.length));
  const pad = { t: 10, b: 10, l: Math.min(360, 24 + longest(0) * 7), r: Math.min(300, 24 + longest(cols - 1) * 7) };
  const colX = (c) => pad.l + (c / (cols - 1)) * (width - pad.l - pad.r - nodeW);
  const byCol = Array.from({ length: cols }, (_, c) => nodes.filter((n) => n.col === c));
  const total = Math.max(...byCol.map((list) => list.reduce((t, n) => t + n.value, 0)), 1);
  const target = 420;
  const k = Math.min(...byCol.map((list) => (target - (list.length - 1) * gap) / total));
  let height = 0;
  for (const list of byCol) {
    const used = list.reduce((t, n) => t + Math.max(n.value * k, minSlot), 0) + (list.length - 1) * gap;
    height = Math.max(height, used);
  }
  height += pad.t + pad.b;
  for (const list of byCol) {
    const used = list.reduce((t, n) => t + Math.max(n.value * k, minSlot), 0) + (list.length - 1) * gap;
    let y = pad.t + (height - pad.t - pad.b - used) / 2;
    for (const n of list) {
      n.x = colX(n.col);
      n.h = Math.max(1, n.value * k);
      n.slot = Math.max(n.h, minSlot);
      n.y = y + (n.slot - n.h) / 2;
      n.outY = n.y;
      n.inY = n.y;
      y += n.slot + gap;
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const bands = s("g", {});
  svg.append(bands);
  for (const l of links) {
    const a = byId.get(l.source);
    const b = byId.get(l.target);
    if (!a || !b || !(l.value > 0)) continue;
    const w = l.value * k;
    const x0 = a.x + nodeW;
    const x1 = b.x;
    const y0 = a.outY;
    const y1 = b.inY;
    a.outY += w;
    b.inY += w;
    const xm = (x0 + x1) / 2;
    const p = s("path", {
      d: `M${x0},${y0} C${xm},${y0} ${xm},${y1} ${x1},${y1} L${x1},${y1 + w} C${xm},${y1 + w} ${xm},${y0 + w} ${x0},${y0 + w} Z`,
      fill: l.color || b.color || "var(--text-muted)", "fill-opacity": 0.32, class: "band",
    });
    const show = (ev) => {
      p.setAttribute("fill-opacity", 0.6);
      onHover?.(`${a.label} → ${b.label}`, [["Amount", fmt(l.value)]], ev);
    };
    p.addEventListener("mousemove", show);
    p.addEventListener("touchstart", (ev) => show(ev.touches[0]), { passive: true });
    p.addEventListener("mouseleave", () => {
      p.setAttribute("fill-opacity", 0.32);
      onLeave?.();
    });
    bands.append(p);
  }
  for (const n of nodes) {
    const r = s("rect", { x: n.x, y: n.y, width: nodeW, height: n.h, fill: n.color || "var(--text-muted)", rx: 2 });
    r.addEventListener("mousemove", (ev) => onHover?.(n.label, [["Amount", fmt(n.value)]], ev));
    r.addEventListener("mouseleave", () => onLeave?.());
    svg.append(r);
    const left = n.col === 0;
    const last = n.col === cols - 1;
    const tx = left ? n.x - 8 : last ? n.x + nodeW + 8 : n.x + nodeW + 6;
    const t = s("text", { x: tx, y: n.y + n.h / 2 + 4, "text-anchor": left ? "end" : "start", class: n.col > 0 && !last ? "sk-mid" : "" });
    t.append(s("tspan", { "font-weight": 600 }, n.label), s("tspan", { dx: 6, class: "axis-label" }, fmt(n.value)));
    svg.append(t);
  }
  el.replaceChildren(svg);
}

/** A small balance-over-time chart: `values` by year, an optional dashed `target` line. */
export function sparkline(el, { labels, values, target, color = "var(--series-3)", onHover, onLeave, height = 110 }) {
  const all = [...values, ...(target || []).filter((v) => v != null), 0];
  const f = frame(el, { height, labels, min: Math.min(...all), max: Math.max(...all) });
  const pts = values.map((v, i) => `${f.x(i)},${f.y(v)}`);
  f.svg.append(s("polygon", { points: [`${f.x(0)},${f.y(0)}`, ...pts, `${f.x(values.length - 1)},${f.y(0)}`].join(" "), fill: color, "fill-opacity": 0.18 }));
  f.svg.append(s("path", { d: values.map((v, i) => `${i ? "L" : "M"}${f.x(i)},${f.y(v)}`).join(""), fill: "none", stroke: color, "stroke-width": 2 }));
  if (target?.some((v) => v != null)) {
    let d = "";
    let pen = false;
    target.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${f.x(i)},${f.y(v)}`;
      pen = true;
    });
    f.svg.append(s("path", { d, fill: "none", stroke: "var(--text-secondary)", "stroke-width": 1.5, "stroke-dasharray": "5 4" }));
  }
  hoverLayer(f, onHover, onLeave);
  el.replaceChildren(f.svg);
}
