"""dashboard.html: one self-contained file (data embedded as JSON, charts drawn as inline SVG by a
small script, no network access). It reloads every minute while the run is active."""

import json
import math

from .report import ratings, step_seconds, warnings
from .state import Run
from .util import folder_bytes, free_disk_gb
from .. import league as L


def data(run: Run, cfg) -> dict:
    s = run.state
    r, games = ratings(s)
    models = [m for m in s["models"] if m["status"] != "abandoned"]
    names = [m["name"] for m in models]
    h2h = []
    for a in names:
        row = []
        for b in names:
            w, d, l = L.result_between(games, a, b)
            n = w + d + l
            row.append(None if a == b or not n else [round((w + d / 2) / n, 3), n])
        h2h.append(row)
    curves = {}
    for m in models[1:]:
        mf = run.path("train", m["name"], "metrics.jsonl")
        if mf.exists():
            curves[m["name"]] = [json.loads(x)["val_loss"] for x in mf.read_text().splitlines() if x.strip()]
    clean = lambda x: None if x is None or (isinstance(x, float) and math.isnan(x)) else x
    return {
        "name": s["name"], "description": s.get("description", ""), "updated": s["updated"],
        "condition": s["condition"], "teacher": run.teacher(), "running": bool(run.running()),
        "models": [{"name": m["name"], "status": m["status"], "teacher": m.get("teacher"),
                    "elo": clean(r[m["name"]][0]), "se": clean(r[m["name"]][1]),
                    "val_loss": (m.get("training") or {}).get("best", {}).get("val_loss"),
                    "g0_val_loss": (m.get("training") or {}).get("g0", {}).get("val_loss"),
                    "steps": step_seconds(m), "gate": m.get("gate"), "reason": m.get("reason", "")} for m in models],
        "h2h": h2h, "curves": curves,
        "rounds": [{"round": x["round"], "teacher": x["teacher"], "status": x.get("status"),
                    "positions": x.get("positions_train") or sum(y["positions"] for y in x.get("shards", [])),
                    "games": x.get("games"), "results": x.get("results"), "hours": (x.get("seconds") or 0) / 3600}
                   for x in s["rounds"]],
        "games": sum(g["w"] + g["d"] + g["l"] for g in games),
        "warnings": warnings(s),
        "disk": {"run": folder_bytes(run.root), "free_gb": round(free_disk_gb(run.root), 1)},
        "events": run.events(12),
    }


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ dashboard</title>
<style>
:root { --bg:#fbfaf7; --panel:#ffffff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e4e2dc;
  --acc:#2f6fb3; --rej:#b8562f; --g0:#8a8780; --pos:#2f8a5f; --neg:#b8562f; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#161615; --panel:#1f1f1d; --ink:#ecebe6;
  --muted:#9d9b94; --line:#34332f; --acc:#6aa5e6; --rej:#e08a62; --g0:#8f8c85; --pos:#5cc08e; --neg:#e08a62; } }
:root[data-theme="dark"] { --bg:#161615; --panel:#1f1f1d; --ink:#ecebe6; --muted:#9d9b94; --line:#34332f;
  --acc:#6aa5e6; --rej:#e08a62; --g0:#8f8c85; --pos:#5cc08e; --neg:#e08a62; }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--ink);
  font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif }
main { max-width:1100px; margin:0 auto; padding:24px 16px 48px }
h1 { font-size:22px; margin:0 } h2 { font-size:16px; margin:0 0 10px } .muted { color:var(--muted) }
header { display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap; margin-bottom:16px }
button { font:inherit; background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:3px 9px; cursor:pointer }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:16px }
.tile, .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px }
.tile b { display:block; font-size:22px } .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr)); gap:14px }
.card { overflow-x:auto } svg { display:block; width:100%; height:auto } svg text { fill:var(--muted); font-size:11px }
table { border-collapse:collapse; width:100%; font-size:13px } td, th { padding:4px 6px; border-bottom:1px solid var(--line); text-align:right }
td:first-child, th:first-child { text-align:left } .warn { border-color:var(--rej) } .hidden { display:none }
.tip { position:fixed; pointer-events:none; background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:4px 8px; font-size:12px; display:none }
.toggle { float:right; font-size:12px }
</style></head><body><main>
<header><div><h1 id="title"></h1><div class="muted" id="sub"></div></div>
<div><button id="theme">Theme: auto</button></div></header>
<div class="tiles" id="tiles"></div>
<div id="warnings"></div>
<div class="grid">
 <section class="card"><button class="toggle" data-t="ladder">Table</button><h2>Ratings (Elo vs G0, ±1 s.e.)</h2><div id="ladder"></div></section>
 <section class="card"><button class="toggle" data-t="loss">Table</button><h2>Validation loss relative to G0</h2><div id="loss"></div></section>
 <section class="card"><button class="toggle" data-t="curves">Table</button><h2>Training curves (validation loss)</h2><div id="curves"></div></section>
 <section class="card"><button class="toggle" data-t="time">Table</button><h2>Time per generation</h2><div id="time"></div></section>
 <section class="card"><h2>Head to head (row's score)</h2><div id="h2h"></div></section>
 <section class="card"><h2>Data rounds</h2><div id="rounds"></div></section>
 <section class="card"><h2>Recent events</h2><div id="events"></div></section>
</div><div class="tip" id="tip"></div></main>
<script id="data" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const $ = id => document.getElementById(id), css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const tip = $('tip');
function hover(el, text) { el.addEventListener('mousemove', e => { tip.style.display='block'; tip.textContent=text;
  tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px'; }); el.addEventListener('mouseleave', () => tip.style.display='none'); }
function svg(w, h) { const s = document.createElementNS('http://www.w3.org/2000/svg','svg'); s.setAttribute('viewBox',`0 0 ${w} ${h}`); return s; }
function el(tag, attrs, parent) { const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; }
function table(head, rows) { return '<table><tr>' + head.map(h => `<th>${esc(h)}</th>`).join('') + '</tr>' +
  rows.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') + '</table>'; }
function axisY(s, x0, y0, y1, lo, hi, fmt, W) { for (let i = 0; i <= 4; i++) { const v = lo + (hi-lo)*i/4, y = y0 - (y0-y1)*i/4;
  el('line',{x1:x0,x2:W-8,y1:y,y2:y,stroke:css('--line')},s); const t = el('text',{x:x0-6,y:y+4,'text-anchor':'end'},s); t.textContent = fmt(v); } }
function colorOf(m) { return m.name === 'g0' ? css('--g0') : m.status === 'accepted' ? css('--acc') : css('--rej'); }
function draw() {
  $('title').textContent = D.name; document.title = D.name + ' dashboard';
  $('sub').textContent = `${D.description ? D.description + ' · ' : ''}updated ${D.updated} · ${D.running ? 'running' : 'not running'} · games at ${D.condition}`;
  const best = D.models.filter(m => m.status === 'accepted').pop();
  const rated = D.models.filter(m => m.elo != null);
  const top = rated.reduce((a, m) => m.elo > a.elo ? m : a, rated[0]);
  const tiles = [['Teacher', D.teacher], ['Teacher rating', best && best.elo != null ? (best.elo>=0?'+':'') + best.elo.toFixed(0) : '–'],
    ['Models', D.models.length - 1], ['Accepted', D.models.filter(m => m.status==='accepted').length - 1],
    ['Rated games', D.games.toLocaleString()], ['Disk', (D.disk.run/1e9).toFixed(1) + ' GB · ' + D.disk.free_gb + ' GB free']];
  $('tiles').innerHTML = tiles.map(([k, v]) => `<div class="tile"><span class="muted">${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  $('warnings').innerHTML = D.warnings.length ? `<div class="card warn" style="margin-bottom:14px"><h2>Warnings</h2>${D.warnings.map(w=>`<div>${esc(w)}</div>`).join('')}</div>` : '';
  // ladder
  { const W = 500, H = 240, x0 = 44, y0 = H-26, y1 = 12, ms = rated; const lo = Math.min(0, ...ms.map(m => m.elo - 2*(m.se||0))),
      hi = Math.max(10, ...ms.map(m => m.elo + 2*(m.se||0))); const s = svg(W, H); axisY(s, x0, y0, y1, lo, hi, v => v.toFixed(0), W);
    const step = (W - x0 - 20) / Math.max(1, ms.length); const Y = v => y0 - (v-lo)/(hi-lo)*(y0-y1);
    ms.forEach((m, i) => { const x = x0 + step*(i+0.5); const c = colorOf(m);
      el('line',{x1:x,x2:x,y1:Y(m.elo-(m.se||0)),y2:Y(m.elo+(m.se||0)),stroke:c,'stroke-width':2},s);
      const dot = el('circle',{cx:x,cy:Y(m.elo),r:5,fill:c},s); hover(dot, `${m.name} (${m.status}): ${m.elo.toFixed(0)} ± ${(m.se||0).toFixed(0)}`);
      const t = el('text',{x,y:H-8,'text-anchor':'middle'},s); t.textContent = m.name; });
    $('ladder').replaceChildren(s); $('ladder').dataset.table = table(['Model','Status','Elo','± s.e.'], ms.map(m => [m.name, m.status, m.elo.toFixed(0), (m.se||0).toFixed(0)])); }
  // loss relative to G0
  { const ms = D.models.filter(m => m.val_loss && m.g0_val_loss); const W = 500, H = 200, x0 = 44, y0 = H-26, y1 = 12; const s = svg(W, H);
    const v = ms.map(m => m.val_loss / m.g0_val_loss); const lo = Math.min(0.5, ...v), hi = Math.max(1, ...v);
    axisY(s, x0, y0, y1, lo, hi, x => (x*100).toFixed(0)+'%', W); const step = (W-x0-20)/Math.max(1, ms.length);
    ms.forEach((m, i) => { const x = x0 + step*i + step*0.2, y = y0 - (v[i]-lo)/(hi-lo)*(y0-y1);
      const b = el('rect',{x,y,width:step*0.6,height:y0-y,fill:colorOf(m),rx:3},s); hover(b, `${m.name}: ${(v[i]*100).toFixed(1)}% of G0's loss`);
      const t = el('text',{x:x+step*0.3,y:H-8,'text-anchor':'middle'},s); t.textContent = m.name; });
    $('loss').replaceChildren(s); $('loss').dataset.table = table(['Model','Val loss','G0 val loss','Ratio'], ms.map((m,i) => [m.name, m.val_loss.toFixed(6), m.g0_val_loss.toFixed(6), (v[i]*100).toFixed(1)+'%'])); }
  // curves
  { const names = Object.keys(D.curves); const W = 500, H = 200, x0 = 54, y0 = H-26, y1 = 12; const s = svg(W, H);
    const all = names.flatMap(n => D.curves[n]); if (all.length) { const lo = Math.min(...all), hi = Math.max(...all) + 1e-9;
      const n = Math.max(...names.map(k => D.curves[k].length)); axisY(s, x0, y0, y1, lo, hi, v => v.toFixed(4), W);
      names.forEach((k, j) => { const pts = D.curves[k].map((v, i) => `${x0 + (W-x0-20)*i/Math.max(1,n-1)},${y0 - (v-lo)/(hi-lo)*(y0-y1)}`).join(' ');
        const newest = j === names.length - 1; const p = el('polyline',{points:pts,fill:'none',stroke:newest?css('--acc'):css('--g0'),'stroke-width':newest?2.5:1.2,opacity:newest?1:0.6},s);
        hover(p, `${k}: best ${Math.min(...D.curves[k]).toFixed(6)} over ${D.curves[k].length} epochs`); }); }
    $('curves').replaceChildren(s); $('curves').dataset.table = table(['Model','Epochs','Best','Last'], names.map(k => [k, D.curves[k].length, Math.min(...D.curves[k]).toFixed(6), D.curves[k].at(-1).toFixed(6)])); }
  // time per generation
  { const steps = ['data','window','train','gate','league']; const cols = [css('--acc'), css('--g0'), css('--pos'), css('--rej'), css('--muted')];
    const ms = D.models.slice(1); const W = 500, H = 220, x0 = 44, y0 = H-40, y1 = 12; const s = svg(W, H);
    const tot = ms.map(m => steps.reduce((a, k) => a + (m.steps[k]||0), 0) / 60); const hi = Math.max(1, ...tot);
    axisY(s, x0, y0, y1, 0, hi, v => v.toFixed(0)+'m', W); const step = (W-x0-20)/Math.max(1, ms.length);
    ms.forEach((m, i) => { let y = y0; steps.forEach((k, j) => { const h = (m.steps[k]||0)/60/hi*(y0-y1); if (h <= 0) return;
        const r = el('rect',{x:x0+step*i+step*0.2,y:y-h,width:step*0.6,height:h,fill:cols[j]},s); hover(r, `${m.name} ${k}: ${((m.steps[k]||0)/60).toFixed(1)} min`); y -= h; });
      const t = el('text',{x:x0+step*(i+0.5),y:y0+14,'text-anchor':'middle'},s); t.textContent = m.name; });
    steps.forEach((k, j) => { el('rect',{x:x0+j*80,y:H-14,width:10,height:10,fill:cols[j]},s); const t = el('text',{x:x0+j*80+14,y:H-5},s); t.textContent = k; });
    $('time').replaceChildren(s); $('time').dataset.table = table(['Model',...steps,'Total (min)'], ms.map((m,i) => [m.name, ...steps.map(k => ((m.steps[k]||0)/60).toFixed(1)), tot[i].toFixed(1)])); }
  // head to head heatmap
  { const ns = D.models.map(m => m.name); let h = '<table><tr><th></th>' + ns.map(n => `<th>${esc(n)}</th>`).join('') + '</tr>';
    D.h2h.forEach((row, i) => { h += `<tr><td>${esc(ns[i])}</td>` + row.map(c => { if (!c) return '<td></td>'; const d = c[0]-0.5;
      const col = d >= 0 ? css('--pos') : css('--neg'); const a = Math.min(1, Math.abs(d)*3);
      return `<td title="${c[1]} games" style="background:color-mix(in srgb, ${col} ${(a*70).toFixed(0)}%, transparent)">${c[0].toFixed(2)}</td>`; }).join('') + '</tr>'; });
    $('h2h').innerHTML = h + '</table>'; }
  $('rounds').innerHTML = table(['Round','Teacher','Status','Positions','Games','White / draw / Black','Hours'], D.rounds.map(r => { const s = r.results ? r.results.white+r.results.draw+r.results.black : 0;
    return [r.round, r.teacher, r.status, (r.positions||0).toLocaleString(), r.games ?? '', s ? [r.results.white,r.results.draw,r.results.black].map(x => (100*x/s).toFixed(1)+'%').join(' / ') : '', r.hours.toFixed(2)]; }));
  $('events').innerHTML = table(['Time','Event','Details'], D.events.slice().reverse().map(e => { const {time, t, event, ...rest} = e; return [time.replace('T',' ').slice(0,19), event, JSON.stringify(rest).slice(0,90)]; }));
}
document.querySelectorAll('.toggle').forEach(b => b.addEventListener('click', () => { const d = $(b.dataset.t);
  if (d.dataset.chart) { d.innerHTML = ''; d.appendChild(d._svg); delete d.dataset.chart; b.textContent = 'Table'; }
  else { d._svg = d.firstChild; d.innerHTML = d.dataset.table; d.dataset.chart = '1'; b.textContent = 'Chart'; } }));
const themes = ['auto','light','dark']; let ti = 0; try { ti = Math.max(0, themes.indexOf(localStorage.getItem('sk-theme') || 'auto')); } catch (e) {}
function applyTheme() { const t = themes[ti]; if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  $('theme').textContent = 'Theme: ' + t; draw(); }
$('theme').addEventListener('click', () => { ti = (ti+1) % 3; try { localStorage.setItem('sk-theme', themes[ti]); } catch (e) {} applyTheme(); });
applyTheme();
if (D.running) setTimeout(() => location.reload(), 60000);
</script></body></html>
"""


def dashboard_html(run: Run, cfg) -> str:
    payload = json.dumps(data(run, cfg)).replace("</", "<\\/")
    return PAGE.replace("__TITLE__", run.state["name"]).replace("__DATA__", payload)
