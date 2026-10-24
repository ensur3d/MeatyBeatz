#!/usr/bin/env node
/* MeatyBeatz — static web server (zero dependencies).
   Serves the app/ folder next to this script's parent directory.

   Run:        node server/static-server.js
   Env vars:   MEATYBEATZ_WEB_HOST  (default 127.0.0.1)
               MEATYBEATZ_WEB_PORT  (default 8097, same as the Docker image)

   HTML/CSS/JS are sent with Cache-Control: no-cache so a running app always
   picks up code changes on refresh — no stale-script surprises. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.MEATYBEATZ_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.MEATYBEATZ_WEB_PORT) || 8097;
const ROOT = path.join(__dirname, '..', 'app');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    res.writeHead(400); return res.end('Bad request');
  }
  if (urlPath === '/') urlPath = '/index.html';

  // Resolve and guard against path traversal.
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.stat(filePath, function (err, st) {
    let target = filePath;
    if (!err && st.isDirectory()) target = path.join(filePath, 'index.html');
    fs.readFile(target, function (err2, data) {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found: ' + urlPath);
      }
      const ext = path.extname(target).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      // Never let the browser cache app code — a refresh must always be fresh.
      if (['.html', '.css', '.js'].includes(ext)) headers['Cache-Control'] = 'no-cache';
      res.writeHead(200, headers);
      res.end(data);
    });
  });
});

server.listen(PORT, HOST, function () {
  console.log('MeatyBeatz web server: http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + '  (serving ' + ROOT + ')');
});
