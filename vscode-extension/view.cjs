// The Keel sidebar's page, drawn from Keel's summary (src/ui-model.mjs).
// A pure function, so it is tested without VS Code (test/unit/vscode-view.test.mjs).
// Every color is one of VS Code's own theme variables, so the page follows
// the person's theme, light, dark or high contrast.

'use strict';

/** @param {unknown} s */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** "just now", "4m ago", "2h ago", "yesterday", "3d ago". */
function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

/** 36,900 → "37k". */
function compact(n) {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/** The budget used, as people read it: "41%", "140%", and past twice the budget "63× budget". */
function budgetLabel(fraction) {
  if (fraction < 1.995) return `${Math.round(fraction * 100)}%`;
  return `${fraction < 9.95 ? fraction.toFixed(1) : Math.round(fraction)}× budget`;
}

const VERDICT = {
  verified: { cls: 'ok', label: 'Verified', glyph: '✓', blurb: 'The project’s checks ran on a separate copy with the original tests frozen, and they passed.' },
  failed: { cls: 'bad', label: 'Checks failed', glyph: '✕', blurb: 'A check ran and failed. Claude was told what failed.' },
  not_verified: { cls: 'warn', label: 'Not verified', glyph: '○', blurb: 'There is no current evidence that the work is done.' },
};

const STYLE = `
:root {
  --ok: var(--vscode-testing-iconPassed, #3fb950);
  --bad: var(--vscode-testing-iconFailed, #f85149);
  --warn: var(--vscode-editorWarning-foreground, #d29922);
  --muted: var(--vscode-descriptionForeground);
  --line: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, .35)));
  --track: var(--vscode-input-background, rgba(128, 128, 128, .2));
  --added: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
  --modified: var(--vscode-gitDecoration-modifiedResourceForeground, #d29922);
  --deleted: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
}
* { box-sizing: border-box; }
body { margin: 0; padding: 12px 14px 20px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); line-height: 1.45; }
button { font: inherit; cursor: pointer; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); padding: 4px 10px; }
button:focus-visible, a:focus-visible, li[role=button]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.primary:hover { background: var(--vscode-button-hoverBackground); }
.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.link { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); }
.link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.muted { color: var(--muted); }
.num { font-variant-numeric: tabular-nums; }

.top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.project { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.hero { border: 1px solid var(--line); border-radius: 6px; padding: 12px; display: grid; gap: 8px; }
.verdict { display: flex; align-items: center; gap: 8px; font-size: 1.3em; font-weight: 600; }
.badge { width: 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 13px; font-weight: 700; flex: none; }
.ok .badge { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.bad .badge { background: color-mix(in srgb, var(--bad) 20%, transparent); color: var(--bad); }
.warn .badge { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
.ok .word { color: var(--ok); } .bad .word { color: var(--bad); } .warn .word { color: var(--warn); }
.checks { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.checks li { display: flex; justify-content: space-between; gap: 8px; }
.reasons { margin: 0; padding-left: 16px; color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }

section { margin-top: 20px; }
h2 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
h2 span { text-transform: none; letter-spacing: 0; font-weight: 400; }

.meter { display: block; width: 100%; height: 8px; border-radius: 4px; overflow: hidden; }
.meter .track { fill: var(--track); }
.meter .tick { fill: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
.fill-low { fill: var(--vscode-progressBar-background, #0e70c0); } .fill-mid { fill: var(--warn); } .fill-high { fill: var(--bad); }
.meter-row { display: flex; justify-content: space-between; margin-top: 6px; gap: 8px; }

.timeline { list-style: none; margin: 0; padding: 0; }
.timeline li { position: relative; display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; padding: 3px 0; }
.timeline li::before { content: ""; position: absolute; left: 7px; top: 18px; bottom: -6px; width: 1px; background: var(--line); }
.timeline li:last-child::before { display: none; }
.pip { width: 15px; height: 15px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; margin-top: 2px; border: 1px solid var(--line); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); position: relative; z-index: 1; }
.pip.green { color: var(--ok); border-color: var(--ok); } .pip.failed { color: var(--bad); border-color: var(--bad); } .pip.blocked { color: var(--warn); border-color: var(--warn); }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.files { list-style: none; margin: 0; padding: 0; }
.files li { display: grid; grid-template-columns: 14px 1fr auto; gap: 8px; padding: 2px 4px; margin: 0 -4px; border-radius: 3px; cursor: pointer; }
.files li:hover { background: var(--vscode-list-hoverBackground); }
.status { font-weight: 700; font-size: .9em; } .status.A { color: var(--added); } .status.M { color: var(--modified); } .status.D { color: var(--deleted); }
.path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.path bdi { direction: ltr; unicode-bidi: isolate; }
.add { color: var(--added); } .del { color: var(--deleted); }

.guard { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.guard li { display: grid; grid-template-columns: auto 1fr; gap: 8px; }
.tag { font-size: .85em; padding: 0 6px; border-radius: 9px; border: 1px solid currentColor; white-space: nowrap; }
.tag.refuse { color: var(--bad); } .tag.ask { color: var(--warn); }
code { font-family: var(--vscode-editor-font-family); font-size: .92em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }

.empty { text-align: left; padding: 8px 0; }
.empty h1 { font-size: 1.2em; margin: 4px 0 8px; }
.empty ol { padding-left: 18px; margin: 8px 0; }
.spaced { margin-top: 8px; }
.notice { border-left: 3px solid var(--warn); padding: 6px 10px; margin-bottom: 12px; background: var(--vscode-textBlockQuote-background, transparent); }
.busy { display: flex; margin-bottom: 10px; align-items: center; gap: 8px; color: var(--muted); }
.spin { width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--vscode-progressBar-background, #0e70c0); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
`;

/**
 * What the page shows: the summary, a note while Keel works, or a first-run
 * page. The extension swaps this into the open page (see renderPage), so the
 * page keeps its scroll position when Keel's records change.
 * @param {any} m  Keel's summary, or null when there is none.
 * @param {{ now?: number, busy?: string|null, keelFound?: boolean, error?: string|null, noFolder?: boolean }} [o]
 */
function renderBody(m, o = {}) {
  const now = o.now ?? Date.now();
  if (o.noFolder) {
    return `<div class="empty"><h1>Open a folder to see Keel</h1><p class="muted">Keel keeps its records per project. Open the project folder you use with Claude Code.</p></div>`;
  }
  const busy = o.busy ? `<div class="busy" role="status"><span class="spin"></span>${esc(o.busy)}…</div>` : '';
  const error = o.error ? `<div class="notice" role="alert">Keel could not read its records: ${esc(o.error)}</div>` : '';
  return busy + error + (m && m.prompts ? overview(m, now) : empty(m, o.keelFound !== false));
}

/**
 * The whole page, drawn once when the view opens. Only the extension's own
 * script and styles run (the nonce), and the page loads nothing else.
 * @param {string} body  From renderBody.
 * @param {{ nonce: string }} o
 */
function renderPage(body, o) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${o.nonce}'; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${o.nonce}">${STYLE}</style></head>
<body><main id="root">${body}</main>
<script nonce="${o.nonce}">
const vscode = acquireVsCodeApi();
const send = (t) => vscode.postMessage({ cmd: t.dataset.cmd, arg: t.dataset.arg || null });
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-cmd]');
  if (t) send(t);
});
document.addEventListener('keydown', (ev) => {
  const t = ev.target.closest('li[data-cmd]');
  if (t && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); send(t); }
});
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'body') document.getElementById('root').innerHTML = ev.data.html;
});
vscode.postMessage({ cmd: 'ready' });
</script></body></html>`;
}

/** @param {any} m @param {boolean} keelFound */
function empty(m, keelFound) {
  if (!keelFound) {
    return `<div class="empty"><h1>Keel isn’t installed in Claude Code yet</h1>
<p class="muted">This sidebar shows what Keel records while Claude works. Install Keel in Claude Code first:</p>
<ol><li>In Claude Code, run <code>/plugin marketplace add SwagatPatel03/keel</code></li><li>Then run <code>/plugin install keel@keel</code></li></ol></div>`;
  }
  return `<div class="empty"><h1>Keel is watching ${esc(m?.project?.name || 'this project')}</h1>
<p class="muted">Nothing is recorded here yet. Start Claude Code in this folder and send a prompt. Keel then shows:</p>
<ol><li>whether Claude’s “done” is backed by passing checks,</li><li>how much of the task’s budget is used,</li><li>every file Claude changed, with a diff and undo,</li><li>the commands Keel refused or asked you about.</li></ol>
<div class="actions"><button class="secondary" data-cmd="refresh">Refresh</button></div></div>`;
}

/** @param {any} m @param {number} now */
function overview(m, now) {
  const v = VERDICT[m.verdict?.value] || VERDICT.not_verified;
  const checks = (m.verdict.checks || []).map((c) => {
    const counts = c.total != null ? `${c.passed ?? 0}/${c.total} passed${c.failed ? `, ${c.failed} failed` : ''}${c.skipped ? `, ${c.skipped} skipped` : ''}` : String(c.verdict).replace('_', ' ');
    return `<li><span>${esc(c.id)}</span><span class="num ${c.verdict === 'failed' ? 'word' : 'muted'}">${esc(counts)}</span></li>`;
  }).join('');
  const reasons = m.verdict.value !== 'verified' && m.verdict.reasons?.length
    ? `<ul class="reasons">${m.verdict.reasons.slice(0, 3).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
  const when = m.verdict.at ? `${m.verdict.source === 'verify' ? 'Checked' : 'After a prompt'} ${ago(m.verdict.at, now)}` : 'No check has run yet';

  const hero = `<div class="hero ${v.cls}">
  <div class="verdict"><span class="badge" aria-hidden="true">${v.glyph}</span><span class="word">${v.label}</span></div>
  <div class="muted">${esc(when)}. ${esc(v.blurb)}</div>
  ${checks ? `<ul class="checks">${checks}</ul>` : ''}${reasons}
  <div class="actions"><button class="primary" data-cmd="verify">Run the checks now</button></div>
</div>`;

  let budget = '';
  if (m.task) {
    const pct = Math.round(m.task.fraction * 100);
    const fill = m.task.fraction >= 1 ? 'fill-high' : m.task.fraction >= 0.7 ? 'fill-mid' : 'fill-low';
    const units = m.task.unit === 'weighted' ? 'budget units' : 'new tokens';
    budget = `<section><h2>Budget <span>prompt ${esc(m.task.prompt)} · ${esc(m.task.size)} task</span></h2>
<svg class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(pct, 100)}" aria-label="Task budget used" preserveAspectRatio="none">
<rect class="track" width="100%" height="100%"/><rect class="${fill}" width="${Math.min(100, pct)}%" height="100%" rx="4"/><rect class="tick" x="70%" width="1" height="100%"/><rect class="tick" x="90%" width="1" height="100%"/></svg>
<div class="meter-row"><span class="num"><strong>${budgetLabel(m.task.fraction)}</strong> <span class="muted">${compact(m.task.used)} of ${compact(m.task.budget)} ${units}</span></span>${m.task.newTokens != null && m.task.unit === 'weighted' ? `<span class="muted num">${compact(m.task.newTokens)} tokens</span>` : ''}</div></section>`;
  }

  const pips = { green: ['green', '★'], failed: ['failed', '✕'], blocked: ['blocked', '↺'], done: ['', '•'] };
  const timeline = (m.timeline || []).slice(0, 6).map((t) => {
    const [cls, glyph] = pips[t.kind] || pips.done;
    return `<li><span class="pip ${cls}" aria-hidden="true">${glyph}</span><span class="label">Prompt ${esc(t.prompt ?? '?')} <span class="muted">· ${esc(t.summary)}</span></span><span class="muted num">${esc(ago(t.at, now))}</span></li>`;
  }).join('');
  const prompts = timeline ? `<section><h2>Prompts <span>${m.lastGreen ? `last green: prompt ${esc(m.lastGreen.prompt ?? '?')}` : 'no green checkpoint yet'}</span></h2><ul class="timeline">${timeline}</ul></section>` : '';

  const fileRows = (m.changes || []).slice(0, 10).map((f) => {
    const slash = f.path.lastIndexOf('/');
    const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
    const name = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    return `<li role="button" tabindex="0" data-cmd="diff" data-arg="${esc(f.path)}" title="Compare ${esc(f.path)} with the start of the session">
<span class="status ${esc(f.status)}">${esc(f.status)}</span><span class="path"><bdi><span class="muted">${esc(dir)}</span>${esc(name)}</bdi></span><span class="num"><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span></li>`;
  }).join('');
  const more = (m.changes || []).length > 10 ? `<div class="muted">and ${(m.changes.length - 10)} more in the Changed Files view</div>` : '';
  const files = `<section><h2>Changed this session <span>${(m.changes || []).length ? `${m.changes.length} ${m.changes.length === 1 ? 'file' : 'files'}` : ''}</span></h2>
${fileRows ? `<ul class="files">${fileRows}</ul>${more}<div class="actions spaced"><button class="secondary" data-cmd="previewUndo">Preview undo…</button></div>` : '<div class="muted">No files changed yet.</div>'}</section>`;

  const guardRows = (m.guard?.recent || []).slice(0, 4).map((g) => `<li><span class="tag ${g.decision}">${g.decision === 'refuse' ? 'refused' : 'asked'}</span><code title="${esc(g.what)}">${esc(g.what || g.rule)}</code></li>`).join('');
  const guard = `<section><h2>Guard <span>${esc(m.guard?.mode || 'beginner')} mode</span></h2>
${guardRows ? `<ul class="guard">${guardRows}</ul>` : '<div class="muted">Nothing refused or asked about this session.</div>'}</section>`;

  return `<div class="top"><span class="project">${esc(m.project.name)}</span><span class="muted num">${m.prompts} ${m.prompts === 1 ? 'prompt' : 'prompts'}</span></div>
${hero}${budget}${prompts}${files}${guard}
<section class="actions"><button class="link" data-cmd="receipt">Open the session receipt</button></section>`;
}

module.exports = { renderBody, renderPage, ago, compact, esc, budgetLabel };
