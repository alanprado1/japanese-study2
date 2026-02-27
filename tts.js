/* ============================================================
   積む — tts.js  (load order: 2nd)
   Google Chirp 3 HD Text-to-Speech

   Audio cache:
   ─ In-memory:  audioCache (voice|text → base64), 50-entry LRU.
                 Instant playback within a session.
   ─ IndexedDB:  'audio' store in jpStudy_db (shared with images.js).
                 Persists across sessions — no re-fetching on refresh.
                 Key: "voice|text"  fields: { key, b64, ts }
   ─ LRU cap:    200 entries in IDB (oldest evicted when exceeded).
   ─ Different voices coexist cleanly — key includes voice name.
   ============================================================ */

var GOOGLE_TTS_KEY = 'AIzaSyDqBrrjHTWooWIgPEjLue8KshfHDEH2zfE';
var GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + GOOGLE_TTS_KEY;

var currentAudio  = null;
var selectedVoice = 'ja-JP-Chirp3-HD-Aoede';
var isSpeaking    = false;

// ─── in-memory layer ─────────────────────────────────────────
var audioCache     = {};
var audioCacheKeys = [];
var AUDIO_MEM_MAX  = 50;
var MAX_CACHED_AUDIO = 200;

// ─── IDB helpers ─────────────────────────────────────────────
// Reuse window._jpStudyDB opened by images.js (load order: images before tts? No —
// tts loads before images per index.html order). So we wait for the promise.
// images.js sets window._jpStudyDB synchronously (Promise constructor), so by the
// time any event handler or prefetch fires, it will be available.

function _audioIdbGet(key) {
  if (!window._jpStudyDB) return Promise.resolve(null);
  return window._jpStudyDB.then(function(db) {
    return new Promise(function(resolve) {
      var tx  = db.transaction('audio', 'readonly');
      var req = tx.objectStore('audio').get(key);
      req.onsuccess = function() { resolve(req.result ? req.result.b64 : null); };
      req.onerror   = function() { resolve(null); };
    });
  }).catch(function() { return null; });
}

function _audioIdbSet(key, b64) {
  if (!window._jpStudyDB) return Promise.resolve();
  return window._jpStudyDB.then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').put({ key: key, b64: b64, ts: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
  }).then(function() {
    return _audioEvictIfNeeded();
  }).catch(function() {});
}

function _audioEvictIfNeeded() {
  if (!window._jpStudyDB) return Promise.resolve();
  return window._jpStudyDB.then(function(db) {
    return new Promise(function(resolve) {
      var all = [];
      var tx  = db.transaction('audio', 'readonly');
      var req = tx.objectStore('audio').index('ts').openCursor();
      req.onsuccess = function(e) {
        var cursor = e.target.result;
        if (cursor) { all.push({ key: cursor.value.key, ts: cursor.value.ts }); cursor.continue(); }
        else        { resolve(all); }
      };
      req.onerror = function() { resolve([]); };
    });
  }).then(function(all) {
    if (all.length <= MAX_CACHED_AUDIO) return;
    all.sort(function(a, b) { return a.ts - b.ts; });
    var toRemove = all.slice(0, all.length - MAX_CACHED_AUDIO);
    return window._jpStudyDB.then(function(db) {
      return new Promise(function(resolve) {
        var tx = db.transaction('audio', 'readwrite');
        toRemove.forEach(function(item) { tx.objectStore('audio').delete(item.key); });
        tx.oncomplete = resolve;
        tx.onerror    = resolve;
      });
    });
  }).catch(function() {});
}

// ─── cache get/set ────────────────────────────────────────────

function cacheGet(key) {
  return audioCache[key] || null;
}

function cacheSet(key, b64) {
  if (audioCache[key]) return;
  if (audioCacheKeys.length >= AUDIO_MEM_MAX) {
    var evict = audioCacheKeys.shift();
    delete audioCache[evict];
  }
  audioCache[key] = b64;
  audioCacheKeys.push(key);
  _audioIdbSet(key, b64); // persist to IDB (fire-and-forget)
}

// Three-tier lookup: memory → IDB → null (caller fetches from network)
function _getAudio(key) {
  var mem = cacheGet(key);
  if (mem) return Promise.resolve(mem);

  return _audioIdbGet(key).then(function(b64) {
    if (b64) {
      // Warm memory cache
      if (audioCacheKeys.length >= AUDIO_MEM_MAX) {
        var evict = audioCacheKeys.shift();
        delete audioCache[evict];
      }
      audioCache[key] = b64;
      audioCacheKeys.push(key);
    }
    return b64; // null if not found
  });
}

// ─── prefetch ────────────────────────────────────────────────

function prefetchJP(text) {
  if (!text) return;
  var key = selectedVoice + '|' + text;
  if (cacheGet(key)) return;

  _audioIdbGet(key).then(function(b64) {
    if (b64) { cacheSet(key, b64); return; }
    fetch(GOOGLE_TTS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input:       { text: text },
        voice:       { languageCode: 'ja-JP', name: selectedVoice },
        audioConfig: { audioEncoding: 'MP3' }
      })
    })
    .then(function(res) { return res.ok ? res.json() : null; })
    .then(function(data) { if (data && data.audioContent) cacheSet(key, data.audioContent); })
    .catch(function() {});
  });
}

// ─── speakJP (word popup + list view) ────────────────────────

function speakJP(text) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  var key = selectedVoice + '|' + text;

  function playFromB64(b64) {
    return new Promise(function(resolve, reject) {
      var audio = new Audio();
      audio.preload = 'auto';
      currentAudio = audio;
      audio.onended = function() { currentAudio = null; resolve(); };
      audio.onerror = function(e) { currentAudio = null; reject(e); };
      audio.oncanplaythrough = function() {
        setTimeout(function() {
          if (currentAudio === audio) audio.play().catch(reject);
        }, 80);
      };
      audio.src = 'data:audio/mp3;base64,' + b64;
      audio.load();
    });
  }

  return _getAudio(key).then(function(b64) {
    if (b64) return playFromB64(b64);

    return fetch(GOOGLE_TTS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input:       { text: text },
        voice:       { languageCode: 'ja-JP', name: selectedVoice },
        audioConfig: { audioEncoding: 'MP3' }
      })
    })
    .then(function(res) {
      if (!res.ok) throw new Error('TTS HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      if (!data.audioContent) throw new Error('No audioContent returned');
      cacheSet(key, data.audioContent);
      return playFromB64(data.audioContent);
    });
  });
}

// ─── SVG icons ───────────────────────────────────────────────

var ICON_PLAY  = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle"><path d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

var pausedAudio = null;
var playToken   = 0;

function _setBtn(icon) {
  ['cardAudioBtn', 'reviewAudioBtn'].forEach(function(id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.innerHTML = icon;
    btn.classList.toggle('playing', icon === ICON_PAUSE);
  });
}

function stopAudio() {
  playToken++;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  pausedAudio = null;
  isSpeaking  = false;
}

// ─── speakCard (card + review mode) ──────────────────────────

function speakCard() {
  var src = isReviewMode ? reviewQueue : getSentencesForFilter();
  var idx = isReviewMode ? reviewIdx  : currentIdx;
  var s   = src[idx];
  if (!s) return;

  // PAUSE
  if (isSpeaking) {
    playToken++;
    if (currentAudio) {
      currentAudio.pause();
      pausedAudio  = currentAudio;
      currentAudio = null;
    }
    isSpeaking = false;
    _setBtn(ICON_PLAY);
    return;
  }

  // RESUME
  if (pausedAudio) {
    var resuming = pausedAudio;
    pausedAudio  = null;
    currentAudio = resuming;
    isSpeaking   = true;
    _setBtn(ICON_PAUSE);
    setTimeout(function() {
      if (currentAudio !== resuming) return;
      resuming.play().catch(function() {
        currentAudio = null;
        isSpeaking   = false;
        _setBtn(ICON_PLAY);
      });
    }, 160);
    return;
  }

  // FRESH PLAY
  isSpeaking = true;
  var token  = ++playToken;
  _setBtn(ICON_PAUSE);

  var key = selectedVoice + '|' + s.jp;

  function startPlay(b64) {
    if (token !== playToken) return;
    var audio = new Audio();
    audio.preload = 'auto';
    currentAudio  = audio;

    audio.onended = function() {
      if (currentAudio === audio) currentAudio = null;
      isSpeaking  = false;
      pausedAudio = null;
      _setBtn(ICON_PLAY);
    };
    audio.onerror = function() {
      if (currentAudio === audio) currentAudio = null;
      isSpeaking = false;
      _setBtn(ICON_PLAY);
    };
    audio.oncanplaythrough = function() {
      setTimeout(function() {
        if (currentAudio === audio && token === playToken) {
          audio.play().catch(function() {
            currentAudio = null;
            isSpeaking   = false;
            _setBtn(ICON_PLAY);
          });
        }
      }, 80);
    };
    audio.src = 'data:audio/mp3;base64,' + b64;
    audio.load();
  }

  _getAudio(key).then(function(b64) {
    if (b64) { startPlay(b64); return; }

    fetch(GOOGLE_TTS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input:       { text: s.jp },
        voice:       { languageCode: 'ja-JP', name: selectedVoice },
        audioConfig: { audioEncoding: 'MP3' }
      })
    })
    .then(function(res) {
      if (!res.ok) throw new Error('TTS HTTP ' + res.status);
      return res.json();
    })
    .then(function(data) {
      if (!data.audioContent) throw new Error('No audioContent');
      cacheSet(key, data.audioContent);
      startPlay(data.audioContent);
    })
    .catch(function(err) {
      if (token !== playToken) return;
      console.error('TTS error:', err);
      isSpeaking = false;
      _setBtn(ICON_PLAY);
      alert('Audio failed. Check your API key or internet connection.');
    });
  });
}

function resetAudioBtn() {
  stopAudio();
  _setBtn(ICON_PLAY);
}

// ─── voice settings ───────────────────────────────────────────

function setSpeaker(voiceName) {
  selectedVoice = voiceName;
  document.querySelectorAll('.speaker-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.sid === voiceName);
  });
  try { localStorage.setItem('jpStudy_voice', voiceName); } catch(e) {}
}

function loadVoicePref() {
  try {
    var saved = localStorage.getItem('jpStudy_voice');
    if (saved) {
      selectedVoice = saved;
      document.querySelectorAll('.speaker-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.sid === saved);
      });
    }
  } catch(e) {}
}
