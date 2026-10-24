/* MeatyBeatz — builtin.js : the "Built-in" extractor.
   Talks to YouTube directly, no community mirrors:
     1. Local proxy (http://127.0.0.1:8199, run `node local-proxy.js`) — most reliable.
     2. Public CORS relays that fetch YouTube's own pages (no key needed).
     3. oEmbed for single-video info (YouTube serves it with CORS enabled natively). */
(function () {
  'use strict';

  // Same host as this page, so the proxy also works when the app is opened over
  var PROXY = 'http://' + (location.hostname || 'localhost') + ':8199';
  var RELAYS = [
    function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
    function (u) { return 'https://corsproxy.io/?url=' + encodeURIComponent(u); }
  ];

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  async function pingProxy() {
    try {
      var r = await withTimeout(fetch(PROXY + '/ping', { method: 'GET' }), 2000);
      if (!r.ok) return false;
      var j = await r.json();
      return !!(j && j.ok);
    } catch (e) { return false; }
  }

  async function proxyJSON(path, timeoutMs) {
    var r = await withTimeout(fetch(PROXY + path), timeoutMs || 30000);
    if (!r.ok) {
      var msg = 'local proxy error';
      try { var j = await r.json(); if (j && j.error) msg = j.error; } catch (e) { /* keep default */ }
      throw new Error(msg + ' (HTTP ' + r.status + ')');
    }
    return r.json();
  }

  /* Pull the first balanced JSON object following `marker` out of raw HTML. */
  function extractJSON(html, marker) {
    var i = html.indexOf(marker);
    if (i === -1) return null;
    i = html.indexOf('{', i + marker.length);
    if (i === -1) return null;
    var depth = 0, inStr = false, esc = false;
    for (var p = i; p < html.length; p++) {
      var c = html[p];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(html.slice(i, p + 1)); } catch (e) { return null; }
          }
        }
      }
    }
    return null;
  }

  function textOf(node) {
    if (!node) return '';
    if (node.simpleText) return node.simpleText;
    if (node.runs && node.runs.length) return node.runs.map(function (r) { return r.text || ''; }).join('');
    return '';
  }

  function parseDur(s) {
    if (!s) return 0;
    var parts = String(s).trim().split(':').map(Number);
    if (parts.length < 2 || parts.some(isNaN)) return 0;
    return parts.reduce(function (acc, p) { return acc * 60 + p; }, 0);
  }

  function walk(o, key, out) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i], key, out); return; }
    if (o[key] && typeof o[key] === 'object' && !Array.isArray(o[key])) { out.push(o[key]); walk(o[key], key, out); }
    for (var k in o) walk(o[k], key, out);
  }

  function tracksFromVideoRenderers(data) {
    var found = [];
    walk(data, 'videoRenderer', found);
    var seen = {}, out = [];
    for (var i = 0; i < found.length; i++) {
      var v = found[i];
      if (!v.videoId || seen[v.videoId]) continue;
      seen[v.videoId] = true;
      out.push({
        videoId: v.videoId,
        title: textOf(v.title) || 'Untitled',
        artist: textOf(v.ownerText) || 'Unknown artist',
        duration: parseDur(v.lengthText && v.lengthText.simpleText)
      });
    }
    return out;
  }

  /* Fetch a YouTube page's HTML through the relays, in order. */
  async function fetchPageViaRelays(pageUrl) {
    var lastErr = null;
    for (var i = 0; i < RELAYS.length; i++) {
      try {
        var r = await withTimeout(fetch(RELAYS[i](pageUrl), { headers: { 'Accept': 'text/html' } }), 9000);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var html = await r.text();
        if (html && html.length > 5000) return html; // a real page, not an error stub
      } catch (e) { lastErr = e; }
    }
    throw new Error('public relays unreachable' + (lastErr ? ' (' + lastErr.message + ')' : ''));
  }

  /* ---------- public API ---------- */
  async function search(q, limit) {
    if (await pingProxy()) {
      var j = await proxyJSON('/search?q=' + encodeURIComponent(q) + '&limit=' + (limit || 30), 25000);
      if (!j || !Array.isArray(j.results)) throw new Error('bad proxy response');
      return { results: j.results, artists: j.artists || [], albums: j.albums || [] };
    }
    var html = await fetchPageViaRelays('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&hl=en');
    var data = extractJSON(html, 'ytInitialData');
    if (!data) throw new Error('could not parse YouTube search page (consent wall?)');
    var results = tracksFromVideoRenderers(data);
    if (!results.length) throw new Error('no results parsed from YouTube search page');
    return { results: results.slice(0, limit || 30), artists: [], albums: [] };
  }

  /* Artist page (UC… browseId). Needs the local proxy — InnerTube is a POST API. */
  async function artist(browseId) {
    if (!(await pingProxy())) throw new Error('artist pages need the local proxy — run `node local-proxy.js`');
    var j = await proxyJSON('/artist?id=' + encodeURIComponent(browseId), 30000);
    if (!j || !Array.isArray(j.sections)) throw new Error('bad proxy response');
    return j;
  }

  /* Album page (MPREb_… browseId) with its full tracklist. Needs the local proxy. */
  async function album(browseId) {
    if (!(await pingProxy())) throw new Error('album pages need the local proxy — run `node local-proxy.js`');
    var j = await proxyJSON('/album?id=' + encodeURIComponent(browseId), 30000);
    if (!j || !Array.isArray(j.tracks)) throw new Error('bad proxy response');
    return j;
  }

  async function videoInfo(videoId) {
    if (await pingProxy()) {
      var j = await proxyJSON('/video?id=' + encodeURIComponent(videoId), 20000);
      if (j && j.videoId) return j;
      throw new Error('bad proxy response');
    }
    try {
      var html = await fetchPageViaRelays('https://www.youtube.com/watch?v=' + videoId + '&hl=en');
      var pr = extractJSON(html, 'ytInitialPlayerResponse');
      var d = pr && pr.videoDetails;
      if (d && d.videoId) {
        return { videoId: videoId, title: d.title || 'Untitled', artist: d.author || 'Unknown artist', duration: Number(d.lengthSeconds) || 0 };
      }
    } catch (e) { /* fall through to oEmbed */ }
    // Last resort: YouTube's oEmbed endpoint is CORS-enabled natively.
    var r = await withTimeout(fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json'), 8000);
    if (!r.ok) throw new Error('could not fetch video info');
    var o = await r.json();
    return { videoId: videoId, title: o.title || 'Untitled', artist: o.author_name || 'Unknown artist', duration: 0 };
  }

  /* knownName: the chip's display title — browse ids (VLPL…/VLRD…) have no
     name in the API response, so the caller passes the one it already shows. */
  async function playlist(listId, knownName) {
    var url = '/playlist?list=' + encodeURIComponent(listId);
    if (knownName) url += '&title=' + encodeURIComponent(knownName);
    if (await pingProxy()) {
      var j = await proxyJSON(url, 120000);
      if (j && Array.isArray(j.tracks)) return { name: j.name || 'Imported playlist', tracks: j.tracks };
      throw new Error('bad proxy response');
    }
    var html = await fetchPageViaRelays('https://www.youtube.com/playlist?list=' + listId + '&hl=en');
    var data = extractJSON(html, 'ytInitialData');
    if (!data) throw new Error('could not parse the playlist page');
    var name = 'Imported playlist';
    var ph = [];
    walk(data, 'pageHeaderViewModel', ph);
    if (ph[0] && ph[0].title) {
      var t = ph[0].title;
      name = t.content || (t.dynamicTextViewModel && t.dynamicTextViewModel.text && t.dynamicTextViewModel.text.content) || name;
    }
    var seen = {}, tracks = [];
    function add(v) {
      if (!v || !v.videoId || seen[v.videoId]) return;
      seen[v.videoId] = true;
      tracks.push({ videoId: v.videoId, title: textOf(v.title) || 'Untitled', artist: textOf(v.ownerText) || 'Unknown artist', duration: parseDur(v.lengthText && v.lengthText.simpleText) });
    }
    var locks = [];
    walk(data, 'lockupViewModel', locks);
    for (var i = 0; i < locks.length; i++) {
      var L = locks[i];
      if (!L.contentId) continue;
      var title = '';
      var md = L.metadata && L.metadata.lockupMetadataViewModel;
      if (md && md.title) title = md.title.content || '';
      tracks.push({ videoId: L.contentId, title: title || 'Untitled', artist: 'Unknown artist', duration: 0 });
    }
    var legacy = [];
    walk(data, 'playlistVideoRenderer', legacy);
    for (var k = 0; k < legacy.length; k++) add(legacy[k]);
    if (!tracks.length) throw new Error('playlist is empty or unavailable');
    return { name: name, tracks: tracks };
  }

  window.BuiltIn = {
    search: search,
    videoInfo: videoInfo,
    playlist: playlist,
    artist: artist,
    album: album,
    pingProxy: pingProxy,
    PROXY: PROXY
  };
})();
