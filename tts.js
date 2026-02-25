/* ============================================================
   積む — tts.js  (load order: 2nd)
   Google Chirp 3 HD Text-to-Speech
   ============================================================ */

var GOOGLE_TTS_KEY = 'AIzaSyDqBrrjHTWooWIgPEjLue8KshfHDEH2zfE';
var GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + GOOGLE_TTS_KEY;

var currentAudio  = null;
var selectedVoice = 'ja-JP-Chirp3-HD-Aoede';
var isSpeaking    = false;

// ─── audio cache: avoids re-fetching the same sentence ───────
// Key: voice + text → base64 audio string
var audioCache = {};
var audioCacheKeys = []; // LRU tracking
var CACHE_MAX = 30;

function cacheGet(key) {
  return audioCache[key] || null;
}

function cacheSet(key, b64) {
  if (audioCache[key]) return; // already stored
  if (audioCacheKeys.length >= CACHE_MAX) {
    var evict = audioCacheKeys.shift();
    delete audioCache[evict];
  }
  audioCache[key] = b64;
  audioCacheKeys.push(key);
}

// Pre-fetch audio for the next card in the background
function prefetchJP(text) {
  if (!text) return;
  var key = selectedVoice + '|' + text;
  if (cacheGet(key)) return; // already cached
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
  .catch(function() {}); // silently ignore prefetch errors
}

// Returns a Promise that resolves when the audio finishes playing.
// Checks cache first — cache hit means near-zero delay.
function speakJP(text) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }

  var key    = selectedVoice + '|' + text;
  var cached = cacheGet(key);

  function playFromB64(b64) {
    return new Promise(function(resolve, reject) {
      var audio = new Audio();
      audio.preload = 'auto';
      currentAudio = audio;
      audio.onended = function() { currentAudio = null; resolve(); };
      audio.onerror = function(e) { currentAudio = null; reject(e); };
      // Wait for enough data to play cleanly, then add a small delay
      // so the browser audio pipeline is ready and the first syllable isn't clipped
      audio.oncanplaythrough = function() {
        setTimeout(function() {
          if (currentAudio === audio) {
            audio.play().catch(reject);
          }
        }, 80);
      };
      // Set src after attaching events so the event fires reliably
      audio.src = 'data:audio/mp3;base64,' + b64;
      audio.load();
    });
  }

  if (cached) {
    return playFromB64(cached);
  }

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
}

// SVG icons
var ICON_PLAY  = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle"><path d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

// pausedAudio holds the paused Audio object so Play resumes rather than restarts.
// playToken is incremented whenever audio is stopped/paused/navigated away, so
// any in-flight fetch knows it has been cancelled and must not start playback.
var pausedAudio = null;
var playToken   = 0;

// ─── list-mode audio state ────────────────────────────────────
// Tracks which list-item button is currently playing/paused so we can
// show the correct icon and handle pause/resume per item. Kept separate
// from the card-mode pausedAudio so the two contexts never interfere.
var _listItemBtn    = null;   // button element currently active in list view
var _listItemPaused = null;   // paused Audio object for that button

function _setBtn(icon) {
  // Update both the card-mode button and the review-mode button
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
  pausedAudio     = null;
  isSpeaking      = false;
  // Reset any playing list-item button so it shows the play icon
  if (_listItemBtn) {
    _listItemBtn.innerHTML = ICON_PLAY;
    _listItemBtn.classList.remove('playing');
    _listItemBtn     = null;
  }
  _listItemPaused = null;
}

function speakCard() {
  var src = isReviewMode ? reviewQueue : getSentencesForFilter();
  var idx = isReviewMode ? reviewIdx  : currentIdx;
  var s   = src[idx];
  if (!s) return;

  // ── PAUSE ──────────────────────────────────────────────────────
  if (isSpeaking) {
    playToken++;                           // cancel any in-flight fetch
    if (currentAudio) {
      currentAudio.pause();
      pausedAudio  = currentAudio;        // save reference for resume
      currentAudio = null;
    }
    isSpeaking = false;
    _setBtn(ICON_PLAY);
    return;
  }

  // ── RESUME ─────────────────────────────────────────────────────
  if (pausedAudio) {
    var resuming = pausedAudio;
    pausedAudio  = null;
    currentAudio = resuming;
    isSpeaking   = true;
    _setBtn(ICON_PAUSE);
    setTimeout(function() {
      if (currentAudio !== resuming) return; // cancelled during delay
      resuming.play().catch(function() {
        currentAudio = null;
        isSpeaking   = false;
        _setBtn(ICON_PLAY);
      });
    }, 190);
    return;
  }

  // ── FRESH PLAY ─────────────────────────────────────────────────
  isSpeaking    = true;
  var token     = ++playToken;            // snapshot: if it changes, we were cancelled
  _setBtn(ICON_PAUSE);

  var key    = selectedVoice + '|' + s.jp;
  var cached = cacheGet(key);

  function startPlay(b64) {
    if (token !== playToken) return;      // paused/navigated before audio was ready

    var audio = new Audio();
    audio.preload = 'auto';
    currentAudio  = audio;

    audio.onended = function() {
      if (currentAudio === audio) { currentAudio = null; }
      isSpeaking  = false;
      pausedAudio = null;
      _setBtn(ICON_PLAY);
    };
    audio.onerror = function() {
      if (currentAudio === audio) { currentAudio = null; }
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

  if (cached) {
    startPlay(cached);
    return;
  }

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
    if (token !== playToken) return;      // was cancelled, ignore silently
    console.error('TTS error:', err);
    isSpeaking = false;
    _setBtn(ICON_PLAY);
    alert('Audio failed. Check your API key or internet connection.');
  });
}

function resetAudioBtn() {
  stopAudio();
  _setBtn(ICON_PLAY);
}

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

// ─── list-item audio: full play/pause/resume per item ────────
// Each list-item audio button calls speakListItem(this, text).
// Only one item can be playing at a time. Clicking a second item
// stops the first and starts the new one. Clicking the same button
// again while playing pauses it; clicking once more resumes it.
// Uses the same playToken / currentAudio / isSpeaking globals so
// card-mode and list-mode audio can never overlap.
function speakListItem(btn, text) {
  // ── PAUSE (same button, currently playing) ──────────────────
  if (_listItemBtn === btn && isSpeaking) {
    playToken++;
    if (currentAudio) {
      currentAudio.pause();
      _listItemPaused = currentAudio;
      currentAudio    = null;
    }
    isSpeaking = false;
    btn.innerHTML = ICON_PLAY;
    btn.classList.remove('playing');
    return;
  }

  // ── RESUME (same button, previously paused) ─────────────────
  if (_listItemBtn === btn && _listItemPaused) {
    var resuming    = _listItemPaused;
    _listItemPaused = null;
    currentAudio    = resuming;
    isSpeaking      = true;
    btn.innerHTML   = ICON_PAUSE;
    btn.classList.add('playing');
    setTimeout(function() {
      if (currentAudio !== resuming) return; // cancelled during delay
      resuming.play().catch(function() {
        currentAudio = null;
        isSpeaking   = false;
        btn.innerHTML = ICON_PLAY;
        btn.classList.remove('playing');
      });
    }, 190);
    return;
  }

  // ── NEW ITEM (different button, or first press) ──────────────
  // Stop card audio if it was playing, reset card buttons
  stopAudio();       // this also clears _listItemBtn/_listItemPaused
  _setBtn(ICON_PLAY);

  _listItemBtn    = btn;
  _listItemPaused = null;
  isSpeaking      = true;
  var token       = ++playToken;
  btn.innerHTML   = ICON_PAUSE;
  btn.classList.add('playing');

  var key    = selectedVoice + '|' + text;
  var cached = cacheGet(key);

  function startListPlay(b64) {
    // Token changed means we were stopped before audio was ready
    if (token !== playToken) {
      btn.innerHTML = ICON_PLAY;
      btn.classList.remove('playing');
      if (_listItemBtn === btn) _listItemBtn = null;
      return;
    }

    var audio    = new Audio();
    audio.preload = 'auto';
    currentAudio  = audio;

    function onDone() {
      if (currentAudio === audio) currentAudio = null;
      isSpeaking = false;
      if (_listItemBtn === btn) {
        btn.innerHTML = ICON_PLAY;
        btn.classList.remove('playing');
        _listItemBtn = null;
      }
    }
    audio.onended = onDone;
    audio.onerror = onDone;
    audio.oncanplaythrough = function() {
      setTimeout(function() {
        if (currentAudio === audio && token === playToken) {
          audio.play().catch(function() { onDone(); });
        }
      }, 80);
    };
    audio.src = 'data:audio/mp3;base64,' + b64;
    audio.load();
  }

  if (cached) { startListPlay(cached); return; }

  fetch(GOOGLE_TTS_URL, {
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
    if (!data.audioContent) throw new Error('No audioContent');
    cacheSet(key, data.audioContent);
    startListPlay(data.audioContent);
  })
  .catch(function(err) {
    if (token !== playToken) return; // was cancelled, ignore silently
    console.error('TTS list error:', err);
    isSpeaking = false;
    btn.innerHTML = ICON_PLAY;
    btn.classList.remove('playing');
    if (_listItemBtn === btn) _listItemBtn = null;
  });
}
