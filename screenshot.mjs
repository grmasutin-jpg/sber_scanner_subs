import http from 'http';
import fs from 'fs';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getTabs() {
  for (let i = 0; i < 20; i++) {
    try {
      return await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9222/json', (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
      });
    } catch (e) { await wait(500); }
  }
  throw new Error('Cannot connect to CDP on 9222');
}

async function main() {
  const tabs = await getTabs();
  const pageTab = tabs.find(t => t.type === 'page');
  if (!pageTab) { fs.writeFileSync('dbg-result.txt','no page tab; tabs='+tabs.map(t=>t.type).join(','),'utf8'); return; }
  const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let msgId = 1;
  const pending = new Map();
  const consoleLogs = [];
  ws.addEventListener('message', (ev) => {
    const resp = JSON.parse(ev.data);
    if (resp.id && pending.has(resp.id)) { pending.get(resp.id)(resp); pending.delete(resp.id); }
    if (resp.method === 'Runtime.exceptionThrown') consoleLogs.push('EXCEPTION: ' + JSON.stringify(resp.params.exceptionDetails.exception?.description || resp.params.exceptionDetails.text));
    if (resp.method === 'Runtime.consoleAPICalled' && resp.params.type === 'error') consoleLogs.push('console.error: ' + JSON.stringify(resp.params.args.map(a=>a.value||a.description)));
  });
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = msgId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://localhost:3000/' });
  await wait(3500);
  const expr = `(async () => {
    const errs = window.__errs || [];
    const res = {};
    res.errors = errs;
    const el = document.getElementById('insights');
    window.scrollTo({ top: el.offsetTop - 120, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 300));
    window.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 300));
    res.activeMid = [...document.querySelectorAll('.menu .nav-subitem')].filter(b=>b.classList.contains('active')).map(b=>b.dataset.target).join(',');
    window.scrollTo({ top: el.offsetTop - 20, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 300));
    window.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 300));
    res.scrollY = window.scrollY;
    res.insightsTop = el.getBoundingClientRect().top;
    res.insightsHeight = el.offsetHeight;
    res.active = [...document.querySelectorAll('.menu .nav-subitem')].map(b => (b.classList.contains('active') ? '* ' : '') + b.dataset.target).join(', ');
    res.clearBtnInScanner = !!document.querySelector('#scanner #clearAnalysisBtn');
    res.kpisInScanner = !!document.querySelector('#scanner #kpisBlock');
    res.kpisInOverview = !!document.querySelector('#overview #kpisBlock');
    res.heroSideGone = !document.querySelector('.hero-side');
    res.supportCardGone = !document.querySelector('.support-card');
    res.visibleDeepSeek = document.body.innerText.includes('DeepSeek');
    res.helpGone = !document.getElementById('help') && !document.body.innerText.includes('Нужна помощь');
    res.kpisHiddenInitially = document.getElementById('kpisBlock').hidden;
    res.clearHiddenInitially = document.getElementById('clearAnalysisBtn').hidden;
    res.clearDisplayNone = getComputedStyle(document.getElementById('clearAnalysisBtn')).display === 'none';
    res.resultsCardExists = !!document.getElementById('resultsCard');
    res.workspaceStretch = getComputedStyle(document.querySelector('.workspace')).alignItems;
    const tb=document.querySelector('.topbar-merged').getBoundingClientRect();
    res.headerCentered = Math.abs((tb.left+tb.width/2)-innerWidth/2)<8;
    res.backTopFixed = getComputedStyle(document.getElementById('backTopBtn')).position==='fixed';
    const pc=getComputedStyle(document.querySelector('.process-card')).backgroundColor;
    res.processCardBg=pc;
    res.processAlpha=pc.indexOf('rgba')===0?Number(pc.replace('rgba(','').replace(')','').split(',')[3]) : 1;
    res.cardBg=getComputedStyle(document.querySelector('.card')).backgroundColor;
    res.trustBg=getComputedStyle(document.querySelector('.trust-item')).backgroundColor;
    res.insightBg=getComputedStyle(document.querySelector('.insight')).backgroundColor;
    res.trustBoxGone = !document.querySelector('.trust-box');
    res.badgeGone = !document.querySelector('.guard-badge');
    res.revealCount = document.querySelectorAll('.reveal').length;
    res.aiMentionInHow = document.getElementById('how').innerText.toLowerCase().includes('ai');
    res.stateActive = window.__state ? window.__state.activeSection : 'n/a';
    return JSON.stringify(res);
  })()`;
  const r1 = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  let out = 'RESULT: ' + (r1.result?.value || JSON.stringify(r1));
  out += '\nPAGE LOGS:\n' + (consoleLogs.length ? consoleLogs.join('\n') : 'No page exceptions captured');
  fs.writeFileSync('dbg-result.txt', out, 'utf8');
  console.log(out);
  const darkExpr = `(async () => {
    const b=document.body,res={};
    b.classList.remove('light');
    localStorage.setItem('theme','dark');
    await new Promise(r=>setTimeout(r,300));
    const read=s=>getComputedStyle(document.querySelector(s)).backgroundColor;
    res.card=read('.card');res.process=read('.process-card');res.trust=read('.trust-item');
    res.decorHidden=b.querySelector('.bg-decor').offsetParent===null;
    res.bodyBg=getComputedStyle(b).backgroundImage.slice(0,60);
    return JSON.stringify(res);
  })()`;
  if (r2.result?.value) fs.appendFileSync('dbg-result.txt', '\nDARK: ' + r2.result.value, 'utf8');
    else fs.appendFileSync('dbg-result.txt', '\nDARK ERR: ' + JSON.stringify(r2), 'utf8');
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot?.data) fs.writeFileSync('preview.png', Buffer.from(shot.data, 'base64'));
  await send('Runtime.evaluate', { expression: `window.scrollTo({top:0,behavior:'instant'})` });
  await wait(800);
  const shot2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot2?.data) fs.writeFileSync('preview-top.png', Buffer.from(shot2.data, 'base64'));
  ws.close();
}
main().catch(e => { fs.writeFileSync('dbg-result.txt', 'FATAL: ' + (e.stack || e.message || e), 'utf8'); });


