import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DASHBOARD_HTML, DASHBOARD_JS, DASHBOARD_CSS } from '../src/dashboard.mjs';

// Small DOM harness runs the actual embedded app handlers without a new dependency.
function app() {
  const nodes = new Map();
  function element() {
    return { hidden: true, value: '', style: {}, textContent: '', offsetHeight: 100,
      innerHTML: '', setAttribute(key, value) { this[key] = value; }, focus() {}, blur() {}, addEventListener() {},
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
      return { status: 200, json: async () => ({ ok: true, tokens: [], token: 'tok_test.ONE_TIME_SECRET' }) };
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

  it('token inventory defaults to active, with a reversible history toggle and no extra request', () => {
    const a = app();
    a.run("renderTokenList([{ agent_id: 'chatgpt', token_id: 'tok_active' }, { agent_id: 'claude', token_id: 'tok_revoked', revoked_at: 1 }])");
    const body = a.document.getElementById('tokensBody');
    const toggle = a.document.getElementById('toggleRevokedTokens');
    assert.ok(body.innerHTML.includes('tok_active'));
    assert.ok(!body.innerHTML.includes('tok_revoked'));
    assert.equal(toggle.textContent, 'Show revoked (1)');
    assert.equal(toggle['aria-pressed'], 'false');
    toggle.onclick();
    assert.ok(body.innerHTML.includes('tok_active'));
    assert.ok(body.innerHTML.includes('tok_revoked'));
    assert.equal(body.querySelectorAll('button[data-revoke]').length, 1);
    assert.equal(toggle.textContent, 'Hide revoked (1)');
    assert.equal(toggle['aria-pressed'], 'true');
    toggle.onclick();
    assert.ok(!body.innerHTML.includes('tok_revoked'));
    assert.equal(a.context.tokenInventory.length, 2);
    assert.equal(a.requests.length, 0);
  });

  it('revoked-only and empty inventories have helpful empty states; reload honors the filter', async () => {
    const a = app();
    const body = a.document.getElementById('tokensBody');
    a.run("renderTokenList([{ token_id: 'tok_history', revoked_at: 1 }])");
    assert.ok(body.innerHTML.includes('No active tokens'));
    a.document.getElementById('toggleRevokedTokens').onclick();
    assert.ok(body.innerHTML.includes('tok_history'));
    a.context.fetch = async () => ({ status: 200, json: async () => ({ ok: true, tokens: [{ token_id: 'tok_history', revoked_at: 1 }] }) });
    a.run('openTokenManager()'); await flush();
    assert.ok(body.innerHTML.includes('tok_history'));
    a.document.getElementById('toggleRevokedTokens').onclick();
    a.run('loadTokens()'); await flush();
    assert.ok(!body.innerHTML.includes('tok_history'));
    a.run('renderTokenList([])');
    assert.ok(body.innerHTML.includes('No agent tokens yet'));
  });

  it('screen markup and CSS provide safe areas, 44px targets and no token dialog', () => {
    assert.ok(!DASHBOARD_HTML.includes('tokenDialog'));
    assert.ok(DASHBOARD_HTML.includes('id="issuedTokenBack"'));
    assert.match(DASHBOARD_CSS, /\.screen button \{ min-width: 44px; min-height: 44px;/);
    for (const edge of ['top', 'bottom', 'left', 'right']) assert.ok(DASHBOARD_CSS.includes('env(safe-area-inset-' + edge + ')'));
  });
});
