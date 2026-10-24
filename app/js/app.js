/* MeatyBeatz — app.js : views, routing, queue engine, player wiring, modals */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(sec) {
    if (!isFinite(sec) || sec <= 0) return '0:00';
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' + mm : m) + ':' + String(s).padStart(2, '0');
  }
  function fmtTotal(sec) {
    if (!sec || sec <= 0) return '0 min';
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (m >= 60) { h += Math.floor(m / 60); m %= 60; }
    return h ? (h + ' hr ' + m + ' min') : (m + ' min');
  }
  function shuffleArr(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------------- state ---------------- */
  var state = {
    view: 'home',            // home | search | library | collection | artist | album
    collectionId: null,
    libraryTab: 'playlists', // playlists | genres | liked
    query: '',
    results: [],
    resultInstance: '',
    searchArtists: [],       // top artists from the last search
    searchAlbums: [],        // albums surfaced by the last search
    linkInfo: null,
    searching: false,
    artistId: null,          // UC… browse id of the open artist page
    artistData: null,
    artistError: null,
    albumId: null,           // MPREb_… browse id of the open album page
    albumData: null,
    albumError: null,
    ctx: { ids: [], label: '', meta: null } // play context for the visible list
  };

  var Q = { context: [], order: [], index: -1, label: '' };
  var consecutiveErrors = 0;
  var errorRunStart = 0; // wall-clock start of the current consecutive-error run (0 = none)
  var lastVolBeforeMute = 80;
  var rowDragFrom = null;

  /* ---------------- toasts ---------------- */
  function toast(msg, type) {
    var root = $('#toast-root');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML = Icons.icon(type === 'error' ? 'close' : 'check') + '<span>' + esc(msg) + '</span>';
    root.appendChild(el);
    setTimeout(function () { el.classList.add('out'); }, 2800);
    setTimeout(function () { el.remove(); }, 3150);
  }

  /* ---------------- popover ---------------- */
  var popCleanup = null;
  function closePopover() {
    $('#popover-root').innerHTML = '';
    if (popCleanup) { popCleanup(); popCleanup = null; }
  }
  function openPopover(html, anchor, extraClass) {
    closePopover();
    var p = document.createElement('div');
    p.className = 'popover' + (extraClass ? ' ' + extraClass : '');
    p.innerHTML = html;
    $('#popover-root').appendChild(p);
    var r = anchor.getBoundingClientRect();
    var pw = p.offsetWidth, ph = p.offsetHeight;
    var left = Math.min(r.left, window.innerWidth - pw - 10);
    var top = r.bottom + 8;
    if (top + ph > window.innerHeight - 10) top = Math.max(10, r.top - ph - 8);
    p.style.left = Math.max(10, left) + 'px';
    p.style.top = top + 'px';
    function onDoc(e) { if (!p.contains(e.target) && !anchor.contains(e.target)) closePopover(); }
    // A scroll that starts INSIDE the popover (e.g. its .pop-list) must not
    // close it — only a real page scroll does.
    function onScroll(e) { if (p.contains(e.target)) return; closePopover(); }
    setTimeout(function () { document.addEventListener('click', onDoc); }, 0);
    window.addEventListener('scroll', onScroll, true);
    popCleanup = function () {
      document.removeEventListener('click', onDoc);
      window.removeEventListener('scroll', onScroll, true);
    };
  }

  /* ---------------- modal ---------------- */
  function closeModal() { $('#modal-root').innerHTML = ''; }
  // Phone-only swipe-down-to-close: from the TOP of a scrollable card, drag
  // down and release past the threshold to fling it away; short drags spring
  // back. Only attached on phones (isPhone) for opts.swipeClose modals —
  // desktop keeps backdrop-tap/Escape only.
  function enableSwipeClose(card) {
    var startY = null, pid = null, dragging = false, curDY = 0;
    card.addEventListener('pointerdown', function (e) {
      if (card.scrollTop > 0) return;                       // only from the top
      if (e.target.closest && e.target.closest('input, textarea, select, button, label, a')) return; // never hijack form controls
      startY = e.clientY; pid = e.pointerId; dragging = true; curDY = 0;
      card.style.transition = 'none';
      // Keep tracking even when the finger slides off the moving card: without
      // capture, later pointer events re-target to whatever is under the finger
      // (the backdrop), the drag freezes below the threshold and long swipes
      // "hesitate" instead of closing. Same try/catch pattern as the seekbar.
      try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    // While we own a downward drag, cancel native scroll: otherwise the browser
    // claims the vertical gesture for (overscroll) scrolling and fires
    // pointercancel after a move or two — the drag "hesitates" and never closes.
    // Only downward moves are cancelled; upward drags still scroll normally.
    card.addEventListener('touchmove', function (e) {
      if (dragging && curDY > 0) e.preventDefault();
    }, { passive: false });
    card.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== pid) return;
      var dy = e.clientY - startY;
      curDY = dy;
      if (dy <= 0) { card.style.transform = ''; return; }   // upward: normal scroll rules
      var d = Math.min(dy, 140) + Math.max(0, dy - 140) * 0.35; // rubber-band past 140px
      card.style.transform = 'translateY(' + d + 'px)';
    });
    function finish(e) {
      if (!dragging || e.pointerId !== pid) return;
      dragging = false; curDY = 0;
      var dy = e.clientY - startY;
      if (dy >= 70) { // short deliberate drag is enough — real swipes land well past this
        card.style.transition = 'transform .22s ease-in';
        card.style.transform = 'translateY(110%)';
        var bd = card.parentElement;
        if (bd) bd.style.transition = 'opacity .22s ease-in', bd.style.opacity = '0';
        setTimeout(closeModal, 230);
      } else {
        card.style.transition = 'transform .25s cubic-bezier(.2,.8,.3,1.2)';
        card.style.transform = '';
      }
    }
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);
  }
  function openModal(html, opts) {
    var root = $('#modal-root');
    root.innerHTML = '<div class="modal-backdrop"><div class="modal-card">' + html + '</div></div>';
    var bd = root.querySelector('.modal-backdrop');
    bd.addEventListener('mousedown', function (e) { if (e.target === bd) closeModal(); });
    var card = root.querySelector('.modal-card');
    if (opts && opts.swipeClose && isPhone()) enableSwipeClose(card);
    return card;
  }
  function confirmModal(title, msg, onYes, danger) {
    var card = openModal(
      '<h3>' + esc(title) + '</h3>' +
      '<p style="color:var(--text-dim);line-height:1.6;font-size:13.5px">' + esc(msg) + '</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" id="cf-no">Cancel</button><button class="btn ' + (danger ? 'btn-danger' : 'btn-accent') + '" id="cf-yes">Confirm</button></div>'
    );
    $('#cf-no').onclick = closeModal;
    $('#cf-yes').onclick = function () { closeModal(); onYes(); };
  }

  /* ---------------- shared renderers ---------------- */
  function trackRow(t, i, opts) {
    opts = opts || {};
    var liked = Store.isLiked(t.videoId);
    // data-action on the row itself: whole-row tap-to-play (the primary
    // playback affordance on touch, where hover-revealed buttons don't exist).
    // trow-static: no working trash button on this row — phones collapse the
    // (invisible) remove column so the title gets the width back. No desktop CSS.
    return '<div class="trow' + (opts.removable ? '' : ' trow-static') + '" data-id="' + t.videoId + '" data-action="play-track">' +
      '<div class="tr-idx">' +
        '<span class="num">' + (i + 1) + '</span>' +
        '<span class="eq"><span></span><span></span><span></span></span>' +
        '<button class="tr-play" data-action="play-track" data-id="' + t.videoId + '" title="Play">' + Icons.icon('play') + '</button>' +
      '</div>' +
      '<div class="tr-main">' +
        '<img class="tr-thumb" loading="lazy" src="' + YouTube.thumbUrl(t.videoId) + '" alt="">' +
        '<div class="tr-text"><div class="tr-title">' + esc(t.title) + '</div><div class="tr-sub">' + esc(t.artist) + '</div></div>' +
      '</div>' +
      '<button class="tr-remove' + (opts.removable ? '' : ' no-op') + '" data-action="remove-track" data-id="' + t.videoId + '" title="Remove from this list">' + Icons.icon('trash') + '</button>' +
      '<button class="tr-like' + (liked ? ' on' : '') + '" data-action="like" data-id="' + t.videoId + '" title="Save to Liked Songs">' + Icons.icon(liked ? 'heartFill' : 'heart') + '</button>' +
      '<button class="tr-add" data-action="add-popover" data-id="' + t.videoId + '" title="Add to playlist / genre">' + Icons.icon('plus') + '</button>' +
      '<div class="tr-dur">' + (t.duration > 0 ? fmtTime(t.duration) : '–') + '</div>' +
    '</div>';
  }

  function tlist(tracks, opts) {
    opts = opts || {};
    var rows = tracks.map(function (t, i) { return trackRow(t, i, opts); }).join('');
    return '<div class="tlist">' +
      '<div class="tlist-head"><span>#</span><span>Title</span><span></span><span></span><span></span><span class="h-dur">Time</span></div>' +
      rows + '</div>';
  }

  function emptyState(ico, title, msg, cta) {
    return '<div class="empty"><div class="e-ico">' + Icons.icon(ico) + '</div><h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>' + (cta || '') + '</div>';
  }

  /* Artist / album / playlist cards for search results and artist pages */
  function artistCard(a) {
    return '<div class="artist-card" data-action="open-artist" data-id="' + esc(a.browseId) + '" title="View ' + esc(a.name) + ' — albums, songs and more">' +
      '<div class="artist-card-art">' + (a.thumbnail ? '<img loading="lazy" src="' + esc(a.thumbnail) + '" alt="">' : Icons.icon('note', 26)) + '</div>' +
      '<div class="artist-card-name">' + esc(a.name) + '</div>' +
      '<div class="artist-card-sub">' + esc(a.subtitle || 'Artist') + '</div>' +
      '</div>';
  }

  function albumCard(al) {
    var liked = Store.isLikedAlbum(al.browseId);
    return '<div class="album-card" data-action="open-album" data-id="' + esc(al.browseId) + '">' +
      '<div class="album-card-art">' + (al.thumbnail ? '<img loading="lazy" src="' + esc(al.thumbnail) + '" alt="">' : Icons.icon('note', 30)) +
        '<button class="tile-play" data-action="open-album" data-id="' + esc(al.browseId) + '" title="Open album">' + Icons.icon('play') + '</button>' +
        '<button class="card-like' + (liked ? ' on' : '') + '" data-action="like-album" data-id="' + esc(al.browseId) + '"' +
          ' data-title="' + esc(al.title || '') + '" data-artist="' + esc(al.artist || '') + '"' +
          ' data-year="' + esc(al.year || '') + '" data-thumb="' + esc(al.thumbnail || '') + '"' +
          ' title="' + (liked ? 'Remove from Liked Albums' : 'Save to Liked Albums') + '">' + Icons.icon(liked ? 'heartFill' : 'heart') + '</button>' +
      '</div>' +
      '<div class="album-card-name">' + esc(al.title) + '</div>' +
      '<div class="album-card-sub">' + esc((al.artist ? al.artist + ' • ' : '') + (al.year || 'Album')) + '</div>' +
      '</div>';
  }

  function playlistCard(it) {
    return '<div class="pl-card" data-action="import-link" data-id="' + esc(it.id) + '" data-title="' + esc(it.title || '') + '" title="Import this playlist into your library">' +
      '<div class="pl-card-art">' + (it.thumbnail ? '<img loading="lazy" src="' + esc(it.thumbnail) + '" alt="">' : Icons.icon('playlist', 26)) + '</div>' +
      '<div class="pl-card-name">' + esc(it.title) + '</div>' +
      '<div class="pl-card-sub">Import playlist</div>' +
      '</div>';
  }

  function backLink() {
    return '<button class="back-btn" data-action="back-search">' + Icons.icon('back') + ' Back to search</button>';
  }

  function colArt(c, iconSize) {
    var first = c.trackIds.length ? Store.getTrack(c.trackIds[0]) : null;
    if (first) return '<img loading="lazy" src="' + YouTube.thumbUrl(first.videoId) + '" alt="">';
    return '<div class="tile-grad" style="background:linear-gradient(135deg,' + c.color[0] + ',' + c.color[1] + ')">' + Icons.icon(c.type === 'genre' ? 'label' : 'playlist', iconSize || 34) + '</div>';
  }

  /* ---------------- views ---------------- */
  function renderHome() {
    var h = new Date().getHours();
    var greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    var cols = Store.collections();
    var likedCount = Store.likedIds().length;

    if (!Store.allTracks().length && !cols.length) {
      return '<div class="view">' +
        '<div class="greet">' + greet + '</div>' +
        '<div class="greet-sub">Your music lives here. It’s 100% free — no login, no API keys, nothing to pay. Playback comes straight from YouTube.</div>' +
        '<div class="onboard">' +
          '<div class="onboard-card" data-action="nav" data-view="search"><div class="o-ico">' + Icons.icon('search') + '</div><h4>Search anything</h4><p>Type a song, artist or album — MeatyBeatz finds it on free public YouTube mirrors.</p></div>' +
          '<div class="onboard-card" data-action="add-music"><div class="o-ico">' + Icons.icon('link') + '</div><h4>Paste a link</h4><p>Drop any youtube.com, youtu.be or music.youtube.com link — video or whole playlist.</p></div>' +
          '<div class="onboard-card" data-action="new-collection"><div class="o-ico">' + Icons.icon('label') + '</div><h4>Organize &amp; play</h4><p>Build playlists and genres, then shuffle, repeat and press play.</p></div>' +
        '</div></div>';
    }

    var html = '<div class="view">';
    html += '<div class="greet">' + greet + '</div>';
    html += '<div class="greet-sub">Everything free. No login, no API keys — just music.</div>';
    html += '<div class="head-actions" style="margin-bottom:26px">' +
      '<button class="btn btn-accent" data-action="add-music">' + Icons.icon('plus') + ' Add music</button>' +
      '<button class="btn btn-ghost" data-action="import-playlist">' + Icons.icon('link') + ' Import playlist</button></div>';

    // quick tiles
    var tiles = '<div class="tile" data-action="open-liked">' +
      '<div class="tile-grad" style="background:linear-gradient(135deg,#8b5cf6,#ec4899)">' + Icons.icon('heartFill', 34) + '</div>' +
      '<div class="tile-scrim"></div><div class="tile-name">Liked Songs</div>' +
      '<button class="tile-play" data-action="play-liked" title="Play Liked Songs">' + Icons.icon('play') + '</button></div>';
    tiles += '<div class="tile" data-action="open-liked-albums">' +
      '<div class="tile-grad" style="background:linear-gradient(135deg,#f59e0b,#ef4444)">' + Icons.icon('note', 34) + '</div>' +
      '<div class="tile-scrim"></div><div class="tile-name">Liked Albums</div></div>';
    cols.slice(0, 5).forEach(function (c) {
      tiles += '<div class="tile" data-action="open-collection" data-id="' + c.id + '">' + colArt(c) +
        '<div class="tile-scrim"></div><div class="tile-name">' + esc(c.name) + '</div>' +
        '<button class="tile-play" data-action="play-collection" data-id="' + c.id + '" title="Play">' + Icons.icon('play') + '</button></div>';
    });
    html += '<div class="section"><div class="quick-grid">' + tiles + '</div></div>';

    // recently added
    var recent = Store.recentTracks(8);
    if (recent.length) {
      state.ctx = { ids: recent.map(function (t) { return t.videoId; }), label: 'Recently added', meta: null };
      html += '<div class="section"><div class="section-head"><h2>Recently added</h2></div>' + tlist(recent, {}) + '</div>';
    }

    // genres shelf
    var genres = cols.filter(function (c) { return c.type === 'genre'; });
    if (genres.length) {
      html += '<div class="section"><div class="section-head"><h2>Your genres</h2><button class="link-btn" data-action="nav-tab" data-view="library" data-tab="genres">Show all</button></div><div class="shelf">';
      genres.forEach(function (g) {
        html += '<div class="shelf-card" data-action="open-collection" data-id="' + g.id + '"><div class="shelf-art">' + colArt(g, 34) + '</div><div class="shelf-name">' + esc(g.name) + '</div><div class="shelf-sub">' + g.trackIds.length + ' songs</div></div>';
      });
      html += '</div></div>';
    }

    // playlists shelf
    var pls = cols.filter(function (c) { return c.type === 'playlist'; });
    if (pls.length) {
      html += '<div class="section"><div class="section-head"><h2>Your playlists</h2><button class="link-btn" data-action="nav-tab" data-view="library" data-tab="playlists">Show all</button></div><div class="shelf">';
      pls.forEach(function (p) {
        html += '<div class="shelf-card" data-action="open-collection" data-id="' + p.id + '"><div class="shelf-art">' + colArt(p, 34) + '</div><div class="shelf-name">' + esc(p.name) + '</div><div class="shelf-sub">' + p.trackIds.length + ' songs</div></div>';
      });
      html += '</div></div>';
    }

    return html + '</div>';
  }

  function linkCardHTML(parsed) {
    var html = '<div class="section">';
    if (parsed.videoId) {
      var t = Store.getTrack(parsed.videoId) || state.linkInfo || { title: 'YouTube video', artist: 'Fetching details…' };
      var inLib = !!Store.getTrack(parsed.videoId);
      html += '<div class="top-hit">' +
        '<div class="top-hit-art"><img src="' + YouTube.thumbUrl(parsed.videoId) + '" alt=""></div>' +
        '<div class="top-hit-info"><div class="top-hit-label">YouTube link</div>' +
        '<h2>' + esc(t.title) + '</h2>' +
        '<div class="top-hit-meta"><span>' + esc(t.artist) + '</span>' + (t.duration > 0 ? '<span class="dur-chip">' + fmtTime(t.duration) + '</span>' : '') + '</div>' +
        '<div class="top-hit-actions">' +
          '<button class="big-play" data-action="play-link" data-id="' + parsed.videoId + '" title="Play">' + Icons.icon('play') + '</button>' +
          (inLib
            ? '<span class="btn btn-ghost" style="opacity:.7">' + Icons.icon('check') + ' In your library</span>'
            : '<button class="btn btn-accent" data-action="add-link" data-id="' + parsed.videoId + '">' + Icons.icon('plus') + ' Add to library</button>') +
        '</div></div></div>';
    } else {
      html += '<div class="hint-box"><div class="h-ico">' + Icons.icon('playlist') + '</div><div>' +
        '<h3>YouTube playlist link</h3>' +
        '<p>This looks like a whole playlist. Import it and every song lands in a new MeatyBeatz playlist, ready to shuffle.</p>' +
        '<div style="margin-top:14px"><button class="btn btn-accent" data-action="import-link" data-id="' + parsed.playlistId + '">' + Icons.icon('download') + ' Import this playlist</button></div>' +
        '</div></div>';
    }
    return html + '</div>';
  }

  function renderSearch() {
    var html = '<div class="view">';
    html += '<div class="search-wrap"><span class="ico-search">' + Icons.icon('search') + '</span>' +
      '<input id="search-input" type="text" placeholder="Song, artist, album — or paste a YouTube link" value="' + esc(state.query) + '" autocomplete="off"></div>';

    if (state.searching) {
      html += '<div class="spinner"></div><p style="text-align:center;color:var(--text-faint)">Searching free mirrors…</p>';
      return html + '</div>';
    }

    var parsed = YouTube.parseYouTubeUrl(state.query);

    if (!state.query.trim()) {
      html += '<div class="hint-box"><div class="h-ico">' + Icons.icon('search') + '</div><div>' +
        '<h3>Find anything on YouTube — free</h3>' +
        '<p>Type a song, artist or album name and MeatyBeatz searches public YouTube mirrors for you. You can also paste any <code>youtube.com/watch?v=…</code>, <code>youtu.be/…</code> or playlist link straight into this box. No API key, no login, nothing to pay.</p>' +
        '</div></div>';
      var rec = Store.recentSearches();
      if (rec.length) {
        html += '<div class="section-head" style="margin-top:28px"><h2>Recent searches</h2></div><div class="chips">';
        rec.forEach(function (q) { html += '<button class="chip" data-action="chip-search" data-q="' + esc(q) + '">' + esc(q) + '</button>'; });
        html += '</div>';
      }
      return html + '</div>';
    }

    if (parsed && (parsed.videoId || parsed.playlistId)) {
      return html + linkCardHTML(parsed) + '</div>';
    }

    if (!state.results.length) {
      html += emptyState('search', 'No results found', 'Nothing came back for “' + esc(state.query) + '”. Try different words, or check your connection and try again.');
      return html + '</div>';
    }

    var meta = {};
    state.results.forEach(function (r) { meta[r.videoId] = r; });
    state.ctx = { ids: state.results.map(function (r) { return r.videoId; }), label: 'Search: ' + state.query, meta: meta };

    if (state.searchArtists.length) {
      html += '<div class="section-head"><h2>Artists</h2></div><div class="artist-shelf">';
      state.searchArtists.forEach(function (a) { html += artistCard(a); });
      html += '</div>';
    }
    if (state.searchAlbums.length) {
      html += '<div class="section-head"><h2>Albums</h2></div><div class="album-grid">';
      state.searchAlbums.forEach(function (al) { html += albumCard(al); });
      html += '</div>';
    }

    var top = state.results[0];
    var rest = state.results.slice(1);
    html += '<div class="top-hit">' +
      '<div class="top-hit-art"><img src="' + YouTube.thumbUrl(top.videoId) + '" alt=""></div>' +
      '<div class="top-hit-info">' +
        '<div class="top-hit-label">Top result</div>' +
        '<h2>' + esc(top.title) + '</h2>' +
        '<div class="top-hit-meta"><span>' + esc(top.artist) + '</span><span class="dur-chip">' + (top.duration > 0 ? fmtTime(top.duration) : '–') + '</span></div>' +
        '<div class="top-hit-actions">' +
          '<button class="big-play" data-action="play-track" data-id="' + top.videoId + '" title="Play">' + Icons.icon('play') + '</button>' +
          '<button class="btn btn-ghost" data-action="add-popover" data-id="' + top.videoId + '">' + Icons.icon('plus') + ' Add to</button>' +
        '</div></div></div>';
    if (rest.length) html += tlist(rest, {});
    if (state.resultInstance) {
      html += '<p class="set-note" style="text-align:center;margin-top:20px">Results via ' + esc(state.resultInstance) + ' — a free public mirror. Playback uses YouTube’s keyless player.</p>';
    }
    return html + '</div>';
  }

  function renderLibrary() {
    var cols = Store.collections();
    var tab = state.libraryTab;
    var html = '<div class="view">';
    html += '<div class="view-head lib-head"><h1>Your Library</h1><div class="head-actions">' +
      '<div class="tabs">' +
        '<button class="tab' + (tab === 'playlists' ? ' active' : '') + '" data-action="lib-tab" data-tab="playlists">Playlists</button>' +
        '<button class="tab' + (tab === 'genres' ? ' active' : '') + '" data-action="lib-tab" data-tab="genres">Genres</button>' +
        '<button class="tab' + (tab === 'liked' ? ' active' : '') + '" data-action="lib-tab" data-tab="liked">Liked Songs</button>' +
        '<button class="tab' + (tab === 'liked-albums' ? ' active' : '') + '" data-action="lib-tab" data-tab="liked-albums">Liked Albums</button>' +
      '</div>' +
      '<button class="btn btn-accent" data-action="new-collection">' + Icons.icon('plus') + ' New</button>' +
      '</div></div>';

    if (tab === 'liked') {
      var ids = Store.likedIds();
      var tracks = ids.map(Store.getTrack).filter(Boolean);
      state.ctx = { ids: ids, label: 'Liked Songs', meta: null };
      // hide-mobile: this header card is hidden on phones (no desktop CSS).
      html += '<div class="col-head hide-mobile">' +
        '<div class="col-art"><div class="tile-grad" style="background:linear-gradient(135deg,#8b5cf6,#ec4899)">' + Icons.icon('heartFill', 64) + '</div></div>' +
        '<div class="col-info"><div class="col-type">Playlist</div><h1>Liked Songs</h1>' +
        '<div class="col-meta"><b>' + tracks.length + '</b> song' + (tracks.length === 1 ? '' : 's') + ' • ' + fmtTotal(tracks.reduce(function (a, t) { return a + (t.duration || 0); }, 0)) + '</div>' +
        '<div class="col-actions">' +
          '<button class="big-play" data-action="play-liked" title="Play">' + Icons.icon('play') + '</button>' +
          '<button class="btn btn-ghost" data-action="shuffle-liked">' + Icons.icon('shuffle') + ' Shuffle</button>' +
        '</div></div></div>';
      html += tracks.length ? tlist(tracks, {}) : emptyState('heart', 'No liked songs yet', 'Tap the heart on any track and it will show up here.');
    } else if (tab === 'liked-albums') {
      var als = Store.likedAlbums();
      html += '<div class="col-head hide-mobile">' +
        '<div class="col-art"><div class="tile-grad" style="background:linear-gradient(135deg,#f59e0b,#ef4444)">' + Icons.icon('note', 64) + '</div></div>' +
        '<div class="col-info"><div class="col-type">Collection</div><h1>Liked Albums</h1>' +
        '<div class="col-meta"><b>' + als.length + '</b> album' + (als.length === 1 ? '' : 's') + '</div></div></div>';
      html += als.length ? '<div class="album-grid">' + als.map(function (a) { return albumCard(a); }).join('') + '</div>'
        : emptyState('heart', 'No liked albums yet', 'Open any album and tap the heart — it will show up here.');
    } else {
      // tab is plural ('playlists'/'genres'); collection types are singular
      var ctype = tab === 'genres' ? 'genre' : 'playlist';
      var list = cols.filter(function (c) { return c.type === ctype; });
      if (!list.length) {
        html += emptyState(tab === 'genres' ? 'label' : 'playlist', 'No ' + tab + ' yet', 'Create one and start collecting the music you love.',
          '<button class="btn btn-accent" data-action="new-collection" data-type="' + tab + '">' + Icons.icon('plus') + ' Create ' + (tab === 'genres' ? 'a genre' : 'a playlist') + '</button>');
      } else {
        html += '<div class="col-grid">';
        list.forEach(function (c) {
          html += '<div class="col-card" data-action="open-collection" data-id="' + c.id + '">' +
            '<div class="col-card-art">' + colArt(c, 40) + '</div>' +
            '<div class="col-card-name">' + esc(c.name) + '</div>' +
            '<div class="col-card-sub">' + (c.type === 'genre' ? 'Genre' : 'Playlist') + ' • ' + c.trackIds.length + ' song' + (c.trackIds.length === 1 ? '' : 's') + '</div>' +
            '<button class="tile-play" data-action="play-collection" data-id="' + c.id + '" title="Play">' + Icons.icon('play') + '</button>' +
            '</div>';
        });
        html += '</div>';
      }
    }
    return html + '</div>';
  }

  function renderCollection() {
    var c = Store.collection(state.collectionId);
    if (!c) { state.view = 'library'; return renderLibrary(); }
    var tracks = c.trackIds.map(Store.getTrack).filter(Boolean);
    state.ctx = { ids: tracks.map(function (t) { return t.videoId; }), label: (c.type === 'genre' ? 'Genre: ' : 'Playlist: ') + c.name, meta: null };

    var html = '<div class="view">';
    html += '<div class="col-head"><div class="col-art">' + colArt(c, 64) + '</div><div class="col-info">' +
      '<div class="col-type">' + (c.type === 'genre' ? 'Genre' : 'Playlist') + '</div>' +
      '<h1>' + esc(c.name) + '</h1>' +
      '<div class="col-meta"><b>' + tracks.length + '</b> song' + (tracks.length === 1 ? '' : 's') + ' • ' + fmtTotal(tracks.reduce(function (a, t) { return a + (t.duration || 0); }, 0)) + '</div>' +
      '<div class="col-actions">' +
        '<button class="big-play" data-action="play-collection" data-id="' + c.id + '" title="Play">' + Icons.icon('play') + '</button>' +
        '<button class="btn btn-ghost" data-action="shuffle-collection" data-id="' + c.id + '">' + Icons.icon('shuffle') + ' Shuffle</button>' +
        '<button class="icon-btn" data-action="edit-collection" data-id="' + c.id + '" title="Edit / delete">' + Icons.icon('more') + '</button>' +
      '</div></div></div>';
    html += tracks.length ? tlist(tracks, { removable: true }) :
      emptyState('note', 'This ' + (c.type === 'genre' ? 'genre' : 'playlist') + ' is empty', 'Add songs from Search or paste a link.',
        '<button class="btn btn-accent" data-action="add-music">' + Icons.icon('plus') + ' Add music</button>');
    return html + '</div>';
  }

  /* ---------------- artist & album views (YouTube Music data) ---------------- */
  function renderArtist() {
    var html = '<div class="view">';
    html += backLink();
    if (!state.artistData) {
      if (state.artistError) {
        html += emptyState('close', 'Could not load this artist', esc(state.artistError),
          '<button class="btn btn-accent" data-action="retry-artist">' + Icons.icon('refresh') + ' Try again</button>');
      } else {
        html += '<div class="spinner"></div><p style="text-align:center;color:var(--text-faint)">Loading artist…</p>';
      }
      return html + '</div>';
    }
    var a = state.artistData;

    // Play context = every playable song on this page (top songs + videos)
    var allTracks = [];
    (a.sections || []).forEach(function (sec) {
      if (sec.kind === 'songs' && sec.tracks) sec.tracks.forEach(function (t) { allTracks.push(t); });
      else if ((sec.kind === 'videos' || sec.kind === 'mixed') && sec.items) {
        sec.items.forEach(function (it) {
          if (it.type === 'video') allTracks.push({ videoId: it.id, title: it.title, artist: a.name, duration: 0 });
        });
      }
    });
    var meta = {};
    allTracks.forEach(function (t) { meta[t.videoId] = t; });
    state.ctx = { ids: allTracks.map(function (t) { return t.videoId; }), label: 'Artist: ' + a.name, meta: meta };

    html += '<div class="artist-head">' +
      (a.thumbnail ? '<img class="artist-art" src="' + esc(a.thumbnail) + '" alt="">' : '<div class="artist-art tile-grad">' + Icons.icon('note', 64) + '</div>') +
      '<div class="artist-info"><div class="col-type">Artist</div><h1>' + esc(a.name) + '</h1>' +
      (a.subtitle ? '<div class="col-meta">' + esc(a.subtitle) + '</div>' : '') +
      '</div></div>';

    (a.sections || []).forEach(function (sec) {
      html += '<div class="section-head"><h2>' + esc(sec.title) + '</h2></div>';
      if (sec.kind === 'songs' && sec.tracks && sec.tracks.length) {
        html += tlist(sec.tracks, {});
      } else if (sec.kind === 'albums' && sec.items) {
        html += '<div class="album-grid">' + sec.items.map(function (it) {
          return albumCard({ browseId: it.id, title: it.title, thumbnail: it.thumbnail, artist: a.name, year: it.subtitle || '' });
        }).join('') + '</div>';
      } else if ((sec.kind === 'videos' || sec.kind === 'mixed') && sec.items) {
        var vids = [], others = [];
        sec.items.forEach(function (it) { (it.type === 'video' ? vids : others).push(it); });
        if (vids.length) html += tlist(vids.map(function (it) { return { videoId: it.id, title: it.title, artist: a.name, duration: 0 }; }), {});
        if (others.length) html += '<div class="artist-shelf">' + others.map(function (it) {
          return it.type === 'artist' ? artistCard({ name: it.title, browseId: it.id, subtitle: it.subtitle || 'Artist', thumbnail: it.thumbnail }) : playlistCard(it);
        }).join('') + '</div>';
      } else if (sec.kind === 'playlists' && sec.items) {
        html += '<div class="artist-shelf">' + sec.items.map(playlistCard).join('') + '</div>';
      } else if (sec.kind === 'artists' && sec.items) {
        html += '<div class="artist-shelf">' + sec.items.map(function (it) {
          return artistCard({ name: it.title, browseId: it.id, subtitle: it.subtitle || 'Artist', thumbnail: it.thumbnail });
        }).join('') + '</div>';
      }
    });
    return html + '</div>';
  }

  function renderAlbum() {
    var html = '<div class="view">';
    html += backLink();
    if (!state.albumData) {
      if (state.albumError) {
        html += emptyState('close', 'Could not load this album', esc(state.albumError),
          '<button class="btn btn-accent" data-action="retry-album">' + Icons.icon('refresh') + ' Try again</button>');
      } else {
        html += '<div class="spinner"></div><p style="text-align:center;color:var(--text-faint)">Loading album…</p>';
      }
      return html + '</div>';
    }
    var al = state.albumData;
    var meta = {};
    al.tracks.forEach(function (t) { meta[t.videoId] = t; });
    state.ctx = { ids: al.tracks.map(function (t) { return t.videoId; }), label: 'Album: ' + al.title, meta: meta };

    var total = al.tracks.reduce(function (s, t) { return s + (t.duration || 0); }, 0);
    html += '<div class="col-head"><div class="col-art">' +
      (al.thumbnail ? '<img src="' + esc(al.thumbnail) + '" alt="">' : '<div class="tile-grad" style="width:100%;height:100%">' + Icons.icon('note', 64) + '</div>') +
      '</div><div class="col-info">' +
      '<div class="col-type">Album</div>' +
      '<h1>' + esc(al.title) + '</h1>' +
      '<div class="col-meta">' + (al.artist ? esc(al.artist) + ' • ' : '') + '<b>' + al.tracks.length + '</b> song' + (al.tracks.length === 1 ? '' : 's') + (total > 0 ? ' • ' + fmtTotal(total) : '') + '</div>' +
      '<div class="col-actions">' +
        '<button class="big-play" data-action="play-album" title="Play album">' + Icons.icon('play') + '</button>' +
        '<button class="btn btn-ghost" data-action="shuffle-album">' + Icons.icon('shuffle') + ' Shuffle</button>' +
        albumLikeBtn(state.albumId, al) +
      '</div></div></div>';
    html += tlist(al.tracks, {});
    return html + '</div>';
  }

  // Heart button for the album page header. No data-id: the router falls back
  // to state.albumId / state.albumData when the element carries no metadata.
  function albumLikeBtn(browseId, al) {
    var liked = browseId ? Store.isLikedAlbum(browseId) : false;
    return '<button class="btn btn-ghost album-like' + (liked ? ' on' : '') + '" data-action="like-album" title="' +
      (liked ? 'Remove from Liked Albums' : 'Save to Liked Albums') + '">' +
      Icons.icon(liked ? 'heartFill' : 'heart') + ' ' + (liked ? 'Album saved' : 'Save album') + '</button>';
  }

  /* ---------------- sidebar + render ---------------- */
  function renderSidebar() {
    var el = $('#side-collections');
    var likedCount = Store.likedIds().length;
    var collapsed = Store.getSettings().sideCollapsed || {};
    var albumCount = Store.likedAlbums().length;
    var html = '<div class="side-item' + (state.view === 'library' && state.libraryTab === 'liked' ? ' active' : '') + '" data-action="open-liked">' +
      '<span class="ico">' + Icons.icon('heartFill') + '</span><span class="nm">Liked Songs</span>' + (likedCount ? '<span class="cnt">' + likedCount + '</span>' : '') + '</div>';
    html += '<div class="side-item' + (state.view === 'library' && state.libraryTab === 'liked-albums' ? ' active' : '') + '" data-action="open-liked-albums">' +
      '<span class="ico">' + Icons.icon('note') + '</span><span class="nm">Liked Albums</span>' + (albumCount ? '<span class="cnt">' + albumCount + '</span>' : '') + '</div>';

    // Playlists and genres live under their own collapsible sections so the
    // list stays tidy as it grows. Collapse state persists in settings.
    var groups = [
      { key: 'playlists', label: 'Playlists', type: 'playlist' },
      { key: 'genres', label: 'Genres', type: 'genre' }
    ];
    groups.forEach(function (g) {
      var items = Store.collections().filter(function (c) { return c.type === g.type; });
      var isCollapsed = !!collapsed[g.key];
      html += '<div class="side-group' + (isCollapsed ? ' collapsed' : '') + '">' +
        '<button class="side-group-head" data-action="toggle-side-group" data-group="' + g.key + '" title="' + (isCollapsed ? 'Expand ' + g.label.toLowerCase() : 'Collapse ' + g.label.toLowerCase()) + '">' +
          '<span class="chev">' + Icons.icon('chevDown') + '</span>' +
          '<span class="nm">' + g.label + '</span><span class="cnt">' + items.length + '</span>' +
        '</button><div class="side-group-body' + (isCollapsed ? ' collapsed' : '') + '">';
      items.forEach(function (c) {
        var active = state.view === 'collection' && state.collectionId === c.id;
        html += '<div class="side-item' + (active ? ' active' : '') + '" data-action="open-collection" data-id="' + c.id + '">' +
          '<span class="ico">' + Icons.icon(c.type === 'genre' ? 'label' : 'playlist') + '</span><span class="nm">' + esc(c.name) + '</span><span class="cnt">' + c.trackIds.length + '</span></div>';
      });
      html += '</div></div>';
    });
    el.innerHTML = html;
  }

  function render() {
    var main = $('#main');
    // The search input is rebuilt on every render — remember whether it had
    // focus (and where the cursor was) so we can restore it afterwards.
    // Without this, a search starting mid-typing drops focus to <body> and
    // Backspace navigates the browser back instead of editing the query.
    var oldInp = state.view === 'search' ? $('#search-input') : null;
    var keepFocus = !!(oldInp && document.activeElement === oldInp);
    var selStart = null, selEnd = null;
    if (keepFocus) { try { selStart = oldInp.selectionStart; selEnd = oldInp.selectionEnd; } catch (e) { /* noop */ } }

    if (state.view === 'home') main.innerHTML = renderHome();
    else if (state.view === 'search') main.innerHTML = renderSearch();
    else if (state.view === 'library') main.innerHTML = renderLibrary();
    else if (state.view === 'collection') main.innerHTML = renderCollection();
    else if (state.view === 'artist') main.innerHTML = renderArtist();
    else if (state.view === 'album') main.innerHTML = renderAlbum();

    $$('.nav-btn[data-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === state.view);
    });
    renderSidebar();
    markPlaying(currentId());

    if (state.view === 'search') {
      var inp = $('#search-input');
      if (inp) {
        if (keepFocus) {
          // We were typing before the re-render — put focus and cursor back.
          inp.focus();
          try {
            if (selStart != null && selEnd != null && selStart <= inp.value.length && selEnd <= inp.value.length) {
              inp.setSelectionRange(selStart, selEnd);
            } else {
              inp.setSelectionRange(inp.value.length, inp.value.length);
            }
          } catch (e) { /* noop */ }
        } else if (!state.searching) {
          // Freshly arriving on the search view: focus the box as before.
          inp.focus();
          try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { /* noop */ }
        }
      }
    }
  }

  function navigate(view, opts) {
    closePopover();
    state.view = view;
    if (view === 'collection') state.collectionId = opts && opts.id || null;
    if (view === 'library' && opts && opts.tab) state.libraryTab = opts.tab;
    if (view === 'artist') { state.artistId = opts && opts.id || null; state.artistData = null; state.artistError = state.artistId ? null : 'No artist id available for this item.'; }
    if (view === 'album') { state.albumId = opts && opts.id || null; state.albumData = null; state.albumError = state.albumId ? null : 'No album id available for this item.'; }
    render();
    $('#main').scrollTop = 0;
    if (view === 'artist' && state.artistId) loadArtist(state.artistId);
    if (view === 'album' && state.albumId) loadAlbum(state.albumId);
  }

  async function loadArtist(id) {
    try {
      var d = await Search.artist(id);
      if (state.view !== 'artist' || state.artistId !== id) return;
      state.artistData = d;
      render();
    } catch (e) {
      if (state.view !== 'artist' || state.artistId !== id) return;
      state.artistError = e.message;
      render();
      toast(e.message, 'error');
    }
  }

  async function loadAlbum(id) {
    try {
      var d = await Search.album(id);
      if (state.view !== 'album' || state.albumId !== id) return;
      state.albumData = d;
      render();
    } catch (e) {
      if (state.view !== 'album' || state.albumId !== id) return;
      state.albumError = e.message;
      render();
      toast(e.message, 'error');
    }
  }

  /* ---------------- queue engine ---------------- */
  function currentId() { return Q.index >= 0 && Q.index < Q.order.length ? Q.order[Q.index] : null; }

  function ensureTrack(id) {
    var t = Store.getTrack(id);
    if (t) return t;
    var m = state.ctx.meta && state.ctx.meta[id];
    if (m) return Store.upsertTrack(m);
    return Store.upsertTrack({ videoId: id, title: 'YouTube video', artist: 'Unknown artist' });
  }

  function playContext(ids, startIdx, label, meta) {
    ids = (ids || []).filter(Boolean);
    if (!ids.length) { toast('Nothing to play yet — add some music first', 'error'); return; }
    if (meta && typeof Store.upsertMany === 'function') {
      var arr = [];
      ids.forEach(function (id) { if (meta[id]) arr.push(meta[id]); });
      if (arr.length) Store.upsertMany(arr);
    }
    Q.context = ids.slice();
    Q.label = label || '';
    var cur = ids[startIdx] != null ? ids[startIdx] : ids[0];
    if (Store.getSettings().shuffle) {
      var rest = ids.filter(function (_, i) { return i !== startIdx; });
      shuffleArr(rest);
      Q.order = [cur].concat(rest);
      Q.index = 0;
    } else {
      Q.order = ids.slice();
      Q.index = Math.max(0, Q.order.indexOf(cur));
    }
    consecutiveErrors = 0;
    errorRunStart = 0;
    startCurrent();
  }

  function startCurrent() {
    var id = currentId();
    if (!id) return;
    ensureTrack(id);
    YTPlayer.play(id);
    setNowPlayingUI(id);
    markPlaying(id);
    renderQueuePanelIfOpen();
  }

  function handleEnded() {
    var s = Store.getSettings();
    if (s.repeat === 'one') { YTPlayer.replay(); return; }
    if (Q.index < Q.order.length - 1) { Q.index++; startCurrent(); }
    else if (s.repeat === 'all') { Q.index = 0; startCurrent(); }
    // otherwise: stop at the end, staying on the last track
  }

  function nextTrack() {
    if (!currentId()) return;
    if (Q.index < Q.order.length - 1) { Q.index++; startCurrent(); }
    else if (Store.getSettings().repeat === 'all') { Q.index = 0; startCurrent(); }
    else toast('End of queue');
  }

  function prevTrack() {
    var id = currentId();
    if (!id) return;
    if (YTPlayer.time() > 3) { YTPlayer.seek(0); return; }
    if (Q.index > 0) { Q.index--; startCurrent(); }
    else YTPlayer.seek(0);
  }

  function setShuffle(on) {
    Store.setSettings({ shuffle: on });
    var cur = currentId();
    if (cur && Q.context.length) {
      if (on) {
        // Shuffle only the unplayed remainder; keep the current track in place.
        var pos = Q.context.indexOf(cur);
        var played = Q.context.slice(0, pos);
        var rest = Q.context.slice(pos + 1);
        shuffleArr(rest);
        Q.order = played.concat([cur], rest);
        Q.index = played.length;
      } else {
        // Turning shuffle OFF restores the original context order.
        Q.order = Q.context.slice();
        Q.index = Math.max(0, Q.context.indexOf(cur));
      }
    }
    updateShuffleBtn();
    markPlaying(cur);
  }

  function cycleRepeat() {
    var s = Store.getSettings();
    var nextRep = s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off';
    Store.setSettings({ repeat: nextRep });
    updateRepeatBtn();
    toast(nextRep === 'off' ? 'Repeat off' : nextRep === 'all' ? 'Repeat all' : 'Repeat one', 'info');
  }

  function updateShuffleBtn() { $('#btn-shuffle').classList.toggle('on', !!Store.getSettings().shuffle); }
  function updateRepeatBtn() {
    var r = Store.getSettings().repeat;
    var btn = $('#btn-repeat');
    btn.innerHTML = Icons.icon(r === 'one' ? 'repeatOne' : 'repeat') + '<span class="rep-badge">1</span>';
    btn.classList.toggle('on', r !== 'off');
    btn.classList.toggle('one', r === 'one');
  }

  function setNowPlayingUI(id) {
    var t = Store.getTrack(id);
    if (!t) return;
    $('#pb-title').textContent = t.title;
    $('#pb-artist').textContent = t.artist;
    $('#pb-thumb').src = YouTube.thumbUrl(t.videoId);
    document.title = t.title + ' • ' + t.artist + ' — MeatyBeatz';
    updateLikeBtn();
  }

  function updateLikeBtn() {
    var id = currentId();
    var liked = !!(id && Store.isLiked(id));
    $('#pb-like').innerHTML = Icons.icon(liked ? 'heartFill' : 'heart');
    $('#pb-like').classList.toggle('on', liked);
  }

  function setPlayIcon(playing) {
    $('#play-icon').innerHTML = Icons.icon(playing ? 'pause' : 'play');
    $('#btn-play').classList.remove('buffering');
  }

  function markPlaying(id) {
    var playing = YTPlayer.getState() === 'playing';
    $$('.trow').forEach(function (r) {
      r.classList.toggle('playing', !!id && r.getAttribute('data-id') === id && playing);
    });
  }

  /* ---------------- player events ---------------- */
  function onPlayerState(data) {
    if (data === 1) {           // playing
      consecutiveErrors = 0;
      errorRunStart = 0;
      setPlayIcon(true);
      markPlaying(currentId());
    } else if (data === 2) {    // paused
      setPlayIcon(false);
      markPlaying(null);
    } else if (data === 3) {    // buffering
      $('#btn-play').classList.add('buffering');
    } else if (data === 0) {    // ended
      handleEnded();
    }
  }

  function onPlayerError() {
    var id = currentId();
    if (!id) return;
    consecutiveErrors++;
    if (!errorRunStart) errorRunStart = Date.now();
    var t = Store.getTrack(id);
    // Bound the skip loop: allow skipping up to min(max(3, queueSize), 25) tracks in a row,
    // and never keep failing for more than 90 seconds. (A huge all-unavailable queue used
    // to loop through every track before stopping.)
    var limit = Math.min(Math.max(3, Q.order.length), 25);
    if (consecutiveErrors > limit || Date.now() - errorRunStart > 90000) {
      toast('Too many unavailable tracks — playback stopped', 'error');
      setPlayIcon(false);
      consecutiveErrors = 0;
      errorRunStart = 0;
      return;
    }
    if (Q.order.length > 1) {
      toast('“' + (t ? t.title : 'This track') + '” isn’t available to play right now — skipping', 'error');
      if (Q.index < Q.order.length - 1) { Q.index++; startCurrent(); }
      else { Q.index = 0; startCurrent(); }
    } else {
      // Single-track queue: there is nowhere to skip to, so stop with an accurate message
      // instead of a misleading "skipping" toast.
      toast('“' + (t ? t.title : 'This track') + '” can’t be played right now — playback stopped', 'error');
      setPlayIcon(false);
      consecutiveErrors = 0;
      errorRunStart = 0;
    }
  }

  /* ---------------- volume / seek ---------------- */
  function applyVolume(v, persist) {
    YTPlayer.setVolume(v);
    $('#vol').value = v;
    updateMuteIcon();
    if (persist) Store.setSettings({ volume: v });
  }
  function updateMuteIcon() {
    var v = Number($('#vol').value);
    $('#mute-icon').innerHTML = Icons.icon(v === 0 ? 'volMute' : 'volHigh');
  }
  // Mute contract shared by the desktop button and the phone popout: at
  // vol > 0 remember it and mute; at 0 restore the remembered value.
  function toggleMute() {
    var v2 = Number($('#vol').value);
    if (v2 > 0) { lastVolBeforeMute = v2; applyVolume(0, true); }
    else applyVolume(lastVolBeforeMute || 50, true);
  }

  /* Phone-only volume popout: a slim vertical slider opened from the
     mute button (#vol is hidden on phones). Reuses the popover system,
     which auto-flips above the anchor when there is no room below. */
  function isPhone() { return window.matchMedia('(max-width: 720px)').matches; }
  function paintVolPop(v) {
    var p = $('#popover-root .vol-pop');
    if (!p) return;
    p.querySelector('.vol-fill').style.height = v + '%';
    p.querySelector('.vol-thumb').style.bottom = v + '%';
  }
  function openVolPopout(anchor) {
    closePopover();
    var v0 = Number($('#vol').value);
    openPopover(
      '<div class="vol-track"><div class="vol-fill"></div><div class="vol-thumb"></div></div>' +
      '<button class="icon-btn vol-mute" title="Mute">' + Icons.icon(v0 === 0 ? 'volMute' : 'volHigh') + '</button>',
      anchor, 'vol-pop');
    paintVolPop(v0);
    var p = $('#popover-root .vol-pop');
    p.querySelector('.vol-mute').addEventListener('click', function () {
      var self = this;
      toggleMute();
      // Defer the icon swap: replacing innerHTML synchronously would detach
      // the clicked node before the popover's outside-click check reads
      // e.target, making it look like an outside tap and close the popout.
      setTimeout(function () {
        self.innerHTML = Icons.icon(Number($('#vol').value) === 0 ? 'volMute' : 'volHigh');
        paintVolPop(Number($('#vol').value));
      }, 0);
    });
    var track = p.querySelector('.vol-track');
    var dragging = false;
    function volFromEvent(e) {
      var r = track.getBoundingClientRect();
      var f = 1 - (e.clientY - r.top) / r.height;
      return Math.round(Math.max(0, Math.min(1, f)) * 100);
    }
    track.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      applyVolume(volFromEvent(e), false);
      paintVolPop(Number($('#vol').value));
    });
    track.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      applyVolume(volFromEvent(e), false);
      paintVolPop(Number($('#vol').value));
    });
    track.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      Store.setSettings({ volume: Number($('#vol').value) });
    });
  }

  var seeking = false;
  function seekFracFromEvent(e) {
    var r = $('#seekbar').getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  function paintSeek(f) {
    $('#seek-fill').style.width = (f * 100) + '%';
    $('#seek-thumb').style.left = (f * 100) + '%';
    var d = YTPlayer.duration();
    if (d > 0) $('#time-cur').textContent = fmtTime(f * d);
  }

  /* ---------------- queue panel ---------------- */
  function toggleQueuePanel() {
    var p = $('#queue-panel');
    if (!p.classList.contains('hidden')) { p.classList.add('hidden'); return; }
    renderQueuePanel();
    p.classList.remove('hidden');
  }
  function renderQueuePanelIfOpen() {
    if (!$('#queue-panel').classList.contains('hidden')) renderQueuePanel();
  }
  function trackOrMeta(id) {
    return Store.getTrack(id) || (state.ctx.meta && state.ctx.meta[id]) || null;
  }
  function renderQueuePanel() {
    var p = $('#queue-panel');
    if (!Q.order.length) {
      p.innerHTML = '<div class="qp-head"><div class="t">Queue <button class="icon-btn" id="qp-close">' + Icons.icon('close') + '</button></div></div>' +
        '<div class="qp-empty">Nothing in the queue yet.<br>Play a song, playlist or genre to fill it up.</div>';
      p.querySelector('#qp-close').onclick = function () { p.classList.add('hidden'); };
      return;
    }
    var cur = currentId();
    var nowT = trackOrMeta(cur);
    var html = '<div class="qp-head"><div class="t">Queue <button class="icon-btn" id="qp-close">' + Icons.icon('close') + '</button></div>' +
      '<div class="src">' + esc(Q.label || 'Queue') + ' • ' + Q.order.length + ' track' + (Q.order.length === 1 ? '' : 's') + '</div></div><div class="qp-list">';
    if (nowT) {
      html += '<div class="qp-now"><div class="lbl">Now playing</div>' +
        '<div class="qp-row" style="cursor:default"><span class="q-idx"></span><img src="' + YouTube.thumbUrl(nowT.videoId) + '" alt=""><div><div class="q-t">' + esc(nowT.title) + '</div><div class="q-a">' + esc(nowT.artist) + '</div></div><span></span></div></div>';
    }
    Q.order.forEach(function (id, i) {
      if (i === Q.index) return; // shown as "now playing"
      var t = trackOrMeta(id);
      if (!t) return;
      html += '<div class="qp-row" draggable="true" data-qidx="' + i + '">' +
        '<span class="q-idx">' + (i + 1) + '</span><img src="' + YouTube.thumbUrl(t.videoId) + '" loading="lazy" alt="">' +
        '<div><div class="q-t">' + esc(t.title) + '</div><div class="q-a">' + esc(t.artist) + '</div></div>' +
        // Move buttons: touch reorder (HTML5 drag-and-drop has no touch support).
        // Hidden on desktop, shown for coarse pointers via CSS.
        '<button class="q-mv q-mv-up" data-action="queue-move" data-qidx="' + i + '" data-dir="-1" title="Move up">' + Icons.icon('chevDown') + '</button>' +
        '<button class="q-mv" data-action="queue-move" data-qidx="' + i + '" data-dir="1" title="Move down">' + Icons.icon('chevDown') + '</button>' +
        '<button class="q-rm" data-action="queue-remove" data-qidx="' + i + '" title="Remove from queue">' + Icons.icon('close') + '</button></div>';
    });
    html += '</div>';
    p.innerHTML = html;

    p.querySelector('#qp-close').onclick = function () { p.classList.add('hidden'); }

    $$('#queue-panel .qp-row[draggable]').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('.q-rm') || e.target.closest('.q-mv')) return;
        Q.index = Number(row.getAttribute('data-qidx'));
        startCurrent();
      });
      row.addEventListener('dragstart', function (e) {
        rowDragFrom = Number(row.getAttribute('data-qidx'));
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(rowDragFrom)); } catch (err) { /* noop */ }
      });
      row.addEventListener('dragend', function () { row.classList.remove('drag-over'); rowDragFrom = null; });
      row.addEventListener('dragover', function (e) { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', function () { row.classList.remove('drag-over'); });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        row.classList.remove('drag-over');
        var from = rowDragFrom, to = Number(row.getAttribute('data-qidx'));
        if (from == null || from === to) return;
        var curIdNow = currentId();
        var item = Q.order.splice(from, 1)[0];
        Q.order.splice(to > from ? to - 1 : to, 0, item);
        Q.index = Math.max(0, Q.order.indexOf(curIdNow));
        rowDragFrom = null;
        renderQueuePanel();
      });
    });

    $$('#queue-panel [data-action="queue-remove"]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        queueRemove(Number(b.getAttribute('data-qidx')));
      });
    });

    $$('#queue-panel [data-action="queue-move"]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        queueMove(Number(b.getAttribute('data-qidx')), Number(b.getAttribute('data-dir')));
      });
    });
  }
  function queueRemove(i) {
    if (i === Q.index) return; // current track can’t be removed
    var id = Q.order.splice(i, 1)[0];
    var ci = Q.context.indexOf(id);
    if (ci !== -1) Q.context.splice(ci, 1);
    if (i < Q.index) Q.index--;
    renderQueuePanel();
  }
  // Touch reorder: swap an upcoming row with its neighbor. The current track
  // can’t be moved, and a swap may never cross it — moving a row into (or
  // across) the current position would desync Q.index from what is playing.
  function queueMove(i, dir) {
    var j = i + dir;
    if (i === Q.index || j === Q.index || j < 0 || j >= Q.order.length) return;
    var tmp = Q.order[i];
    Q.order[i] = Q.order[j];
    Q.order[j] = tmp;
    renderQueuePanel();
  }

  /* ---------------- search flow ---------------- */
  var searchTimer = null;
  function onSearchInput(v) {
    state.query = v;
    clearTimeout(searchTimer);
    var q = v.trim();
    if (!q) { state.results = []; state.searchArtists = []; state.searchAlbums = []; state.searching = false; render(); return; }
    // Auto-search only once the query is a plausible name (≥3 chars), the user
    // has paused, and they haven't just typed a space — a trailing space means
    // another word is coming, so multi-word band names are not searched word by
    // word mid-typing. Enter always searches, at any length.
    if (q.length < 3) return;
    if (/[ \t]$/.test(v)) return;
    searchTimer = setTimeout(function () { runSearch(q); }, 1200);
  }

  async function runSearch(q) {
    q = (q || '').trim();
    state.query = q;
    var parsed = YouTube.parseYouTubeUrl(q);

    if (parsed && (parsed.videoId || parsed.playlistId)) {
      state.searching = true;
      state.linkInfo = null;
      render();
      if (parsed.videoId) {
        try { state.linkInfo = await Search.getVideoInfo(parsed.videoId); } catch (e) { state.linkInfo = null; }
      }
      if (state.query !== q) return; // superseded by newer input
      state.searching = false;
      render();
      return;
    }

    state.searching = true;
    state.results = [];
    state.searchArtists = [];
    state.searchAlbums = [];
    render();
    try {
      var res = await Search.search(q, 30);
      if (state.query !== q) return;
      state.results = res.results;
      state.resultInstance = res.instance;
      state.searchArtists = res.artists || [];
      state.searchAlbums = res.albums || [];
      Store.addRecentSearch(q);
    } catch (e) {
      if (state.query !== q) return;
      state.results = [];
      toast(e.message, 'error');
    }
    state.searching = false;
    render();
  }

  /* ---------------- add-to popover ---------------- */
  function openAddPopover(anchor, videoId) {
    ensureTrack(videoId);
    var playlists = Store.collections().filter(function (c) { return c.type === 'playlist'; });
    var genres = Store.collections().filter(function (c) { return c.type === 'genre'; });
    var liked = Store.isLiked(videoId);

    var html = '<div class="pop-title">Add to</div>';
    html += '<button class="pop-row' + (liked ? ' in' : '') + '" data-addlike="' + videoId + '"><span class="ico">' + Icons.icon(liked ? 'heartFill' : 'heart') + '</span><span class="nm">Liked Songs</span><span class="chk">' + Icons.icon('check') + '</span></button>';
    // With many collections a flat list is unusable — the middle zone scrolls
    // and a live name filter (shown from 10 collections up) finds them fast.
    var showFilter = (playlists.length + genres.length) >= 10;
    if (showFilter) html += '<input type="text" id="pop-filter" class="pop-filter" placeholder="Filter playlists & genres…" autocomplete="off">';
    html += '<div class="pop-list">';
    html += '<div class="pop-section">Playlists</div>';
    if (!playlists.length) html += '<div style="padding:4px 10px;color:var(--text-faint);font-size:12.5px">No playlists yet</div>';
    playlists.forEach(function (c) {
      var inIt = c.trackIds.indexOf(videoId) !== -1;
      html += '<button class="pop-row' + (inIt ? ' in' : '') + '" data-addpl="' + c.id + '" data-name="' + esc(c.name) + '"><span class="ico">' + Icons.icon('playlist') + '</span><span class="nm">' + esc(c.name) + '</span><span class="chk">' + Icons.icon('check') + '</span></button>';
    });
    html += '<div class="pop-section">Genres</div>';
    if (!genres.length) html += '<div style="padding:4px 10px;color:var(--text-faint);font-size:12.5px">No genres yet</div>';
    genres.forEach(function (c) {
      var inIt = c.trackIds.indexOf(videoId) !== -1;
      html += '<button class="pop-row' + (inIt ? ' in' : '') + '" data-addpl="' + c.id + '" data-name="' + esc(c.name) + '"><span class="ico">' + Icons.icon('label') + '</span><span class="nm">' + esc(c.name) + '</span><span class="chk">' + Icons.icon('check') + '</span></button>';
    });
    html += '<div id="pop-nomatch" class="pop-nomatch hidden">No matches</div>';
    html += '</div>';
    // Create buttons stay pinned at the bottom — reachable without scrolling.
    html += '<div class="pop-footer">' +
      '<button class="pop-row pop-new" data-newpl="' + videoId + '"><span class="ico">' + Icons.icon('plus') + '</span><span class="nm">New playlist…</span></button>' +
      '<button class="pop-row pop-new" data-newg="' + videoId + '"><span class="ico">' + Icons.icon('plus') + '</span><span class="nm">New genre…</span></button>' +
    '</div>';

    openPopover(html, anchor, 'add-pop');
    var p = $('#popover-root .popover');

    if (showFilter) {
      var fi = $('#pop-filter');
      fi.addEventListener('input', function () {
        var q = fi.value.trim().toLowerCase();
        var anyVisible = false;
        p.querySelectorAll('.pop-list .pop-row[data-addpl]').forEach(function (r) {
          var hit = !q || (r.getAttribute('data-name') || '').toLowerCase().indexOf(q) !== -1;
          r.style.display = hit ? '' : 'none';
          if (hit) anyVisible = true;
        });
        // Hide a section header when none of its rows are visible.
        p.querySelectorAll('.pop-list .pop-section').forEach(function (sec) {
          var next = sec.nextElementSibling, visible = false;
          while (next && !next.classList.contains('pop-section') && next.id !== 'pop-nomatch') {
            if (next.classList.contains('pop-row') && next.hasAttribute('data-addpl') && next.style.display !== 'none') visible = true;
            next = next.nextElementSibling;
          }
          sec.style.display = visible ? '' : 'none';
        });
        $('#pop-nomatch').classList.toggle('hidden', anyVisible);
      });
      setTimeout(function () { fi.focus(); }, 30);
    }

    p.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-addlike')) {
        var nowLiked = Store.toggleLike(videoId);
        toast(nowLiked ? 'Added to Liked Songs' : 'Removed from Liked Songs', nowLiked ? 'success' : 'info');
        closePopover(); render(); updateLikeBtn();
      } else if (b.hasAttribute('data-addpl')) {
        var cid = b.getAttribute('data-addpl');
        var c = Store.collection(cid);
        if (!c) return;
        var wasIn = c.trackIds.indexOf(videoId) !== -1;
        if (wasIn) Store.removeFromCollection(cid, videoId); else Store.addToCollection(cid, videoId);
        toast(wasIn ? 'Removed from “' + c.name + '”' : 'Added to “' + c.name + '”', wasIn ? 'info' : 'success');
        closePopover(); render();
      } else if (b.hasAttribute('data-newpl')) {
        closePopover(); openCreateModal('playlist', videoId);
      } else if (b.hasAttribute('data-newg')) {
        closePopover(); openCreateModal('genre', videoId);
      }
    });
  }

  /* ---------------- create / edit modals ---------------- */
  var GENRE_PRESETS = ['Pop', 'Rock', 'Hip-Hop / Rap', 'Electronic / Dance', 'R&B / Soul', 'Jazz', 'Classical', 'Metal', 'Country', 'Folk / Acoustic', 'Lo-fi / Chill', 'Ambient', 'Indie', 'Punk', 'Reggae', 'Blues', 'Latin', 'K-Pop', 'Anime / J-Rock', 'World'];

  function openCreateModal(type, pendingTrackId) {
    var card = openModal(
      '<h3>Create ' + (type === 'genre' ? 'genre' : 'playlist') + '</h3>' +
      '<div class="seg" id="m-seg">' +
        '<button data-type="playlist" class="' + (type !== 'genre' ? 'active' : '') + '">' + Icons.icon('playlist') + ' Playlist</button>' +
        '<button data-type="genre" class="' + (type === 'genre' ? 'active' : '') + '">' + Icons.icon('label') + ' Genre</button>' +
      '</div>' +
      '<label class="field-label">Name</label>' +
      '<input class="text-input" id="m-name" placeholder="' + (type === 'genre' ? 'e.g. Lo-fi beats, 80s Rock…' : 'e.g. Road trip, Workout…') + '" maxlength="60">' +
      '<div class="genre-chips hidden" id="m-chips">' + GENRE_PRESETS.map(function (g) { return '<button class="chip" data-g="' + esc(g) + '">' + esc(g) + '</button>'; }).join('') + '</div>' +
      (pendingTrackId ? '<p class="set-note">The song will be added to this ' + (type === 'genre' ? 'genre' : 'playlist') + ' automatically.</p>' : '') +
      '<div class="modal-actions"><button class="btn btn-ghost" id="m-cancel">Cancel</button><button class="btn btn-accent" id="m-save">Create</button></div>',
      { swipeClose: true }
    );

    var curType = type;
    function syncChips() { $('#m-chips').classList.toggle('hidden', curType !== 'genre'); }
    card.querySelectorAll('#m-seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        curType = b.getAttribute('data-type');
        card.querySelectorAll('#m-seg button').forEach(function (x) { x.classList.toggle('active', x === b); });
        syncChips();
      });
    });
    card.querySelectorAll('#m-chips .chip').forEach(function (c) {
      c.addEventListener('click', function () { $('#m-name').value = c.getAttribute('data-g'); $('#m-name').focus(); });
    });
    $('#m-cancel').onclick = closeModal;
    function save() {
      var name = $('#m-name').value.trim();
      if (!name) { toast('Give it a name first', 'error'); return; }
      var col = Store.createCollection(name, curType);
      if (pendingTrackId) Store.addToCollection(col.id, pendingTrackId);
      closeModal();
      toast('Created “' + name + '”', 'success');
      render();
    }
    $('#m-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
    $('#m-save').onclick = save;
    setTimeout(function () { var n = $('#m-name'); if (n) n.focus(); }, 30);
  }

  function openEditModal(colId) {
    var c = Store.collection(colId);
    if (!c) return;
    openModal(
      '<h3>Edit ' + (c.type === 'genre' ? 'genre' : 'playlist') + '</h3>' +
      '<label class="field-label">Name</label><input class="text-input" id="m-name" value="' + esc(c.name) + '" maxlength="60">' +
      '<div class="modal-actions"><button class="btn btn-danger" id="m-del">' + Icons.icon('trash') + ' Delete</button><span style="flex:1"></span><button class="btn btn-ghost" id="m-cancel">Cancel</button><button class="btn btn-accent" id="m-save">Save</button></div>',
      { swipeClose: true }
    );
    $('#m-cancel').onclick = closeModal;
    function doSave() {
      var name = $('#m-name').value.trim();
      if (!name) { toast('Name can’t be empty', 'error'); return; }
      Store.updateCollection(c.id, { name: name });
      closeModal(); render(); toast('Saved', 'success');
    }
    $('#m-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSave(); });
    $('#m-save').onclick = doSave;
    $('#m-del').onclick = function () {
      confirmModal('Delete “' + c.name + '”?', 'The songs themselves stay in your library — only this ' + c.type + ' gets deleted.', function () {
        Store.deleteCollection(c.id);
        if (state.view === 'collection' && state.collectionId === c.id) navigate('library');
        else render();
        toast('Deleted', 'info');
      }, true);
    };
  }

  /* ---------------- add music modal ---------------- */
  function openAddMusicModal() {
    openModal(
      '<h3>Add music</h3>' +
      '<p class="set-note" style="margin-top:-6px">Paste any YouTube link (video or playlist) — or just type a song, artist or album name.</p>' +
      '<div style="display:flex;gap:8px;margin-top:14px"><input class="text-input" id="am-input" placeholder="https://youtu.be/…  or  “never gonna give you up”" style="flex:1"><button class="btn btn-accent" id="am-go">Find</button></div>' +
      '<div id="am-results"></div>',
      { swipeClose: true }
    );
    var inp = $('#am-input');
    function go() { doFind(inp.value); }
    $('#am-go').onclick = go;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    setTimeout(function () { var n = $('#am-input'); if (n) n.focus(); }, 30);

    async function doFind(raw) {
      raw = (raw || '').trim();
      if (!raw) return;
      var btn = $('#am-go');
      if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
      function done() { if (btn) { btn.disabled = false; btn.style.opacity = ''; } }
      var box = $('#am-results');
      var parsed = YouTube.parseYouTubeUrl(raw);

      if (parsed && parsed.videoId) {
        box.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
        var info = null;
        try { info = await Search.getVideoInfo(parsed.videoId); } catch (e) { /* offline-ish */ }
        var t = Store.getTrack(parsed.videoId) || info || { videoId: parsed.videoId, title: 'YouTube video', artist: 'Unknown artist' };
        var inLib = !!Store.getTrack(parsed.videoId);
        box.innerHTML = '<div class="mini-results"><div class="mini-row"><img src="' + YouTube.thumbUrl(t.videoId) + '" alt="">' +
          '<div><div class="m-t">' + esc(t.title) + '</div><div class="m-a">' + esc(t.artist) + '</div></div>' +
          (inLib ? '<button class="mini-add added">' + Icons.icon('check') + ' In library</button>' : '<button class="mini-add" id="am-single-add">' + Icons.icon('plus') + ' Add</button>') +
          '</div></div>';
        if (!inLib) {
          $('#am-single-add').onclick = function () {
            Store.upsertTrack({ videoId: t.videoId, title: t.title, artist: t.artist, duration: t.duration || 0 });
            this.classList.add('added');
            this.innerHTML = Icons.icon('check') + ' Added';
            toast('Added to your library', 'success');
            render();
          };
        }
        done();
        return;
      }

      if (parsed && parsed.playlistId) { await doImportIntoBox(parsed.playlistId, box); done(); return; }

      // plain text → search
      box.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
      try {
        var res = await Search.search(raw, 8);
        var rows = res.results.map(function (r) {
          return '<div class="mini-row"><img src="' + YouTube.thumbUrl(r.videoId) + '" alt="">' +
            '<div><div class="m-t">' + esc(r.title) + '</div><div class="m-a">' + esc(r.artist) + '</div></div>' +
            '<button class="mini-add" data-amadd2="' + r.videoId + '" data-title="' + esc(r.title) + '" data-artist="' + esc(r.artist) + '" data-dur="' + (r.duration || 0) + '">' + Icons.icon('plus') + ' Add</button></div>';
        }).join('');
        box.innerHTML = '<div class="mini-results">' + rows + '</div>';
        box.querySelectorAll('[data-amadd2]').forEach(function (b) {
          b.addEventListener('click', function () {
            Store.upsertTrack({ videoId: b.getAttribute('data-amadd2'), title: b.getAttribute('data-title'), artist: b.getAttribute('data-artist'), duration: Number(b.getAttribute('data-dur')) });
            b.classList.add('added');
            b.innerHTML = Icons.icon('check') + ' Added';
          });
        });
      } catch (e) {
        box.innerHTML = '<p class="set-note" style="color:#fca5a5;margin-top:14px">' + esc(e.message) + '</p>';
      }
      done();
    }

    function doImportIntoBox(playlistId, box) {
      box.innerHTML = '<div class="spinner" style="margin:20px auto"></div><p class="set-note" style="text-align:center">Fetching playlist…</p>';
      return Search.importPlaylist(playlistId).then(function (res) {
        box.innerHTML = '<p class="set-note" style="margin-top:14px">Found <b style="color:var(--text)">' + esc(res.name) + '</b> — ' + res.tracks.length + ' songs.</p>' +
          '<div class="modal-actions"><button class="btn btn-accent" id="am-import-go">' + Icons.icon('download') + ' Import as new playlist</button></div>';
        $('#am-import-go').onclick = function () {
          // Batched: 3 saves total instead of one per track (per-track saves
          // re-serialized the whole library and froze the page on import).
          var col = Store.createCollection(res.name, 'playlist');
          Store.upsertMany(res.tracks);
          Store.addManyToCollection(col.id, res.tracks.map(function (t) { return t.videoId; }));
          closeModal();
          toast('Imported ' + res.tracks.length + ' songs into “' + res.name + '”', 'success');
          navigate('collection', { id: col.id });
        };
      }).catch(function (e) {
        box.innerHTML = '<p class="set-note" style="color:#fca5a5;margin-top:14px">' + esc(e.message) + '</p>';
      });
    }
  }

  /* ---------------- import playlist modal ---------------- */
  function openImportModal(prefillId, prefillTitle) {
    openModal(
      '<h3>Import a YouTube playlist</h3>' +
      '<p class="set-note" style="margin-top:-6px">Paste a playlist link — from youtube.com or music.youtube.com. Every song becomes playable in MeatyBeatz.</p>' +
      '<div style="display:flex;gap:8px;margin-top:14px"><input class="text-input" id="ip-url" placeholder="https://www.youtube.com/playlist?list=PL…" style="flex:1"><button class="btn btn-accent" id="ip-go">Fetch</button></div>' +
      '<div id="ip-results"></div>',
      { swipeClose: true }
    );
    var inp = $('#ip-url');
    function setFetching(busy) {
      var b = $('#ip-go');
      if (!b) return;
      b.disabled = busy;
      b.style.opacity = busy ? '.6' : '';
      b.textContent = busy ? 'Fetching…' : 'Fetch';
    }
    function doFetch(playlistId, knownName) {
      var box = $('#ip-results');
      box.innerHTML = '<div class="spinner" style="margin:20px auto"></div><p class="set-note" style="text-align:center">Fetching playlist…</p>';
      setFetching(true);
      Search.importPlaylist(playlistId, knownName).then(function (res) {
        setFetching(false);
        box.innerHTML = '<p class="set-note" style="margin-top:14px">Found <b style="color:var(--text)">' + esc(res.name) + '</b> — ' + res.tracks.length + ' songs.</p>' +
          '<div class="modal-actions"><button class="btn btn-accent" id="ip-go2">' + Icons.icon('download') + ' Import as new playlist</button></div>';
        $('#ip-go2').onclick = function () {
          // Batched: 3 saves total instead of one per track (per-track saves
          // re-serialized the whole library and froze the page on import).
          var col = Store.createCollection(res.name, 'playlist');
          Store.upsertMany(res.tracks);
          Store.addManyToCollection(col.id, res.tracks.map(function (t) { return t.videoId; }));
          closeModal();
          toast('Imported ' + res.tracks.length + ' songs into “' + res.name + '”', 'success');
          navigate('collection', { id: col.id });
        };
      }).catch(function (e) {
        setFetching(false);
        box.innerHTML = '<p class="set-note" style="color:#fca5a5;margin-top:14px">' + esc(e.message) + '</p>';
      });
    }
    function go() {
      var parsed = YouTube.parseYouTubeUrl(inp.value);
      if (!parsed || !parsed.playlistId) { toast('That doesn’t look like a playlist link', 'error'); return; }
      doFetch(parsed.playlistId);
    }
    $('#ip-go').onclick = go;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    setTimeout(function () {
      var n = $('#ip-url');
      if (!n) return;
      n.focus();
      if (prefillId) { n.value = 'https://www.youtube.com/playlist?list=' + prefillId; doFetch(prefillId, prefillTitle || null); }
    }, 30);
  }

  /* ---------------- settings modal ---------------- */
  function openSettingsModal() {
    var insts = Search.instances();
    var customs = Store.getSettings().customInstances;
    var ext = Store.getSettings().extractor || 'auto';
    // INVIDIOUS_BASE is a function that resolves the default URL — it must be
    // CALLED, not stringified (an old bug rendered its source code into this field).
    var invDefault = 'http://localhost:3010';
    try {
      if (window.YouTube && typeof window.YouTube.INVIDIOUS_BASE === 'function') invDefault = String(window.YouTube.INVIDIOUS_BASE());
      else if (window.YouTube && typeof window.YouTube.INVIDIOUS_BASE === 'string' && window.YouTube.INVIDIOUS_BASE) invDefault = window.YouTube.INVIDIOUS_BASE;
    } catch (e) { /* keep the fallback */ }
    // Only show a stored value that actually looks like a URL. A buggy version
    // of this screen could have saved something else here — self-heal by clearing it.
    var rawInv = (Store.getSettings().invidiousUrl || '').trim();
    var invUrl = '';
    if (rawInv) {
      if (/^https?:\/\//i.test(rawInv)) invUrl = rawInv.replace(/\/+$/, '');
      else Store.setSettings({ invidiousUrl: '' });
    }
    var rows = insts.map(function (x, i) {
      var isCustom = customs.some(function (c) { return c.base === x.base; });
      return '<div class="inst-row"><span class="dot" id="sdot-' + i + '"></span><span class="inst-name">' + esc(x.name) + '</span>' +
        '<span class="inst-kind">' + x.kind + (isCustom ? ' • custom' : '') + '</span><span class="inst-ms" id="sms-' + i + '"></span>' +
        (isCustom ? '<button class="icon-btn" data-rm-inst="' + i + '" title="Remove instance">' + Icons.icon('close') + '</button>' : '') +
        '</div>';
    }).join('');

    openModal(
      '<h3>Settings</h3>' +
      '<div class="set-block"><div class="set-title">Extractor</div>' +
        '<div class="seg" id="st-extractor">' +
          '<button data-ext="auto"' + (ext === 'auto' ? ' class="active"' : '') + '>Auto</button>' +
          '<button data-ext="builtin"' + (ext === 'builtin' ? ' class="active"' : '') + '>Built-in</button>' +
          '<button data-ext="invidious"' + (ext === 'invidious' ? ' class="active"' : '') + '>Invidious</button>' +
        '</div>' +
        '<p class="set-note"><b>Auto</b> tries both routes at once and uses whichever answers first. <b>Built-in</b> talks to YouTube directly (local proxy: <span id="st-proxy">…</span>). <b>Invidious</b> uses only the instance below (field above).</p>' +
      '</div>' +
       '<div class="set-block"><div class="set-title">Invidious instance</div>' +
         '<input class="text-input" id="st-inv-url" spellcheck="false" placeholder="' + esc(invDefault) + '" value="' + esc(invUrl) + '">' +
         '<p class="set-note">The Invidious instance MeatyBeatz searches and streams through. The default is the bundled instance on this host at port 3010 (auto-detected from the address you opened). Change it only if your instance runs elsewhere — e.g. on another machine or at a different port.</p>' +
         '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn-accent" id="st-inv-save">' + Icons.icon('check') + ' Save</button></div>' +
       '</div>' +
      '<div class="set-block"><div class="set-title">Search instances <button class="btn btn-ghost" id="st-test" style="padding:6px 14px;font-size:12px">' + Icons.icon('refresh') + ' Test all</button></div>' +
        rows +
        '<p class="set-note">MeatyBeatz searches and streams through the Invidious instance above — it stays in sync with playback. If it’s unreachable, MeatyBeatz automatically falls back to the built-in route. You can add extra instances below if you like.</p>' +
        '<div class="add-inst-row"><input class="text-input" id="si-name" placeholder="Name (optional)"><input class="text-input" id="si-url" placeholder="https://… instance URL"><button class="btn btn-accent" id="si-add">' + Icons.icon('plus') + ' Add</button></div>' +
      '</div>' +
      '<div class="set-block"><div class="set-title">Persistence</div>' +
        '<p class="set-note" id="st-disk-status">Checking disk database…</p>' +
        '<p class="set-note">Optional extra (Chrome/Edge): connect a library file and MeatyBeatz rewrites it after every change too.</p>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<span class="set-note" id="st-backup-status">Checking…</span>' +
          '<button class="btn btn-ghost" id="st-backup-btn"></button>' +
        '</div>' +
      '</div>' +
      '<div class="set-block"><div class="set-title">Your data</div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
          '<button class="btn btn-ghost" id="st-export">' + Icons.icon('download') + ' Export backup</button>' +
          '<button class="btn btn-ghost" id="st-import">' + Icons.icon('upload') + ' Import backup</button>' +
          '<input type="file" id="st-import-file" accept="application/json,.json" class="hidden">' +
          '<button class="btn btn-danger" id="st-reset">' + Icons.icon('trash') + ' Reset everything</button>' +
        '</div>' +
        '<p class="set-note">Your library is kept in sync with the disk database (SQLite file) when it’s running, and always in the browser’s IndexedDB as a live copy. “Reset everything” wipes all copies, including a connected library file.</p>' +
      '</div>' +
      '<div class="set-block"><div class="set-title">About</div><p class="set-note">MeatyBeatz searches and streams music through your local Invidious instance — no login, no paid APIs, nothing that blocks playback. If the instance is offline, the built-in YouTube player takes over.</p></div>',
      { swipeClose: true }
    );

    function setDot(i, cls, ms) {
      var d = document.getElementById('sdot-' + i);
      if (d) d.className = 'dot' + (cls ? ' ' + cls : '');
      var m = document.getElementById('sms-' + i);
      if (m) m.textContent = ms || '';
    }

    $$('#st-extractor button').forEach(function (b) {
      b.onclick = function () {
        $$('#st-extractor button').forEach(function (x) { x.classList.toggle('active', x === b); });
        Store.setSettings({ extractor: b.getAttribute('data-ext') });
      };
    });
    if (window.BuiltIn) {
      BuiltIn.pingProxy().then(function (ok) {
        var el = $('#st-proxy');
        if (el) el.textContent = ok ? 'online' : 'offline';
      });
    }

    $('#st-inv-save').onclick = function () {
      var v = $('#st-inv-url').value.trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v; // bare host:port — assume http
      Store.setSettings({ invidiousUrl: v });
      toast('Invidious instance saved — ' + (v || 'default'));
    };

    $('#st-test').onclick = async function () {
      var btn = $('#st-test');
      btn.setAttribute('disabled', '');
      for (var i = 0; i < insts.length; i++) {
        setDot(i, null, '…');
        var r = await Search.ping(i);
        setDot(i, r.ok ? 'ok' : 'bad', r.ms + ' ms');
      }
      btn.removeAttribute('disabled');
    };

    $('#si-add').onclick = function () {
      var url = $('#si-url').value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(url)) { toast('Enter a full URL starting with https://', 'error'); return; }
      var name = $('#si-name').value.trim();
      if (!name) { try { name = new URL(url).hostname; } catch (e) { name = url; } }
      var inst = { name: name, base: url, kind: Search.detectKind(url) };
      Store.setSettings({ customInstances: Store.getSettings().customInstances.concat([inst]) });
      toast('Added instance “' + name + '”', 'success');
      closeModal(); openSettingsModal();
    };

    $$('#modal-root [data-rm-inst]').forEach(function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-rm-inst'));
        var target = Search.instances()[i];
        if (!target) return;
        Store.setSettings({ customInstances: Store.getSettings().customInstances.filter(function (c) { return c.base !== target.base; }), instanceOffset: 0 });
        closeModal(); openSettingsModal();
      };
    });

    $('#st-export').onclick = function () {
      var blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'meatybeatz-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast('Backup downloaded', 'success');
    };
    $('#st-import').onclick = function () { $('#st-import-file').click(); };
    $('#st-import-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        var ok = Store.importJSON(String(rd.result));
        toast(ok ? 'Backup imported — reloading…' : 'Import failed: not a valid MeatyBeatz backup', ok ? 'success' : 'error');
        setTimeout(function () { location.reload(); }, ok ? 900 : 1600);
      };
      rd.readAsText(f);
    });
    $('#st-reset').onclick = function () {
      confirmModal('Reset MeatyBeatz?', 'This deletes every track, playlist, genre and setting from this browser. This cannot be undone.', function () {
        Store.resetAll();
        location.reload();
      }, true);
    };

    paintBackupStatus();
    paintDiskStatus();
    Store.diskPing().then(paintDiskStatus); // re-check — the server may have started after page load

    $('#st-backup-btn').onclick = function () {
      var btn = $('#st-backup-btn');
      var mode = btn.getAttribute('data-mode') || 'connect';
      var done = function () { paintBackupStatus(); };
      if (mode === 'connect') {
        Store.connectBackupFile().then(function () {
          toast('Library file connected — every change is saved to it automatically', 'success');
          done();
        }).catch(function (e) { if (e && e.name !== 'AbortError') toast('Could not connect the file: ' + e.message, 'error'); });
      } else if (mode === 'reauth') {
        Store.reauthorizeBackupFile().then(function (ok) {
          toast(ok ? 'Library file reconnected' : 'Connection not granted', ok ? 'success' : 'error');
          done();
        });
      } else {
        Store.disconnectBackupFile().then(function () {
          toast('Library file disconnected', 'info');
          done();
        });
      }
    };
  }

  function paintBackupStatus() {
    var el = $('#st-backup-status'), btn = $('#st-backup-btn');
    if (!el || !btn) return;
    var st = Store.backupStatus();
    if (!st.supported) {
      el.textContent = 'Auto file backup needs Chrome or Edge — in other browsers use Export/Import below.';
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    if (!st.connected) {
      el.textContent = 'No library file connected yet.';
      btn.innerHTML = Icons.icon('upload') + ' Connect file…';
      btn.setAttribute('data-mode', 'connect');
    } else if (st.permission === 'granted') {
      el.textContent = 'Connected — your library is saved to this file automatically after every change.';
      btn.innerHTML = Icons.icon('close') + ' Disconnect';
      btn.setAttribute('data-mode', 'disconnect');
    } else {
      el.textContent = 'Click to reconnect your library file (the browser reset its permission).';
      btn.innerHTML = Icons.icon('upload') + ' Reconnect…';
      btn.setAttribute('data-mode', 'reauth');
    }
  }

  function paintDiskStatus() {
    var el = $('#st-disk-status');
    if (!el) return;
    var st = Store.diskStatus();
    el.innerHTML = st.online
      ? '<b style="color:#4ade80">● Disk database online</b> — your library is saved to the real SQLite file <code>' + esc(st.file) + '</code> after every change. It lives on your disk, outside the browser, and survives clearing cookies or site data.'
      : '<b style="color:#fca5a5">● Disk database offline</b> — start it with <code>node db-server.js</code>, then reload this page. Until then your library is kept in IndexedDB (which clearing cookies also does not touch).';
  }

  /* ---------------- action router ---------------- */
  function handleAction(action, el) {
    var id = el.getAttribute('data-id');
    switch (action) {
      case 'nav': navigate(el.getAttribute('data-view')); break;
      case 'nav-tab': navigate(el.getAttribute('data-view'), { tab: el.getAttribute('data-tab') }); break;
      case 'lib-tab': state.libraryTab = el.getAttribute('data-tab'); render(); break;
      case 'open-collection': navigate('collection', { id: id }); break;
      case 'open-liked': navigate('library', { tab: 'liked' }); break;
      case 'open-liked-albums': navigate('library', { tab: 'liked-albums' }); break;
      case 'toggle-side-group': {
        var gk = el.getAttribute('data-group');
        var sc = Store.getSettings().sideCollapsed || {};
        sc[gk] = !sc[gk];
        Store.setSettings({ sideCollapsed: sc });
        renderSidebar();
        break;
      }

      case 'open-artist': navigate('artist', { id: id }); break;
      case 'open-album': navigate('album', { id: id }); break;
      case 'back-search': state.view = 'search'; render(); $('#main').scrollTop = 0; break;
      case 'retry-artist': if (state.artistId) loadArtist(state.artistId); break;
      case 'retry-album': if (state.albumId) loadAlbum(state.albumId); break;

      case 'play-album': {
        var al1 = state.albumData;
        if (al1 && al1.tracks.length) {
          var ameta = {};
          al1.tracks.forEach(function (t) { ameta[t.videoId] = t; });
          playContext(al1.tracks.map(function (t) { return t.videoId; }), 0, 'Album: ' + al1.title, ameta);
        }
        break;
      }
      case 'shuffle-album': {
        var al2 = state.albumData;
        if (al2 && al2.tracks.length) {
          setShuffle(true);
          var ameta2 = {};
          al2.tracks.forEach(function (t) { ameta2[t.videoId] = t; });
          playContext(al2.tracks.map(function (t) { return t.videoId; }), 0, 'Album: ' + al2.title, ameta2);
        }
        break;
      }

      case 'play-track': {
        var ids = state.ctx.ids || [];
        var idx = ids.indexOf(id);
        if (idx === -1) { ensureTrack(id); playContext([id], 0, ''); }
        else playContext(ids, idx, state.ctx.label, state.ctx.meta);
        break;
      }
      case 'play-liked': {
        var lids = Store.likedIds().filter(function (x) { return Store.getTrack(x); });
        if (!lids.length) { toast('No liked songs yet — tap the heart on any track', 'info'); break; }
        playContext(lids, 0, 'Liked Songs');
        break;
      }
      case 'shuffle-liked': {
        var lids2 = Store.likedIds().filter(function (x) { return Store.getTrack(x); });
        if (!lids2.length) { toast('No liked songs yet — tap the heart on any track', 'info'); break; }
        setShuffle(true);
        playContext(lids2, 0, 'Liked Songs');
        break;
      }
      case 'play-collection': {
        var c1 = Store.collection(id);
        if (!c1) break;
        var ids2 = c1.trackIds.filter(function (x) { return Store.getTrack(x); });
        if (!ids2.length) { toast('This ' + c1.type + ' is empty', 'info'); break; }
        playContext(ids2, 0, (c1.type === 'genre' ? 'Genre: ' : 'Playlist: ') + c1.name);
        break;
      }
      case 'shuffle-collection': {
        var c2 = Store.collection(id);
        if (!c2) break;
        var ids3 = c2.trackIds.filter(function (x) { return Store.getTrack(x); });
        if (!ids3.length) { toast('This ' + c2.type + ' is empty', 'info'); break; }
        setShuffle(true);
        playContext(ids3, 0, (c2.type === 'genre' ? 'Genre: ' : 'Playlist: ') + c2.name);
        break;
      }

      case 'like': {
        ensureTrack(id);
        var nowL = Store.toggleLike(id);
        el.innerHTML = Icons.icon(nowL ? 'heartFill' : 'heart');
        el.classList.toggle('on', nowL);
        if (currentId() === id) updateLikeBtn();
        renderSidebar();
        if (state.view === 'library' && state.libraryTab === 'liked') render();
        break;
      }
      case 'like-album': {
        // Album cards carry data-id + metadata attributes; the album-page
        // header button carries neither, so fall back to the open album.
        var bid = el.getAttribute('data-id') || (state.view === 'album' ? state.albumId : null);
        if (!bid) break;
        var saved = null;
        Store.likedAlbums().forEach(function (a) { if (a.browseId === bid) saved = a; });
        var src = (state.view === 'album' && state.albumData) ? state.albumData : null;
        var nowA = Store.toggleLikedAlbum({
          browseId: bid,
          title: el.getAttribute('data-title') || (src && src.title) || (saved && saved.title) || 'Unknown album',
          artist: el.getAttribute('data-artist') || (src && src.artist) || (saved && saved.artist) || '',
          year: el.getAttribute('data-year') || (src && src.year) || (saved && saved.year) || '',
          thumbnail: el.getAttribute('data-thumb') || (src && src.thumbnail) || (saved && saved.thumbnail) || ''
        });
        if (el.classList.contains('card-like')) { // keep the clicked card's button in sync without a full re-render
          el.innerHTML = Icons.icon(nowA ? 'heartFill' : 'heart');
          el.classList.toggle('on', nowA);
          el.title = nowA ? 'Remove from Liked Albums' : 'Save to Liked Albums';
        }
        renderSidebar();
        if (state.view === 'album') render();
        else if (state.view === 'library' && state.libraryTab === 'liked-albums') render();
        break;
      }
      case 'add-popover': openAddPopover(el, id); break;

      case 'remove-track': {
        if (state.view === 'collection' && state.collectionId) {
          Store.removeFromCollection(state.collectionId, id);
          render();
        }
        break;
      }

      case 'new-collection': openCreateModal(el.getAttribute('data-type') || 'playlist', null); break;
      case 'add-music': openAddMusicModal(); break;
      case 'import-playlist': openImportModal(null); break;
      case 'settings': openSettingsModal(); break;
      case 'edit-collection': openEditModal(id); break;
      case 'chip-search': state.query = el.getAttribute('data-q'); runSearch(state.query); break;

      case 'play-link': {
        var info2 = Store.getTrack(id) || state.linkInfo || { videoId: id, title: 'YouTube video', artist: 'Unknown artist' };
        Store.upsertTrack(info2);
        playContext([id], 0, '');
        break;
      }
      case 'add-link': {
        var info3 = state.linkInfo || { videoId: id, title: 'YouTube video', artist: 'Unknown artist' };
        Store.upsertTrack(info3);
        toast('Added to your library', 'success');
        render();
        break;
      }
      case 'import-link': openImportModal(id, el.getAttribute('data-title') || null); break;

      default: break;
    }
  }

  /* ---------------- init & wiring ---------------- */
  function init() {
    $('#logo-icon').innerHTML = Icons.icon('note');
    setPlayIcon(false);
    updateShuffleBtn();
    updateRepeatBtn();

    var v = Store.getSettings().volume;
    lastVolBeforeMute = v || 80;
    applyVolume(v, false);

    // main + sidebar click delegation
    $('#main').addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      handleAction(el.getAttribute('data-action'), el);
    });
    $('#sidebar').addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      handleAction(el.getAttribute('data-action'), el);
    });

    // search input (bound after each render creates it — use delegation on main)
    $('#main').addEventListener('input', function (e) {
      if (e.target && e.target.id === 'search-input') onSearchInput(e.target.value);
    });
    $('#main').addEventListener('keydown', function (e) {
      if (e.target && e.target.id === 'search-input' && e.key === 'Enter') {
        clearTimeout(searchTimer);
        runSearch(e.target.value.trim());
      }
    });

    // player bar
    $('#btn-play').addEventListener('click', function () {
      var id = currentId();
      if (!id) {
        var lids = Store.likedIds().filter(function (x) { return Store.getTrack(x); });
        if (lids.length) { playContext(lids, 0, 'Liked Songs'); return; }
        var cols = Store.collections();
        for (var i = 0; i < cols.length; i++) {
          var ids = cols[i].trackIds.filter(function (x) { return Store.getTrack(x); });
          if (ids.length) { playContext(ids, 0, (cols[i].type === 'genre' ? 'Genre: ' : 'Playlist: ') + cols[i].name); return; }
        }
        toast('Add some music first — search or paste a link', 'info');
        return;
      }
      YTPlayer.toggle();
    });
    $('#btn-next').addEventListener('click', nextTrack);
    $('#btn-prev').addEventListener('click', prevTrack);
    $('#btn-shuffle').addEventListener('click', function () {
      var next = !Store.getSettings().shuffle;
      setShuffle(next);
      toast(next ? 'Shuffle on' : 'Shuffle off', 'info');
    });
    $('#btn-repeat').addEventListener('click', cycleRepeat);
    $('#pb-like').addEventListener('click', function () {
      var id = currentId();
      if (!id) { toast('Nothing playing', 'info'); return; }
      var nowL = Store.toggleLike(id);
      updateLikeBtn(); renderSidebar();
      toast(nowL ? 'Added to Liked Songs' : 'Removed from Liked Songs', nowL ? 'success' : 'info');
    });
    $('#btn-queue').addEventListener('click', toggleQueuePanel);
    $('#vol').addEventListener('input', function () { applyVolume(Number(this.value), false); });
    $('#vol').addEventListener('change', function () { Store.setSettings({ volume: Number(this.value) }); });
    // Phones: the button opens the slim vertical volume popout (#vol is
    // hidden there). Desktop keeps the direct mute toggle.
    $('#btn-mute').addEventListener('click', function () {
      if (isPhone()) {
        var open = !!$('#popover-root .vol-pop');
        if (open) closePopover(); else openVolPopout(this);
      } else toggleMute();
    });

    // seekbar
    $('#seekbar').addEventListener('pointerdown', function (e) {
      if (!currentId()) return;
      seeking = true;
      try { $('#seekbar').setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      paintSeek(seekFracFromEvent(e));
    });
    $('#seekbar').addEventListener('pointermove', function (e) { if (seeking) paintSeek(seekFracFromEvent(e)); });
    $('#seekbar').addEventListener('pointerup', function (e) {
      if (!seeking) return;
      seeking = false;
      var d = YTPlayer.duration();
      if (d > 0) YTPlayer.seek(seekFracFromEvent(e) * d);
    });

    // keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.code === 'Space') { e.preventDefault(); $('#btn-play').click(); }
      else if (e.key === '/') { e.preventDefault(); navigate('search'); }
      else if (e.key === 'Escape') {
        closePopover(); closeModal();
        var qp = $('#queue-panel');
        if (!qp.classList.contains('hidden')) qp.classList.add('hidden');
      }
    });

    // progress polling
    setInterval(function () {
      if (!YTPlayer.isReady()) return;
      if (YTPlayer.getState() === 'playing') {
        var t = YTPlayer.time(), d = YTPlayer.duration();
        if (d > 0) {
          $('#time-dur').textContent = fmtTime(d);
          if (!seeking) {
            $('#seek-fill').style.width = (t / d * 100) + '%';
            $('#seek-thumb').style.left = (t / d * 100) + '%';
            $('#time-cur').textContent = fmtTime(t);
          }
        }
      }
    }, 500);

    // Storage sync: store.js adopts the newer of (localStorage, IndexedDB,
    // library file) after load — re-render so the restored library shows up.
    window.addEventListener('store-synced', function (e) {
      render();
      if (e.detail && e.detail.source === 'backup-file') toast('Library restored from your library file', 'success');
    });

    // YouTube player
    YTPlayer.init({
      onState: onPlayerState,
      onError: onPlayerError,
      onFail: function (err) { toast('YouTube player unavailable — ' + err.message, 'error'); }
    });

    render();
  }

  init();
})();
