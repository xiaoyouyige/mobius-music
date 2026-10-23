'use strict';

/*
 * Möbius Music 局域网静态服务器（零依赖）
 *   node server.js          启动
 *   node server.js --open   启动并打开本机浏览器
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');

const ROOT = path.resolve(__dirname);
const PORT = Number(process.env.PORT) || 8090;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const resolved = path.resolve(path.join(ROOT, pathname));
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(resolved).pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。`);
    console.error(`可以换一个端口：  set PORT=8091 && node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }

  console.log('');
  console.log('  Möbius Music · 莫比乌斯音乐');
  console.log('  ------------------------------------------');
  console.log(`  本机预览   http://localhost:${PORT}`);
  if (ips.length) {
    ips.forEach((ip) => console.log(`  iPhone     http://${ip}:${PORT}`));
  } else {
    console.log('  未找到局域网 IP，请检查网络连接。');
  }
  console.log('');
  console.log('  1. 让 iPhone 与电脑连接同一个 Wi-Fi');
  console.log('  2. 在 iPhone Safari 打开上面的 iPhone 地址');
  console.log('  3. 分享按钮 → 添加到主屏幕');
  console.log('  4. 打开应用，点右上角 ＋ 导入音乐');
  console.log('');
  console.log('  提示：首次运行 Windows 可能弹出防火墙授权，请允许。');
  console.log('  按 Ctrl+C 停止服务。');
  console.log('');

  if (process.argv.includes('--open') && process.platform === 'win32') {
    exec(`start "" "http://localhost:${PORT}"`);
  }
});
