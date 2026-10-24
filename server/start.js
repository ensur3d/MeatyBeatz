#!/usr/bin/env node
/* MeatyBeatz — one-command launcher for the no-Docker setup.
   Spawns the three sidecars (web UI, disk DB, YouTube proxy) with tagged logs
   in a single terminal and tears them all down on Ctrl+C / exit. If any of
   them dies unexpectedly (e.g. its port is already taken), everything stops.

   Run:  node server/start.js
   Zero dependencies; Node >= 18. Environment passes through unchanged, so all
   MEATYBEATZ_* variables work in this mode too:

     MEATYBEATZ_WEB_PORT=9000 MEATYBEATZ_DB_FILE=/data/meatybeatz.db node server/start.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILDREN = [
  ['web', 'static-server.js'],    // required — the app itself (http://127.0.0.1:8097)
  ['db', 'db-server.js'],         // optional — SQLite disk DB (127.0.0.1:8198)
  ['proxy', 'local-proxy.js']     // optional — YouTube direct proxy (127.0.0.1:8199)
];

const procs = [];
let shuttingDown = false;

function tag(name, line) {
  const t = new Date().toISOString().slice(11, 19);
  console.log('[' + name.padEnd(5) + '] ' + t + '  ' + line.trim());
}

for (const [name, file] of CHILDREN) {
  const p = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  p.stdout.on('data', function (d) { d.toString().split('\n').filter(Boolean).forEach(function (l) { tag(name, l); }); });
  p.stderr.on('data', function (d) { d.toString().split('\n').filter(Boolean).forEach(function (l) { tag(name, l); }); });
  p.on('exit', function (code) {
    if (!shuttingDown) {
      console.error('[' + name + '] ' + file + ' exited unexpectedly (code ' + code + ') — stopping everything.');
      shutdown(1);
    }
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) { try { p.kill('SIGTERM'); } catch (e) { /* noop */ } }
  setTimeout(function () { process.exit(code); }, 1500).unref(); // give them a moment, then force
}

process.on('SIGINT', function () { shutdown(0); });
process.on('SIGTERM', function () { shutdown(0); });
