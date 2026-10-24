/* MeatyBeatz — store.js : persistence layer (3 tiers)
   1. localStorage  — synchronous cache, keeps the app instant on load.
   2. IndexedDB     — durable database. Lives SEPARATELY from cookies, so
                      clearing cookies does not wipe it. Every save() writes
                      here; on startup the newer copy wins and a 'store-synced'
                      event makes the UI re-render (this is how the library
                      comes back after a cookie/site-data wipe).
   3. Library file  — OPTIONAL real file on disk (Chrome/Edge, File System
                      Access API). Connect once in Settings; every change is
                      auto-written to it ~1s later. Survives everything; if
                      browser storage is ever emptied, the app restores from
                      this file automatically. */
(function () {
  'use strict';

  var KEY = 'meatybeatz.v1';
  var DB_NAME = 'meatybeatz-db';
  var STORE_NAME = 'kv';
  var STATE_KEY = 'state';
  var HANDLE_KEY = 'backup-handle';
  // db-server.js — real SQLite file on disk. The browser talks to it directly, so use
  // the SAME host as this page: works locally (localhost) AND when the app is opened
  var DISK_BASE = 'http://' + (location.hostname || 'localhost') + ':8198';

  var PALETTE = [
    ['#8b5cf6', '#ec4899'],
    ['#06b6d4', '#3b82f6'],
    ['#f59e0b', '#ef4444'],
    ['#10b981', '#06b6d4'],
    ['#f43f5e', '#8b5cf6'],
    ['#84cc16', '#10b981'],
    ['#f97316', '#f43f5e'],
    ['#6366f1', '#a855f7']
  ];

  function defaults() {
    return {
      tracks: {},          // videoId -> {videoId,title,artist,duration,addedAt}
      liked: [],           // [videoId]
      collections: [],     // [{id,name,type:'playlist'|'genre',color:[c1,c2],trackIds:[],createdAt}]
      settings: {
        volume: 80,
        shuffle: false,
        repeat: 'off',     // off | all | one
        extractor: 'auto', // auto | builtin | invidious
        instanceOffset: 0, // round-robin pointer across search instances
        customInstances: []// [{name,base,kind}]
      },
      recentSearches: [],  // [query]
      likedAlbums: [],     // [{browseId,title,artist,year,thumbnail,addedAt}] — albums saved via the heart
      savedAt: 0           // last save timestamp (used to pick the newer copy)
    };
  }

  // Merge a raw object over defaults so old shapes keep working.
  function normalize(d) {
    var base = defaults();
    for (var k in base) {
      if (d[k] === undefined || d[k] === null) d[k] = base[k];
    }
    if (!d.settings) d.settings = base.settings;
    for (var s in base.settings) {
      if (d.settings[s] === undefined) d.settings[s] = base.settings[s];
    }
    if (typeof d.savedAt !== 'number') d.savedAt = 0;
    return d;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      return normalize(JSON.parse(raw));
    } catch (e) {
      console.warn('MeatyBeatz: could not load saved data, starting fresh.', e);
      return defaults();
    }
  }

  var data = load();

  /* ---------- IndexedDB helpers (tier 2) ---------- */
  var dbPromise = null;
  function idb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
    });
    return dbPromise;
  }
  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rq = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
        rq.onsuccess = function () { resolve(rq.result == null ? null : rq.result); };
        rq.onerror = function () { reject(rq.error || new Error('IndexedDB read failed')); };
      });
    });
  }
  function idbSet(key, value) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rq = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key);
        rq.onsuccess = function () { resolve(); };
        rq.onerror = function () { reject(rq.error || new Error('IndexedDB write failed')); };
      });
    });
  }

  function snapshot() { return JSON.parse(JSON.stringify(data)); }

  function emitSync(source) {
    try { window.dispatchEvent(new CustomEvent('store-synced', { detail: { source: source } })); } catch (e) { /* noop */ }
  }

  /* ---------- Library file helpers (tier 3, Chrome/Edge only) ---------- */
  var backupHandle = null;       // FileSystemFileHandle, persisted in IndexedDB
  var backupPermission = 'none'; // none | prompt | granted
  var fileWriteTimer = null;

  function fsSupported() { return typeof window.showSaveFilePicker === 'function'; }

  function writeBackupFile() {
    if (!backupHandle) return Promise.resolve();
    return backupHandle.createWritable().then(function (w) {
      return w.write(JSON.stringify(snapshot(), null, 2)).then(function () { return w.close(); });
    });
  }

  function scheduleFileWrite() {
    if (!backupHandle || backupPermission !== 'granted') return;
    if (fileWriteTimer) clearTimeout(fileWriteTimer);
    fileWriteTimer = setTimeout(function () {
      fileWriteTimer = null;
      writeBackupFile().catch(function (e) { console.warn('MeatyBeatz: library file write failed', e); });
    }, 1000);
  }

  function connectBackupFile() {
    if (!fsSupported()) return Promise.reject(new Error('File System Access API not supported in this browser'));
    return window.showSaveFilePicker({
      suggestedName: 'meatybeatz-library.json',
      types: [{ description: 'MeatyBeatz library', accept: { 'application/json': ['.json'] } }]
    }).then(function (handle) {
      backupHandle = handle;
      backupPermission = 'granted';
      return idbSet(HANDLE_KEY, handle).catch(function () {}); // persist the handle
    }).then(function () {
      return writeBackupFile(); // immediate first write
    });
  }

  function disconnectBackupFile() {
    if (fileWriteTimer) { clearTimeout(fileWriteTimer); fileWriteTimer = null; }
    backupHandle = null;
    backupPermission = 'none';
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var rq = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(HANDLE_KEY);
        rq.onsuccess = resolve;
        rq.onerror = resolve;
      });
    }).catch(function () {});
  }

  function reauthorizeBackupFile() {
    if (!backupHandle) return Promise.resolve(false);
    return backupHandle.requestPermission({ mode: 'readwrite' }).then(function (perm) {
      backupPermission = perm || 'prompt';
      if (backupPermission === 'granted') return tryRestoreFromFile().then(function () { return true; });
      return false;
    }).catch(function () { return false; });
  }

  function backupStatus() {
    return { supported: fsSupported(), connected: !!backupHandle, permission: backupPermission };
  }

  function dataIsEmpty(d) {
    return !d || (!d.liked.length && !d.collections.length && !(d.likedAlbums && d.likedAlbums.length) && !Object.keys(d.tracks || {}).length);
  }

  // If local storage is empty but the library file has data -> restore from it.
  function tryRestoreFromFile() {
    if (!backupHandle || backupPermission !== 'granted' || !dataIsEmpty(data)) return Promise.resolve(false);
    return backupHandle.getFile().then(function (f) { return f.text(); }).then(function (txt) {
      var d = JSON.parse(txt);
      if (dataIsEmpty(d)) return false;
      data = normalize(d);
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* noop */ }
      idbSet(STATE_KEY, snapshot()).catch(function () {});
      emitSync('backup-file');
      return true;
    }).catch(function () { return false; });
  }

  function restoreBackupHandle() {
    if (!fsSupported()) return Promise.resolve();
    return idbGet(HANDLE_KEY).then(function (h) {
      if (!h) return;
      backupHandle = h;
      return h.queryPermission('readwrite');
    }).then(function (perm) {
      if (!backupHandle) return;
      backupPermission = perm || 'prompt';
      if (backupPermission === 'granted') return tryRestoreFromFile();
    }).catch(function () { backupHandle = null; backupPermission = 'none'; });
  }

  /* ---------- Disk database (tier 4, via db-server.js) ----------
     A real SQLite file on disk (meatybeatz.db), kept in sync over HTTP.
     Survives ANY browser clearing — it lives outside the browser entirely. */
  var diskOnline = false;
  var diskFile = '';
  var diskTimer = null;

  function fetchTimeout(url, opts) {
    opts = opts || {};
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(3000);
    return fetch(url, opts);
  }

  function diskPing() {
    return fetchTimeout(DISK_BASE + '/ping').then(function (r) { return r.json(); }).then(function (j) {
      var wasOffline = !diskOnline;
      diskOnline = !!(j && j.ok);
      diskFile = j.file || '';
      if (diskOnline && wasOffline) {
        // The disk DB came back — reconcile so edits made while offline sync.
        setTimeout(function () { diskReconcile(); }, 500);
      }
      return diskOnline;
    }).catch(function () { diskOnline = false; return false; });
  }

  function diskPush() {
    // No diskOnline gate: the push result IS the health signal, so a save made
    // while the DB is down still lands once it comes back.
    return fetchTimeout(DISK_BASE + '/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot()) })
      .then(function (r) { diskOnline = r.ok; return r.ok; })
      .catch(function () { diskOnline = false; return false; });
  }

  function scheduleDiskWrite() {
    if (diskTimer) clearTimeout(diskTimer);
    diskTimer = setTimeout(function () {
      diskTimer = null;
      diskPush(); // fails fast while offline; result updates diskOnline
    }, 1000);
  }

  function diskStatus() { return { online: diskOnline, file: diskFile }; }

  // Reconcile with the disk database: newer copy wins.
  function diskReconcile() {
    return diskPing().then(function (ok) {
      if (!ok) return;
      return fetchTimeout(DISK_BASE + '/state').then(function (r) { return r.json(); }).then(function (stored) {
        // Same rule as above: an empty database never overwrites a real library.
        if (stored && stored.data && (stored.savedAt || 0) > (data.savedAt || 0) && !(dataIsEmpty(stored.data) && !dataIsEmpty(data))) {
          data = normalize(stored.data);
          try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* noop */ }
          idbSet(STATE_KEY, snapshot()).catch(function () {});
          emitSync('disk-db');
        } else {
          diskPush(); // local is newer or equal — make sure disk has it
        }
      });
    }).catch(function () { diskOnline = false; });
  }

  /* ---------- save / startup ---------- */
  function save() {
    data.savedAt = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('MeatyBeatz: could not save to localStorage', e);
    }
    idbSet(STATE_KEY, snapshot()).catch(function (e) {
      console.warn('MeatyBeatz: IndexedDB write failed (localStorage still active)', e);
    });
    scheduleFileWrite();
    scheduleDiskWrite();
  }

  // Startup: the newer of (localStorage, IndexedDB, disk database) wins. If a
  // durable copy is newer, adopt it and re-render — this is the recovery path
  // after any wipe of browser storage.
  (function startup() {
    var p = idbGet(STATE_KEY).then(function (stored) {
      if (!stored || typeof stored !== 'object') {
        return idbSet(STATE_KEY, snapshot()); // first run / migrating an existing user
      }
      // An empty durable copy never overwrites a non-empty local one (a freshly
      // reset database must not wipe an existing library).
      if ((stored.savedAt || 0) > (data.savedAt || 0) && !(dataIsEmpty(stored) && !dataIsEmpty(data))) {
        data = normalize(stored);
        try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* noop */ }
        emitSync('indexeddb');
      } else {
        idbSet(STATE_KEY, snapshot()).catch(function () {});
      }
    });
    p.then(diskReconcile).then(restoreBackupHandle).catch(function (e) {
      console.warn('MeatyBeatz: storage sync unavailable (using localStorage only)', e);
    });
  })();

  // Self-healing: while the disk DB is unreachable (container restart, network
  // blip), poll it every 30s; the ping's offline->online hook reconciles state.
  // No traffic at all while healthy.
  if (typeof setInterval === 'function') {
    setInterval(function () {
      if (!diskOnline) diskPing();
    }, 30000);
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', function () {
      if (fileWriteTimer) { // best-effort flush of a pending file write
        clearTimeout(fileWriteTimer);
        fileWriteTimer = null;
        writeBackupFile().catch(function () {});
      }
      if (diskTimer) { // best-effort flush of a pending disk write
        clearTimeout(diskTimer);
        diskTimer = null;
        diskPush();
      }
    });
  }

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  /* ---------- tracks ---------- */
  function getTrack(videoId) { return data.tracks[videoId] || null; }

  function upsertTrack(t) {
    // t: {videoId, title, artist, duration}
    if (!t || !t.videoId) return null;
    var ex = data.tracks[t.videoId];
    if (ex) {
      if (t.title && (!ex.title || ex.title === 'YouTube video')) ex.title = t.title;
      if (t.artist && (!ex.artist || ex.artist === 'Unknown artist')) ex.artist = t.artist;
      if (t.duration > 0 && !(ex.duration > 0)) ex.duration = t.duration;
    } else {
      data.tracks[t.videoId] = {
        videoId: t.videoId,
        title: t.title || 'YouTube video',
        artist: t.artist || 'Unknown artist',
        duration: Number(t.duration) || 0,
        addedAt: Date.now()
      };
    }
    save();
    return data.tracks[t.videoId];
  }

  // Batch version: registers many tracks with a single save. Existing tracks
  // get the same "fill missing metadata" merge as upsertTrack (never overrides
  // good values), so bulk imports of known songs upgrade bare placeholders.
  function upsertMany(list) {
    var n = 0;
    (list || []).forEach(function (t) {
      if (!t || !t.videoId) return;
      var ex = data.tracks[t.videoId];
      if (ex) {
        if (t.title && (!ex.title || ex.title === 'YouTube video')) ex.title = t.title;
        if (t.artist && (!ex.artist || ex.artist === 'Unknown artist')) ex.artist = t.artist;
        if (t.duration > 0 && !(ex.duration > 0)) ex.duration = t.duration;
      } else {
        data.tracks[t.videoId] = {
          videoId: t.videoId,
          title: t.title || 'YouTube video',
          artist: t.artist || 'Unknown artist',
          duration: Number(t.duration) || 0,
          addedAt: Date.now()
        };
      }
      n++;
    });
    if (n) save();
    return n;
  }

  function allTracks() { return Object.keys(data.tracks).map(function (k) { return data.tracks[k]; }); }

  function recentTracks(n) {
    return allTracks().sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); }).slice(0, n);
  }

  /* ---------- likes ---------- */
  function isLiked(id) { return data.liked.indexOf(id) !== -1; }
  function likedIds() { return data.liked.slice(); }
  function toggleLike(id) {
    var i = data.liked.indexOf(id);
    if (i === -1) { data.liked.unshift(id); } else { data.liked.splice(i, 1); }
    save();
    return i === -1; // true => now liked
  }

  /* ---------- liked albums ----------
     An album is identified by its YouTube Music browseId (MPREb_…). We store
     just the display metadata — the tracklist is re-fetched from the local
     proxy whenever the album page is opened. */
  function likedAlbums() { return data.likedAlbums.slice(); }
  function isLikedAlbum(browseId) {
    return data.likedAlbums.some(function (a) { return a.browseId === browseId; });
  }
  function toggleLikedAlbum(al) {
    if (!al || !al.browseId) return false;
    var i = -1;
    for (var k = 0; k < data.likedAlbums.length; k++) {
      if (data.likedAlbums[k].browseId === al.browseId) { i = k; break; }
    }
    if (i !== -1) { data.likedAlbums.splice(i, 1); save(); return false; }
    data.likedAlbums.unshift({
      browseId: al.browseId,
      title: al.title || 'Unknown album',
      artist: al.artist || '',
      year: al.year || '',
      thumbnail: al.thumbnail || '',
      addedAt: Date.now()
    });
    save();
    return true; // true => now liked
  }

  /* ---------- collections ---------- */
  function collections() { return data.collections; }
  function collection(id) {
    for (var i = 0; i < data.collections.length; i++) if (data.collections[i].id === id) return data.collections[i];
    return null;
  }
  function createCollection(name, type, color) {
    var col = {
      id: uid(),
      name: String(name || '').trim() || 'Untitled',
      type: type === 'genre' ? 'genre' : 'playlist',
      color: color && color.length === 2 ? color : PALETTE[hashStr(name || uid()) % PALETTE.length],
      trackIds: [],
      createdAt: Date.now()
    };
    data.collections.push(col);
    save();
    return col;
  }
  function updateCollection(id, patch) {
    var c = collection(id);
    if (!c) return null;
    for (var k in patch) {
      if (k === 'trackIds') continue; // use add/remove methods
      c[k] = patch[k];
    }
    save();
    return c;
  }
  function deleteCollection(id) {
    var i = data.collections.findIndex(function (c) { return c.id === id; });
    if (i !== -1) { data.collections.splice(i, 1); save(); }
  }
  function addToCollection(cid, videoId) {
    var c = collection(cid);
    if (!c || !videoId) return 'nope';
    if (c.trackIds.indexOf(videoId) !== -1) return 'exists';
    c.trackIds.push(videoId);
    save();
    return 'added';
  }
  // Batch version: adds many tracks with a single save. Per-item saves would
  // re-serialize the whole library once per track (a multi-second UI freeze on
  // large libraries — this is why playlist imports used to hang).
  function addManyToCollection(cid, videoIds) {
    var c = collection(cid);
    if (!c || !videoIds) return 0;
    var added = 0;
    var seen = {};
    c.trackIds.forEach(function (id) { seen[id] = true; });
    (videoIds || []).forEach(function (id) {
      if (!id || seen[id]) return;
      seen[id] = true;
      c.trackIds.push(id);
      added++;
    });
    if (added) save();
    return added;
  }
  function removeFromCollection(cid, videoId) {
    var c = collection(cid);
    if (!c) return;
    var i = c.trackIds.indexOf(videoId);
    if (i !== -1) { c.trackIds.splice(i, 1); save(); }
  }
  function inCollections(videoId) {
    return data.collections.filter(function (c) { return c.trackIds.indexOf(videoId) !== -1; });
  }

  /* ---------- settings ---------- */
  function getSettings() { return data.settings; }
  function setSettings(patch) {
    for (var k in patch) data.settings[k] = patch[k];
    save();
  }

  /* ---------- recent searches ---------- */
  function addRecentSearch(q) {
    q = String(q || '').trim();
    if (!q) return;
    var i = data.recentSearches.indexOf(q);
    if (i !== -1) data.recentSearches.splice(i, 1);
    data.recentSearches.unshift(q);
    if (data.recentSearches.length > 8) data.recentSearches.length = 8;
    save();
  }
  function recentSearches() { return data.recentSearches.slice(); }

  /* ---------- export / import / reset ---------- */
  function exportJSON() {
    return JSON.stringify({ app: 'MeatyBeatz', version: 1, exportedAt: new Date().toISOString(), data: data }, null, 2);
  }
  function importJSON(str) {
    try {
      var obj = JSON.parse(str);
      var d = obj && obj.data ? obj.data : obj;
      if (!d || typeof d !== 'object' || !('tracks' in d)) throw new Error('not a MeatyBeatz backup');
      data = load(); // reset to current shape first, then merge incoming
      for (var k in defaults()) {
        if (d[k] !== undefined && d[k] !== null) data[k] = d[k];
      }
      save();
      return true;
    } catch (e) {
      console.warn('MeatyBeatz: import failed', e);
      return false;
    }
  }
  function resetAll() {
    try { localStorage.removeItem(KEY); } catch (e) { /* noop */ }
    data = defaults();
    save(); // persist the wipe to IndexedDB and (if connected) the library file
  }

  window.Store = {
    get raw() { return data; },
    save: save,
    getTrack: getTrack,
    upsertTrack: upsertTrack,
    upsertMany: upsertMany,
    allTracks: allTracks,
    recentTracks: recentTracks,
    isLiked: isLiked,
    likedIds: likedIds,
    toggleLike: toggleLike,
    likedAlbums: likedAlbums,
    isLikedAlbum: isLikedAlbum,
    toggleLikedAlbum: toggleLikedAlbum,
    collections: collections,
    collection: collection,
    createCollection: createCollection,
    updateCollection: updateCollection,
    deleteCollection: deleteCollection,
    addToCollection: addToCollection,
    addManyToCollection: addManyToCollection,
    removeFromCollection: removeFromCollection,
    inCollections: inCollections,
    getSettings: getSettings,
    setSettings: setSettings,
    addRecentSearch: addRecentSearch,
    recentSearches: recentSearches,
    exportJSON: exportJSON,
    importJSON: importJSON,
    resetAll: resetAll,
    backupStatus: backupStatus,
    connectBackupFile: connectBackupFile,
    disconnectBackupFile: disconnectBackupFile,
    reauthorizeBackupFile: reauthorizeBackupFile,
    diskStatus: diskStatus,
    diskPing: diskPing,
    PALETTE: PALETTE
  };
})();
