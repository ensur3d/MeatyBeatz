/* MeatyBeatz — search.js : free YouTube search.
   Primary source: the local Invidious instance running in docker on this
   machine (<this host>:3010) — the same instance that serves playback streams.
   Falls back to the built-in route (local proxy / CORS relays). Users can
   still add their own instances (Invidious or Piped) in Settings; the Piped
   code path stays for user-added forks/endpoints. */
(function () {
  'use strict';

  /* Local Invidious — resolved live so a change in Settings → "Invidious
     instance" applies without editing code. Default: the bundled instance on
     THIS host, port 3010 (derived from the address the app was opened with,
     so LAN access works with zero configuration; falls back to localhost). */
  function localBase() {
    try {
      var s = window.Store && Store.getSettings().invidiousUrl;
      // Only accept values that look like URLs (mirrors youtube.js invBase) so a
      // garbage stored value can never be used as a fetch base.
      if (s && /^https?:\/\//i.test(String(s).trim())) return String(s).trim().replace(/\/+$/, '');
    } catch (e) { /* settings unavailable — use default */ }
    var h = '';
    try { h = location.hostname; } catch (e2) { /* no location — use fallback */ }
    return 'http://' + (h || 'localhost') + ':3010';
  }

  var TIMEOUT_MS = 7000;

  function instances() {
    var custom = (window.Store && Store.getSettings().customInstances) || [];
    return custom.concat([{ name: 'Local Invidious', base: localBase(), kind: 'invidious' }]);
  }

  function detectKind(url) {
    return /piped/i.test(url) ? 'piped' : 'invidious';
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  async function fetchJSON(inst, path) {
    return withTimeout(fetch(inst.base + path, { headers: { 'Accept': 'application/json' } }), TIMEOUT_MS).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function normResult(it) {
    var id = it.videoId || it.id;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    var title = it.title || 'Untitled';
    var artist = it.author || it.uploaderName || 'Unknown artist';
    var dur = Number(it.lengthSeconds != null ? it.lengthSeconds : it.duration) || 0;
    return { videoId: id, title: title, artist: artist, duration: dur };
  }

  /* ---------- adapters ---------- */
  async function invidiousSearch(inst, q) {
    var data = await fetchJSON(inst, '/api/v1/search?q=' + encodeURIComponent(q) + '&type=video');
    if (!Array.isArray(data)) throw new Error('bad response');
    return data.map(normResult).filter(Boolean);
  }

  async function pipedSearch(inst, q) {
    var data = await fetchJSON(inst, '/search?q=' + encodeURIComponent(q));
    var items = (data && data.items) || [];
    return items.filter(function (it) { return it.type === 'stream' && it.url; }).map(function (it) {
      var m = String(it.url).match(/[?&]v=([A-Za-z0-9_-]{11})/);
      if (!m) return null;
      return { videoId: m[1], title: it.title || 'Untitled', artist: it.uploaderName || 'Unknown artist', duration: Number(it.duration) || 0 };
    }).filter(Boolean);
  }

  async function searchWith(inst, q, limit) {
    var fn = inst.kind === 'piped' ? pipedSearch : invidiousSearch;
    var res = await fn(inst, q);
    // de-dupe by videoId, keep order, drop near-empty entries
    var seen = {};
    var out = [];
    for (var i = 0; i < res.length && out.length < (limit || 30); i++) {
      var r = res[i];
      if (!r.videoId || seen[r.videoId]) continue;
      seen[r.videoId] = true;
      out.push(r);
    }
    return out;
  }

  /* ---------- extractor modes ----------
     auto      : local Invidious provides the songs; built-in enriches with artist/album cards
     builtin   : YouTube direct only (local proxy / public relays / oEmbed)
     invidious : local Invidious only */
  function extractorMode() {
    var m = (window.Store && Store.getSettings().extractor) || 'auto';
    return m === 'builtin' ? 'builtin' : m === 'invidious' ? 'invidious' : 'auto';
  }

  /* Resolve with the first promise that succeeds; reject only when both fail. */
  function race(a, b, labelA, labelB) {
    return new Promise(function (resolve, reject) {
      var done = false, pending = 2, errs = {};
      function settle(ok, value, err, label) {
        if (done) return;
        if (ok) { done = true; resolve(value); return; }
        errs[label] = (err && err.message) ? err.message : String(err);
        if (--pending === 0) {
          done = true;
          reject(new Error(labelA + ': ' + errs[labelA] + ' — ' + labelB + ': ' + errs[labelB]));
        }
      }
      Promise.resolve(a).then(function (v) { settle(true, v, null, labelA); }, function (e) { settle(false, null, e, labelA); });
      Promise.resolve(b).then(function (v) { settle(true, v, null, labelB); }, function (e) { settle(false, null, e, labelB); });
    });
  }

  async function builtinSearch(q, limit) {
    if (!window.BuiltIn) throw new Error('built-in extractor not loaded');
    return window.BuiltIn.search(q, limit);
  }

  /* ---------- public API ---------- */
  async function search(q, limit) {
    if (!q) throw new Error('Empty query');
    var m = extractorMode();
    if (m === 'invidious') {
      var r1 = await invidiousChain(q, limit);
      return { results: r1.results, artists: [], albums: [], instance: r1.instance };
    }
    if (m === 'builtin') {
      var r2 = await builtinSearch(q, limit);
      return { results: r2.results || r2, artists: r2.artists || [], albums: r2.albums || [], instance: 'Built-in (YouTube direct)' };
    }
    // auto: local Invidious is the primary song source; the built-in route
    // enriches the same result set with artist + album cards. Both run in
    // parallel, so the slower one only adds a little wait.
    var ivP = invidiousChain(q, limit).then(function (r) { return { results: r.results, instance: r.instance }; });
    var biP = builtinSearch(q, limit).then(function (r) { return { results: r.results || r, artists: r.artists || [], albums: r.albums || [] }; });

    var iv = null;
    try { iv = await withTimeout(ivP, 9000); } catch (e) { console.warn('MeatyBeatz: local Invidious search failed:', e && e.message); }

    if (iv && iv.results.length) {
      var bi = null;
      try { bi = await withTimeout(biP, 6000); } catch (e) { /* enrichment unavailable — songs are fine */ }
      return {
        results: mergeSongs(iv.results, bi ? bi.results : []),
        artists: (bi && bi.artists) || [],
        albums: (bi && bi.albums) || [],
        instance: iv.instance + ((bi && (bi.artists.length || bi.albums.length)) ? ' + Built-in' : '')
      };
    }

    // Invidious failed — fall back to the built-in route on its own.
    var bi2 = null;
    try { bi2 = await withTimeout(biP, 15000); } catch (e) { /* both down */ }
    if (bi2 && bi2.results.length) {
      return { results: bi2.results, artists: bi2.artists || [], albums: bi2.albums || [], instance: 'Built-in (YouTube direct)' };
    }
    throw new Error('search failed — local Invidious and the built-in route are both unavailable');
  }

  /* Invidious songs first, then any built-only ones; de-duped by videoId. */
  function mergeSongs(primary, extra) {
    var seen = {};
    var out = [];
    [primary, extra].forEach(function (list) {
      (list || []).forEach(function (r) {
        if (!r || !r.videoId || seen[r.videoId]) return;
        seen[r.videoId] = true;
        out.push(r);
      });
    });
    return out.slice(0, 30);
  }

  /* Artist page with albums / videos / playlists. Built-in only (local proxy). */
  async function artist(browseId) {
    if (extractorMode() === 'invidious') throw new Error('Artist pages need the built-in extractor (local proxy)');
    return window.BuiltIn.artist(browseId);
  }

  /* Album page with its full tracklist. Built-in only (local proxy). */
  async function album(browseId) {
    if (extractorMode() === 'invidious') throw new Error('Album pages need the built-in extractor (local proxy)');
    return window.BuiltIn.album(browseId);
  }

  /* metadata for a single video id (used when adding by link) */
  async function getVideoInfo(videoId) {
    var m = extractorMode();
    if (m === 'invidious') return invidiousVideoInfo(videoId);
    if (m === 'builtin') return window.BuiltIn.videoInfo(videoId);
    return race(window.BuiltIn.videoInfo(videoId), invidiousVideoInfo(videoId), 'Built-in', 'Invidious');
  }

  /* import a full YouTube playlist by list id (or artist-page browse id).
     knownName: optional display title for browse ids, which carry no name. */
  async function importPlaylist(playlistId, knownName) {
    var m = extractorMode();
    if (m === 'invidious') return invidiousPlaylist(playlistId);
    if (m === 'builtin') return window.BuiltIn.playlist(playlistId, knownName);
    // Music browse ids (VLPL…/VLRD…) only work through the built-in InnerTube
    // path — Invidious's /api/v1/playlist rejects them on every instance.
    // Routing them straight to Built-in skips a doomed mirror race (faster,
    // and a clearer error if the local proxy is down).
    if (/^VL[PR]/i.test(String(playlistId).trim())) return window.BuiltIn.playlist(playlistId, knownName);
    return race(window.BuiltIn.playlist(playlistId, knownName), invidiousPlaylist(playlistId), 'Built-in', 'Invidious');
  }

  /* ---------- Invidious / Piped mirror chain ---------- */
  async function invidiousChain(q, limit) {
    var list = instances();
    if (!list.length) throw new Error('No search instances configured');
    var offset = (window.Store ? Store.getSettings().instanceOffset : 0) || 0;
    var lastErr = null;

    for (var i = 0; i < list.length; i++) {
      var idx = (offset + i) % list.length;
      var inst = list[idx];
      try {
        var results = await searchWith(inst, q, limit);
        if (!results.length) throw new Error('empty result');
        Store.setSettings({ instanceOffset: idx });
        return { results: results, instance: inst.name };
      } catch (e) {
        lastErr = e;
        console.warn('MeatyBeatz: instance ' + inst.name + ' failed:', e && e.message);
      }
    }
    throw new Error('all mirrors failed (' + (lastErr && lastErr.message) + ')');
  }

  /* metadata for a single video id via mirrors (graceful fallback) */
  async function invidiousVideoInfo(videoId) {
    var list = instances();
    var offset = (window.Store ? Store.getSettings().instanceOffset : 0) || 0;
    for (var i = 0; i < list.length; i++) {
      var idx = (offset + i) % list.length;
      var inst = list[idx];
      try {
        if (inst.kind === 'piped') {
          var d1 = await fetchJSON(inst, '/streams/' + videoId);
          if (d1 && d1.title) return { videoId: videoId, title: d1.title, artist: d1.uploader || 'Unknown artist', duration: Number(d1.duration) || 0 };
        } else {
          var d2 = await fetchJSON(inst, '/api/v1/videos/' + videoId);
          if (d2 && d2.title) return { videoId: videoId, title: d2.title, artist: d2.author || 'Unknown artist', duration: Number(d2.lengthSeconds) || 0 };
        }
      } catch (e) { /* try next */ }
    }
    // graceful fallback — the player will still work
    return { videoId: videoId, title: 'YouTube video', artist: 'Unknown artist', duration: 0 };
  }

  /* import a full YouTube playlist by list id via mirrors */
  async function invidiousPlaylist(playlistId) {
    var list = instances();
    var offset = (window.Store ? Store.getSettings().instanceOffset : 0) || 0;
    for (var i = 0; i < list.length; i++) {
      var idx = (offset + i) % list.length;
      var inst = list[idx];
      try {
        if (inst.kind === 'piped') {
          var d1 = await fetchJSON(inst, '/playlist/' + encodeURIComponent(playlistId));
          var items = (d1 && d1.items) || [];
          var tracks = items.filter(function (it) { return it.type === 'stream' && it.url; }).map(function (it) {
            var m = String(it.url).match(/[?&]v=([A-Za-z0-9_-]{11})/);
            if (!m) return null;
            return { videoId: m[1], title: it.title || 'Untitled', artist: it.uploaderName || 'Unknown artist', duration: Number(it.duration) || 0 };
          }).filter(Boolean);
          if (tracks.length) return { name: d1.name || 'Imported playlist', tracks: tracks };
        } else {
          var d2 = await fetchJSON(inst, '/api/v1/playlist?list=' + encodeURIComponent(playlistId));
          var vids = (d2 && d2.videos) || [];
          var t2 = vids.map(normResult).filter(Boolean);
          if (t2.length) return { name: d2.title || 'Imported playlist', tracks: t2 };
        }
      } catch (e) { /* try next */ }
    }
    throw new Error('Could not fetch that playlist from any instance.');
  }

  /* lightweight health ping for Settings */
  async function ping(instIndex) {
    var inst = instances()[instIndex];
    if (!inst) return { ok: false, ms: 0 };
    var t0 = performance.now();
    try {
      await searchWith(inst, 'test', 1);
      return { ok: true, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, ms: Math.round(performance.now() - t0) };
    }
  }

  window.Search = {
    search: search,
    artist: artist,
    album: album,
    getVideoInfo: getVideoInfo,
    importPlaylist: importPlaylist,
    ping: ping,
    instances: instances,
    detectKind: detectKind,
    localBase: localBase
  };
})();
