/* ============================================================
   積む — tts.js  (load order: 2nd)
   Multi-provider Text-to-Speech: Google, ElevenLabs, Edge/Browser

   Providers:
   ─ Google:       Chirp 3 HD voices (ja-JP). Returns base64 JSON.
   ─ ElevenLabs:   Japanese voices, Eleven v3 model. Returns audio/mpeg binary.
   ─ Edge/Browser: Web Speech API — browser-native, no API key required.
                   Best quality in Microsoft Edge with Japanese language pack.

   Audio cache (Google + ElevenLabs only):
   ─ In-memory:  audioCache (key → base64), 50-entry LRU.
   ─ IndexedDB:  'audio' store in jpStudy_db. Persists across sessions.
   ─ Cache key:  "provider:voice|text"
   ─ LRU cap:    200 entries in IDB.

   Pause/resume works in ALL modes:
   ─ Card/Review: speakCard() — buttons #cardAudioBtn, #reviewAudioBtn
   ─ List view:   speakJP(text, btnEl) — button element passed in
   ─ Word popup:  speakJP(text) — no btn, one-shot play
   ============================================================ */

// ─── API keys & config ────────────────────────────────────────
var GOOGLE_TTS_KEY   = 'AIzaSyDqBrrjHTWooWIgPEjLue8KshfHDEH2zfE';
var GOOGLE_TTS_URL   = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + GOOGLE_TTS_KEY;

var ELEVENLABS_KEY   = '0f0704648329dd39026e88b43e3dc8bc0d9403600d542e8ce6082c31eb0fea79';
var ELEVENLABS_URL   = 'https://api.elevenlabs.io/v1/text-to-speech/';
var ELEVENLABS_MODEL = 'eleven_multilingual_v2';

// ─── provider & voice state ───────────────────────────────────
var selectedProvider = 'google';
var selectedVoice    = 'ja-JP-Chirp3-HD-Aoede';
var currentAudio     = null;
var isSpeaking       = false;

// ─── voice catalogue ──────────────────────────────────────────
// ⚠ ElevenLabs: Replace each FILL_ID_XXXX with the real Voice ID from
//   elevenlabs.io → Voices → (voice) → click ID to copy.
//   The entry { id: '6wdSVG3CMjPfAthsnMv9' } is confirmed and ready.
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
    { id: '6wdSVG3CMjPfAthsnMv9', label: 'Makoto — male, narration'              },
    { id: '3JDquces8E8bkmvbh6Bc', label: 'Otani — male, narration'               },
    { id: 'Mv8AjrYZCBkdsmDHNwcB', label: 'Ishibashi — male, authoritative'       },
    { id: 'j210dv0vWm7fCknyQpbA', label: 'Hinata — male, smooth'                 },
    { id: 'WQz3clzUdMqvBf0jswZQ', label: 'Shizuka — female, storytelling'        },
    { id: 'bqpOyYNUu11tjjvRUbKn', label: 'Yamato — male, versatile'              },
    { id: 'b34JylakFZPlGS0BnwyY', label: 'Kenzo — male, professional'            },
    { id: '8EkOjt4xTPGMclNlh1pk', label: 'Morioki — female, conversational AI'   }
  ],
  edge: [
    // Populated at runtime by _loadEdgeVoices() from window.speechSynthesis.getVoices()
    // This fallback entry is replaced once voices load
    { id: '__loading__', label: 'Loading browser voices…' }
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
  if (selectedVoice.indexOf('FILL_ID_') === 0) {
    return Promise.reject(new Error(
      'Voice ID not set for ' + selectedVoice.replace('FILL_ID_', '') +
      '. Copy the ID from elevenlabs.io → Voices and paste it in tts.js.'
    ));
  }
  return fetch(ELEVENLABS_URL + selectedVoice + '?output_format=mp3_44100_128', {
    method:  'POST',
    headers: {
      'Accept':       'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key':   ELEVENLABS_KEY
    },
    body: JSON.stringify({
      text:           text,
      model_id:       ELEVENLABS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }
    })
  })
  .then(function(res) {
    if (!res.ok) throw new Error('ElevenLabs HTTP ' + res.status);
    return res.blob();
  })
  .then(_blobToB64);
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

// ─── Web Speech API (Edge/Browser provider) ───────────────────
var _wssSpeaking    = false;  // Web Speech API is currently speaking
var _wssPaused      = false;  // Web Speech API is paused
var _wssCurrentBtn  = null;   // button that triggered the current utterance
var _wssCurrentCard = false;  // whether current utterance was triggered via speakCard

function _loadEdgeVoices() {
  if (!window.speechSynthesis) return;
  var voices   = speechSynthesis.getVoices();
  var jaVoices = voices.filter(function(v) { return v.lang && v.lang.indexOf('ja') === 0; });
  if (!jaVoices.length) return;

  VOICE_CATALOGUE.edge = jaVoices.map(function(v) {
    return { id: v.voiceURI, label: v.name };
  });

  // If on edge provider and saved voice no longer valid, reset to first
  if (selectedProvider === 'edge') {
    var valid = VOICE_CATALOGUE.edge.some(function(v) { return v.id === selectedVoice; });
    if (!valid) {
      selectedVoice = VOICE_CATALOGUE.edge[0].id;
      try { localStorage.setItem('jpStudy_voice', selectedVoice); } catch(e) {}
    }
    _renderVoicePanel();
  }
}

// Get the speechSynthesis voice object matching selectedVoice (or best ja-JP fallback)
function _getEdgeVoice() {
  var voices = speechSynthesis.getVoices();
  return voices.filter(function(v) { return v.voiceURI === selectedVoice; })[0]
      || voices.filter(function(v) { return v.lang && v.lang.indexOf('ja') === 0; })[0]
      || null;
}

function _speakEdge(text, btnEl, isCard) {
  if (!window.speechSynthesis) {
    alert('Web Speech API not supported in this browser. Try Chrome or Edge.');
    return;
  }

  // ── PAUSE ─────────────────────────────────────────────────
  // Same button clicked while speaking → pause
  if (_wssSpeaking && !_wssPaused) {
    var sameBtn  = btnEl  && _wssCurrentBtn  === btnEl;
    var sameCard = isCard && _wssCurrentCard;
    if (sameBtn || sameCard) {
      speechSynthesis.pause();
      _wssPaused   = true;
      _wssSpeaking = false;
      isSpeaking   = false;
      if (_wssCurrentBtn)  _wssCurrentBtn.innerHTML  = '&#9654;';
      if (_wssCurrentCard) _setBtn(ICON_PLAY);
      return;
    }
  }

  // ── RESUME ────────────────────────────────────────────────
  // Same button clicked while paused → resume
  if (_wssPaused) {
    var sameBtnR  = btnEl  && _wssCurrentBtn  === btnEl;
    var sameCardR = isCard && _wssCurrentCard;
    if (sameBtnR || sameCardR) {
      speechSynthesis.resume();
      _wssPaused   = false;
      _wssSpeaking = true;
      isSpeaking   = true;
      if (_wssCurrentBtn)  _wssCurrentBtn.innerHTML  = ICON_PAUSE;
      if (_wssCurrentCard) _setBtn(ICON_PAUSE);
      return;
    }
  }

  // ── NEW utterance ─────────────────────────────────────────
  speechSynthesis.cancel();
  _wssSpeaking = false;
  _wssPaused   = false;
  isSpeaking   = false;
  // Reset previous button icons
  if (_wssCurrentBtn)              { _wssCurrentBtn.innerHTML = '&#9654;'; }
  if (_wssCurrentCard)             { _setBtn(ICON_PLAY); }

  _wssCurrentBtn  = btnEl  || null;
  _wssCurrentCard = !!isCard;

  var utterance  = new SpeechSynthesisUtterance(text);
  var edgeVoice  = _getEdgeVoice();
  if (edgeVoice) utterance.voice = edgeVoice;
  utterance.lang = 'ja-JP';
  utterance.rate = 0.9;

  utterance.onstart = function() {
    _wssSpeaking = true;
    _wssPaused   = false;
    isSpeaking   = true;
    if (btnEl)   btnEl.innerHTML = ICON_PAUSE;
    if (isCard)  _setBtn(ICON_PAUSE);
  };
  utterance.onend = function() {
    _wssSpeaking    = false;
    _wssPaused      = false;
    isSpeaking      = false;
    _wssCurrentBtn  = null;
    _wssCurrentCard = false;
    if (btnEl)  btnEl.innerHTML = '&#9654;';
    if (isCard) _setBtn(ICON_PLAY);
  };
  utterance.onerror = function(e) {
    if (e.error === 'interrupted' || e.error === 'canceled') return; // intentional cancel
    _wssSpeaking    = false;
    _wssPaused      = false;
    isSpeaking      = false;
    _wssCurrentBtn  = null;
    _wssCurrentCard = false;
    if (btnEl)  btnEl.innerHTML = '&#9654;';
    if (isCard) _setBtn(ICON_PLAY);
  };

  speechSynthesis.speak(utterance);
}

// ─── SVG icons ───────────────────────────────────────────────
var ICON_PLAY  = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle"><path d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

var pausedAudio  = null;
var playToken    = 0;
var _listAudioBtn = null; // currently active list-view button (Google/ElevenLabs)

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
  if (window.speechSynthesis) { speechSynthesis.cancel(); }
  _wssSpeaking = false; _wssPaused = false;
  if (_wssCurrentBtn)              { _wssCurrentBtn.innerHTML = '&#9654;'; _wssCurrentBtn = null; }
  if (_wssCurrentCard)             { _wssCurrentCard = false; }
  if (_listAudioBtn)               { _listAudioBtn.innerHTML = '&#9654;'; _listAudioBtn = null; }
  pausedAudio = null;
  isSpeaking  = false;
}

// ─── speakJP — word popup + list view ────────────────────────
// btnEl: the clicked <button> element (list view). Undefined for word popup.
// With btnEl: supports pause/resume toggle on the same button.
// Without btnEl: one-shot play (word popup), stops any current audio.
function speakJP(text, btnEl) {
  // Edge/Browser provider — delegate entirely
  if (selectedProvider === 'edge') {
    _speakEdge(text, btnEl || null, false);
    return Promise.resolve();
  }

  var key = _cacheKey(text);

  // ── PAUSE (same list button, currently playing) ────────────
  if (btnEl && _listAudioBtn === btnEl && isSpeaking && currentAudio) {
    currentAudio.pause();
    pausedAudio  = currentAudio;
    currentAudio = null;
    isSpeaking   = false;
    btnEl.innerHTML = '&#9654;';
    return Promise.resolve();
  }

  // ── RESUME (same list button, currently paused) ────────────
  if (btnEl && _listAudioBtn === btnEl && pausedAudio && !isSpeaking) {
    var resuming = pausedAudio;
    pausedAudio  = null;
    currentAudio = resuming;
    isSpeaking   = true;
    btnEl.innerHTML = ICON_PAUSE;
    return resuming.play().catch(function() {
      currentAudio = null; isSpeaking = false; btnEl.innerHTML = '&#9654;';
    });
  }

  // ── NEW (different button, or word popup) ─────────────────
  // Stop whatever is playing
  if (currentAudio)  { currentAudio.pause(); currentAudio = null; }
  pausedAudio = null;
  isSpeaking  = false;
  _setBtn(ICON_PLAY); // reset card/review btn if it was active
  // Reset previous list button icon
  if (_listAudioBtn && _listAudioBtn !== btnEl) {
    _listAudioBtn.innerHTML = '&#9654;';
  }
  _listAudioBtn = btnEl || null;

  function playFromB64(b64) {
    return new Promise(function(resolve, reject) {
      var audio    = new Audio();
      audio.preload = 'auto';
      currentAudio  = audio;
      isSpeaking    = true;
      if (btnEl) btnEl.innerHTML = ICON_PAUSE;

      audio.onended = function() {
        if (currentAudio === audio) currentAudio = null;
        isSpeaking    = false;
        pausedAudio   = null;
        _listAudioBtn = null;
        if (btnEl) btnEl.innerHTML = '&#9654;';
        resolve();
      };
      audio.onerror = function(e) {
        if (currentAudio === audio) currentAudio = null;
        isSpeaking    = false;
        _listAudioBtn = null;
        if (btnEl) btnEl.innerHTML = '&#9654;';
        reject(e);
      };
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
    return _fetchAudio(text).then(function(b64) {
      cacheSet(key, b64);
      return playFromB64(b64);
    });
  });
}

// ─── speakCard — card view + review mode ─────────────────────
function speakCard() {
  var src = isReviewMode ? reviewQueue : getSentencesForFilter();
  var idx = isReviewMode ? reviewIdx  : currentIdx;
  var s   = src[idx];
  if (!s) return;

  // Edge/Browser provider — delegate
  if (selectedProvider === 'edge') {
    _speakEdge(s.jp, null, true);
    return;
  }

  // Reset any active list button and its paused state
  if (_listAudioBtn) {
    _listAudioBtn.innerHTML = '&#9654;';
    _listAudioBtn = null;
    pausedAudio   = null; // discard list audio — we're now in card context
  }

  // ── PAUSE ─────────────────────────────────────────────────
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

  // ── RESUME ────────────────────────────────────────────────
  if (pausedAudio) {
    var resuming = pausedAudio;
    pausedAudio  = null;
    currentAudio = resuming;
    isSpeaking   = true;
    _setBtn(ICON_PAUSE);
    setTimeout(function() {
      if (currentAudio !== resuming) return;
      resuming.play().catch(function() {
        currentAudio = null; isSpeaking = false; _setBtn(ICON_PLAY);
      });
    }, 160);
    return;
  }

  // ── FRESH PLAY ────────────────────────────────────────────
  isSpeaking  = true;
  var token   = ++playToken;
  _setBtn(ICON_PAUSE);

  var key = _cacheKey(s.jp);

  function startPlay(b64) {
    if (token !== playToken) return;
    var audio    = new Audio();
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
            currentAudio = null; isSpeaking = false; _setBtn(ICON_PLAY);
          });
        }
      }, 80);
    };
    audio.src = 'data:audio/mp3;base64,' + b64;
    audio.load();
  }

  _getAudio(key).then(function(b64) {
    if (b64) { startPlay(b64); return; }
    _fetchAudio(s.jp)
      .then(function(b64) { cacheSet(key, b64); startPlay(b64); })
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
  if (provider === 'edge') _loadEdgeVoices();
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

  // Update provider button active states
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

  // Edge-specific note
  if (selectedProvider === 'edge') {
    html += '<div style="font-family:\'DM Mono\',monospace;font-size:0.62rem;color:var(--text3);' +
      'margin-top:8px;line-height:1.6;">Uses your <strong style="color:var(--text2)">browser\'s built-in voices</strong>.' +
      ' Best in Edge with Japanese language pack installed. No API key needed.</div>';
  }

  var credit = { google: 'Google Chirp 3 HD', elevenlabs: 'ElevenLabs Eleven v3', edge: 'Edge / Browser (Web Speech API)' };
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

  // Load Edge voices — may be async on first page load
  if (window.speechSynthesis) {
    if (speechSynthesis.getVoices().length) {
      _loadEdgeVoices();
    } else {
      speechSynthesis.onvoiceschanged = _loadEdgeVoices;
    }
  }

  _renderVoicePanel();
}
