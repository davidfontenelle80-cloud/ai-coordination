// dashboard.mjs — task 010: David's control tower (Dashboard UI v1).
//
// Served by the Worker at GET / and GET /dashboard (David-only; see
// index.mjs). The page is a single-page app that talks to the task 009
// HTTP API with the session cookie. It works fully over plain HTTP
// polling — WebSockets (task 013) are enhancement only.
//
// The HTML/CSS/JS live here as template literals so the module imports
// identically in node tests and in the esbuild worker bundle (no fs, no
// build step). The embedded app JS avoids backticks and dollar-brace interpolation so it can
// sit inside the outer template literal safely.

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1420">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="AI Hub">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>AI Hub — David's control tower</title>
<link rel="icon" type="image/png" href="/dashboard/icons/icon-192.png">
<link rel="apple-touch-icon" href="/dashboard/icons/apple-touch-icon.png">
<link rel="manifest" href="/dashboard/manifest.webmanifest">
<link rel="stylesheet" href="/dashboard/styles.css">
</head>
<body>
<div id="dashboardScreen">
<header>
  <div class="brand">
    <h1>AI Coordination Hub</h1>
    <span class="sub">David's control tower</span>
  </div>
  <div class="head-right">
    <span id="principal" class="principal">…</span>
    <span id="stats" class="stats"></span>
    <button id="refreshBtn" title="Refresh now">⟳</button>
    <button id="logoutBtn" title="Sign out">Sign out</button>
  </div>
</header>

<div id="alerts" class="alerts" hidden></div>

<main>
  <section id="needsDavid" class="queue queue-david">
    <h2>Needs David <span id="ndCount" class="count"></span></h2>
    <div id="ndList" class="cards"><p class="empty">Loading…</p></div>
  </section>

  <section id="needsMateo" class="queue queue-mateo">
    <h2>Needs Mateo <span id="nmCount" class="count"></span></h2>
    <div id="nmList" class="cards"><p class="empty">Loading…</p></div>
  </section>

  <div class="grid">
    <section class="panel">
      <h2>Tasks <span id="taskCount" class="count"></span></h2>
      <div class="filters">
        <select id="statusFilter">
          <option value="">All statuses</option>
          <option value="pending">pending</option>
          <option value="claimed">claimed</option>
          <option value="in-progress">in-progress</option>
          <option value="blocked">blocked</option>
          <option value="under-review">under-review</option>
          <option value="completed">completed</option>
        </select>
        <select id="assigneeFilter"><option value="">All agents</option></select>
      </div>
      <div id="taskList" class="tasklist"><p class="empty">Loading…</p></div>
    </section>

    <section class="panel">
      <h2>Agents</h2>
      <div id="agentList" class="cards"><p class="empty">Loading…</p></div>
      <h2 class="mt">Activity</h2>
      <div id="activityList" class="activity"><p class="empty">Loading…</p></div>
    </section>
  </div>

  <section id="chatSection" class="chat-section">
    <h2>Team chat</h2>
    <div id="threadScroll" class="thread-scroll">
      <div id="thread" class="thread" aria-live="polite"><p class="empty">Loading…</p></div>
    </div>
    <button id="newMsgPill" class="newmsg" hidden>↓ new messages</button>
  </section>
</main>

<div id="taskDetail" class="overlay" hidden>
  <div class="dialog">
    <div class="dialog-head">
      <h3 id="detailTitle">Task</h3>
      <button id="detailClose">✕</button>
    </div>
    <div id="detailBody" class="dialog-body"><p class="empty">Loading…</p></div>
  </div>
</div>

<div id="composerWrap">
  <div id="typingRow" class="typing" hidden></div>
  <div id="cmdMenu" class="cmdmenu" hidden></div>
  <div id="chipRow" class="chip-row" hidden></div>
  <div id="composer">
    <button id="slashBtn" class="iconbtn" title="Commands" aria-label="Commands">/</button>
    <textarea id="cmdInput" rows="1" placeholder="Message the team…" autocomplete="off" enterkeyhint="enter"></textarea>
    <button id="cmdSend" class="sendbtn" title="Send" aria-label="Send">➤</button>
  </div>
  <div id="cmdStatus" class="cmdstatus" role="status"></div>
</div>

</div>
<section id="tokensScreen" class="screen" hidden aria-labelledby="tokensTitle">
  <header class="screen-head"><button id="tokensBack">← Back</button><h1 id="tokensTitle" tabindex="-1">Agent tokens</h1></header>
  <main class="screen-body">
    <div class="tokfilters"><button id="toggleRevokedTokens" aria-pressed="false" disabled>Show revoked</button></div>
    <div id="tokensBody"><p class="empty">Loading…</p></div>
  </main>
</section>
<section id="issuedTokenScreen" class="screen" hidden aria-labelledby="issuedTokenTitle">
  <header class="screen-head"><button id="issuedTokenBack">← Back</button><h1 id="issuedTokenTitle" tabindex="-1">Token issued</h1></header>
  <main id="issuedTokenBody" class="screen-body"></main>
</section>
<script src="/dashboard/app.js"></script>
</body>
</html>
`;

export const DASHBOARD_CSS = `
:root {
  --bg: #0f1420; --panel: #182033; --panel2: #1f2942; --line: #2b3a5e;
  --text: #e8edf7; --muted: #93a0bd; --accent: #5aa9ff;
  --david: #c77dff; --mateo: #4fd1a5; --warn: #ffb020; --bad: #ff6b6b;
  --radius: 10px;
}
* { box-sizing: border-box; }
html { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  min-height: 100dvh;
  padding-bottom: calc(var(--composer-h, 112px) + 28px);
}
header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 10; flex-wrap: wrap; gap: 8px;
}
.brand h1 { margin: 0; font-size: 19px; }
.brand .sub { color: var(--muted); font-size: 12px; }
.head-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.principal { color: var(--muted); font-size: 13px; }
.stats { display: flex; gap: 8px; flex-wrap: wrap; }
.chip {
  background: var(--panel2); border: 1px solid var(--line); border-radius: 20px;
  padding: 2px 10px; font-size: 12px; color: var(--muted); white-space: nowrap;
}
.chip b { color: var(--text); }
button, select, input[type=text] {
  font: inherit; border-radius: 8px; border: 1px solid var(--line);
  background: var(--panel2); color: var(--text); padding: 6px 10px;
}
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #06121f; font-weight: 600; }
button.danger { border-color: var(--bad); color: var(--bad); }
main { max-width: 1200px; margin: 0 auto; padding: 16px 20px; }
.queue { margin-bottom: 18px; }
.queue h2 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
.queue-david h2 { color: var(--david); }
.queue-mateo h2 { color: var(--mateo); }
.count {
  background: var(--panel2); border: 1px solid var(--line); border-radius: 12px;
  font-size: 12px; padding: 1px 9px; color: var(--muted);
}
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 14px;
}
.card h3 { margin: 0 0 6px; font-size: 14px; }
.card p { margin: 4px 0; font-size: 13px; color: var(--muted); }
.card p b, .card .q { color: var(--text); }
.card .actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
.card input[type=text] { width: 100%; margin-top: 6px; font-size: 13px; }
.empty { color: var(--muted); font-size: 13px; }
.grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; }
@media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
.panel h2 { font-size: 16px; margin: 0 0 8px; }
.mt { margin-top: 18px; }
.filters { display: flex; gap: 8px; margin-bottom: 10px; }
.tasklist { display: flex; flex-direction: column; gap: 6px; max-height: 560px; overflow: auto; }
.taskrow {
  display: grid; grid-template-columns: 1fr auto; gap: 4px 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 8px 12px; cursor: pointer; text-align: left; width: 100%;
}
.taskrow:hover { border-color: var(--accent); }
.taskrow .t { font-size: 14px; }
.taskrow .meta { font-size: 12px; color: var(--muted); }
.pill {
  font-size: 11px; border-radius: 10px; padding: 1px 8px; white-space: nowrap;
  border: 1px solid var(--line); color: var(--muted); align-self: start;
}
.pill.blocked { color: var(--bad); border-color: var(--bad); }
.pill.under-review, .pill.in-progress { color: var(--warn); border-color: var(--warn); }
.pill.completed { color: var(--mateo); border-color: var(--mateo); }
.pill.pending, .pill.claimed { color: var(--accent); border-color: var(--accent); }
.activity { display: flex; flex-direction: column; gap: 6px; max-height: 480px; overflow: auto; font-size: 13px; }
.act { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
.act .who { color: var(--accent); } .act .ts { color: var(--muted); font-size: 11px; }
.alerts { max-width: 1200px; margin: 12px auto 0; padding: 0 20px; }
.alert {
  background: #3a2b12; border: 1px solid var(--warn); color: #ffd98a;
  border-radius: var(--radius); padding: 8px 14px; margin-bottom: 8px; font-size: 13px;
}
.alert.bad { background: #3a1a1a; border-color: var(--bad); color: #ffb3b3; }
.overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 20;
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.overlay[hidden] { display: none; }
.dialog {
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  max-width: 760px; width: 100%; max-height: 86vh; display: flex; flex-direction: column;
}
/* Task 018: real screens; the dashboard retains its existing layout. */
#dashboardScreen[hidden], .screen[hidden] { display: none !important; }
body.subscreen { padding-bottom: 0; }
.screen { min-height: 100dvh; }
.screen-head {
  padding: calc(12px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 12px calc(16px + env(safe-area-inset-left));
  justify-content: flex-start;
}
.screen-head h1 { margin: 0; font-size: 20px; }
.screen button { min-width: 44px; min-height: 44px; }
.screen-body {
  max-width: 760px; padding: 16px calc(16px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left));
}
.screen .tokbtns { flex-wrap: wrap; }
.tokfilters { margin-bottom: 12px; }
.screen .tokwho, .screen .tokmeta { overflow-wrap: anywhere; min-width: 0; }
.screen textarea.toksecret { display: block; width: 100%; resize: vertical; font-size: 16px; }

.tokrow {
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
  margin-bottom: 10px; background: var(--panel);
}
.tokrow .tokhead { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.tokrow .tokwho { font-weight: 700; font-size: 15px; }
.tokrow .tokwho small { display: block; font-weight: 400; color: var(--muted); font-size: 12px; }
.tokbadge {
  font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--mateo); color: var(--mateo); white-space: nowrap;
}
.tokbadge.revoked { border-color: var(--bad); color: var(--bad); }
.tokmeta { font-size: 12px; color: var(--muted); margin: 6px 0 8px; }
.tokid { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
.tokbtns { display: flex; gap: 8px; }
.tokbtns button {
  min-height: 44px; padding: 10px 16px; border-radius: 10px; font-size: 15px;
  border: 1px solid var(--line); background: var(--bg); color: var(--text);
}
.tokbtns button.danger { border-color: var(--bad); color: var(--bad); }
.tokbtns button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 700; }
.toksecret {
  font-family: ui-monospace, monospace; font-size: 13px; word-break: break-all;
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; margin: 8px 0;
}
.tokwarn { font-size: 13px; color: var(--warn); }
.dialog-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.dialog-head h3 { margin: 0; font-size: 16px; }
.dialog-body { padding: 14px 16px; overflow: auto; font-size: 14px; }
.dialog-body .sec { margin-bottom: 14px; }
.dialog-body .sec > h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.msg { border-left: 3px solid var(--line); padding: 4px 10px; margin: 6px 0; }
.msg .who { font-size: 12px; color: var(--accent); }
pre.ev { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font-size: 12px; overflow: auto; }
/* ---- Team chat (task 015) ---- */
.cmdstatus { font-size: 12px; color: var(--muted); }
.cmdstatus.ok { color: var(--mateo); } .cmdstatus.err { color: var(--bad); }
.chat-section { margin-top: 22px; position: relative; }
.chat-section h2 { font-size: 16px; margin: 0 0 8px; color: var(--mateo); }
.thread-scroll {
  max-height: min(56dvh, 540px); overflow-y: auto; overscroll-behavior: contain;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 10px 12px;
}
.thread { display: flex; flex-direction: column; }
.daydiv {
  text-align: center; color: var(--muted); font-size: 12px; margin: 12px 0 6px;
}
.daydiv:first-child { margin-top: 2px; }
.tgroup { display: flex; flex-direction: column; margin: 8px 0; max-width: 100%; }
.tgroup.david { align-items: flex-end; }
.tgroup.agent { align-items: flex-start; }
.tauthor { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
.avatar {
  width: 28px; height: 28px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #0b1220;
}
.aname { font-size: 12.5px; font-weight: 600; color: var(--text); }
.bubble {
  max-width: 82%; padding: 8px 13px; border-radius: 16px; margin: 2px 0;
  font-size: 14.5px; line-height: 1.45; overflow-wrap: break-word;
}
.tgroup.agent .bubble {
  background: var(--panel2); border: 1px solid var(--line);
  border-bottom-left-radius: 5px;
}
.tgroup.david .bubble {
  background: var(--accent); color: #06121f;
  border-bottom-right-radius: 5px;
}
.btask { font-size: 11px; opacity: .75; margin-top: 5px; }
.bts { font-size: 10.5px; opacity: .65; margin-top: 3px; text-align: right; }
.newmsg {
  position: absolute; left: 50%; transform: translateX(-50%); bottom: 12px;
  background: var(--accent); color: #06121f; border: none; border-radius: 18px;
  padding: 8px 16px; font-size: 13px; font-weight: 600; z-index: 5;
  box-shadow: 0 4px 14px rgba(0,0,0,.4);
}
.newmsg[hidden] { display: none; }

/* ---- Composer (task 015): pinned bottom, keyboard + safe-area aware ---- */
#composerWrap {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 15;
  background: var(--panel); border-top: 1px solid var(--line);
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  padding-left: calc(12px + env(safe-area-inset-left));
  padding-right: calc(12px + env(safe-area-inset-right));
  will-change: transform;
}
.typing {
  font-size: 12.5px; color: var(--muted); padding: 2px 4px 6px;
  display: flex; align-items: center; gap: 6px;
}
.typing[hidden] { display: none; }
.typing .dots span {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--muted); margin-right: 3px; animation: tblink 1.2s infinite;
}
.typing .dots span:nth-child(2) { animation-delay: .2s; }
.typing .dots span:nth-child(3) { animation-delay: .4s; }
@keyframes tblink { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }
.cmdmenu {
  position: absolute; left: 12px; right: 12px; bottom: 100%; margin-bottom: 6px;
  background: var(--panel2); border: 1px solid var(--line); border-radius: 12px;
  overflow: hidden; box-shadow: 0 -6px 24px rgba(0,0,0,.45); z-index: 16;
  max-height: 300px; overflow-y: auto;
}
.cmdmenu[hidden] { display: none; }
.cmdmenu button {
  display: block; width: 100%; text-align: left; background: none;
  border: none; border-bottom: 1px solid var(--line); border-radius: 0;
  padding: 11px 14px; font-size: 14px;
}
.cmdmenu button:last-child { border-bottom: none; }
.cmdmenu button small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
.cmdmenu .menuhead {
  padding: 8px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--muted); border-bottom: 1px solid var(--line);
}
.chip-row { display: flex; gap: 8px; flex-wrap: wrap; padding: 2px 2px 8px; }
.chip-row[hidden] { display: none; }
.tchip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--panel2); border: 1px solid var(--accent); color: var(--text);
  border-radius: 16px; padding: 5px 8px 5px 12px; font-size: 12.5px;
}
.tchip button {
  border: none; background: none; color: var(--muted); padding: 2px 6px;
  font-size: 13px; line-height: 1;
}
#composer { display: flex; gap: 8px; align-items: flex-end; }
.iconbtn {
  flex: none; width: 44px; height: 44px; border-radius: 50%;
  font-size: 20px; font-weight: 700; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
#cmdInput {
  flex: 1; font-size: 16px; line-height: 1.5; resize: none;
  min-height: 44px; max-height: 132px; overflow-y: hidden;
  padding: 10px 12px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--bg); color: var(--text);
  font-family: inherit;
}
#cmdInput:focus { outline: none; border-color: var(--accent); }
.sendbtn {
  flex: none; width: 44px; height: 44px; border-radius: 50%;
  background: var(--accent); border-color: var(--accent); color: #06121f;
  font-size: 17px; display: inline-flex; align-items: center; justify-content: center;
}
#composerWrap .cmdstatus { font-size: 12px; color: var(--muted); min-height: 0; padding: 4px 2px 0; }
#composerWrap .cmdstatus:empty { display: none; }
#composerWrap .cmdstatus.ok { color: var(--mateo); }
#composerWrap .cmdstatus.err { color: var(--bad); }
`;

export const DASHBOARD_JS = `
// Dashboard app (task 010). Plain HTTP polling against the task 009 API.
// No build step: vanilla JS, no backticks or dollar-brace interpolation (it is embedded in a template literal).
'use strict';

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ts(t) {
  if (!t) return '';
  var d = new Date(Number(t));
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function api(path, opts) {
  opts = opts || {};
  opts.credentials = 'same-origin';
  opts.headers = opts.headers || {};
  if (opts.body && !opts.headers['content-type']) opts.headers['content-type'] = 'application/json';
  return fetch(path, opts).then(function (r) {
    if (r.status === 401) { window.location = '/auth/github/login'; return null; }
    return r.json().then(function (j) { return { status: r.status, body: j }; });
  });
}

function cmd(command, fields) {
  var body = { command: command, idempotency_key: crypto.randomUUID() };
  for (var k in fields) body[k] = fields[k];
  return api('/api/commands', { method: 'POST', body: JSON.stringify(body) });
}

var state = { tasks: [], decisions: [], agents: [], activity: [], stats: null, me: null, pending: [] };

function setStatus(el, ok, msg) {
  el.className = 'cmdstatus ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
}

function loadAll() {
  return Promise.all([
    api('/api/stats'),
    api('/api/decisions?state=requested'),
    api('/api/tasks?limit=200'),
    api('/api/agents'),
    api('/api/activity?limit=60'),
    api('/auth/me'),
  ]).then(function (rs) {
    for (var i = 0; i < rs.length; i++) if (!rs[i]) return; // 401 -> redirected
    state.stats = rs[0].body;
    state.decisions = rs[1].body.decisions || [];
    state.tasks = rs[2].body.tasks || [];
    state.agents = rs[3].body.agents || [];
    state.activity = rs[4].body.events || [];
    state.me = rs[5].body.principal;
    render();
  }).catch(function (e) {
    console.error('dashboard load failed', e);
  });
}

// ---- header / stats / alerts -------------------------------------------

function renderStats() {
  var s = state.stats, el = document.getElementById('stats');
  if (!s) { el.innerHTML = ''; return; }
  el.innerHTML =
    chip('events today', s.events_today) +
    chip('events total', s.events_total) +
    chip('tasks', s.tasks_total) +
    chip('open decisions', s.decisions_open);
  function chip(label, v) {
    return '<span class="chip">' + esc(label) + ' <b>' + esc(v) + '</b></span>';
  }
  var me = document.getElementById('principal');
  me.textContent = state.me ? 'signed in as ' + (state.me.kind === 'david' ? 'David' : state.me.agent_id) : '';
}

function renderAlerts() {
  var box = document.getElementById('alerts'), out = '';
  var blocked = state.tasks.filter(function (t) { return t.status === 'blocked'; });
  var stalledAgents = state.agents.filter(function (a) { return a.work_state === 'stalled'; });
  var failedValid = state.activity.filter(function (e) {
    return e.event_type === 'command.rejected' || (e.payload && e.payload.code === 'VALIDATION_FAILED');
  }).slice(0, 3);
  if (state.decisions.length) {
    out += '<div class="alert">' + state.decisions.length +
      ' decision' + (state.decisions.length === 1 ? '' : 's') + ' awaiting David.</div>';
  }
  blocked.forEach(function (t) {
    out += '<div class="alert bad">Task blocked: ' + esc(t.title) +
      ' <span style="color:var(--muted)">(' + esc(t.task_id) + ')</span></div>';
  });
  stalledAgents.forEach(function (a) {
    out += '<div class="alert bad">Agent stalled: ' + esc(a.agent_id) + '</div>';
  });
  if (out) { box.innerHTML = out; box.hidden = false; }
  else { box.innerHTML = ''; box.hidden = true; }
}

// ---- Needs David ---------------------------------------------------------

function renderNeedsDavid() {
  var list = document.getElementById('ndList');
  document.getElementById('ndCount').textContent = state.decisions.length;
  if (!state.decisions.length) {
    list.innerHTML = '<p class="empty">Nothing waiting on David. Nice.</p>';
    return;
  }
  list.innerHTML = state.decisions.map(function (d) {
    var opts = '';
    if (d.options && d.options.length) {
      opts = '<p>Options: ' + d.options.map(function (o) {
        return '<b>' + esc(typeof o === 'string' ? o : JSON.stringify(o)) + '</b>';
      }).join(' · ') + '</p>';
    }
    var taskLine = d.task_id ? '<p>Task: <b>' + esc(taskTitle(d.task_id)) + '</b></p>' : '<p>Workspace-level decision</p>';
    return '<div class="card" data-dec="' + esc(d.decision_id) + '">' +
      '<h3 class="q">' + esc(d.question) + '</h3>' + taskLine + opts +
      '<div class="actions">' +
        '<button class="primary" data-act="approve">Approve</button>' +
        '<button class="danger" data-act="reject">Reject</button>' +
      '</div>' +
      '<input type="text" data-role="modify" placeholder="Modified decision text, then press Enter to resolve as modified">' +
      (d.task_id
        ? '<input type="text" data-role="comment" placeholder="Comment on the task, then press Enter">'
        : '') +
    '</div>';
  }).join('');
  list.querySelectorAll('.card').forEach(function (card) {
    var id = card.getAttribute('data-dec');
    card.querySelector('[data-act=approve]').onclick = function () {
      resolveDecision(id, 'approved', card);
    };
    card.querySelector('[data-act=reject]').onclick = function () {
      resolveDecision(id, 'rejected', card);
    };
    var mod = card.querySelector('[data-role=modify]');
    mod.onkeydown = function (ev) {
      if (ev.key === 'Enter' && mod.value.trim()) {
        resolveDecision(id, 'modified: ' + mod.value.trim(), card);
      }
    };
    var com = card.querySelector('[data-role=comment]');
    if (com) com.onkeydown = function (ev) {
      if (ev.key === 'Enter' && com.value.trim()) {
        var dec = state.decisions.filter(function (x) { return x.decision_id === id; })[0];
        cmd('postMessage', { task_id: dec.task_id, body: com.value.trim() }).then(function () { loadAll(); });
      }
    };
  });
}

function resolveDecision(id, resolution, card) {
  cmd('resolveDecision', { decision_id: id, resolution: resolution }).then(function (r) {
    if (r && r.body && r.body.ok) { loadAll(); }
    else if (card) { card.querySelector('.actions').insertAdjacentHTML('beforeend',
      '<span class="cmdstatus err">' + esc((r && r.body && r.body.message) || 'failed') + '</span>'); }
  });
}

function taskTitle(id) {
  var t = state.tasks.filter(function (x) { return x.task_id === id; })[0];
  return t ? t.title : id;
}

// ---- Needs Mateo ---------------------------------------------------------

function renderNeedsMateo() {
  var list = document.getElementById('nmList');
  var review = state.tasks.filter(function (t) { return t.status === 'under-review'; });
  var blocked = state.tasks.filter(function (t) { return t.status === 'blocked'; });
  var stalled = state.agents.filter(function (a) { return a.work_state === 'stalled' || a.work_state === 'blocked'; });
  var total = review.length + blocked.length + stalled.length;
  document.getElementById('nmCount').textContent = total;
  if (!total) { list.innerHTML = '<p class="empty">Nothing waiting on Mateo.</p>'; return; }
  var html = '';
  review.forEach(function (t) {
    html += '<div class="card" data-task="' + esc(t.task_id) + '">' +
      '<h3>Result awaiting review</h3>' +
      '<p><b>' + esc(t.title) + '</b> — ' + esc(t.assignee || 'unassigned') + '</p>' +
      '<div class="actions">' +
        '<button class="primary" data-act="accept">Accept</button>' +
        '<button data-act="rework">Request rework</button>' +
        '<button data-act="open">Open task</button>' +
      '</div>' +
      '<input type="text" data-role="note" placeholder="Review note (optional)">' +
    '</div>';
  });
  blocked.forEach(function (t) {
    html += '<div class="card" data-task="' + esc(t.task_id) + '">' +
      '<h3>Blocked task</h3>' +
      '<p><b>' + esc(t.title) + '</b> — ' + esc(t.assignee || 'unassigned') + '</p>' +
      '<div class="actions">' +
        '<button class="primary" data-act="unblock">Unblock (start)</button>' +
        '<button data-act="open">Open task</button>' +
      '</div>' +
    '</div>';
  });
  stalled.forEach(function (a) {
    html += '<div class="card"><h3>Stalled agent</h3><p><b>' + esc(a.agent_id) +
      '</b> — ' + esc(a.work_state) + ' · health ' + esc(a.context_health) + '</p></div>';
  });
  list.innerHTML = html;
  list.querySelectorAll('.card[data-task]').forEach(function (card) {
    var id = card.getAttribute('data-task');
    var note = card.querySelector('[data-role=note]');
    var act = function (sel, fn) {
      var b = card.querySelector('[data-act=' + sel + ']');
      if (b) b.onclick = fn;
    };
    act('accept', function () { cmd('recordReview', { task_id: id, outcome: 'accepted', notes: note && note.value.trim() ? note.value.trim() : undefined }).then(function () { loadAll(); }); });
    act('rework', function () { cmd('recordReview', { task_id: id, outcome: 'rework', notes: note && note.value.trim() ? note.value.trim() : 'needs rework' }).then(function () { loadAll(); }); });
    act('unblock', function () { cmd('startTask', { task_id: id }).then(function () { loadAll(); }); });
    act('open', function () { openTask(id); });
  });
}

// ---- Tasks -----------------------------------------------------------------

function renderTasks() {
  var sf = document.getElementById('statusFilter').value;
  var af = document.getElementById('assigneeFilter').value;
  var rows = state.tasks.filter(function (t) {
    return (!sf || t.status === sf) && (!af || t.assignee === af);
  });
  document.getElementById('taskCount').textContent = rows.length + ' / ' + state.tasks.length;
  var list = document.getElementById('taskList');
  if (!rows.length) { list.innerHTML = '<p class="empty">No tasks match.</p>'; return; }
  list.innerHTML = rows.map(function (t) {
    return '<button class="taskrow" data-task="' + esc(t.task_id) + '">' +
      '<span class="t">' + esc(t.title) + '</span>' +
      '<span class="pill ' + esc(t.status) + '">' + esc(t.status) + '</span>' +
      '<span class="meta">' + esc(t.assignee || 'unassigned') + ' · ' + esc(t.priority || 'normal') +
        ' · v' + esc(t.version) + ' · ' + esc(ts(t.updated_at)) + '</span>' +
      '<span></span>' +
    '</button>';
  }).join('');
  list.querySelectorAll('.taskrow').forEach(function (b) {
    b.onclick = function () { openTask(b.getAttribute('data-task')); };
  });
  // assignee filter options (rebuild only when the agent set changes, so a
  // poll never yanks the dropdown out from under David — task 015)
  var sel = document.getElementById('assigneeFilter');
  var agents = {};
  state.tasks.forEach(function (t) { if (t.assignee) agents[t.assignee] = 1; });
  var sig = Object.keys(agents).sort().join('|');
  if (sel.getAttribute('data-sig') !== sig) {
    var cur = sel.value;
    sel.innerHTML = '<option value="">All agents</option>' + Object.keys(agents).sort().map(function (a) {
      return '<option value="' + esc(a) + '"' + (a === cur ? ' selected' : '') + '>' + esc(a) + '</option>';
    }).join('');
    sel.setAttribute('data-sig', sig);
  }
}

function openTask(id) {
  var dlg = document.getElementById('taskDetail');
  var body = document.getElementById('detailBody');
  dlg.hidden = false;
  body.innerHTML = '<p class="empty">Loading…</p>';
  api('/api/tasks/' + encodeURIComponent(id) + '/resume').then(function (r) {
    if (!r) return;
    var rs = r.body.resume;
    var task = rs.task || {};
    document.getElementById('detailTitle').textContent = task.title || id;
    var h = '';
    h += sec('State', '<p><b>' + esc(rs.status) + '</b> · assignee ' + esc(rs.assignee || 'unassigned') +
      ' · priority ' + esc(task.priority || 'normal') + ' · version ' + esc(rs.version) + '</p>' +
      (task.goal ? '<p>' + esc(task.goal) + '</p>' : ''));
    if (rs.blocked_reason) h += sec('Blocker', '<p>' + esc(rs.blocked_reason) + '</p>');
    if (rs.latest_result) h += sec('Latest result', '<p>' + esc(rs.latest_result.summary || '') +
      ' <span style="color:var(--muted)">by ' + esc(rs.latest_result.actor_id || '?') + '</span></p>');
    if (rs.latest_review) h += sec('Latest review', '<p>' + esc(rs.latest_review.outcome) +
      (rs.latest_review.notes ? ' — ' + esc(rs.latest_review.notes) : '') + '</p>');
    if (rs.recent_messages && rs.recent_messages.length) {
      h += sec('Messages', rs.recent_messages.map(function (m) {
        return '<div class="msg"><span class="who">' + esc(m.actor_id || '?') +
          ' · ' + esc(m.kind || 'message') + ' · ' + esc(ts(m.created_at)) + '</span><br>' +
          esc(m.body) + '</div>';
      }).join(''));
    }
    var decs = (rs.open_decisions || []).concat(rs.resolved_decisions || []);
    if (decs.length) {
      h += sec('Decisions', decs.map(function (d) {
        return '<p><b>' + esc(d.question) + '</b> — ' + esc(d.resolution || 'awaiting David') + '</p>';
      }).join(''));
    }
    if (rs.artifact_refs && rs.artifact_refs.length) {
      h += sec('Artifacts', rs.artifact_refs.map(function (a) {
        return '<p><a href="' + esc(a.uri) + '" target="_blank" rel="noopener">' + esc(a.name) + '</a></p>';
      }).join(''));
    }
    if (rs.latest_handoff) {
      h += sec('Latest handoff', '<p><b>' + esc(rs.latest_handoff.agent_id) + '</b>: ' +
        esc(rs.latest_handoff.goal || '') + '</p>');
    }
    h += '<div class="sec"><h4>Actions</h4><div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button data-a="msg">Post message</button>' +
      '<button data-a="start">Start</button>' +
      '<button data-a="block">Block</button>' +
      '<button data-a="priority">Set priority</button>' +
      '<button data-a="decision">Request decision</button>' +
    '</div><input type="text" id="detailInput" placeholder="Action input (message, reason, priority, question)" style="width:100%;margin-top:8px">' +
    '<span id="detailStatus" class="cmdstatus"></span></div>';
    body.innerHTML = h;
    body.querySelectorAll('[data-a]').forEach(function (b) {
      b.onclick = function () { detailAction(id, b.getAttribute('data-a')); };
    });
    document.getElementById('detailInput').onkeydown = function (ev) {
      if (ev.key === 'Enter') detailAction(id, 'msg');
    };
  });
  function sec(t, inner) { return '<div class="sec"><h4>' + esc(t) + '</h4>' + inner + '</div>'; }
}

function detailAction(id, a) {
  var inp = document.getElementById('detailInput');
  var st = document.getElementById('detailStatus');
  var v = inp.value.trim();
  var p;
  if (a === 'msg') { if (!v) return setStatus(st, false, 'type a message'); p = cmd('postMessage', { task_id: id, body: v }); }
  else if (a === 'start') p = cmd('startTask', { task_id: id });
  else if (a === 'block') { if (!v) return setStatus(st, false, 'type a reason'); p = cmd('blockTask', { task_id: id, reason: v }); }
  else if (a === 'priority') { if (!v) return setStatus(st, false, 'type a priority'); p = cmd('setPriority', { task_id: id, priority: v }); }
  else if (a === 'decision') { if (!v) return setStatus(st, false, 'type a question'); p = cmd('requestDecision', { task_id: id, question: v }); }
  p.then(function (r) {
    if (r && r.body && r.body.ok) { setStatus(st, true, 'done'); inp.value = ''; loadAll(); setTimeout(function () { openTask(id); }, 600); }
    else setStatus(st, false, (r && r.body && r.body.message) || 'failed');
  });
}

document.getElementById('detailClose').onclick = function () {
  document.getElementById('taskDetail').hidden = true;
};
document.getElementById('taskDetail').addEventListener('click', function (ev) {
  if (ev.target.id === 'taskDetail') document.getElementById('taskDetail').hidden = true;
});

// ---- Task 018: extensible in-memory screen router -----------------------------
var screens = {
  dashboard: { element: 'dashboardScreen' },
  tokens: { element: 'tokensScreen', title: 'tokensTitle', enter: loadTokens },
  issuedToken: { element: 'issuedTokenScreen', title: 'issuedTokenTitle', leave: clearIssuedToken },
};
var currentScreen = 'dashboard';
var screenStack = [];
var screenScroll = {};
var tokenLoadVersion = 0;

function clearIssuedToken() {
  // Remove both plaintext and handlers closing over it. Never put this screen
  // on the back stack: leaving it ends the one-time viewing session.
  document.getElementById('issuedTokenBody').replaceChildren();
}

function navigateScreen(name, back) {
  if (!screens[name]) return;
  if (name === currentScreen) return;
  screenScroll[currentScreen] = window.scrollY;
  if (screens[currentScreen].leave) screens[currentScreen].leave();
  if (!back && currentScreen !== 'issuedToken') screenStack.push(currentScreen);
  currentScreen = name;
  Object.keys(screens).forEach(function (key) {
    document.getElementById(screens[key].element).hidden = key !== name;
  });
  document.body.classList.toggle('subscreen', name !== 'dashboard');
  hideMenu();
  document.getElementById('taskDetail').hidden = true;
  document.getElementById('cmdInput').blur();
  window.scrollTo(0, screenScroll[name] || 0);
  if (screens[name].title) document.getElementById(screens[name].title).focus({ preventScroll: true });
  if (screens[name].enter) screens[name].enter();
  if (name === 'dashboard') updateComposerPad();
}

function backScreen() { navigateScreen(screenStack.pop() || 'dashboard', true); }
function doneTokenScreen() { screenStack = []; navigateScreen('dashboard', true); }
document.getElementById('tokensBack').onclick = backScreen;
document.getElementById('issuedTokenBack').onclick = backScreen;

function copyText(t, done) {
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    done(ok);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(function () { done(true); }, fallback);
  } else fallback();
}

// Plaintext belongs only to the one-time issued-token screen.
function showIssuedToken(who, token) {
  navigateScreen('issuedToken');
  var body = document.getElementById('issuedTokenBody');
  body.innerHTML =
    '<p>New token for <b>' + esc(who) + '</b>.</p>' +
    '<textarea id="issuedTokenValue" class="toksecret" readonly rows="4" aria-label="One-time agent token"></textarea>' +
    '<p class="tokwarn">copy it now — it will not be shown again.</p>' +
    '<div class="tokbtns">' +
    '<button id="copyTokBtn" class="primary">Copy token</button>' +
    '<button id="viewToksBtn">View all tokens</button>' +
    '<button id="doneTokBtn">Done</button>' +
    '</div>';
  document.getElementById('issuedTokenValue').value = token;
  document.getElementById('doneTokBtn').onclick = doneTokenScreen;
  document.getElementById('copyTokBtn').onclick = function () {
    var b = this;
    copyText(token, function (ok) {
      b.textContent = ok ? 'Copied ✓' : 'Copy failed — select it manually';
    });
  };
  document.getElementById('viewToksBtn').onclick = function () { openTokenManager(); };
}

var tokenInventory = [];
var showRevokedTokens = false;
document.getElementById('toggleRevokedTokens').onclick = function () {
  showRevokedTokens = !showRevokedTokens;
  renderTokenList(tokenInventory);
};

function openTokenManager() { navigateScreen('tokens'); }

function loadTokens() {
  var version = ++tokenLoadVersion;
  tokenInventory = [];
  document.getElementById('toggleRevokedTokens').disabled = true;
  var body = document.getElementById('tokensBody');
  body.innerHTML = '<p class="empty">Loading…</p>';
  return api('/auth/agents/tokens').then(function (r) {
    if (version !== tokenLoadVersion || currentScreen !== 'tokens' || !r) return;
    if (!r.body || !r.body.ok) throw new Error('load failed');
    renderTokenList(r.body.tokens || []);
  }).catch(function () {
    if (version !== tokenLoadVersion || currentScreen !== 'tokens') return;
    body.innerHTML = '<p class="empty">Failed to load tokens.</p><button id="retryTokens">Try again</button>';
    document.getElementById('retryTokens').onclick = loadTokens;
  });
}

function renderTokenList(tokens) {
  tokenInventory = tokens;
  var revokedCount = tokens.filter(function (t) { return !!t.revoked_at; }).length;
  var toggle = document.getElementById('toggleRevokedTokens');
  toggle.disabled = false;
  toggle.textContent = (showRevokedTokens ? 'Hide revoked' : 'Show revoked') + ' (' + revokedCount + ')';
  toggle.setAttribute('aria-pressed', String(showRevokedTokens));
  var visibleTokens = tokens.filter(function (t) { return showRevokedTokens || !t.revoked_at; });
  var body = document.getElementById('tokensBody');
  if (!tokens.length) {
    body.innerHTML = '<p class="empty">No agent tokens yet. Issue one from the / menu.</p>';
    return;
  }
  if (!visibleTokens.length) {
    body.innerHTML = '<p class="empty">No active tokens. Turn on Show revoked to view token history.</p>';
    return;
  }
  body.innerHTML = visibleTokens.map(function (t) {
    var revoked = !!t.revoked_at;
    var h = '<div class="tokrow">' +
      '<div class="tokhead"><div class="tokwho">' + esc(t.display_name || t.agent_id) +
      '<small>' + esc(t.agent_id) + '</small></div>' +
      '<span class="tokbadge' + (revoked ? ' revoked' : '') + '">' +
      (revoked ? 'Revoked' : 'Active') + '</span></div>' +
      '<div class="tokmeta"><span class="tokid">' + esc(t.token_id) + '</span><br>' +
      'issued ' + esc(ts(t.created_at)) + ' by ' + esc(t.created_by || '?') +
      ' · last used ' + (t.last_used_at ? esc(ts(t.last_used_at)) : 'never') + '</div>';
    if (!revoked) {
      h += '<div class="tokbtns"><button class="danger" data-revoke="' +
        esc(t.token_id) + '">Revoke</button></div>';
    }
    return h + '</div>';
  }).join('');
  var btns = body.querySelectorAll('button[data-revoke]');
  for (var i = 0; i < btns.length; i++) {
    (function (b) {
      var armed = false, timer = null;
      b.onclick = function () {
        var tokenId = b.getAttribute('data-revoke');
        if (!armed) {
          armed = true;
          b.textContent = 'Tap again to confirm';
          timer = setTimeout(function () {
            armed = false; b.textContent = 'Revoke';
          }, 6000);
          return;
        }
        clearTimeout(timer);
        b.disabled = true;
        b.textContent = 'Revoking…';
        api('/auth/agents/revoke', {
          method: 'POST',
          body: JSON.stringify({ token_id: tokenId }),
        }).then(function (r) {
          if (r && r.body && r.body.ok) { if (currentScreen === 'tokens') loadTokens(); }
          else {
            b.disabled = false;
            b.textContent = 'Revoke failed — try again';
            armed = false;
          }
        }).catch(function () {
          b.disabled = false; b.textContent = 'Revoke failed — try again'; armed = false;
        });
      };
    })(btns[i]);
  }
}

// ---- Agents / activity ---------------------------------------------------------

function renderAgents() {
  var list = document.getElementById('agentList');
  if (!state.agents.length) { list.innerHTML = '<p class="empty">No agents yet.</p>'; return; }
  list.innerHTML = state.agents.map(function (a) {
    return '<div class="card"><h3>' + esc(a.agent_id) + '</h3>' +
      '<p>state <b>' + esc(a.work_state || '?') + '</b> · context health <b>' + esc(a.context_health || '?') + '</b></p>' +
      '<p>task: ' + esc(a.current_task_id ? taskTitle(a.current_task_id) : '—') + '</p>' +
      '<p>last activity ' + esc(ts(a.updated_at)) + '</p></div>';
  }).join('');
}

function renderActivity() {
  var list = document.getElementById('activityList');
  if (!state.activity.length) { list.innerHTML = '<p class="empty">No activity yet.</p>'; return; }
  list.innerHTML = state.activity.map(function (e) {
    return '<div class="act"><span class="who">' + esc(e.actor_id || e.submitted_by || '?') + '</span> ' +
      esc(e.event_type) +
      (e.task_id ? ' · <b>' + esc(taskTitle(e.task_id)) + '</b>' : '') +
      ' <span class="ts">#' + esc(e.seq) + ' · ' + esc(ts(e.created_at)) + '</span></div>';
  }).join('');
}

// ---- Team chat thread + composer (task 015) --------------------------------
//
// The thread renders message.posted events from the /api/activity feed
// (chronological, flat) plus optimistic local echoes of David's own sends.
// David's messages go right in accent bubbles; everyone else goes left with
// an avatar (initials, per-agent color) and a name header on the first
// message of each consecutive group.

var AGENT_COLORS = { david: '#5aa9ff', mateo: '#4fd1a5', chatgpt: '#7ee787', claude: '#ff9e64' };
var AGENT_PALETTE = ['#c77dff', '#ffb020', '#ff6b6b', '#5ad1ff', '#a3e635', '#f472b6'];
var AGENT_NAMES = { david: 'David', mateo: 'Mateo', chatgpt: 'ChatGPT', claude: 'Claude' };

function agentColor(id) {
  if (AGENT_COLORS[id]) return AGENT_COLORS[id];
  var h = 0, s = String(id || '?'), i;
  for (i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

function agentInitials(id) {
  return String(id || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

function displayName(id) {
  return AGENT_NAMES[id] || String(id || '?');
}

function dayLabel(t) {
  var d = new Date(Number(t));
  if (isNaN(d.getTime())) return '';
  var today = new Date(), yest = new Date();
  yest.setDate(today.getDate() - 1);
  var sameDay = function (a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  };
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  return d.toLocaleDateString();
}

function timeLabel(t) {
  var d = new Date(Number(t));
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function threadMessages() {
  // Expire optimistic echoes that never confirmed (45s).
  var now = Date.now();
  state.pending = state.pending.filter(function (p) { return now - p.ts < 45000; });
  var msgs = state.activity
    .filter(function (e) { return e.event_type === 'message.posted' && e.payload && e.payload.body; })
    .map(function (e) {
      return {
        author: e.actor_id || e.submitted_by || '?',
        body: String(e.payload.body),
        kind: e.payload.kind || 'message',
        ts: e.created_at,
        task: e.task_id ? taskTitle(e.task_id) : '',
        seq: e.seq,
        pending: false,
      };
    });
  state.pending.forEach(function (p) {
    var dup = msgs.some(function (m) {
      return m.author === 'david' && m.body === p.body && Math.abs(Number(m.ts) - p.ts) < 120000;
    });
    if (!dup) msgs.push(p);
  });
  msgs.sort(function (a, b) { return Number(a.ts) - Number(b.ts); });
  return msgs;
}

var lastThreadSig = null;
var lastSeenMaxSeq = null;

function isNearBottom() {
  var sc = document.getElementById('threadScroll');
  return (sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 90;
}

function renderThread() {
  var msgs = threadMessages();
  var sig = msgs.map(function (m) { return (m.pending ? 'p' : m.seq) + ':' + m.ts + ':' + m.body.length; }).join('|');
  if (sig === lastThreadSig) return; // nothing changed: never touch the DOM
  lastThreadSig = sig;
  var sc = document.getElementById('threadScroll');
  var thread = document.getElementById('thread');
  var pill = document.getElementById('newMsgPill');
  var stick = isNearBottom() || lastSeenMaxSeq === null;
  var maxSeq = 0;
  msgs.forEach(function (m) { if (!m.pending && Number(m.seq) > maxSeq) maxSeq = Number(m.seq); });

  var groups = [];
  msgs.forEach(function (m) {
    var day = dayLabel(m.ts);
    var g = groups[groups.length - 1];
    if (!g || g.author !== m.author || g.day !== day) {
      g = { author: m.author, day: day, items: [] };
      groups.push(g);
    }
    g.items.push(m);
  });

  var html = '', lastDay = null;
  groups.forEach(function (g) {
    if (g.day !== lastDay) {
      html += '<div class="daydiv">' + esc(g.day) + '</div>';
      lastDay = g.day;
    }
    var isDavid = g.author === 'david';
    html += '<div class="' + (isDavid ? 'tgroup david' : 'tgroup agent') + '">';
    if (!isDavid) {
      html += '<div class="tauthor"><span class="avatar" style="background:' + agentColor(g.author) + '">' +
        esc(agentInitials(g.author)) + '</span><span class="aname">' + esc(displayName(g.author)) + '</span></div>';
    }
    g.items.forEach(function (m) {
      html += '<div class="bubble">' + esc(m.body) +
        (m.task ? '<div class="btask">' + esc(m.task) + '</div>' : '') +
        '<div class="bts">' + esc(timeLabel(m.ts)) + (m.pending ? ' · sending…' : '') + '</div></div>';
    });
    html += '</div>';
  });
  thread.innerHTML = html || '<p class="empty">No messages yet — say hi to the team.</p>';

  if (stick) {
    sc.scrollTop = sc.scrollHeight;
    pill.hidden = true;
  } else if (lastSeenMaxSeq !== null && maxSeq > lastSeenMaxSeq) {
    pill.hidden = false;
  }
  lastSeenMaxSeq = maxSeq;
}

// ---- typing indicator --------------------------------------------------------
// Shown in-flow where the reply will land while a command is in flight.
// Always cleared on response, on error, or after ~10s — never stuck.
var typingTimer = null;

function showTyping(label) {
  var row = document.getElementById('typingRow');
  row.innerHTML = '<span class="dots"><span></span><span></span><span></span></span> ' + esc(label);
  row.hidden = false;
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(hideTyping, 10000);
}

function hideTyping() {
  if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
  document.getElementById('typingRow').hidden = true;
}

function typingLabel(taskId) {
  if (taskId) {
    var t = state.tasks.filter(function (x) { return x.task_id === taskId; })[0];
    if (t && t.assignee) return displayName(t.assignee) + ' is writing…';
  }
  return 'Sending…';
}

// ---- slash-command menu + task-target chip -------------------------------------
// Keeps the task 010 command semantics: message-a-task (default), create
// task ("title | goal"), set priority, request decision. Commands that need
// a task get a removable task-target chip above the textarea.

var MENU_COMMANDS = [
  { id: 'postMessage', label: 'Message task', hint: 'post to a task thread', needsText: true, needsTask: true },
  { id: 'createTask', label: 'Create task', hint: 'type "title | goal"', needsText: true },
  { id: 'setPriority', label: 'Set priority', hint: 'set a task priority', needsText: true, needsTask: true },
  { id: 'requestDecision', label: 'Request decision', hint: 'ask David a question', needsText: true },
  { id: 'issueToken', label: 'Issue agent token', hint: 'mint a token for an agent', needsAgent: true },
  { id: 'manageTokens', label: 'Manage agent tokens', hint: 'list tokens and revoke', needsTask: false },
];

// Task 016: the three team agents David can mint tokens for. role is always
// 'agent' (least privilege) — issuance creates the identity row if needed.
var AGENTS_MENU = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'mateo-watcher', label: 'Mateo watcher' },
];

var chatSel = { cmd: 'postMessage', taskId: null, agentId: null };
var menuStep = 'cmd';

function menuLabel(id) {
  var c = MENU_COMMANDS.filter(function (x) { return x.id === id; })[0];
  return c ? c.label : id;
}

function agentLabel(id) {
  var a = AGENTS_MENU.filter(function (x) { return x.id === id; })[0];
  return a ? a.label : id;
}

function toggleMenu() {
  var menu = document.getElementById('cmdMenu');
  if (menu.hidden) { menuStep = 'cmd'; renderMenu(); }
  else hideMenu();
}

function hideMenu() {
  document.getElementById('cmdMenu').hidden = true;
}

function renderMenu() {
  var menu = document.getElementById('cmdMenu');
  var html = '';
  if (menuStep === 'cmd') {
    html += '<div class="menuhead">Commands</div>';
    html += MENU_COMMANDS.map(function (c, i) {
      return '<button data-mi="' + i + '"><b>' + esc(c.label) + '</b><small>' + esc(c.hint) + '</small></button>';
    }).join('');
  } else if (menuStep === 'agent') {
    // Task 016: pick which team agent gets the new token.
    html += '<div class="menuhead">Pick an agent — ' + esc(menuLabel(chatSel.cmd)) + '</div>';
    html += AGENTS_MENU.map(function (a) {
      return '<button data-ma="' + esc(a.id) + '"><b>' + esc(a.label) + '</b><small>role: agent</small></button>';
    }).join('');
  } else {
    html += '<div class="menuhead">Pick a task — ' + esc(menuLabel(chatSel.cmd)) + '</div>';
    if (!state.tasks.length) html += '<div class="menuhead">No tasks yet</div>';
    html += state.tasks.map(function (t) {
      return '<button data-mt="' + esc(t.task_id) + '"><b>' + esc(t.title) + '</b><small>' +
        esc(t.status) + (t.assignee ? ' · ' + esc(t.assignee) : '') + '</small></button>';
    }).join('');
  }
  menu.innerHTML = html;
  menu.hidden = false;
  var btns = menu.querySelectorAll('button[data-mi]');
  for (var i = 0; i < btns.length; i++) {
    (function (b) {
      b.onclick = function (ev) {
        // Stop the document-level dismiss handler from seeing this click:
        // renderMenu() below detaches the clicked button, which would
        // otherwise look like an outside click and instantly hide the menu.
        if (ev && ev.stopPropagation) ev.stopPropagation();
        var c = MENU_COMMANDS[Number(b.getAttribute('data-mi'))];
        if (!c.needsText && !c.needsTask && !c.needsAgent) {
          hideMenu(); executeInstantCommand(c.id); return;
        }
        chatSel.cmd = c.id;
        chatSel.agentId = null;
        if (c.needsTask) { menuStep = 'task'; renderMenu(); }
        else if (c.needsAgent) { menuStep = 'agent'; renderMenu(); }
        else { chatSel.taskId = null; hideMenu(); renderChips(); focusInput(); }
      };
    })(btns[i]);
  }
  var abtns = menu.querySelectorAll('button[data-ma]');
  for (var k = 0; k < abtns.length; k++) {
    (function (b) {
      b.onclick = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        chatSel.agentId = b.getAttribute('data-ma');
        hideMenu(); renderChips(); focusInput();
      };
    })(abtns[k]);
  }
  var tbtns = menu.querySelectorAll('button[data-mt]');
  for (var j = 0; j < tbtns.length; j++) {
    (function (b) {
      b.onclick = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        chatSel.taskId = b.getAttribute('data-mt');
        hideMenu(); renderChips(); focusInput();
      };
    })(tbtns[j]);
  }
  updateComposerPad();
}

function executeInstantCommand(id) {
  if (id === 'manageTokens') openTokenManager();
}

function renderChips() {
  var row = document.getElementById('chipRow');
  var html = '';
  if (chatSel.cmd !== 'postMessage') {
    html += '<span class="tchip">/' + esc(menuLabel(chatSel.cmd)) +
      ' <button data-chip="cmd" aria-label="Clear command">✕</button></span>';
  }
  if (chatSel.taskId) {
    html += '<span class="tchip">▸ ' + esc(taskTitle(chatSel.taskId)) +
      ' <button data-chip="task" aria-label="Clear task">✕</button></span>';
  }
  if (chatSel.agentId) {
    html += '<span class="tchip">▸ ' + esc(agentLabel(chatSel.agentId)) +
      ' <button data-chip="agent" aria-label="Clear agent">✕</button></span>';
  }
  row.innerHTML = html;
  row.hidden = !html;
  var btns = row.querySelectorAll('button[data-chip]');
  for (var i = 0; i < btns.length; i++) {
    (function (b) {
      b.onclick = function () {
        if (b.getAttribute('data-chip') === 'cmd') { chatSel.cmd = 'postMessage'; chatSel.agentId = null; }
        else if (b.getAttribute('data-chip') === 'agent') chatSel.agentId = null;
        else chatSel.taskId = null;
        renderChips();
      };
    })(btns[i]);
  }
  updateComposerPad();
}

function focusInput() {
  document.getElementById('cmdInput').focus();
}

// ---- composer ------------------------------------------------------------------

var DRAFT_KEY = 'hub.chatDraft';

function autoresize(input) {
  input.style.height = 'auto';
  var h = Math.min(input.scrollHeight, 132);
  input.style.height = h + 'px';
  input.style.overflowY = input.scrollHeight > 132 ? 'auto' : 'hidden';
}

function initComposer() {
  var input = document.getElementById('cmdInput');
  var saved = null;
  try { saved = sessionStorage.getItem(DRAFT_KEY); } catch (e) { /* private mode */ }
  if (saved) input.value = saved;
  autoresize(input);

  input.addEventListener('input', function () {
    try { sessionStorage.setItem(DRAFT_KEY, input.value); } catch (e) {}
    autoresize(input);
  });
  input.addEventListener('keydown', function (ev) {
    var menuOpen = !document.getElementById('cmdMenu').hidden;
    if (ev.key === 'Escape') { hideMenu(); return; }
    if (ev.key !== 'Enter') return;
    // With the command picker open, Enter inserts a newline — never sends.
    if (menuOpen) return;
    // Desktop: Enter sends, Shift+Enter is a newline. On touch devices
    // (iPhone) Enter is a newline; the Send button sends.
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (!coarse && !ev.shiftKey) { ev.preventDefault(); sendChat(); }
  });

  document.getElementById('cmdSend').onclick = sendChat;
  document.getElementById('slashBtn').onclick = toggleMenu;
  document.getElementById('newMsgPill').onclick = function () {
    var sc = document.getElementById('threadScroll');
    sc.scrollTop = sc.scrollHeight;
    document.getElementById('newMsgPill').hidden = true;
  };
  document.getElementById('threadScroll').addEventListener('scroll', function () {
    if (isNearBottom()) document.getElementById('newMsgPill').hidden = true;
  });
  // Tapping outside the menu dismisses it.
  document.addEventListener('click', function (ev) {
    var menu = document.getElementById('cmdMenu');
    if (!menu.hidden && !menu.contains(ev.target) && ev.target.id !== 'slashBtn') hideMenu();
  });

  initViewportKeyboard();
  updateComposerPad();
  window.addEventListener('resize', updateComposerPad);
}

// iOS does not shrink the layout viewport when the keyboard opens — it just
// covers the bottom, so position:fixed;bottom:0 alone leaves the composer
// buried. Offset the composer by the visualViewport keyboard height instead.
function initViewportKeyboard() {
  var vv = window.visualViewport;
  var wrap = document.getElementById('composerWrap');
  if (!vv) return;
  var raf = 0;
  var apply = function () {
    raf = 0;
    var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    wrap.style.transform = kb > 1 ? 'translateY(' + (-Math.round(kb)) + 'px)' : '';
  };
  var schedule = function () { if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
}

// Keep page content clear of the fixed composer.
function updateComposerPad() {
  var wrap = document.getElementById('composerWrap');
  var h = wrap ? wrap.offsetHeight : 112;
  document.documentElement.style.setProperty('--composer-h', h + 'px');
}

function removePending(p) {
  state.pending = state.pending.filter(function (x) { return x !== p; });
}

function sendChat() {
  var input = document.getElementById('cmdInput');
  var text = input.value.trim();
  var st = document.getElementById('cmdStatus');
  var action = chatSel.cmd;
  var taskId = chatSel.taskId;
  var agentId = chatSel.agentId;
  var p;
  if (action === 'postMessage') {
    if (!taskId) return setStatus(st, false, 'pick a task — tap / first');
    if (!text) return setStatus(st, false, 'type a message');
    p = cmd('postMessage', { task_id: taskId, body: text });
  } else if (action === 'createTask') {
    if (!text) return setStatus(st, false, 'type a task title');
    // "title | goal": goal defaults to the title when omitted.
    var parts = text.split('|');
    var f2 = { title: parts[0].trim(), goal: parts.length > 1 ? parts.slice(1).join('|').trim() : parts[0].trim() };
    if (!f2.title || !f2.goal) return setStatus(st, false, 'title and goal are required');
    p = cmd('createTask', f2);
  } else if (action === 'setPriority') {
    if (!taskId) return setStatus(st, false, 'pick a task — tap / first');
    if (!text) return setStatus(st, false, 'type a priority');
    p = cmd('setPriority', { task_id: taskId, priority: text });
  } else if (action === 'requestDecision') {
    if (!text) return setStatus(st, false, 'type a question');
    var f = { question: text };
    if (taskId) f.task_id = taskId;
    p = cmd('requestDecision', f);
  } else if (action === 'manageTokens') {
    // Token inventory navigation also supports the legacy send path.
    chatSel.cmd = 'postMessage';
    renderChips();
    openTokenManager();
    return;
  } else if (action === 'issueToken') {
    // Task 016: David-only token issuance. The plaintext token is returned
    // once — it goes only to the dedicated issued-token screen.
    if (!chatSel.agentId) return setStatus(st, false, 'pick an agent — tap / first');
    showTyping('Issuing token…');
    p = api('/auth/agents', {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId, role: 'agent' }),
    });
  } else {
    return setStatus(st, false, 'unknown command');
  }
  // Optimistic echo + in-flow typing indicator (not for token issuance —
  // that is an admin action, not a chat message).
  var echo = null;
  if (action !== 'issueToken') {
    echo = {
      author: 'david', body: text, kind: 'message', ts: Date.now(),
      task: taskId ? taskTitle(taskId) : '', seq: 'p' + Date.now(), pending: true,
    };
    state.pending.push(echo);
    renderThread();
    showTyping(typingLabel(taskId));
  }
  p.then(function (r) {
    hideTyping();
    if (r && r.body && r.body.ok) {
      if (action === 'issueToken') {
        // Plaintext is shown ONCE on its own screen, never in the composer.
        var who = agentLabel(agentId);
        showIssuedToken(who, r.body.token || '');
        setStatus(st, true, 'Token issued for ' + who + ' — copy it now; it will not be shown again.');
        chatSel.cmd = 'postMessage';
        chatSel.agentId = null;
        renderChips();
      } else {
        setStatus(st, true, 'sent #' + r.body.seq);
        input.value = '';
        try { sessionStorage.setItem(DRAFT_KEY, ''); } catch (e) {}
        autoresize(input);
      }
      loadAll();
    } else {
      if (echo) removePending(echo);
      renderThread();
      setStatus(st, false, (r && r.body && (r.body.code + ': ' + r.body.message)) || 'failed');
    }
  }).catch(function () {
    hideTyping();
    removePending(echo);
    renderThread();
    setStatus(st, false, 'network error');
  });
}

// ---- init --------------------------------------------------------------------------

function render() {
  renderStats();
  renderAlerts();
  renderNeedsDavid();
  renderNeedsMateo();
  renderTasks();
  renderAgents();
  renderActivity();
  renderThread();
  // NOTE (task 015): render() never touches the composer DOM — the 15s
  // poll re-renders sections and the thread only, so it cannot steal
  // David's focus or wipe his draft.
}

document.getElementById('refreshBtn').onclick = loadAll;
document.getElementById('statusFilter').onchange = renderTasks;
document.getElementById('assigneeFilter').onchange = renderTasks;
document.getElementById('logoutBtn').onclick = function () {
  api('/auth/logout', { method: 'POST' }).then(function () { window.location = '/auth/github/login'; });
};

initComposer();
loadAll();
setInterval(function () { if (!document.hidden) loadAll(); }, 15000);
`;
