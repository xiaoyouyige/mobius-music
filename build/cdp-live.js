'use strict';

/* 线上验收：HTTPS 页面、iPhone 尺寸、Service Worker、资源加载 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const URL = 'https://xiaoyouyige.github.io/mobius-music/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve(d));
  }).on('error', reject);
});

(async () => {
  let targets = [];
  for (let i = 0; i < 40; i++) {
    try {
      targets = JSON.parse(await get('http://127.0.0.1:9335/json/list'));
      if (targets.some((t) => t.type === 'page')) break;
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.error('no page'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: URL });
  await sleep(6000);

  const r = await send('Runtime.evaluate', {
    expression: `(async () => {
      const out = {
        title: document.title,
        bodyClass: document.body.className,
        emptyShown: document.getElementById('empty').classList.contains('show'),
        meta: document.getElementById('libMeta').textContent,
        sw: null,
        files: {}
      };
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        out.sw = regs.length;
      } catch (e) { out.sw = 'err:' + e.message; }
      for (const f of ['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icons/icon.svg']) {
        try {
          const res = await fetch('./' + f, { cache: 'no-store' });
          out.files[f] = res.status;
        } catch (e) { out.files[f] = 'err'; }
      }
      return JSON.stringify(out);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(r.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'ui-live.png'), Buffer.from(shot.data, 'base64'));
  console.log('done');
  ws.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
