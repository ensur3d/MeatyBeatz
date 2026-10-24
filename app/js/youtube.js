/* MeatyBeatz — youtube.js : playback engine + URL parsing
   Primary engine: direct audio streams from the local Invidious instance
   (<this host>:3010) played in a native <audio> element — plays any video,
   no embedding restrictions. Fallback engine: the built-in YouTube IFrame
   Player API, used automatically whenever the instance is unreachable. */
(function () {
  'use strict';

  /* Local Invidious (bundled in the docker stack, port 3010). The default is
     derived from the address the app was opened with — <this-host>:3010 — so
     LAN access works with zero configuration. Change it in Settings →
     "Invidious instance" without touching code. */
  function invBaseDefault() {
    var h = '';
    try { h = location.hostname; } catch (e) { /* no location — use fallback */ }
    return 'http://' + (h || 'localhost') + ':3010';
  }
  function invBase() {
    try {
      var s = window.Store && Store.getSettings().invidiousUrl;
      // Only accept values that look like URLs: a buggy version of the settings
      // screen could have stored other text here, which must not break playback.
      if (s && /^https?:\/\//i.test(String(s).trim())) return String(s).trim().replace(/\/+$/, '');
    } catch (e) { /* settings unavailable — use default */ }
    return invBaseDefault();
  }
  var STREAM_TIMEOUT_MS = 8000;   // how long to wait for a stream URL
  var INV_DOWN_COOLDOWN_MS = 60000; // after a failure, skip the instance briefly

  /* ---------- URL parsing ---------- */
  var ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function parseYouTubeUrl(str) {
    str = String(str || '').trim();
    if (!str) return null;
    // bare video id?
    if (ID_RE.test(str)) return { videoId: str };

    var m;
    // normalize protocol-less input
    if (!/^https?:\/\//i.test(str)) str = 'https://' + str;
    try {
      var u = new URL(str);
      var host = (u.hostname || '').toLowerCase().replace(/^www\.|^m\.|^music\./, '');
      if (host !== 'youtube.com' && host !== 'youtu.be') return null;

      // youtu.be/ID
      if (host === 'youtu.be') {
        var id1 = u.pathname.slice(1).split('/')[0];
        if (ID_RE.test(id1)) return { videoId: id1 };
        return null;
      }
      // ?v=ID  or  /embed/ID  or  /shorts/ID  or  /live/ID
      var v = u.searchParams.get('v');
      if (v && ID_RE.test(v)) {
        var list = u.searchParams.get('list');
        return { videoId: v, playlistId: list || null };
      }
      m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) {
        var list2 = u.searchParams.get('list');
        return { videoId: m[1], playlistId: list2 || null };
      }
      // playlist only: ?list=PL...
      var pl = u.searchParams.get('list');
      if (pl && /^[A-Za-z0-9_-]{6,}$/.test(pl)) return { videoId: null, playlistId: pl };
      return null;
    } catch (e) {
      return null;
    }
  }

  function thumbUrl(videoId, quality) {
    var q = quality || 'mqdefault'; // mqdefault | hqdefault | maxresdefault
    return 'https://i.ytimg.com/vi/' + videoId + '/' + q + '.jpg';
  }

  /* ---------- shared state ---------- */
  var handlers = {};
  var state = 'idle'; // idle | loading | playing | paused | buffering | ended
  var lastVideoId = null;
  var lastVolume = 80;
  var engine = null;      // 'audio' | 'iframe' — which engine drives the current track

  // lightweight debug hook (console / tests): which engine is driving playback,
  // and how many times an engine switch stopped the built-in player (regression:
  // a track left playing in the background after skipping — "ghost playback").
  window.__wt = {
    get engine() { return engine; },
    get videoId() { return lastVideoId; },
    get invDownAt() { return invDownAt; },
    get iframeStops() { return iframeStopCount; }
  };

  /* ================================================================
     ENGINE A — Invidious audio stream in a native <audio> element
     ================================================================ */
  var audio = null;          // HTMLAudioElement (created lazily)
  var audioVideoId = null;   // video id behind the current src
  var audioRetried = false;  // this track already got one stream retry
  var invDownAt = 0;         // when the instance last failed (cooldown gate)

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  /* Ask the local Invidious instance for a playable audio stream URL.
     Errors carry `videoLevel = true` when the instance answered but THIS video
     is unavailable (404 / age-restricted / no audio format). Those must not set
     the instance cooldown — only network failures, timeouts and 5xx mean the
     instance itself is down. */
  function invStreamUrl(videoId) {
    return withTimeout(fetch(invBase() + '/api/v1/videos/' + videoId, { headers: { 'Accept': 'application/json' } }), STREAM_TIMEOUT_MS).then(function (r) {
      if (!r.ok) {
        var err = new Error('Invidious HTTP ' + r.status);
        if (r.status < 500) err.videoLevel = true; // instance answered: problem is this video
        throw err;
      }
      return r.json();
    }).then(function (j) {
      if (!j || j.error) { var e2 = new Error(String(j && j.error || 'no stream data')); e2.videoLevel = true; throw e2; }
      var fmts = [].concat(j.formats || [], j.adaptiveFormats || [])
        .filter(function (f) { return f.url && f.type && f.type.indexOf('audio') === 0; });
      if (!fmts.length) { var e3 = new Error('no audio stream for this video'); e3.videoLevel = true; throw e3; }
      // Prefer m4a/mp4 (widest browser support), then highest bitrate.
      fmts.sort(function (a, b) {
        var am = /mp4|m4a/i.test(a.type) ? 1 : 0;
        var bm = /mp4|m4a/i.test(b.type) ? 1 : 0;
        if (am !== bm) return bm - am;
        return (b.bitrate || 0) - (a.bitrate || 0);
      });
      return fmts[0].url;
    });
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    audio.volume = lastVolume / 100;

    audio.addEventListener('playing', function () {
      if (engine !== 'audio') return;
      state = 'playing';
      if (handlers.onState) handlers.onState(1);
    });
    audio.addEventListener('pause', function () {
      if (engine !== 'audio' || audio.ended) return;
      state = 'paused';
      if (handlers.onState) handlers.onState(2);
    });
    audio.addEventListener('ended', function () {
      if (engine !== 'audio') return;
      state = 'ended';
      if (handlers.onState) handlers.onState(0);
    });
    audio.addEventListener('waiting', function () {
      if (engine !== 'audio' || state === 'paused') return;
      state = 'buffering';
      if (handlers.onState) handlers.onState(3);
    });
    audio.addEventListener('error', onAudioError);
    return audio;
  }

  /* Stream died or never started: one retry, then the built-in iframe. */
  function onAudioError() {
    if (engine !== 'audio' || !audioVideoId) return;
    var vid = audioVideoId;
    var t = audio.currentTime || 0;
    // Clear the src so the error state doesn't linger / re-fire.
    try { audio.removeAttribute('src'); } catch (e) { /* ignore */ }
    if (audioRetried) { useIframeEngine(vid, t); return; }
    audioRetried = true;
    invStreamUrl(vid).then(function (url) {
      if (lastVideoId !== vid || engine !== 'audio') return;
      var a = ensureAudio();
      audioVideoId = vid;
      a.src = url;
      if (t > 1) { try { a.currentTime = t; } catch (e) { /* ignore */ } }
      a.play().catch(function () { useIframeEngine(vid, t); });
    }).catch(function (e) {
      if (!(e && e.videoLevel)) invDownAt = Date.now(); // only instance-level failures set the cooldown
      console.warn('MeatyBeatz: audio stream failed (' + (e && e.message || String(e)) + ') — using built-in player');
      useIframeEngine(vid, t);
    });
  }

  function startAudio(videoId) {
    engine = 'audio';
    state = 'loading';
    // If the previous track was on the built-in player (fallback), stop it —
    // otherwise it keeps playing in the background under the new stream. The
    // ENDED event this emits is ignored: onStateChange only acts while
    // engine === 'iframe'.
    if (player && ready) { try { player.stopVideo(); iframeStopCount++; } catch (e) { /* noop */ } }
    if (handlers.onState) handlers.onState(3); // buffering while the URL is fetched
    invStreamUrl(videoId).then(function (url) {
      if (lastVideoId !== videoId || engine !== 'audio') return; // superseded
      var a = ensureAudio();
      audioVideoId = videoId;
      a.src = url;
      a.play().catch(function () { useIframeEngine(videoId, 0); });
    }).catch(function (e) {
      if (lastVideoId !== videoId) return;
      var msg = (e && e.message || String(e));
      if (e && e.videoLevel) {
        // Instance is healthy; only this video is unavailable. Try the embed
        // without poisoning the cooldown for every other track.
        console.warn('MeatyBeatz: no stream for this video (' + msg + ') — trying built-in player');
        useIframeEngine(videoId, 0);
      } else {
        invDownAt = Date.now();
        console.warn('MeatyBeatz: local Invidious unavailable (' + msg + ') — using built-in player');
        useIframeEngine(videoId, 0);
      }
    });
  }

  /* ================================================================
     ENGINE B — built-in YouTube IFrame Player (fallback)
     ================================================================ */
  var player = null;
  var ready = false;
  var apiWarned = false;
  var pendingVideoId = null; // play() routed to the iframe before it was ready
  var apiPollTimer = null;
  var iframeSawBuffering = false; // buffering observed for the current cue (resets per cue)
  var iframeWatchdog = null;     // fires when the embed stalls in loading/buffering
  var iframeStopCount = 0;       // engine switches that stopped the built-in player (via __wt)

  // Unavailable videos do not always fire onPlaybackError — some just report
  // buffering and then drop back to "unstarted" (-1), or stall silently. Surface
  // both shapes as errors so the app's bounded skip logic can take over.
  function armIframeWatchdog() {
    if (iframeWatchdog) clearTimeout(iframeWatchdog);
    iframeWatchdog = setTimeout(function () {
      iframeWatchdog = null;
      if (engine === 'iframe' && lastVideoId && (state === 'loading' || state === 'buffering')) {
        console.warn('MeatyBeatz: embedded player stalled — treating track as unavailable');
        state = 'idle';
        if (handlers.onError) handlers.onError(2);
      }
    }, 20000);
  }
  function disarmIframeWatchdog() {
    if (iframeWatchdog) { clearTimeout(iframeWatchdog); iframeWatchdog = null; }
  }

  function createPlayer() {
    if (player) return; // already created
    try {
      player = new YT.Player('yt-player', {
        width: '1',
        height: '1',
        // NOTE: do NOT pass videoId here — even `videoId: null` makes the API
        // throw "Invalid video id" (String(null) = "null"), and it leaves a
        // src-less iframe behind that never fires onReady. The player starts
        // empty; play() cues the first real video.
        playerVars: {
          controls: 0,
          disablekb: 1,
          playsinline: 1,
          rel: 0,
          iv_load_policy: 3,
          fs: 0,
          modestbranding: 1
        },
        events: {
          onReady: function () {
            ready = true;
            player.setVolume(lastVolume);
            // a play() request may have arrived before the player existed — fulfil it now.
            // Only while the iframe is still THE engine: if playback has since moved to
            // the audio engine, loading this video would start a second, ghost copy.
            if (pendingVideoId && pendingVideoId === lastVideoId && engine === 'iframe') {
              var id = pendingVideoId;
              pendingVideoId = null;
              state = 'loading';
              try { player.loadVideoById(id); } catch (e) { console.warn('queued play failed', e); }
            }
          },
          onStateChange: function (e) {
            if (engine !== 'iframe') return; // audio engine is driving — ignore
            switch (e.data) {
              case -5: // unplayable
                state = 'idle';
                if (handlers.onError) handlers.onError(150);
                break;
              case -1: // unstarted — after buffering this means the video is unavailable
                if (lastVideoId && iframeSawBuffering) {
                  disarmIframeWatchdog();
                  iframeSawBuffering = false;
                  console.warn('MeatyBeatz: embedded player dropped to unstarted — treating track as unavailable');
                  state = 'idle';
                  if (handlers.onError) handlers.onError(2);
                } else {
                  armIframeWatchdog();
                }
                break;
              case 0: state = 'ended'; disarmIframeWatchdog(); if (handlers.onState) handlers.onState(e.data); break;
              case 1: state = 'playing'; iframeSawBuffering = false; disarmIframeWatchdog(); if (handlers.onState) handlers.onState(e.data); break;
              case 2: state = 'paused'; if (handlers.onState) handlers.onState(e.data); break;
              case 3: state = 'buffering'; iframeSawBuffering = true; armIframeWatchdog(); if (handlers.onState) handlers.onState(e.data); break;
              case 5: state = 'cued'; if (handlers.onState) handlers.onState(e.data); break;
              default: if (handlers.onState) handlers.onState(e.data);
            }
          },
          onPlaybackError: function (code) {
            // 2 invalid, 5 html5 error, 100 not found, 101/embed blocked, 150 embed disabled
            if (engine !== 'iframe') return;
            state = 'idle';
            if (handlers.onError) handlers.onError(code);
          }
        }
      });
    } catch (err) {
      console.error('MeatyBeatz: failed to create YouTube player', err);
      // The API may have replaced #yt-player with a broken iframe before
      // throwing — restore a clean anchor so the next retry can succeed.
      try {
        var broken = document.getElementById('yt-player');
        if (broken && broken.tagName === 'IFRAME') {
          var d = document.createElement('div');
          d.id = 'yt-player';
          broken.parentNode.replaceChild(d, broken);
        }
      } catch (e2) { /* ignore */ }
      if (handlers.onFail) handlers.onFail(err);
    }
  }

  function apiIsLoaded() {
    return !!(window.YT && window.YT.Player);
  }

  function useIframeEngine(videoId, fromTime) {
    engine = 'iframe';
    // If the previous track was on the <audio> element, stop it — otherwise it
    // keeps playing under the embed. The pause/error events this emits are
    // ignored: the audio handlers only act while engine === 'audio'.
    if (audio) { try { audio.pause(); audio.removeAttribute('src'); } catch (e) { /* noop */ } }
    state = 'loading';
    iframeSawBuffering = false;
    armIframeWatchdog();
    if (handlers.onState) handlers.onState(3);
    if (!player || !ready) {
      pendingVideoId = videoId; // onReady will load it once the API is up
      return;
    }
    try {
      player.loadVideoById(videoId, fromTime > 1 ? fromTime : undefined);
    } catch (e) { console.warn('iframe play failed', e); }
  }

  /* ================================================================
     Public player API (engine-agnostic)
     ================================================================ */
  function init(h) {
    handlers = h || {};

    window.onYouTubeIframeAPIReady = function () {
      createPlayer();
    };

    if (!apiIsLoaded()) {
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      document.head.appendChild(s);
    }

    // Retry loop: keep trying until the player exists (max ~15 s). Covers the
    // one-shot onYouTubeIframeAPIReady race, slow API loads and constructor
    // failures alike. createPlayer() is idempotent.
    var waited = 0;
    apiPollTimer = setInterval(function () {
      waited += 250;
      if (player) { clearInterval(apiPollTimer); apiPollTimer = null; return; }
      if (apiIsLoaded()) createPlayer();
      if (waited >= 15000) { clearInterval(apiPollTimer); apiPollTimer = null; }
    }, 250);

    // Watchdog: only meaningful when BOTH engines are out — the iframe never
    // came up AND the local Invidious instance is unreachable.
    setTimeout(function () {
      if (!ready && invDownAt > 0 && !apiWarned) {
        apiWarned = true;
        if (handlers.onFail) handlers.onFail(new Error('player unavailable — check your internet connection or refresh the page.'));
      }
    }, 15000);
  }

  function play(videoId) {
    if (!videoId) return;
    lastVideoId = videoId;
    audioRetried = false;
    iframeSawBuffering = false;
    disarmIframeWatchdog();
    // Primary path: direct audio stream from the local Invidious instance.
    // Skip it briefly right after a known failure (instance down).
    if (Date.now() - invDownAt > INV_DOWN_COOLDOWN_MS) {
      startAudio(videoId);
    } else {
      useIframeEngine(videoId, 0);
    }
  }

  function replay() {
    // The engine flag is authoritative: while the audio engine is driving (even
    // while its element is still being set up), never touch the iframe — that
    // would start a second, ghost copy of an older track.
    if (engine === 'audio') {
      if (audio) { try { audio.currentTime = 0; audio.play().catch(function () { /* ignore */ }); } catch (e) { /* noop */ } }
      return;
    }
    if (!player || !ready) return;
    try { player.seekTo(0, true); player.playVideo(); } catch (e) { /* noop */ }
  }

  function toggle() {
    if (engine === 'audio') {
      if (!audio) return;
      if (state === 'playing' || state === 'buffering') { try { audio.pause(); } catch (e) { /* noop */ } }
      else {
        try { if (audio.ended) audio.currentTime = 0; audio.play().catch(function () { useIframeEngine(lastVideoId, 0); }); } catch (e) { /* noop */ }
      }
      return;
    }
    if (!player || !ready) return;
    try {
      var st = player.getPlayerState();
      if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) player.pauseVideo();
      else if (st === YT.PlayerState.PAUSED || st === YT.PlayerState.ENDED || st === YT.PlayerState.CUED) player.playVideo();
    } catch (e) { /* noop */ }
  }

  function pause() {
    if (engine === 'audio') { if (audio) { try { audio.pause(); } catch (e) { /* noop */ } } return; }
    if (player && ready) { try { player.pauseVideo(); } catch (e) {} }
  }

  function seek(t) {
    t = Number(t) || 0;
    if (engine === 'audio' && audio) { try { audio.currentTime = t; } catch (e) { /* noop */ } return; }
    if (player && ready) { try { player.seekTo(t, true); } catch (e) {} }
  }

  function time() {
    if (engine === 'audio' && audio) return audio.currentTime || 0;
    if (player && ready) { try { return player.getCurrentTime() || 0; } catch (e) { return 0; } }
    return 0;
  }

  function duration() {
    if (engine === 'audio' && audio) return isFinite(audio.duration) ? audio.duration : 0;
    if (player && ready) { try { return player.getDuration() || 0; } catch (e) { return 0; } }
    return 0;
  }

  function setVolume(v) {
    v = Math.max(0, Math.min(100, Number(v) || 0));
    lastVolume = v;
    if (audio) { try { audio.volume = v / 100; } catch (e) { /* noop */ } }
    if (player && ready) { try { player.setVolume(v); } catch (e) {} }
  }

  window.YTPlayer = {
    init: init,
    play: play,
    replay: replay,
    toggle: toggle,
    pause: pause,
    seek: seek,
    time: time,
    duration: duration,
    setVolume: setVolume,
    getState: function () { return state; },
    getEngine: function () { return engine; },
    isReady: function () {
      if (engine === 'audio' && audio) return true;
      return ready && !!player;
    }
  };

  window.YouTube = { parseYouTubeUrl: parseYouTubeUrl, thumbUrl: thumbUrl, INVIDIOUS_BASE: invBase };
})();
