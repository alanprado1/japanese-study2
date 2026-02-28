/* ============================================================
   積む — tts.js  (load order: 2nd)
   Multi-provider Text-to-Speech: Google, ElevenLabs, Microsoft

   Providers:
   ─ Google:      Chirp 3 HD voices (ja-JP only). Returns base64 JSON.
   ─ ElevenLabs:  Multilingual v2 voices. Returns audio/mpeg binary.
   ─ Microsoft:   Azure Neural voices (ja-JP). Returns audio/mpeg binary.
                  Requires user-supplied key + region in settings.

   Audio cache:
   ─ In-memory:  audioCache (key → base64), 50-entry LRU.
   ─ IndexedDB:  'audio' store in jpStudy_db (shared with images.js).
                 Persists across sessions — no re-fetching on refresh.
   ─ Cache key:  "provider:voice|text"
   ─ LRU cap:    200 entries in IDB.
   ============================================================ */

// ─── API keys & config ────────────────────────────────────────
var GOOGLE_TTS_KEY    = 'AIzaSyDqBrrjHTWooWIgPEjLue8KshfHDEH2zfE';
var GOOGLE_TTS_URL    = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + GOOGLE_TTS_KEY;

var ELEVENLABS_KEY    = 'sk_505985290737398ea773e6782a02176e3ddad588b4110efb';
var ELEVENLABS_URL    = 'https://api.elevenlabs.io/v1/text-to-speech/';
var ELEVENLABS_MODEL  = 'eleven_multilingual_v2';

// Microsoft: key and region are entered by the user in settings
// Stored in localStorage as jpStudy_ms_key and jpStudy_ms_region
var MICROSOFT_KEY    = '';
var MICROSOFT_REGION = 'eastus';

// ─── provider & voice state ───────────────────────────────────
var selectedProvider = 'google';
var selectedVoice    = 'ja-JP-Chirp3-HD-Aoede';
var currentAudio     = null;
var isSpeaking       = false;

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
    { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel — female'    },
    { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi — female'      },
    { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella — female'     },
    { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli — female'      },
    { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte — female' },
    { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice — female'     },
    { id: 'FGY2WhTYpPnrIDTdsKH5', label: 'Laura — female'     },
    { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni — male'      },
    { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh — male'        },
    { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold — male'      },
    { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — male'        },
    { id: 'yoZ06aMxZJJ28mfd3POQ', label: 'Sam — male'         },
    { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam — male'        },
    { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel — male'      }
  ],
  microsoft: [
    { id: 'ja-JP-NanamiNeural',  label: 'Nanami — female' },
    { id: 'ja-JP-AoiNeural',     label: 'Aoi — female'    },
    { id: 'ja-JP-MayuNeural',    label: 'Mayu — female'   },
    { id: 'ja-JP-ShioriNeural',  label: 'Shiori — female' },
    { id: 'ja-JP-KeitaNeural',   label: 'Keita — male'    },
    { id: 'ja-JP-DaichiNeural',  label: 'Daichi — male'   },
    { id: 'ja-JP-NaokiNeural',   label: 'Naoki — male'    }
  ]
};

// ─── in-memory layer ─────────────────────────────────────────
var audioCache     = {};
var audioCacheKeys = [];
var AUDIO_MEM_MAX  = 50;
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
function _cacheKey(text) {
  return selectedProvider + ':' + selectedVoice + '|' + text;
}

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
    reader.onloadend = function() {
      // result is "data:audio/mpeg;base64,XXXX" — strip the prefix
      var b64 = reader.result.split(',')[1];
      resolve(b64);
    };
    reader.onerror = reject;
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
    return data.audioContent; // already base64
  });
}

function _fetchElevenLabs(text) {
  return fetch(ELEVENLABS_URL + selectedVoice, {
    method:  'POST',
    headers: {
      'Accept':       'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key':   ELEVENLABS_KEY
    },
    body: JSON.stringify({
      text:           text,
      model_id:       ELEVENLABS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  })
  .then(function(res) {
    if (!res.ok) throw new Error('ElevenLabs HTTP ' + res.status);
    return res.blob();
  })
  .then(_blobToB64);
}

function _fetchMicrosoft(text) {
  if (!MICROSOFT_KEY) throw new Error('No Microsoft TTS key set. Add it in Settings.');
  var url = 'https://' + MICROSOFT_REGION + '.tts.speech.microsoft.com/cognitiveservices/v1';
  var ssml = '<speak version="1.0" xml:lang="ja-JP">' +
    '<voice xml:lang="ja-JP" name="' + selectedVoice + '">' +
    text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') +
    '</voice></speak>';
  return fetch(url, {
    method:  'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': MICROSOFT_KEY,
      'Content-Type':              'application/ssml+xml',
      'X-Microsoft-OutputFormat':  'audio-16khz-128kbitrate-mono-mp3'
    },
    body: ssml
  })
  .then(function(res) {
    if (!res.ok) throw new Error('Microsoft TTS HTTP ' + res.status);
    return res.blob();
  })
  .then(_blobToB64);
}

function _fetchAudio(text) {
  if (selectedProvider === 'elevenlabs') return _fetchElevenLabs(text);
  if (selectedProvider === 'microsoft')  return _fetchMicrosoft(text);
  return _fetchGoogle(text);
}

// ─── prefetch (Google only — ElevenLabs/Microsoft charge per character) ──
function prefetchJP(text) {
  if (!text || selectedProvider !== 'google') return;
  var key = _cacheKey(text);
  if (cacheGet(key)) return;
  _audioIdbGet(key).then(function(b64) {
    if (b64) { cacheSet(key, b64); return; }
    _fetchGoogle(text)
      .then(function(b64) { cacheSet(key, b64); })
      .catch(function() {});
  });
}

// ─── speakJP (word popup + list view) ────────────────────────
function speakJP(text) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  var key = _cacheKey(text);

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
    return _fetchAudio(text).then(function(b64) {
      cacheSet(key, b64);
      return playFromB64(b64);
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

  var key = _cacheKey(s.jp);

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
    _fetchAudio(s.jp)
      .then(function(b64) {
        cacheSet(key, b64);
        startPlay(b64);
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
  // Switch to the first voice of the new provider
  var voices = VOICE_CATALOGUE[provider];
  selectedVoice = voices[0].id;
  try {
    localStorage.setItem('jpStudy_provider', provider);
    localStorage.setItem('jpStudy_voice', selectedVoice);
  } catch(e) {}
  _renderVoicePanel();
}

function setSpeaker(voiceId) {
  selectedVoice = voiceId;
  try { localStorage.setItem('jpStudy_voice', voiceId); } catch(e) {}
  // Update active state on voice buttons
  document.querySelectorAll('.speaker-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.sid === voiceId);
  });
}

function setMicrosoftKey(key) {
  MICROSOFT_KEY = key.trim();
  try { localStorage.setItem('jpStudy_ms_key', MICROSOFT_KEY); } catch(e) {}
}

function setMicrosoftRegion(region) {
  MICROSOFT_REGION = region.trim() || 'eastus';
  try { localStorage.setItem('jpStudy_ms_region', MICROSOFT_REGION); } catch(e) {}
}

// Renders the voice list + provider label inside #voicePanel
function _renderVoicePanel() {
  var panel = document.getElementById('voicePanel');
  if (!panel) return;

  var voices = VOICE_CATALOGUE[selectedProvider] || [];

  // Update provider dropdown active state
  document.querySelectorAll('.provider-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.provider === selectedProvider);
  });

  // Build voice buttons
  var html = '<div class="weight-btns" style="flex-direction:column;gap:5px;align-items:stretch;">';
  voices.forEach(function(v) {
    var isActive = v.id === selectedVoice;
    html += '<button class="speaker-btn weight-btn' + (isActive ? ' active' : '') + '"' +
      ' data-sid="' + v.id + '"' +
      ' onclick="setSpeaker(\'' + v.id + '\')">' +
      v.label + '</button>';
  });
  html += '</div>';

  // Microsoft key/region inputs
  if (selectedProvider === 'microsoft') {
    html += '<div style="margin-top:10px;">' +
      '<input id="msKeyInput" type="text" placeholder="Azure subscription key"' +
      ' value="' + (MICROSOFT_KEY || '') + '"' +
      ' oninput="setMicrosoftKey(this.value)"' +
      ' style="width:100%;box-sizing:border-box;background:var(--bg2);border:1px solid var(--border);' +
      'color:var(--text);border-radius:6px;padding:6px 8px;font-size:0.72rem;margin-bottom:6px;">' +
      '<input id="msRegionInput" type="text" placeholder="Region (e.g. eastus)"' +
      ' value="' + (MICROSOFT_REGION || 'eastus') + '"' +
      ' oninput="setMicrosoftRegion(this.value)"' +
      ' style="width:100%;box-sizing:border-box;background:var(--bg2);border:1px solid var(--border);' +
      'color:var(--text);border-radius:6px;padding:6px 8px;font-size:0.72rem;">' +
      '</div>';
  }

  // Provider credit line
  var credit = { google: 'Google Chirp 3 HD', elevenlabs: 'ElevenLabs Multilingual v2', microsoft: 'Microsoft Azure Neural' };
  html += '<div style="font-family:\'DM Mono\',monospace;font-size:0.62rem;color:var(--text3);margin-top:10px;line-height:1.6;">' +
    'Powered by <strong style="color:var(--text2)">' + credit[selectedProvider] + '</strong></div>';

  panel.innerHTML = html;
}

function loadVoicePref() {
  try {
    var prov  = localStorage.getItem('jpStudy_provider');
    var voice = localStorage.getItem('jpStudy_voice');
    var msKey = localStorage.getItem('jpStudy_ms_key');
    var msReg = localStorage.getItem('jpStudy_ms_region');

    if (prov && VOICE_CATALOGUE[prov]) selectedProvider = prov;
    if (voice) selectedVoice = voice;
    if (msKey) MICROSOFT_KEY = msKey;
    if (msReg) MICROSOFT_REGION = msReg;
  } catch(e) {}
  // Render is deferred until settings panel is first opened,
  // but we call it here so the panel is correct if opened early.
  _renderVoicePanel();
}
