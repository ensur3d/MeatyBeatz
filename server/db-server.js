#!/usr/bin/env node
/* MeatyBeatz — disk database server (companion, like local-proxy.js).
   Zero dependencies: uses Node's built-in SQLite (node:sqlite, Node >= 22.5;
   on older Node it falls back to a plain JSON file with the same API).

   Run:  node db-server.js
   Listens on http://127.0.0.1:8198 and keeps your whole library in a REAL
   database file (meatybeatz.db) next to this script — on your disk, outside
   the browser, so it survives clearing cookies or site data:

     GET  /ping   -> {ok:true, engine:'sqlite', file:'/…/meatybeatz.db'}
     GET  /state  -> {savedAt, data:{tracks,liked,collections,settings,recentSearches,likedAlbums}}
     PUT  /state  <- full state JSON (same shape the app stores)

   Tables inside meatybeatz.db (open it with any SQLite tool):
     tracks(video_id, title, artist, duration, added_at)
     collections(id, name, type, color, created_at)
     collection_tracks(collection_id, video_id, position)
     liked_songs(video_id, position)
     liked_albums(browse_id, title, artist, year, thumbnail, added_at, position)
     settings(key, value)
     recent_searches(position, query)
     meta(key, value)                      -- saved_at timestamp
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Configurable via environment so it can run inside a container (bind to
// 0.0.0.0, persist the SQLite file on a volume). Defaults match local use.
const HOST = process.env.MEATYBEATZ_DB_HOST || '127.0.0.1';
const PORT = Number(process.env.MEATYBEATZ_DB_PORT) || 8198;
const DB_FILE = process.env.MEATYBEATZ_DB_FILE || path.join(__dirname, 'meatybeatz.db');
const JSON_FILE = process.env.MEATYBEATZ_STATE_FILE || path.join(__dirname, 'meatybeatz-state.json'); // fallback only
const MAX_BODY = 10 * 1024 * 1024;

/* ---------- storage engine: SQLite (preferred) or JSON file ---------- */
let engine; // { name, file, readState(), writeState(state) }

function sqliteEngine() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS tracks (video_id TEXT PRIMARY KEY, title TEXT, artist TEXT, duration INTEGER, added_at INTEGER);
    CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT, type TEXT, color TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS collection_tracks (collection_id TEXT, video_id TEXT, position INTEGER, PRIMARY KEY (collection_id, video_id));
    CREATE TABLE IF NOT EXISTS liked_songs (video_id TEXT PRIMARY KEY, position INTEGER);
    CREATE TABLE IF NOT EXISTS liked_albums (browse_id TEXT PRIMARY KEY, title TEXT, artist TEXT, year TEXT, thumbnail TEXT, added_at INTEGER, position INTEGER);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS recent_searches (position INTEGER PRIMARY KEY, query TEXT);
  `);
  const insMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  const insTrack = db.prepare('INSERT OR REPLACE INTO tracks (video_id, title, artist, duration, added_at) VALUES (?, ?, ?, ?, ?)');
  const insCol = db.prepare('INSERT OR REPLACE INTO collections (id, name, type, color, created_at) VALUES (?, ?, ?, ?, ?)');
  const insCT = db.prepare('INSERT OR REPLACE INTO collection_tracks (collection_id, video_id, position) VALUES (?, ?, ?)');
  const insLiked = db.prepare('INSERT OR REPLACE INTO liked_songs (video_id, position) VALUES (?, ?)');
  const insLikedAlbum = db.prepare('INSERT OR REPLACE INTO liked_albums (browse_id, title, artist, year, thumbnail, added_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const insRecent = db.prepare('INSERT OR REPLACE INTO recent_searches (position, query) VALUES (?, ?)');

  function readState() {
    const tracks = {};
    for (const r of db.prepare('SELECT * FROM tracks').all()) {
      tracks[r.video_id] = { videoId: r.video_id, title: r.title, artist: r.artist, duration: r.duration || 0, addedAt: r.added_at || 0 };
    }
    const cols = db.prepare('SELECT * FROM collections ORDER BY created_at').all().map(function (c) {
      let color = null; try { color = JSON.parse(c.color); } catch (e) { /* keep null */ }
      return { id: c.id, name: c.name, type: c.type, color: Array.isArray(color) ? color : null, trackIds: [], createdAt: c.created_at || 0 };
    });
    const byId = {}; cols.forEach(function (c) { byId[c.id] = c; });
    for (const r of db.prepare('SELECT * FROM collection_tracks ORDER BY position').all()) {
      if (byId[r.collection_id]) byId[r.collection_id].trackIds.push(r.video_id);
    }
    const liked = db.prepare('SELECT video_id FROM liked_songs ORDER BY position').all().map(function (r) { return r.video_id; });
    const likedAlbums = db.prepare('SELECT * FROM liked_albums ORDER BY position').all().map(function (r) {
      return { browseId: r.browse_id, title: r.title || 'Unknown album', artist: r.artist || '', year: r.year || '', thumbnail: r.thumbnail || '', addedAt: r.added_at || 0 };
    });
    const settings = {};
    for (const r of db.prepare('SELECT key, value FROM settings').all()) { try { settings[r.key] = JSON.parse(r.value); } catch (e) { settings[r.key] = null; } }
    const recentSearches = db.prepare('SELECT query FROM recent_searches ORDER BY position').all().map(function (r) { return r.query; });
    const savedRow = db.prepare("SELECT value FROM meta WHERE key = 'saved_at'").get();
    const savedAt = savedRow ? Number(savedRow.value) || 0 : 0;
    return { savedAt: savedAt, data: { tracks: tracks, liked: liked, collections: cols, settings: settings, recentSearches: recentSearches, likedAlbums: likedAlbums, savedAt: savedAt } };
  }

  function writeState(state) {
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM tracks; DELETE FROM collection_tracks; DELETE FROM collections; DELETE FROM liked_songs; DELETE FROM liked_albums; DELETE FROM settings; DELETE FROM recent_searches; DELETE FROM meta;');
      const now = Date.now();
      Object.keys(state.tracks || {}).forEach(function (vid) {
        const t = state.tracks[vid] || {};
        insTrack.run(vid, t.title || 'YouTube video', t.artist || 'Unknown artist', Number(t.duration) || 0, Number(t.addedAt) || now);
      });
      (state.collections || []).forEach(function (c) {
        if (!c || !c.id) return;
        insCol.run(c.id, c.name || 'Untitled', c.type === 'genre' ? 'genre' : 'playlist', JSON.stringify(c.color || []), Number(c.createdAt) || now);
        (c.trackIds || []).forEach(function (vid, i) { if (vid) insCT.run(c.id, vid, i); });
      });
      (state.liked || []).forEach(function (vid, i) { if (vid) insLiked.run(vid, i); });
      (state.likedAlbums || []).forEach(function (a, i) {
        if (a && a.browseId) insLikedAlbum.run(a.browseId, a.title || 'Unknown album', a.artist || '', a.year || '', a.thumbnail || '', Number(a.addedAt) || now, i);
      });
      Object.keys(state.settings || {}).forEach(function (k) { insSetting.run(k, JSON.stringify(state.settings[k])); });
      (state.recentSearches || []).forEach(function (q, i) { if (q) insRecent.run(i, q); });
      insMeta.run('saved_at', String(Number(state.savedAt) || now));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* noop */ }
      throw e;
    }
  }

  return { name: 'sqlite', file: DB_FILE, readState: readState, writeState: writeState };
}

function jsonEngine() {
  function readState() {
    try {
      const raw = fs.readFileSync(JSON_FILE, 'utf8');
      const obj = JSON.parse(raw);
      return { savedAt: Number(obj.savedAt) || 0, data: obj.data || null };
    } catch (e) { return { savedAt: 0, data: null }; }
  }
  function writeState(state) {
    fs.writeFileSync(JSON_FILE, JSON.stringify({ savedAt: Number(state.savedAt) || Date.now(), data: state }, null, 2));
  }
  return { name: 'json', file: JSON_FILE, readState: readState, writeState: writeState };
}

/* ---------- data dir preflight (permission-safe) ---------- */
// The container entrypoint already prepares /data, but db-server can also be
// run standalone (node server/db-server.js). Fail with an actionable message
// instead of a cryptic SQLite error when the folder is missing or unwritable.
function permissionHint(dir) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
  console.error('Fix on the host: make the data folder owned by / writable for uid ' + uid + ', e.g.');
  console.error('    chown -R <uid>:<gid> ' + dir);
  console.error('or set MEATYBEATZ_UID / MEATYBEATZ_GID in docker-compose.yml to the uids that already own the folder.');
}

function ensureDataDir() {
  const dir = path.dirname(DB_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('MeatyBeatz disk db: cannot create data folder ' + dir + ': ' + e.message.split('\n')[0]);
    permissionHint(dir);
    process.exit(1);
  }
  const probe = path.join(dir, '.meatybeatz-write-test-' + process.pid);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    console.error('MeatyBeatz disk db: data folder ' + dir + ' is not writable by the current user.');
    permissionHint(dir);
    process.exit(1);
  }
}

ensureDataDir();

// Only fall back to the JSON engine when this Node has no built-in SQLite at
// all. A permission/IO failure opening the DB file must NOT be masked by the
// fallback — the JSON file lives in the same folder and would fail too.
let sqliteAvailable;
try { require('node:sqlite'); sqliteAvailable = true; } catch (e) { sqliteAvailable = false; }

if (!sqliteAvailable) {
  console.warn('MeatyBeatz disk db: node:sqlite unavailable — falling back to ' + JSON_FILE);
  engine = jsonEngine();
} else {
  try {
    engine = sqliteEngine();
  } catch (e) {
    console.error('MeatyBeatz disk db: cannot open ' + DB_FILE + ': ' + e.message.split('\n')[0]);
    permissionHint(path.dirname(DB_FILE));
    process.exit(1);
  }
}

/* ---------- HTTP ---------- */
function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

const server = http.createServer(async function (req, res) {
  let u;
  try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { res.writeHead(400); return res.end(); }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const send = function (code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (u.pathname === '/ping') {
      return send(200, { ok: true, engine: engine.name, file: engine.file });
    }
    if (u.pathname === '/state' && req.method === 'GET') {
      return send(200, engine.readState());
    }
    if (u.pathname === '/state' && req.method === 'PUT') {
      const body = await readBody(req);
      let state;
      try { state = JSON.parse(body); } catch (e) { return send(400, { error: 'invalid JSON' }); }
      if (!state || typeof state !== 'object' || !('tracks' in state)) return send(400, { error: 'not a MeatyBeatz state' });
      engine.writeState(state);
      console.log(new Date().toISOString() + '  saved library to disk (' + Object.keys(state.tracks || {}).length + ' tracks, ' + (state.collections || []).length + ' collections)');
      return send(200, { ok: true, savedAt: Number(state.savedAt) || Date.now() });
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    console.error('disk db error:', e.message);
    if (/(EACCES|EPERM|EISDIR|EROFS)/.test(e.code || '')) {
      permissionHint(path.dirname(engine.file));
    }
    return send(500, { error: e.message });
  }
});

server.listen(PORT, HOST, function () {
  console.log('MeatyBeatz disk database ready (' + engine.name.toUpperCase() + ')');
  console.log('  file : ' + engine.file);
  console.log('  api  : http://' + HOST + ':' + PORT + '   (/ping /state)');
});
