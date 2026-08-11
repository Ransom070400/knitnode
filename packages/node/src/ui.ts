/**
 * The console served at `GET /`.
 *
 * Embedded as a string rather than read from disk so it survives `tsc` (which
 * copies no assets) and works identically whether the package is run from
 * source or from `dist`. It is served by the same server that answers JSON-RPC,
 * which means same-origin: no CORS, no configuration, nothing to point at.
 */
export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>knitnode console</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #fff; --ink: #1a1a19; --muted: #6b6b68;
    --line: #e4e4e1; --accent: #b8543a; --accent-soft: #fdf1ed;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17171a; --panel: #1e1e22; --ink: #ececeb; --muted: #9a9a96;
      --line: #2e2e34; --accent: #e08265; --accent-soft: #2a1f1c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  .pills { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }
  .pill {
    font: 12px/1 var(--mono); padding: 6px 10px; border-radius: 999px;
    background: var(--bg); border: 1px solid var(--line); color: var(--muted);
    white-space: nowrap;
  }
  .pill b { color: var(--ink); font-weight: 600; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; }
  .up { background: #2f9e63; } .down { background: #c8503a; }
  main { display: grid; grid-template-columns: 260px 1fr; gap: 20px; padding: 20px; max-width: 1100px; }
  @media (max-width: 760px) { main { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  .coll {
    width: 100%; text-align: left; display: block; padding: 9px 11px; margin-bottom: 6px;
    border: 1px solid var(--line); border-radius: 7px; background: transparent;
    color: inherit; font: inherit; cursor: pointer;
  }
  .coll:hover { border-color: var(--accent); }
  .coll[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
  .coll .nm { display: block; font-weight: 600; font-size: 14px; }
  .coll .meta { display: block; margin-top: 2px; font: 11px/1.4 var(--mono); color: var(--muted); }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
  textarea, input {
    width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 7px;
    background: var(--bg); color: var(--ink); font: 13px/1.5 var(--mono);
  }
  textarea { resize: vertical; min-height: 76px; }
  textarea:focus, input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .row { display: flex; gap: 10px; align-items: flex-end; margin-top: 12px; flex-wrap: wrap; }
  .row > div { flex: 0 0 90px; }
  button.go, button.alt {
    padding: 9px 16px; border-radius: 7px; font: 600 13px/1 inherit; cursor: pointer; border: 1px solid var(--line);
  }
  button.go { background: var(--accent); color: #fff; border-color: var(--accent); }
  button.alt { background: transparent; color: var(--muted); }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th { text-align: left; font: 600 11px/1 inherit; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 0 10px 8px 0; }
  td { padding: 8px 10px 8px 0; border-top: 1px solid var(--line); vertical-align: top; font-size: 13px; }
  td.id { font-family: var(--mono); font-weight: 600; }
  td.d { font-family: var(--mono); color: var(--muted); white-space: nowrap; }
  td.md { font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-word; }
  .bar { height: 3px; border-radius: 2px; background: var(--accent); opacity: .8; margin-top: 5px; }
  .note { color: var(--muted); font-size: 13px; margin: 0; }
  .err { color: #c8503a; font: 13px/1.5 var(--mono); margin: 12px 0 0; white-space: pre-wrap; }
  .scroll { overflow-x: auto; }
</style>
</head>
<body>
<header>
  <h1>knit<span>node</span> console</h1>
  <div class="pills">
    <span class="pill" id="p-health"><span class="dot down"></span>connecting</span>
    <span class="pill">block <b id="p-block">—</b></span>
    <span class="pill">entries <b id="p-entries">—</b></span>
  </div>
</header>

<main>
  <section class="card">
    <h2>Collections</h2>
    <div id="colls"><p class="note">Loading…</p></div>
  </section>

  <section class="card">
    <h2>Similarity search</h2>
    <label for="q">Query vector — JSON array or comma-separated. Comes from your embedding model; <em>Random</em> is for smoke-testing.</label>
    <textarea id="q" spellcheck="false" placeholder="[0.95, 0.05, 0]"></textarea>
    <div class="row">
      <div>
        <label for="k">k</label>
        <input id="k" type="number" min="1" max="100" value="5">
      </div>
      <button class="go" id="run">Search</button>
      <button class="alt" id="rand">Random vector</button>
    </div>
    <p class="err" id="err" hidden></p>
    <div id="out"></div>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
let selected = null;
let dims = {};

async function rpc(method, params) {
  const res = await fetch('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

function showError(e) {
  const el = $('err');
  if (!e) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = String(e && e.message ? e.message : e);
  // Drop any previous hits: they answered a different query, and leaving them
  // under an error message reads as though they answered this one.
  $('out').innerHTML = '';
}

function renderCollections(list) {
  const box = $('colls');
  dims = {};
  if (!list.length) {
    box.innerHTML = '<p class="note">No collections yet. The node indexes them as writes replay.</p>';
    return;
  }
  box.innerHTML = '';
  for (const c of list) {
    dims[c.collection] = c.dim;
    const b = document.createElement('button');
    b.className = 'coll';
    b.setAttribute('aria-pressed', String(c.collection === selected));
    b.innerHTML = '<span class="nm"></span><span class="meta"></span>';
    b.querySelector('.nm').textContent = c.collection;
    b.querySelector('.meta').textContent = c.size + ' vectors · dim ' + c.dim + ' · ' + c.metric;
    b.onclick = () => { selected = c.collection; renderCollections(list); };
    box.appendChild(b);
  }
  if (selected === null) { selected = list[0].collection; renderCollections(list); }
}

function parseVector(text) {
  const t = text.trim();
  if (!t) throw new Error('Enter a query vector.');
  let v;
  if (t.startsWith('[')) v = JSON.parse(t);
  else v = t.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!Array.isArray(v) || !v.length || v.some((n) => typeof n !== 'number' || Number.isNaN(n))) {
    throw new Error('Query vector must be a non-empty list of numbers.');
  }
  return v;
}

function renderHits(hits) {
  const out = $('out');
  if (!hits.length) {
    out.innerHTML = '<p class="note">No hits — the collection is empty.</p>';
    return;
  }
  const max = Math.max(...hits.map((h) => h.distance), 1e-9);
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>#</th><th>id</th><th>distance</th><th>metadata</th></tr></thead>';
  const tb = document.createElement('tbody');
  hits.forEach((h, i) => {
    const tr = document.createElement('tr');
    const rank = document.createElement('td'); rank.textContent = String(i + 1);
    const id = document.createElement('td'); id.className = 'id'; id.textContent = h.id;
    const d = document.createElement('td'); d.className = 'd';
    d.textContent = h.distance.toFixed(6);
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = Math.max(2, (1 - h.distance / max) * 100) + '%';
    d.appendChild(bar);
    const md = document.createElement('td'); md.className = 'md';
    md.textContent = Object.keys(h.metadata || {}).length ? JSON.stringify(h.metadata) : '—';
    tr.append(rank, id, d, md);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  const wrap = document.createElement('div');
  wrap.className = 'scroll';
  wrap.appendChild(table);
  out.innerHTML = '';
  out.appendChild(wrap);
}

async function refresh() {
  try {
    const s = await rpc('status');
    $('p-health').innerHTML = '<span class="dot up"></span>ok';
    $('p-block').textContent = s.nextBlock;
    $('p-entries').textContent = s.collections.reduce((n, c) => n + c.size, 0);
    renderCollections(s.collections);
  } catch (e) {
    $('p-health').innerHTML = '<span class="dot down"></span>unreachable';
    showError(e);
  }
}

$('rand').onclick = () => {
  const d = dims[selected] || 3;
  const v = Array.from({ length: d }, () => Number((Math.random() * 2 - 1).toFixed(4)));
  $('q').value = JSON.stringify(v);
  showError(null);
};

$('run').onclick = async () => {
  showError(null);
  try {
    if (!selected) throw new Error('No collection to search.');
    const queryVector = parseVector($('q').value);
    const expected = dims[selected];
    if (expected && queryVector.length !== expected) {
      throw new Error('Collection "' + selected + '" is dim ' + expected + ', query is ' + queryVector.length + '.');
    }
    $('run').disabled = true;
    renderHits(await rpc('similaritySearch', {
      collection: selected,
      queryVector,
      k: Number($('k').value) || 5,
    }));
  } catch (e) {
    showError(e);
  } finally {
    $('run').disabled = false;
  }
};

$('q').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('run').click();
});

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;
