/* ============================================================
   積む — tts.js  (load order: 2nd)
   Multi-provider Text-to-Speech: Google, ElevenLabs

   Providers:
   ─ Google:      Chirp 3 HD voices (ja-JP). Returns base64 JSON.
   ─ ElevenLabs:  Japanese voices, Multilingual v2 model. Returns audio/mpeg binary.

   Audio cache:
   ─ In-memory:  audioCache (key → base64), 50-entry LRU.
   ─ IndexedDB:  'audio' store in jpStudy_db. Persists across sessions.
   ─ Cache key:  "provider:voice|text"
   ─ LRU cap:    200 entries in IDB.

   Pause/resume: smooth 80ms fade via Web Audio API GainNode (no clicks or gaps).
   ─ Card/Review: speakCard() — buttons #cardAudioBtn, #reviewAudioBtn
   ─ List view:   speakJP(text, btnEl) — button element passed in
   ─ Word popup:  speakJP(text) — no btn, one-shot play
   ============================================================ */

// ─── API keys & config ────────────────────────────────────────
var GOOGLE_TTS_KEY   = 'AIzaSyDqBrrjHTWooWIgPEjLue8KshfHDEH2zfE';
var GOOGLE_TTS_URL   = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + GOOGLE_TTS_KEY;

var ELEVENLABS_KEY   = 'sk_505985290737398ea773e6782a02176e3ddad588b4110efb';
var ELEVENLABS_URL   = 'https://api.elevenlabs.io/v1/text-to-speech/';
var ELEVENLABS_MODEL = 'eleven_multilingual_v2';

// ─── provider & voice state ───────────────────────────────────
var selectedProvider = 'google';
var selectedVoice    = 'ja-JP-Chirp3-HD-Aoede';
var currentAudio     = null;  // current HTMLAudioElement
var currentGain      = null;  // current GainNode (Web Audio API)
var isSpeaking       = false;
var isPaused         = false; // true while in the paused-but-resumable state

// ─── voice catalogue ──────────────────────────────────────────
var VOICE_CATALOGUE = {
  google: [
    { id: 'ja-JP-Chirp3-HD-Aoede',  label: 'Aoede — female'  },
    { id: 'ja-JP-Chirp3-HD-Kore',   label: 'Kore — female'   },
    { id: 'ja-JP-Chirp3-HD-Leda',   label: 'Leda — female'   },
    { id: 'ja-JP-Chirp3-HD-Zephyr', label: 'Zephyr — female' },
    { id: 'ja-JP-Chirp3-HD-Charon', label: 'Charon — male'   },
    { id: 'ja-JP-Chirp3-HD-Fenrir', label: 'Fenrir — male'   },
    { id: 'ja-JP-Chirp3-HD-Orus',   label: 'Orus — male'     },
    { id: 'ja-JP-Chirp3-HD-Puck',   label: 'Puck — male'     }
  ],
  elevenlabs: [
    // ElevenLabs premade (default) voices — available on free tier via API.
    // All speak Japanese via the eleven_multilingual_v2 model.
    { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel — female, clear'     },
    { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella — female, soft'       },
    { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli — female, younger'     },
    { id: 'piTKgcLEGmPE4e6mEKli', label: 'Nicole — female, calm'      },
    { id: 'ThT5KcBeYPX3keUQqHPh', label: 'Dorothy — female, warm'     },
    { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — male, clear'         },
    { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh — male, deep'          },
    { id: 'yoZ06aMxZJJ28mfd3POQ', label: 'Sam — male, raspy'          },
    { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold — male, crisp'       },
    { id: 'N2lVS1w4EtoT3dr4eOWO', label: 'Callum — male, intense'     }
  ]
};

// ─── in-memory cache ─────────────────────────────────────────
var audioCache     = {};
var audioCacheKeys = [];
var AUDIO_MEM_MAX    = 50;
var MAX_CACHED_AUDIO = 200;

// ─── IDB helpers ─────────────────────────────────────────────
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
  }).then(function() { return _audioEvictIfNeeded(); })
    .catch(function() {});
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

// ─── cache helpers ────────────────────────────────────────────
function _cacheKey(text) {
  return selectedProvider + ':' + selectedVoice + '|' + text;
}

function cacheGet(key) { return audioCache[key] || null; }

function cacheSet(key, b64) {
  if (audioCache[key]) return;
  if (audioCacheKeys.length >= AUDIO_MEM_MAX) {
    var evict = audioCacheKeys.shift();
    delete audioCache[evict];
  }
  audioCache[key] = b64;
  audioCacheKeys.push(key);
  _audioIdbSet(key, b64);
}

function _getAudio(key) {
  var mem = cacheGet(key);
  if (mem) return Promise.resolve(mem);
  return _audioIdbGet(key).then(function(b64) {
    if (b64) {
      if (audioCacheKeys.length >= AUDIO_MEM_MAX) {
        var evict = audioCacheKeys.shift();
        delete audioCache[evict];
      }
      audioCache[key] = b64;
      audioCacheKeys.push(key);
    }
    return b64;
  });
}

// ─── blob → base64 helper ─────────────────────────────────────
function _blobToB64(blob) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onloadend = function() { resolve(reader.result.split(',')[1]); };
    reader.onerror   = reject;
    reader.readAsDataURL(blob);
  });
}

// ─── provider fetch functions ─────────────────────────────────

function _fetchGoogle(text) {
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
    if (!res.ok) throw new Error('Google TTS HTTP ' + res.status);
    return res.json();
  })
  .then(function(data) {
    if (!data.audioContent) throw new Error('Google TTS: no audioContent');
    return data.audioContent;
  });
}

function _fetchElevenLabs(text) {
  return fetch(ELEVENLABS_URL + selectedVoice, {
    method: 'POST',
    headers: {
      'Accept':       'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key':   ELEVENLABS_KEY
    },
    body: JSON.stringify({
      text:     text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: {
        stability:        0.5,
        similarity_boost: 0.75,
        style:            0,
        use_speaker_boost: true
      }
    })
  })
  .then(function(res) {
    if (!res.ok) {
      // Read the actual error body so the user knows exactly what went wrong
      return res.text().then(function(body) {
        var msg = 'ElevenLabs HTTP ' + res.status;
        try {
          var json   = JSON.parse(body);
          var detail = json.detail;
          if (typeof detail === 'string') {
            msg = detail;
          } else if (detail && detail.message) {
            msg = detail.message;
          } else if (detail && detail.status) {
            msg = 'ElevenLabs: ' + detail.status;
          }
        } catch (e) {
          if (body && body.length < 300) msg = body;
        }
        throw new Error(msg);
      });
    }
    return res.blob();
  })
  .then(function(result) {
    // After the error branch throws, this only runs on success (result is a Blob)
    return _blobToB64(result);
  });
}

function _fetchAudio(text) {
  if (selectedProvider === 'elevenlabs') return _fetchElevenLabs(text);
  return _fetchGoogle(text);
}

// ─── prefetch (Google only — ElevenLabs charges per character) ──
function prefetchJP(text) {
  if (!text || selectedProvider !== 'google') return;
  var key = _cacheKey(text);
  if (cacheGet(key)) return;
  _audioIdbGet(key).then(function(b64) {
    if (b64) { cacheSet(key, b64); return; }
    _fetchGoogle(text).then(function(b64) { cacheSet(key, b64); }).catch(function() {});
  });
}

// ─── Web Audio API — smooth pause/resume ──────────────────────
// One shared AudioContext for the whole session.
// Each Audio element gets a MediaElementSourceNode + GainNode wired through it.
// Fade duration: 80ms — long enough to be smooth, short enough to feel responsive.
var _audioCtx = null;
var FADE_MS   = 80;

function _getAudioCtx() {
  if (!_audioCtx) {
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) {
      return null; // Browser doesn't support Web Audio API — fall back gracefully
    }
  }
  // Resume context if it was suspended (autoplay policy)
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume().catch(function() {});
  }
  return _audioCtx;
}

// Wire an Audio element through a GainNode. Returns the GainNode (or null).
// NOTE: MediaElementSourceNode can only be created ONCE per HTMLAudioElement,
// so we store it on the element itself to detect double-wiring.
function _wireGain(audio) {
  var ctx = _getAudioCtx();
  if (!ctx) return null;
  if (audio._gainNode) return audio._gainNode; // already wired
  try {
    var source   = ctx.createMediaElementSource(audio);
    var gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(1, ctx.currentTime);
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    audio._gainNode = gainNode; // store reference on element
    return gainNode;
  } catch(e) {
    return null;
  }
}

// Schedule a linear gain ramp and return a promise that resolves after `ms`.
function _rampGain(gainNode, from, to, ms) {
  return new Promise(function(resolve) {
    if (!gainNode) { resolve(); return; }
    var ctx = _getAudioCtx();
    if (!ctx) { resolve(); return; }
    var now = ctx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(from, now);
    gainNode.gain.linearRampToValueAtTime(to, now + ms / 1000);
    setTimeout(resolve, ms);
  });
}

// ─── SVG icons ───────────────────────────────────────────────
var ICON_PLAY  = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle"><path d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

var pausedAudio   = null; // Audio element saved while paused
var pausedGain    = null; // GainNode saved while paused
var playToken     = 0;
var _listAudioBtn = null; // currently active list-view button

function _setBtn(icon) {
  ['cardAudioBtn', 'reviewAudioBtn'].forEach(function(id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.innerHTML = icon;
    btn.classList.toggle('playing', icon === ICON_PAUSE);
  });
}

// Hard-stop everything immediately (used on card navigation)
function stopAudio() {
  playToken++;
  if (currentGain) {
    try { currentGain.gain.cancelScheduledValues(0); currentGain.gain.setValueAtTime(0, 0); } catch(e) {}
  }
  if (currentAudio) { try { currentAudio.pause(); } catch(e) {} currentAudio = null; }
  currentGain = null;
  pausedAudio = null;
  pausedGain  = null;
  isSpeaking  = false;
  isPaused    = false;
  if (_listAudioBtn) { _listAudioBtn.innerHTML = '&#9654;'; _listAudioBtn = null; }
}

// ─── core play function ───────────────────────────────────────
// Creates an Audio element from b64, wires it through Web Audio GainNode,
// fades in, plays, fades out at end. Returns a promise resolving on end/error.
function _playB64(b64, token, onEnd, onError) {
  var audio    = new Audio();
  audio.preload = 'auto';
  audio.src     = 'data:audio/mp3;base64,' + b64;

  // Wire immediately so GainNode is ready before play()
  var gain = _wireGain(audio);
  if (gain) {
    // Start gain at 0; we'll ramp up once playback actually starts
    gain.gain.setValueAtTime(0, (_audioCtx && _audioCtx.currentTime) || 0);
  }

  currentAudio = audio;
  currentGain  = gain;

  audio.onended = function() {
    if (currentAudio !== audio) return; // superseded
    currentAudio = null;
    currentGain  = null;
    isSpeaking   = false;
    isPaused     = false;
    if (onEnd) onEnd();
  };

  audio.onerror = function(e) {
    if (currentAudio !== audio) return;
    currentAudio = null;
    currentGain  = null;
    isSpeaking   = false;
    isPaused     = false;
    if (onError) onError(e);
  };

  audio.oncanplaythrough = function() {
    if (token !== playToken || currentAudio !== audio) return;
    var p = audio.play();
    var doPlay = p && p.then ? p : Promise.resolve();
    doPlay.then(function() {
      if (token !== playToken || currentAudio !== audio) return;
      // Fade in from 0 → 1
      if (gain) {
        _rampGain(gain, 0, 1, FADE_MS);
      }
    }).catch(function(err) {
      if (onError) onError(err);
    });
  };

  audio.load();
}

// ─── smooth pause ────────────────────────────────────────────
// Fades gain 1→0 over FADE_MS, then pauses the element.
// Always pauses the specific audio element passed in — no stale-reference checks.
function _doPause(audio, gain, afterPause) {
  isSpeaking = false;
  isPaused   = true;
  _rampGain(gain, 1, 0, FADE_MS).then(function() {
    try { audio.pause(); } catch(e) {}
    if (afterPause) afterPause();
  });
}

// ─── smooth resume ───────────────────────────────────────────
// Sets gain to 0, calls play(), then ramps 0→1.
function _doResume(audio, gain, afterResume) {
  if (gain) {
    var ctx = _getAudioCtx();
    if (ctx) gain.gain.setValueAtTime(0, ctx.currentTime);
  }
  var p = audio.play();
  var doPlay = p && p.then ? p : Promise.resolve();
  doPlay.then(function() {
    isSpeaking = true;
    isPaused   = false;
    if (gain) _rampGain(gain, 0, 1, FADE_MS);
    if (afterResume) afterResume();
  }).catch(function() {
    isSpeaking = false;
    isPaused   = false;
    pausedAudio = null;
    pausedGain  = null;
    currentAudio = null;
    currentGain  = null;
    if (afterResume) afterResume('error');
  });
}

// ─── speakJP — word popup + list view ────────────────────────
function speakJP(text, btnEl) {
  var key = _cacheKey(text);

  // ── PAUSE (same list button, currently playing) ────────────
  if (btnEl && _listAudioBtn === btnEl && isSpeaking && currentAudio) {
    var _pauseAudio = currentAudio;
    var _pauseGain  = currentGain;
    currentAudio = null;
    currentGain  = null;
    btnEl.innerHTML = '&#9654;';
    _doPause(_pauseAudio, _pauseGain, function() {
      pausedAudio = _pauseAudio;
      pausedGain  = _pauseGain;
    });
    return Promise.resolve();
  }

  // ── RESUME (same list button, currently paused) ────────────
  if (btnEl && _listAudioBtn === btnEl && isPaused && pausedAudio) {
    var resumeAudio = pausedAudio;
    var resumeGain  = pausedGain;
    pausedAudio  = null;
    pausedGain   = null;
    currentAudio = resumeAudio;
    currentGain  = resumeGain;
    btnEl.innerHTML = ICON_PAUSE;
    _doResume(resumeAudio, resumeGain, function(err) {
      if (err) { btnEl.innerHTML = '&#9654;'; }
    });
    return Promise.resolve();
  }

  // ── NEW play (different button or word popup) ──────────────
  // Stop/abandon whatever is playing
  playToken++;
  if (currentGain) {
    try { currentGain.gain.cancelScheduledValues(0); currentGain.gain.setValueAtTime(0, 0); } catch(e) {}
  }
  if (currentAudio) { try { currentAudio.pause(); } catch(e) {} }
  currentAudio = null;
  currentGain  = null;
  pausedAudio  = null;
  pausedGain   = null;
  isSpeaking   = false;
  isPaused     = false;
  _setBtn(ICON_PLAY);
  if (_listAudioBtn && _listAudioBtn !== btnEl) {
    _listAudioBtn.innerHTML = '&#9654;';
  }
  _listAudioBtn = btnEl || null;

  var token = playToken;

  function startListPlay(b64) {
    isSpeaking = true;
    if (btnEl) btnEl.innerHTML = ICON_PAUSE;
    _playB64(b64, token, function() {
      // onEnd
      _listAudioBtn = null;
      if (btnEl) btnEl.innerHTML = '&#9654;';
    }, function() {
      // onError
      isSpeaking    = false;
      _listAudioBtn = null;
      if (btnEl) btnEl.innerHTML = '&#9654;';
    });
  }

  return _getAudio(key).then(function(b64) {
    if (token !== playToken) return;
    if (b64) { startListPlay(b64); return; }
    return _fetchAudio(text).then(function(b64) {
      if (token !== playToken) return;
      cacheSet(key, b64);
      startListPlay(b64);
    });
  });
}

// ─── speakCard — card view + review mode ─────────────────────
function speakCard() {
  var src = isReviewMode ? reviewQueue : getSentencesForFilter();
  var idx = isReviewMode ? reviewIdx  : currentIdx;
  var s   = src[idx];
  if (!s) return;

  // If a list item is active, kill it cleanly
  if (_listAudioBtn) {
    playToken++;
    if (currentGain) {
      try { currentGain.gain.cancelScheduledValues(0); currentGain.gain.setValueAtTime(0, 0); } catch(e) {}
    }
    if (currentAudio) { try { currentAudio.pause(); } catch(e) {} currentAudio = null; }
    currentGain = null;
    pausedAudio = null;
    pausedGain  = null;
    isSpeaking  = false;
    isPaused    = false;
    _listAudioBtn.innerHTML = '&#9654;';
    _listAudioBtn = null;
  }

  // ── PAUSE ─────────────────────────────────────────────────
  if (isSpeaking && currentAudio) {
    var _pauseAudio = currentAudio;
    var _pauseGain  = currentGain;
    currentAudio = null;
    currentGain  = null;
    playToken++;
    _setBtn(ICON_PLAY);
    _doPause(_pauseAudio, _pauseGain, function() {
      // Only save pausedAudio if nothing new started during the fade
      if (!isSpeaking) {
        pausedAudio = _pauseAudio;
        pausedGain  = _pauseGain;
        isPaused    = true;
      } else {
        try { _pauseAudio.pause(); } catch(e) {}
      }
    });
    return;
  }

  // ── RESUME ────────────────────────────────────────────────
  if (isPaused && pausedAudio) {
    var resumeAudio = pausedAudio;
    var resumeGain  = pausedGain;
    pausedAudio  = null;
    pausedGain   = null;
    currentAudio = resumeAudio;
    currentGain  = resumeGain;
    _setBtn(ICON_PAUSE);
    _doResume(resumeAudio, resumeGain, function(err) {
      if (err) { _setBtn(ICON_PLAY); }
    });
    return;
  }

  // ── FRESH PLAY ────────────────────────────────────────────
  isSpeaking = true;
  isPaused   = false;
  var token  = ++playToken;
  _setBtn(ICON_PAUSE);

  var key = _cacheKey(s.jp);

  function startCardPlay(b64) {
    if (token !== playToken) return;
    _playB64(b64, token, function() {
      // onEnd
      _setBtn(ICON_PLAY);
    }, function(err) {
      // onError
      isSpeaking = false;
      _setBtn(ICON_PLAY);
      if (err && err.message) alert('Audio failed: ' + err.message);
    });
  }

  _getAudio(key).then(function(b64) {
    if (token !== playToken) return;
    if (b64) { startCardPlay(b64); return; }
    _fetchAudio(s.jp)
      .then(function(b64) {
        if (token !== playToken) return;
        cacheSet(key, b64);
        startCardPlay(b64);
      })
      .catch(function(err) {
        if (token !== playToken) return;
        console.error('TTS error:', err);
        isSpeaking = false;
        _setBtn(ICON_PLAY);
        alert('Audio failed: ' + (err.message || err));
      });
  });
}

function resetAudioBtn() {
  stopAudio();
  _setBtn(ICON_PLAY);
}

// ─── provider & voice settings ───────────────────────────────

function setProvider(provider) {
  selectedProvider = provider;
  selectedVoice    = VOICE_CATALOGUE[provider][0].id;
  try {
    localStorage.setItem('jpStudy_provider', provider);
    localStorage.setItem('jpStudy_voice', selectedVoice);
  } catch(e) {}
  _renderVoicePanel();
}

function setSpeaker(voiceId) {
  selectedVoice = voiceId;
  try { localStorage.setItem('jpStudy_voice', voiceId); } catch(e) {}
  document.querySelectorAll('.speaker-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.sid === voiceId);
  });
}

// Renders the voice list + credit line inside #voicePanel
function _renderVoicePanel() {
  var panel = document.getElementById('voicePanel');
  if (!panel) return;

  document.querySelectorAll('.provider-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.provider === selectedProvider);
  });

  var voices = VOICE_CATALOGUE[selectedProvider] || [];
  var html   = '<div class="weight-btns" style="flex-direction:column;gap:5px;align-items:stretch;">';
  voices.forEach(function(v) {
    html += '<button class="speaker-btn weight-btn' + (v.id === selectedVoice ? ' active' : '') + '"' +
      ' data-sid="' + v.id + '" onclick="setSpeaker(\'' + v.id + '\')">' +
      v.label + '</button>';
  });
  html += '</div>';

  var credit = { google: 'Google Chirp 3 HD', elevenlabs: 'ElevenLabs Multilingual v2' };
  html += '<div style="font-family:\'DM Mono\',monospace;font-size:0.62rem;color:var(--text3);margin-top:6px;line-height:1.6;">' +
    'Powered by <strong style="color:var(--text2)">' + credit[selectedProvider] + '</strong></div>';

  panel.innerHTML = html;
}

function loadVoicePref() {
  try {
    var prov  = localStorage.getItem('jpStudy_provider');
    var voice = localStorage.getItem('jpStudy_voice');
    if (prov && VOICE_CATALOGUE[prov]) selectedProvider = prov;
    if (voice) selectedVoice = voice;
  } catch(e) {}
  _renderVoicePanel();
}
