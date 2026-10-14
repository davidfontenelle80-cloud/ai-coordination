// Synthetic (not live Hub data) 390px before/after mobile UI captures.
import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import puppeteer from 'puppeteer-core';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(project, '..');
const baseline = '2d6bb62a33473a55ec6679d5e73c247b52f96feb';
const beforeSource = execFileSync('git', ['show', baseline + ':hub/worker/src/dashboard.mjs'],
  { cwd: root, encoding: 'utf8' });
const afterSource = await readFile(path.join(project, 'worker/src/dashboard.mjs'), 'utf8');
const screenshots = path.join(project, 'docs/screenshots/mobile-polish');
await mkdir(screenshots, { recursive: true });

function parseModule(source) {
  const context = {};
  vm.runInNewContext(source.replace(/export const DASHBOARD_/g, 'var DASHBOARD_'), context);
  return context;
}
function mockFetcher() {
  // Illustrative fixtures, never requests to the production dashboard.
  var n = Date.now();
  var tasks = [
    {task_id:'demo-01',title:'Review morning briefing alerts',status:'blocked',priority:'high',assignee:'chatgpt',version:3,updated_at:n-120000},
    {task_id:'demo-02',title:'Mobile dashboard polish',status:'in-progress',priority:'high',assignee:'chatgpt',version:4,updated_at:n-3600000},
    {task_id:'demo-03',title:'Check weekly spending summary',status:'pending',priority:'normal',assignee:'mateo',version:2,updated_at:n-7200000},
    {task_id:'demo-04',title:'Confirm app health check',status:'claimed',priority:'low',assignee:'mateo',version:2,updated_at:n-86400000}
  ];
  var messages = [
    {event_type:'message.posted',actor_id:'mateo',payload:{body:'Morning check-in is ready for review.'},seq:201,created_at:n-7200000},
    {event_type:'message.posted',actor_id:'chatgpt',payload:{body:'I am testing the mobile dashboard polish and accessibility.'},seq:202,created_at:n-3600000},
    {event_type:'message.posted',actor_id:'david',payload:{body:'Thanks. Keep everything working and make the important things easy to spot.'},seq:203,created_at:n-1800000}
  ];
  var responses = {
    '/api/stats':{events_today:8,events_total:427,tasks_total:4,decisions_open:2},
    '/api/decisions?state=requested':{decisions:[
      {decision_id:'demo-d1',task_id:'demo-01',question:'Approve the revised morning alert layout?',options:['Approve','Request changes']},
      {decision_id:'demo-d2',task_id:'demo-03',question:'Keep the weekly review on Sunday?',options:['Sunday','Monday']}
    ]},
    '/api/tasks?limit=200':{tasks:tasks},
    '/api/agents':{agents:[]},
    '/api/activity?limit=60':{events:messages},
    '/auth/me':{principal:{kind:'david'}}
  };
  window.fetch = async function (url) {
    var result = responses[String(url)];
    if (String(url).includes('/resume')) {
      result = {ok:true,resume:{
        task:{task_id:'demo-02',title:'Mobile dashboard polish',goal:'Make the hub feel effortless on a phone.',priority:'high',updated_at:n-3600000},
        status:'in-progress',assignee:'chatgpt',version:4,
        recent_messages:[
          {actor_id:'mateo',kind:'message',body:'Focus on the mobile home, visual priorities, and thread clarity.',created_at:n-7200000},
          {actor_id:'chatgpt',kind:'message',body:'I will keep the existing layout and polish the visual presentation.',created_at:n-3600000},
          {actor_id:'david',kind:'message',body:'Great. Make sure the dashboard stays simple to use.',created_at:n-1800000}
        ],open_decisions:[],resolved_decisions:[]
      }};
    }
    return {status:200,json:async function(){return result||{};}};
  };
}
const mockScript = '<script>('+mockFetcher.toString()+')();</script>';
function documentFor({DASHBOARD_HTML:html,DASHBOARD_CSS:css,DASHBOARD_JS:js}) {
  return html
    .replace('<link rel="stylesheet" href="/dashboard/styles.css">', '<style>' + css + '</style>')
    .replace('<script src="/dashboard/app.js"></script>', mockScript + '<script>' + js + '</script>');
}
const executablePath = process.env.CHROME_BIN || ['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
if (!executablePath) throw new Error('Chromium/Chrome binary missing');
const browser = await puppeteer.launch({headless:true,executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  const page = await browser.newPage();
  await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const [name, source] of [['before',beforeSource],['after',afterSource]]) {
    await page.setContent(documentFor(parseModule(source)), {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.querySelectorAll('#taskList .taskrow').length === 4,
      {timeout:12000});
    await page.screenshot({path:path.join(screenshots,name+'-home-390.jpg'),type:'jpeg',quality:83,fullPage:true});
    if (name === 'after') {
      await page.click('#taskList .taskrow[data-task="demo-02"]');
      await page.waitForFunction(() => document.getElementById('detailTitle').textContent === 'Mobile dashboard polish');
      const visible = await page.evaluate(() => !!document.getElementById('taskDetailScreen').getClientRects().length);
      if (!visible) throw new Error('Task detail blank on 390px viewport');
      await page.screenshot({path:path.join(screenshots,'after-thread-390.jpg'),type:'jpeg',quality:83,fullPage:true});
    }
  }
  if (errors.length) throw new Error('Browser errors: '+errors.join(' | '));
  console.log('Captured before/after Home and after Thread, 390px with demo data');
} finally {
  await browser.close();
}
