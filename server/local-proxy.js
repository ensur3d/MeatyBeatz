#!/usr/bin/env node
/* MeatyBeatz — local search proxy (optional companion).
   Zero dependencies. Run:  node local-proxy.js
   Listens on http://127.0.0.1:8199 so the app can talk to YouTube directly —
   no community mirrors, no API keys, no login:
     GET /ping                   -> {ok:true}
     GET /search?q=...&limit=N   -> {results:[{videoId,title,artist,duration}]}
      GET /artist?id=UC...        -> {name,subtitle,thumbnail,sections:[{title,kind,items|tracks}]}
      GET /album?id=MPREb_...     -> {title,subtitle,thumbnail,artist,tracks:[...]}
     GET /video?id=VIDEO_ID      -> {videoId,title,artist,duration}
     GET /playlist?list=LIST_ID  -> {name,tracks:[{videoId,title,artist,duration}]}
       (also accepts music browse ids VLPL…/VLRD… from artist-page playlist chips)
   The app detects this proxy automatically (Settings shows its status). */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const HOST = process.env.MEATYBEATZ_PROXY_HOST || '127.0.0.1';
const PORT = Number(process.env.MEATYBEATZ_PROXY_PORT) || 8199;
const CLIENT = { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en' };
/* The music.youtube.com client — returns artist/album/song renderers without login. */
const REMIX = { clientName: 'WEB_REMIX', clientVersion: '1.20250101.00.00', hl: 'en' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------- low-level HTTP ---------- */
function httpsReq(method, host, path, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: host,
      path: path,
      method: method,
      headers: Object.assign(
        { 'User-Agent': UA, 'Accept': 'application/json, text/html;q=0.9' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      )
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.setTimeout(timeoutMs, function () { req.destroy(new Error('timeout after ' + timeoutMs + ' ms')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* YouTube's public web API (InnerTube) — the same one the website itself uses. */
async function innerTube(endpoint, body, client) {
  const payload = Object.assign({}, body, { context: { client: client || CLIENT } });
  const r = await httpsReq('POST', 'www.youtube.com', '/youtubei/v1/' + endpoint + '?prettyPrint=false', payload, 15000);
  if (r.status !== 200) throw new Error('YouTube HTTP ' + r.status);
  return JSON.parse(r.body);
}

/* ---------- helpers ---------- */
function parseDur(s) {
  if (!s) return 0;
  const parts = String(s).trim().split(':').map(Number);
  if (parts.length < 2 || parts.some(isNaN)) return 0;
  return parts.reduce(function (acc, p) { return acc * 60 + p; }, 0);
}

function textOf(node) {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  if (node.runs && node.runs.length) return node.runs.map(function (r) { return r.text || ''; }).join('');
  return '';
}

/* Collect every object in the tree that has a key named `key` (descends into matches too). */
function walk(o, key, out) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) {
    for (let i = 0; i < o.length; i++) walk(o[i], key, out);
    return;
  }
  if (o[key] && typeof o[key] === 'object' && !Array.isArray(o[key])) {
    out.push(o[key]);
    walk(o[key], key, out);
  }
  for (const k in o) walk(o[k], key, out);
}

/* Find the first long continuation token in document order. */
function findToken(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.token === 'string' && o.token.length > 40) return o.token;
  if (Array.isArray(o)) {
    for (let i = 0; i < o.length; i++) { const t = findToken(o[i]); if (t) return t; }
    return null;
  }
  for (const k in o) { const t = findToken(o[k]); if (t) return t; }
  return null;
}

/* Pull the first balanced JSON object following `marker` out of raw HTML. */
function extractJSON(html, marker) {
  let i = html.indexOf(marker);
  if (i === -1) return null;
  i = html.indexOf('{', i + marker.length);
  if (i === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = i; p < html.length; p++) {
    const c = html[p];
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

/* ---------- endpoints ---------- */
async function doSearch(q, limit) {
  const data = await innerTube('search', { context: { client: CLIENT }, query: q });
  const found = [];
  walk(data, 'videoRenderer', found);
  const seen = new Set();
  const results = [];
  for (const v of found) {
    if (!v.videoId || seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    results.push({
      videoId: v.videoId,
      title: textOf(v.title) || 'Untitled',
      artist: textOf(v.ownerText) || 'Unknown artist',
      duration: parseDur(v.lengthText && v.lengthText.simpleText)
    });
    if (results.length >= limit) break;
  }
  return results;
}

/* ---------- music data (artists / albums / tracklists) ---------- */

/* Largest URL out of a thumbnailRenderer / musicThumbnailRenderer node. */
function thumbOf(node) {
  const m = node && (node.musicThumbnailRenderer || node.thumbnailRenderer || node);
  const ts = m && m.thumbnail && m.thumbnail.thumbnails;
  if (!ts || !ts.length) return '';
  return ts[ts.length - 1].url;
}

/* One musicResponsiveListItemRenderer row -> track. Used by search + album pages. */
function musicRowToTrack(row, defaultArtist) {
  let title = '', videoId = null, dur = 0;
  const fcs = (row && row.flexColumns) || [];
  for (const fc of fcs) {
    const c = fc.musicResponsiveListItemFlexColumnRenderer;
    if (!c || !c.text) continue;
    const t = textOf(c.text);
    if (t && !title) title = t;
    // search rows carry the duration as "Song • 5:55" in a flex column
    const m = t.match(/(\d+:\d\d)$/);
    if (m && !dur) dur = parseDur(m[1]);
    const run = c.text.runs && c.text.runs[0];
    if (run && run.navigationEndpoint && run.navigationEndpoint.watchEndpoint) {
      videoId = run.navigationEndpoint.watchEndpoint.videoId;
    }
  }
  if (!videoId) {
    const pb = row.overlay && row.overlay.musicItemThumbnailOverlayRenderer &&
      row.overlay.musicItemThumbnailOverlayRenderer.content &&
      row.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer;
    if (pb && pb.playNavigationEndpoint && pb.playNavigationEndpoint.watchEndpoint) {
      videoId = pb.playNavigationEndpoint.watchEndpoint.videoId;
    }
  }
  for (const fc of (row && row.fixedColumns) || []) {
    const c = fc.musicResponsiveListItemFixedColumnRenderer;
    if (!c || !c.text) continue;
    const t = textOf(c.text);
    if (/^\d+:\d\d$/.test(t)) dur = parseDur(t);
  }
  let artist = '';
  if (row.subtitles && row.subtitles.parts) {
    artist = row.subtitles.parts.map(function (p) { return p.text || ''; }).join('');
  }
  // "4.3M plays" is not an artist — fall back to the provided name instead
  if (!artist || /plays?$/i.test(artist)) artist = defaultArtist || 'Unknown artist';
  if (!videoId || !title) return null;
  return { videoId: videoId, title: title, artist: artist, duration: dur };
}

/* music.youtube.com search -> songs + top artists (no login needed). */
async function doMusicSearch(q, limit) {
  // Music client for ordering/artists; plain web client in parallel to enrich
  // each song with its artist name and exact duration.
  const [data, web] = await Promise.all([
    innerTube('search', { query: q }, REMIX),
    innerTube('search', { query: q }, CLIENT).catch(function () { return null; })
  ]);
  const enrich = {};
  if (web) {
    const vids = [];
    walk(web, 'videoRenderer', vids);
    for (const v of vids) {
      if (!v.videoId || enrich[v.videoId]) continue;
      enrich[v.videoId] = {
        title: textOf(v.title),
        artist: textOf(v.ownerText) || '',
        duration: parseDur(v.lengthText && v.lengthText.simpleText)
      };
    }
  }
  const rows = [];
  walk(data, 'musicResponsiveListItemRenderer', rows);
  const seen = {};
  const results = [];
  const albums = [];
  const albumSeen = {};
  for (const row of rows) {
    // Music search mixes song rows with album rows — "Album • Queen • 1981"
    const f1c = row.flexColumns && row.flexColumns[1] && row.flexColumns[1].musicResponsiveListItemFlexColumnRenderer;
    const f1 = f1c && f1c.text ? textOf(f1c.text) : '';
    if (/^album/i.test(f1)) {
      const be = row.navigationEndpoint && row.navigationEndpoint.browseEndpoint;
      if (!be || !be.browseId || albumSeen[be.browseId]) continue;
      const parts = f1.split('•').map(function (s) { return s.trim(); });
      albumSeen[be.browseId] = true;
      albums.push({
        title: textOf(row.flexColumns && row.flexColumns[0] && row.flexColumns[0].musicResponsiveListItemFlexColumnRenderer && row.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text),
        artist: parts[1] || '',
        year: parts[2] || '',
        browseId: be.browseId,
        thumbnail: thumbOf(row.thumbnail)
      });
      continue;
    }
    const t = musicRowToTrack(row);
    if (!t || seen[t.videoId]) continue;
    const e = enrich[t.videoId];
    if (e) {
      if (e.artist) t.artist = e.artist;
      if (!t.duration && e.duration) t.duration = e.duration;
    }
    seen[t.videoId] = true;
    results.push(t);
  }
  // Fill the list with web-search-only videos (they carry artist names).
  for (const vid of Object.keys(enrich)) {
    if (results.length >= limit) break;
    if (seen[vid]) continue;
    const e = enrich[vid];
    if (!e.title) continue;
    seen[vid] = true;
    results.push({ videoId: vid, title: e.title, artist: e.artist || 'Unknown artist', duration: e.duration });
  }
  const artists = [];
  const cards = [];
  walk(data, 'musicCardShelfRenderer', cards);
  for (const c of cards) {
    const run = c.title && c.title.runs && c.title.runs[0];
    const be = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
    if (!be || !be.browseId) continue;
    artists.push({
      name: textOf(c.title),
      browseId: be.browseId,
      subtitle: textOf(c.subtitle),
      thumbnail: thumbOf(c.thumbnail)
    });
  }
  return { results: results, artists: artists, albums: albums };
}

/* One musicTwoRowItemRenderer (album / single / video / playlist / artist card). */
function twoRowToItem(it) {
  const be = it.navigationEndpoint && it.navigationEndpoint.browseEndpoint;
  let id = be ? be.browseId : null;
  let type = 'link';
  if (be) {
    const cfg = be.browseEndpointContextSupportedConfigs && be.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig;
    const pt = cfg && cfg.pageType;
    if (pt === 'MUSIC_PAGE_TYPE_ALBUM') type = 'album';
    else if (pt === 'MUSIC_PAGE_TYPE_ARTIST') type = 'artist';
    else if (pt === 'MUSIC_PAGE_TYPE_PLAYLIST') type = 'playlist';
  }
  if (!id) {
    const pb = it.thumbnailOverlay && it.thumbnailOverlay.musicItemThumbnailOverlayRenderer &&
      it.thumbnailOverlay.musicItemThumbnailOverlayRenderer.content &&
      it.thumbnailOverlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer;
    if (pb && pb.playNavigationEndpoint && pb.playNavigationEndpoint.watchEndpoint) {
      id = pb.playNavigationEndpoint.watchEndpoint.videoId;
      type = 'video';
    }
  }
  if (!id) return null;
  return {
    type: type,
    id: id,
    title: textOf(it.title),
    subtitle: textOf(it.subtitle),
    thumbnail: thumbOf(it.thumbnailRenderer || it.thumbnail)
  };
}

/* Artist page (UC… browseId) -> header + sections of albums/videos/playlists. */
async function doArtist(browseId) {
  const data = await innerTube('browse', { browseId: browseId }, REMIX);
  let name = '', subtitle = '', thumbnail = '';
  const hdrs = [];
  walk(data, 'musicImmersiveHeaderRenderer', hdrs);
  if (hdrs[0]) {
    name = textOf(hdrs[0].title) || browseId;
    thumbnail = thumbOf(hdrs[0].thumbnail);
    subtitle = textOf(hdrs[0].monthlyListenerCount) || '';
  }
  const sections = [];

  // "Top songs" shelf (musicShelfRenderer with list rows)
  const shelves = [];
  walk(data, 'musicShelfRenderer', shelves);
  for (const sh of shelves) {
    const rows = [];
    walk(sh, 'musicResponsiveListItemRenderer', rows);
    if (!rows.length) continue;
    const tracks = rows.map(function (r) { return musicRowToTrack(r, name); }).filter(Boolean);
    if (tracks.length) sections.unshift({ title: 'Top songs', kind: 'songs', tracks: tracks });
  }

  // Carousels: Albums, Singles & EPs, Videos, Live performances, Playlists…
  const cars = [];
  walk(data, 'musicCarouselShelfRenderer', cars);
  for (const c of cars) {
    const hdr = c.header && c.header.musicCarouselShelfBasicHeaderRenderer;
    const title = textOf(hdr && hdr.title);
    if (!title) continue;
    const items = [];
    walk(c, 'musicTwoRowItemRenderer', items);
    const mapped = items.map(twoRowToItem).filter(Boolean);
    if (!mapped.length) continue;
    let kind = 'mixed';
    const types = {};
    mapped.forEach(function (m) { types[m.type] = true; });
    if (types.album && Object.keys(types).length === 1) kind = 'albums';
    else if (types.video && Object.keys(types).length === 1) kind = 'videos';
    else if (types.playlist && Object.keys(types).length === 1) kind = 'playlists';
    else if (types.artist && Object.keys(types).length === 1) kind = 'artists';
    sections.push({ title: title, kind: kind, items: mapped });
  }
  return { name: name, subtitle: subtitle, thumbnail: thumbnail, sections: sections };
}

/* Album page (MPREb_… browseId) -> header + full tracklist. */
async function doAlbum(browseId) {
  let node = await innerTube('browse', { browseId: browseId }, REMIX);
  let title = '', subtitle = '', thumbnail = '', artist = '';
  const hdrs = [];
  walk(node, 'musicResponsiveHeaderRenderer', hdrs);
  if (hdrs[0]) {
    title = textOf(hdrs[0].title) || 'Album';
    subtitle = textOf(hdrs[0].subtitle);
    thumbnail = thumbOf(hdrs[0].thumbnail);
    artist = textOf(hdrs[0].straplineTextOne) || '';
  }
  const seen = {};
  const tracks = [];
  for (let page = 0; page < 30; page++) {
    // find the shelf that holds list rows and its own continuation token
    let shelfToken = null;
    const shelves = [];
    walk(node, 'musicShelfRenderer', shelves);
    let added = 0;
    for (const sh of shelves) {
      const rows = [];
      walk(sh, 'musicResponsiveListItemRenderer', rows);
      if (!rows.length) continue;
      for (const row of rows) {
        const t = musicRowToTrack(row, artist || null);
        if (!t || seen[t.videoId]) continue;
        seen[t.videoId] = true;
        tracks.push(t);
        added++;
      }
      const ce = sh.continuation && sh.continuation.continuationEndpoint;
      if (ce && ce.continuation) shelfToken = ce.continuation;
    }
    if (!added || !tracks.length) break;
    if (!shelfToken) break;
    node = await innerTube('browse', { continuation: shelfToken }, REMIX);
  }
  if (!tracks.length) throw new Error('No tracks found for this album');
  return { title: title, subtitle: subtitle, thumbnail: thumbnail, artist: artist, tracks: tracks };
}

async function doVideo(id) {
  try {
    const data = await innerTube('player', { context: { client: CLIENT }, videoId: id });
    const d = data.videoDetails || {};
    if (d.videoId) {
      return { videoId: id, title: d.title || 'Untitled', artist: d.author || 'Unknown artist', duration: Number(d.lengthSeconds) || 0 };
    }
  } catch (e) { /* fall through to oEmbed */ }
  const r = await httpsReq('GET', 'www.youtube.com', '/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json', null, 10000);
  if (r.status !== 200) throw new Error('Could not fetch video info (HTTP ' + r.status + ')');
  const d = JSON.parse(r.body);
  return { videoId: id, title: d.title || 'Untitled', artist: d.author_name || 'Unknown artist', duration: 0 };
}

/* Map one track out of a playlist item (new "lockupViewModel" or legacy renderer). */
function trackFromItem(v) {
  if (!v) return null;
  let id = v.videoId || v.contentId;
  let title = '';
  if (v.title && v.title.runs) title = v.title.runs.map(function (r) { return r.text || ''; }).join('');
  else if (v.title && v.title.simpleText) title = v.title.simpleText;
  if (!id && !title) return null;
  const artist = textOf(v.ownerText) || 'Unknown artist';
  const dur = parseDur(v.lengthText && v.lengthText.simpleText);
  if (!id) return null;
  return { videoId: id, title: title || 'Untitled', artist: artist, duration: dur };
}

/* Fetch full metadata for a batch of tracks via the player endpoint (concurrency-limited). */
async function enrich(tracks, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < tracks.length) {
      const i = idx++;
      try {
        const d = await doVideo(tracks[i].videoId);
        if (d.title && d.title !== 'Untitled') tracks[i].title = d.title;
        if (d.artist && d.artist !== 'Unknown artist') tracks[i].artist = d.artist;
        if (d.duration > 0) tracks[i].duration = d.duration;
      } catch (e) { /* keep what we have */ }
    }
  }
  const n = Math.min(concurrency || 6, tracks.length);
  await Promise.all(Array.from({ length: n }, worker));
}

/* Music browse ids (VLPL…/VLRD…) — the playlist chips on artist pages are
   browse endpoints, not list= ids. Fetch them via InnerTube browse, the same
   way albums are fetched: tracks sit in musicPlaylistShelfRenderer rows. */
async function doMusicPlaylistBrowse(browseId, cap, fallbackName) {
  let node = await innerTube('browse', { browseId: browseId }, REMIX);
  // The browse response carries no playlist title — use the caller-supplied
  // name (the artist-page chip already shows it) when present.
  let name = String(fallbackName || '').trim() || 'Imported playlist';
  const seen = {};
  const tracks = [];
  for (let page = 0; page < 15; page++) {
    const shelves = [];
    walk(node, 'musicPlaylistShelfRenderer', shelves);
    let added = 0;
    for (const sh of shelves) {
      const rows = [];
      walk(sh, 'musicResponsiveListItemRenderer', rows);
      for (const row of rows) {
        const t = musicRowToTrack(row, null);
        if (!t || seen[t.videoId]) continue;
        seen[t.videoId] = true;
        tracks.push(t);
        added++;
      }
    }
    if (!added || !tracks.length) break;
    // Defensive continuation: current responses carry no token, but long
    // playlists may paginate — follow it exactly like doAlbum does.
    let shelfToken = null;
    for (const sh of shelves) {
      const ce = sh.continuation && sh.continuation.continuationEndpoint;
      if (ce && ce.token) shelfToken = ce.token;
    }
    if (!shelfToken) break;
    node = await innerTube('browse', { continuation: shelfToken }, REMIX);
    if (tracks.length >= cap) break;
  }
  if (!tracks.length) throw new Error('Playlist is empty or unavailable');
  tracks.length = Math.min(tracks.length, cap);
  return { name: name, tracks: tracks };
}

async function doPlaylist(listId, maxTracks, knownName) {
  const cap = Math.min(Math.max(maxTracks || 300, 1), 500);
  if (/^VL[PR]/i.test(String(listId).trim())) return doMusicPlaylistBrowse(String(listId).trim(), cap, knownName);
  const r = await httpsReq('GET', 'www.youtube.com', '/playlist?list=' + encodeURIComponent(listId) + '&hl=en', null, 15000);
  if (r.status !== 200) throw new Error('YouTube HTTP ' + r.status);
  const data = extractJSON(r.body, 'ytInitialData');
  if (!data) throw new Error('Could not parse the playlist page');

  // Playlist name: new pageHeaderViewModel or legacy playlistHeaderRenderer.
  let name = 'Imported playlist';
  const ph = [];
  walk(data, 'pageHeaderViewModel', ph);
  if (ph[0] && ph[0].title) {
    const t = ph[0].title;
    name = (t.content) || (t.dynamicTextViewModel && t.dynamicTextViewModel.text && t.dynamicTextViewModel.text.content) || name;
  }
  if (name === 'Imported playlist') {
    const hdr = [];
    walk(data, 'playlistHeaderRenderer', hdr);
    if (hdr[0] && hdr[0].title) name = textOf(hdr[0].title) || name;
  }

  // Collect tracks from the initial data, then follow continuation tokens.
  const seen = new Set();
  const tracks = [];
  function add(t) {
    if (!t || !t.videoId || seen.has(t.videoId)) return;
    seen.add(t.videoId);
    tracks.push(t);
  }
  let node = data;
  for (let page = 0; page < 20 && tracks.length < cap; page++) {
    const locks = [];
    walk(node, 'lockupViewModel', locks);
    const legacy = [];
    walk(node, 'playlistVideoRenderer', legacy);
    let added = 0;
    for (const v of locks) { const t = trackFromItem(v); if (t) { add(t); added++; } }
    for (const v of legacy) { const t = trackFromItem(v); if (t) { add(t); added++; } }
    if (!added || !tracks.length) break;
    const token = findToken(node);
    if (!token) break;
    const resp = await innerTube('browse', { context: { client: CLIENT }, continuation: token });
    node = resp;
    if (tracks.length >= cap) break;
  }

  if (!tracks.length) throw new Error('Playlist is empty or unavailable');
  tracks.length = Math.min(tracks.length, cap);
  await enrich(tracks, 6); // fill in artist + duration for every track
  return { name: name, tracks: tracks };
}

/* ---------- server ---------- */
const server = http.createServer(async function (req, res) {
  let u;
  try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { res.writeHead(400); return res.end(); }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const send = function (code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (u.pathname === '/ping') return send(200, { ok: true });
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q');
      if (!q) return send(400, { error: 'missing q' });
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit')) || 30, 1), 60);
      // Music search first (songs + artists); fall back to plain video search.
      try {
        const m = await doMusicSearch(q, limit);
        if (m.results.length) return send(200, { results: m.results.slice(0, limit), artists: m.artists, albums: m.albums });
      } catch (e) { console.error('music search failed:', e.message); }
      return send(200, { results: await doSearch(q, limit), artists: [], albums: [] });
    }
    if (u.pathname === '/artist') {
      const id = u.searchParams.get('id');
      if (!id) return send(400, { error: 'missing id' });
      return send(200, await doArtist(id));
    }
    if (u.pathname === '/album') {
      const id = u.searchParams.get('id');
      if (!id) return send(400, { error: 'missing id' });
      return send(200, await doAlbum(id));
    }
    if (u.pathname === '/video') {
      const id = u.searchParams.get('id');
      if (!id) return send(400, { error: 'missing id' });
      return send(200, await doVideo(id));
    }
    if (u.pathname === '/playlist') {
      const list = u.searchParams.get('list');
      if (!list) return send(400, { error: 'missing list' });
      const max = Number(u.searchParams.get('max')) || 300;
      const title = u.searchParams.get('title') || null; // chip name for browse ids (VLPL…/VLRD…)
      return send(200, await doPlaylist(list, max, title));
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    return send(502, { error: e.message || 'upstream error' });
  }
});

server.listen(PORT, HOST, function () {
  console.log('MeatyBeatz local proxy running at http://' + HOST + ':' + PORT);
  console.log('The app detects it automatically — no other setup needed. Ctrl+C to stop.');
});
