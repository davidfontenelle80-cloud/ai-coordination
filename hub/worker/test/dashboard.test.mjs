import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DASHBOARD_HTML, DASHBOARD_JS, DASHBOARD_CSS } from '../src/dashboard.mjs';

// Small DOM harness runs the actual embedded app handlers without a new dependency.
// Pass respond(path, opts) to customize fetch JSON per test; default keeps the
// legacy fixed response.
function app(respond) {
  const nodes = new Map();
  function element() {
    const attrs = {};
    return { hidden: true, value: '', style: {}, textContent: '', offsetHeight: 100,
      innerHTML: '', focus() {}, blur() {}, addEventListener() {},
      getAttribute(name) { return name in attrs ? attrs[name] : null; },
      setAttribute(name, v) { attrs[name] = String(v); },
      replaceChildren() { this.innerHTML = ''; },
      querySelectorAll(selector) {
        const attr = /\[([^\]]+)\]/.exec(selector)?.[1];
        if (!attr) return [];
        return [...this.innerHTML.matchAll(new RegExp(attr + '="([^"]*)"', 'g'))].map(m => {
          const b = element(); b.getAttribute = () => m[1]; return b;
        });
      },
    };
  }
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    body: { classList: { toggle() {} } },
    documentElement: { style: { setProperty() {} } },
  };
  const requests = [];
  const context = vm.createContext({ document, window: { scrollY: 0, scrollTo() {} },
    navigator: {}, setTimeout: () => 1, clearTimeout() {},
    crypto: { randomUUID: () => 'test' }, sessionStorage: { setItem() {} },
    fetch: async (path, opts) => {
      requests.push({ path, opts });
      const body = respond
        ? respond(path, opts)
        : { ok: true, tokens: [], token: 'tok_test.ONE_TIME_SECRET' };
      return { status: 200, json: async () => body };
    },
  });
  vm.runInContext(DASHBOARD_JS.slice(0, DASHBOARD_JS.lastIndexOf('initComposer();')), context);
  vm.runInContext('loadAll = function () {}; renderThread = function () {};', context);
  return { context, document, requests, run: code => vm.runInContext(code, context) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('task 018 screen behavior', () => {
  it('every no-input menu command executes on tap, without arming a chip or sending a draft', async () => {
    const a = app();
    a.document.getElementById('cmdInput').value = 'unsent draft';
    a.run('renderMenu()');
    const buttons = a.document.getElementById('cmdMenu').querySelectorAll('button[data-mi]');
    // Re-render and capture the real handlers on the same fake nodes.
    a.document.getElementById('cmdMenu').querySelectorAll = selector => selector === 'button[data-mi]' ? buttons : [];
    a.run('renderMenu()');
    const commands = a.context.MENU_COMMANDS;
    commands.forEach((c, i) => {
      if (c.needsText || c.needsTask || c.needsAgent) return;
      buttons[i].onclick({ stopPropagation() {} });
      assert.equal(a.context.currentScreen, 'tokens');
      assert.equal(a.context.chatSel.cmd, 'postMessage');
      assert.equal(a.document.getElementById('cmdMenu').hidden, true);
    });
    await flush();
    assert.deepEqual(a.requests.map(r => r.path), ['/auth/agents/tokens']);
    assert.equal(a.document.getElementById('cmdInput').value, 'unsent draft');
  });

  it('input-dependent commands retain task/agent pick and chip flows', () => {
    for (let i = 0; i < 5; i++) {
      const a = app(); a.run('renderMenu()');
      const buttons = a.document.getElementById('cmdMenu').querySelectorAll('button[data-mi]');
      const original = a.document.getElementById('cmdMenu').querySelectorAll;
      a.document.getElementById('cmdMenu').querySelectorAll = selector => selector === 'button[data-mi]' ? buttons : original.call(a.document.getElementById('cmdMenu'), selector);
      a.run('renderMenu()'); buttons[i].onclick({ stopPropagation() {} });
      assert.equal(a.context.currentScreen, 'dashboard');
      assert.equal(a.requests.length, 0);
      assert.equal(a.context.chatSel.cmd, a.context.MENU_COMMANDS[i].id);
      assert.equal(a.context.menuStep, i === 4 ? 'agent' : (i === 0 || i === 2 ? 'task' : 'cmd'));
    }
  });

  it('Tokens is a real screen with back navigation and complete inventory', async () => {
    const a = app(); a.run('openTokenManager()'); await flush();
    assert.equal(a.document.getElementById('dashboardScreen').hidden, true);
    assert.equal(a.document.getElementById('tokensScreen').hidden, false);
    a.run(`renderTokenList([{ display_name: 'ChatGPT', agent_id: 'chatgpt', token_id: 'tok_123', created_at: 1, created_by: 'david', last_used_at: 2 }])`);
    const html = a.document.getElementById('tokensBody').innerHTML;
    for (const text of ['ChatGPT', 'chatgpt', 'tok_123', 'david', 'last used', 'Active', 'Revoke']) assert.ok(html.includes(text));
    a.document.getElementById('tokensBack').onclick();
    assert.equal(a.context.currentScreen, 'dashboard');
    assert.equal(a.context.screenStack.length, 0);
  });

  it('issuance shows copy, readonly, back and done; never writes plaintext to composer or history', async () => {
    const a = app(); const input = a.document.getElementById('cmdInput'); input.value = 'draft';
    a.run("chatSel.cmd = 'issueToken'; chatSel.agentId = 'chatgpt'; sendChat()");
    await flush();
    assert.equal(a.context.currentScreen, 'issuedToken');
    assert.equal(input.value, 'draft');
    assert.equal(a.document.getElementById('issuedTokenValue').value, 'tok_test.ONE_TIME_SECRET');
    const html = a.document.getElementById('issuedTokenBody').innerHTML;
    for (const text of ['readonly', 'Copy token', 'View all tokens', 'Done']) assert.ok(html.includes(text));
    let copied;
    a.context.navigator.clipboard = { writeText: async text => { copied = text; } };
    a.document.getElementById('copyTokBtn').onclick(); await flush();
    assert.equal(copied, 'tok_test.ONE_TIME_SECRET');
    a.document.getElementById('viewToksBtn').onclick(); await flush();
    assert.equal(a.document.getElementById('issuedTokenBody').innerHTML, '');
    a.document.getElementById('tokensBack').onclick();
    assert.equal(a.context.currentScreen, 'dashboard');
    assert.ok(!a.context.screenStack.includes('issuedToken'));
    a.run("showIssuedToken('ChatGPT', 'another-token')");
    a.document.getElementById('doneTokBtn').onclick();
    assert.equal(a.context.currentScreen, 'dashboard');
    assert.equal(a.document.getElementById('issuedTokenBody').innerHTML, '');
  });

  it('issueToken walks agent then role; Lead posts role mateo and resets after', async () => {
    const a = app();
    const menu = a.document.getElementById('cmdMenu');
    const realQSA = menu.querySelectorAll.bind(menu);
    const useButtons = selector => {
      const btns = realQSA(selector);
      menu.querySelectorAll = s => s === selector ? btns : [];
      a.run('renderMenu()');
      return btns;
    };
    a.run("menuStep = 'cmd'; renderMenu()");
    const miBtns = useButtons('button[data-mi]');
    const idx = a.context.MENU_COMMANDS.findIndex(c => c.id === 'issueToken');
    miBtns[idx].onclick({ stopPropagation() {} });
    assert.equal(a.context.chatSel.cmd, 'issueToken');
    assert.equal(a.context.menuStep, 'agent');
    const maBtns = useButtons('button[data-ma]');
    const mateoBtn = maBtns.find(b => b.getAttribute('data-ma') === 'mateo');
    assert.ok(mateoBtn, 'mateo is a mintable agent');
    mateoBtn.onclick({ stopPropagation() {} });
    assert.equal(a.context.chatSel.agentId, 'mateo');
    assert.equal(a.context.menuStep, 'role');
    const mrBtns = useButtons('button[data-mr]');
    assert.equal(mrBtns.length, 2);
    const leadBtn = mrBtns.find(b => b.getAttribute('data-mr') === 'mateo');
    leadBtn.onclick({ stopPropagation() {} });
    assert.equal(a.context.chatSel.role, 'mateo');
    a.run('sendChat()'); await flush();
    const issue = a.requests.find(r => r.path === '/auth/agents');
    assert.ok(issue);
    assert.deepEqual(JSON.parse(issue.opts.body), { agent_id: 'mateo', role: 'mateo' });
    assert.equal(a.context.chatSel.role, 'agent');
    assert.equal(a.context.chatSel.agentId, null);
    assert.equal(a.context.chatSel.cmd, 'postMessage');
  });

  it('issueToken defaults to the agent role when no role was picked', async () => {
    const a = app();
    a.run("chatSel.cmd = 'issueToken'; chatSel.agentId = 'chatgpt'; sendChat()");
    await flush();
    const issue = a.requests.find(r => r.path === '/auth/agents');
    assert.ok(issue);
    assert.deepEqual(JSON.parse(issue.opts.body), { agent_id: 'chatgpt', role: 'agent' });
  });

  it('revoke requires two taps, posts only token_id, and reloads inventory without stacking', async () => {
    const a = app(); a.run('openTokenManager()'); await flush();
    const body = a.document.getElementById('tokensBody');
    const button = { getAttribute: () => 'tok_123' };
    body.querySelectorAll = () => [button];
    a.run("renderTokenList([{ agent_id: 'chatgpt', token_id: 'tok_123' }])");
    button.onclick(); assert.equal(a.requests.length, 1);
    assert.equal(button.textContent, 'Tap again to confirm');
    button.onclick(); await flush();
    assert.equal(a.requests[1].path, '/auth/agents/revoke');
    assert.equal(a.requests[1].opts.body, '{"token_id":"tok_123"}');
    assert.equal(a.requests[2].path, '/auth/agents/tokens');
    assert.equal(a.context.screenStack.length, 1);
  });

  it('screen markup and CSS provide safe areas, 44px targets and no token dialog', () => {
    assert.ok(!DASHBOARD_HTML.includes('tokenDialog'));
    assert.ok(DASHBOARD_HTML.includes('id="issuedTokenBack"'));
    assert.match(DASHBOARD_CSS, /\.screen button \{ min-width: 44px; min-height: 44px;/);
    for (const edge of ['top', 'bottom', 'left', 'right']) assert.ok(DASHBOARD_CSS.includes('env(safe-area-inset-' + edge + ')'));
  });
});

describe('Board UX: completed section + thread view', () => {
  const TASKS = [
    { task_id: 't1', title: 'Active thing', status: 'in-progress', assignee: 'claude', priority: 'high', version: 3, updated_at: 1000 },
    { task_id: 't2', title: 'Blocked thing', status: 'blocked', assignee: 'chatgpt', priority: 'normal', version: 1, updated_at: 2000 },
    { task_id: 't9', title: 'Done thing', status: 'completed', assignee: 'claude', priority: 'low', version: 5, updated_at: 3000 },
  ];
  const seedTasks = a => a.run('state.tasks = ' + JSON.stringify(TASKS));

  it('status filter no longer offers completed; main board lists active tasks only', () => {
    assert.ok(!DASHBOARD_HTML.includes('value="completed"'), 'no completed option in filter');
    const a = app(); seedTasks(a);
    a.run('renderTasks()');
    const html = a.document.getElementById('taskList').innerHTML;
    assert.ok(html.includes('Active thing'));
    assert.ok(html.includes('Blocked thing'));
    assert.ok(!html.includes('Done thing'), 'completed task not on main board');
    assert.equal(a.document.getElementById('taskCount').textContent, '2 of 2 active');
  });

  it('completed section lists completed tasks, is tappable, and respects the agent filter', () => {
    const a = app(); seedTasks(a);
    a.run('renderCompleted()');
    const list = a.document.getElementById('completedList');
    assert.equal(a.document.getElementById('completedCount').textContent, '1');
    assert.ok(list.innerHTML.includes('Done thing'));
    assert.ok(!list.innerHTML.includes('Active thing'));
    assert.ok(list.innerHTML.includes('data-task="t9"'), 'row carries the task id');
    // agent filter applies to the completed list too
    a.document.getElementById('assigneeFilter').value = 'chatgpt';
    a.run('renderCompleted()');
    assert.ok(list.innerHTML.includes('No completed tasks.'));
    a.document.getElementById('assigneeFilter').value = '';
    a.run('renderCompleted()');
    assert.ok(list.innerHTML.includes('Done thing'));
  });

  it('completed section toggle collapses and expands the list', () => {
    const a = app(); seedTasks(a); a.run('renderCompleted()');
    const toggle = a.document.getElementById('completedToggle');
    const listEl = a.document.getElementById('completedList');
    const caret = a.document.getElementById('completedCaret');
    toggle.onclick();
    assert.equal(listEl.hidden, true);
    assert.equal(caret.textContent, '▸');
    toggle.onclick();
    assert.equal(listEl.hidden, false);
    assert.equal(caret.textContent, '▾');
  });

  const RESUME = status => ({ ok: true, resume: {
    task: { task_id: 't1', title: 'Active thing', goal: 'Make it work', priority: 'high', updated_at: 1000 },
    status, assignee: 'claude', version: 3,
    recent_messages: [{ actor_id: 'claude', kind: 'message', body: 'hello world', created_at: 2000 }],
    open_decisions: [], resolved_decisions: [],
  } });
  const openSeeded = (a, status) => {
    a.run("state.activity = [{ task_id: 't1', event_type: 'task.changed', actor_id: 'mateo', seq: 4, created_at: 1500, payload: { field: 'status', from: 'claimed', to: 'in-progress' } }]");
    a.run("openTask('t1')");
  };

  it('tapping a task opens a full thread screen with meta, messages and events', async () => {
    const a = app(p => p.includes('/resume') ? RESUME('in-progress') : { ok: true });
    seedTasks(a); openSeeded(a, 'in-progress'); await flush();
    assert.equal(a.context.currentScreen, 'taskDetail');
    assert.equal(a.document.getElementById('taskDetailScreen').hidden, false);
    assert.equal(a.document.getElementById('dashboardScreen').hidden, true);
    assert.equal(a.document.getElementById('detailTitle').textContent, 'Active thing');
    const html = a.document.getElementById('detailBody').innerHTML;
    for (const text of ['Make it work', 'in-progress', 'claude', 'high', 'hello world',
        'task.changed', 'claimed →', '#4', 'data-a="start"', 'data-a="msg"']) {
      assert.ok(html.includes(text), 'thread shows ' + text);
    }
  });

  it('the sticky Back button returns to the board', async () => {
    const a = app(p => p.includes('/resume') ? RESUME('in-progress') : { ok: true });
    seedTasks(a); openSeeded(a, 'in-progress'); await flush();
    a.document.getElementById('detailBack').onclick();
    assert.equal(a.context.currentScreen, 'dashboard');
    assert.equal(a.document.getElementById('dashboardScreen').hidden, false);
    assert.equal(a.document.getElementById('taskDetailScreen').hidden, true);
    assert.equal(a.context.screenStack.length, 0);
  });

  it('completed task detail notes reopening is unsupported and hides state-changing actions', async () => {
    const a = app(p => p.includes('/resume') ? RESUME('completed') : { ok: true });
    seedTasks(a); openSeeded(a, 'completed'); await flush();
    const html = a.document.getElementById('detailBody').innerHTML;
    assert.ok(html.includes('Reopening is not supported yet'));
    for (const act of ['data-a="start"', 'data-a="block"', 'data-a="priority"']) {
      assert.ok(!html.includes(act), act + ' hidden on completed tasks');
    }
    assert.ok(html.includes('data-a="msg"'), 'post message still available');
    assert.ok(html.includes('data-a="decision"'), 'request decision still available');
  });

  it('completed rows open the thread screen when tapped', async () => {
    const a = app(p => p.includes('/resume') ? RESUME('completed') : { ok: true });
    seedTasks(a);
    const list = a.document.getElementById('completedList');
    const realQSA = list.querySelectorAll.bind(list);
    let wired;
    list.querySelectorAll = s => {
      const r = realQSA(s === '.taskrow' ? 'button[data-task]' : s);
      if (s === '.taskrow') wired = r;
      return r;
    };
    a.run('renderCompleted()');
    assert.equal(wired.length, 1);
    wired[0].onclick(); await flush();
    assert.equal(a.context.currentScreen, 'taskDetail');
    assert.equal(a.document.getElementById('detailTitle').textContent, 'Active thing');
  });

  it('markup and CSS carry the new screen affordances and no modal remnants', () => {
    assert.ok(DASHBOARD_HTML.includes('id="taskDetailScreen"'));
    assert.ok(DASHBOARD_HTML.includes('id="detailBack"'));
    assert.ok(DASHBOARD_HTML.includes('id="completedSection"'));
    assert.ok(DASHBOARD_HTML.includes('id="completedToggle"'));
    assert.ok(DASHBOARD_HTML.includes('id="completedList"'));
    assert.ok(!DASHBOARD_HTML.includes('id="taskDetail"'), 'old overlay id gone');
    assert.ok(!DASHBOARD_HTML.includes('class="overlay"'), 'no modal overlay markup');
    assert.ok(!DASHBOARD_HTML.includes('detailClose'), 'no modal close button');
    assert.match(DASHBOARD_CSS, /#taskDetailScreen \.screen-head \{\s*position: sticky;/);
    for (const sel of ['.completed-list', '.evline', '.sechead', '.dnote', '.dmeta']) {
      assert.ok(DASHBOARD_CSS.includes(sel), 'CSS has ' + sel);
    }
  });
});
