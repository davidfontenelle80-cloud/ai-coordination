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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Coordination Hub — David's control tower</title>
<link rel="stylesheet" href="/dashboard/styles.css">
</head>
<body>
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

<footer id="cmdbar">
  <select id="cmdAction">
    <option value="postMessage">Message task</option>
    <option value="createTask">Create task</option>
    <option value="setPriority">Set priority</option>
    <option value="requestDecision">Request decision</option>
  </select>
  <select id="cmdTask"><option value="">(select task)</option></select>
  <input id="cmdInput" type="text" placeholder="Type here, then Send — message, 'title | goal' for a new task, priority, or question" autocomplete="off">
  <button id="cmdSend">Send</button>
  <span id="cmdStatus" class="cmdstatus"></span>
</footer>

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
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  padding-bottom: 76px;
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
.dialog-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.dialog-head h3 { margin: 0; font-size: 16px; }
.dialog-body { padding: 14px 16px; overflow: auto; font-size: 14px; }
.dialog-body .sec { margin-bottom: 14px; }
.dialog-body .sec > h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.msg { border-left: 3px solid var(--line); padding: 4px 10px; margin: 6px 0; }
.msg .who { font-size: 12px; color: var(--accent); }
pre.ev { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font-size: 12px; overflow: auto; }
footer#cmdbar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 15;
  background: var(--panel); border-top: 1px solid var(--line);
  display: flex; gap: 8px; padding: 10px 16px; align-items: center;
}
#cmdInput { flex: 1; }
.cmdstatus { font-size: 12px; color: var(--muted); min-width: 120px; }
.cmdstatus.ok { color: var(--mateo); } .cmdstatus.err { color: var(--bad); }
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

var state = { tasks: [], decisions: [], agents: [], activity: [], stats: null, me: null };

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
  // assignee filter options
  var sel = document.getElementById('assigneeFilter');
  var cur = sel.value;
  var agents = {};
  state.tasks.forEach(function (t) { if (t.assignee) agents[t.assignee] = 1; });
  sel.innerHTML = '<option value="">All agents</option>' + Object.keys(agents).sort().map(function (a) {
    return '<option value="' + esc(a) + '"' + (a === cur ? ' selected' : '') + '>' + esc(a) + '</option>';
  }).join('');
  // command-bar task select
  var cs = document.getElementById('cmdTask');
  var ccur = cs.value;
  cs.innerHTML = '<option value="">(select task)</option>' + state.tasks.map(function (t) {
    return '<option value="' + esc(t.task_id) + '"' + (t.task_id === ccur ? ' selected' : '') + '>' +
      esc(t.title) + '</option>';
  }).join('');
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

// ---- David's command bar ---------------------------------------------------------

function sendCommand() {
  var action = document.getElementById('cmdAction').value;
  var taskId = document.getElementById('cmdTask').value;
  var input = document.getElementById('cmdInput').value.trim();
  var st = document.getElementById('cmdStatus');
  var p;
  if (action === 'postMessage') {
    if (!taskId) return setStatus(st, false, 'pick a task');
    if (!input) return setStatus(st, false, 'type a message');
    p = cmd('postMessage', { task_id: taskId, body: input });
  } else if (action === 'createTask') {
    if (!input) return setStatus(st, false, 'type a task title');
    // "title | goal": goal defaults to the title when omitted.
    var parts = input.split('|');
    var f2 = { title: parts[0].trim(), goal: parts.length > 1 ? parts.slice(1).join('|').trim() : parts[0].trim() };
    if (!f2.title || !f2.goal) return setStatus(st, false, 'title and goal are required');
    p = cmd('createTask', f2);
  } else if (action === 'setPriority') {
    if (!taskId) return setStatus(st, false, 'pick a task');
    if (!input) return setStatus(st, false, 'type a priority');
    p = cmd('setPriority', { task_id: taskId, priority: input });
  } else if (action === 'requestDecision') {
    if (!input) return setStatus(st, false, 'type a question');
    var f = { question: input };
    if (taskId) f.task_id = taskId;
    p = cmd('requestDecision', f);
  }
  p.then(function (r) {
    if (r && r.body && r.body.ok) {
      setStatus(st, true, 'sent #' + r.body.seq);
      document.getElementById('cmdInput').value = '';
      loadAll();
    } else setStatus(st, false, (r && r.body && (r.body.code + ': ' + r.body.message)) || 'failed');
  });
}

document.getElementById('cmdSend').onclick = sendCommand;
document.getElementById('cmdInput').onkeydown = function (ev) { if (ev.key === 'Enter') sendCommand(); };

// ---- init --------------------------------------------------------------------------

function render() {
  renderStats();
  renderAlerts();
  renderNeedsDavid();
  renderNeedsMateo();
  renderTasks();
  renderAgents();
  renderActivity();
}

document.getElementById('refreshBtn').onclick = loadAll;
document.getElementById('statusFilter').onchange = renderTasks;
document.getElementById('assigneeFilter').onchange = renderTasks;
document.getElementById('logoutBtn').onclick = function () {
  api('/auth/logout', { method: 'POST' }).then(function () { window.location = '/auth/github/login'; });
};

loadAll();
setInterval(function () { if (!document.hidden) loadAll(); }, 15000);
`;
