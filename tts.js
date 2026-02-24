/* ============================================================
   積む — tts.js  (load order: 2nd)
   Google Chirp 3 HD Text-to-Speech
   ============================================================ */

var GOOGLE_TTS_KEY = 'AIzaSyDqBrrjHTWooWIgPEjLue8KshfHDEH2zfE';
var GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=' + GOOGLE_TTS_KEY;

var currentAudio     = null;
var selectedVoice    = 'ja-JP-Chirp3-HD-Aoede';
var isSpeaking       = false;
var speakCancelToken = 0; // incremented on each stop to cancel in-flight fetches

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
function speakJP(text, cancelToken) {
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
    if (cancelToken !== undefined && cancelToken !== speakCancelToken) return Promise.resolve();
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
    if (cancelToken !== undefined && cancelToken !== speakCancelToken) return;
    return playFromB64(data.audioContent);
  });
}

function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
}

function speakCard() {
  // In card mode, sentences are filtered — must use same source as renderCard
  var src = isReviewMode ? reviewQueue : getSentencesForFilter();
  var idx = isReviewMode ? reviewIdx  : currentIdx;
  var s   = src[idx];
  if (!s) return;

  var btn = document.getElementById('cardAudioBtn');

  if (isSpeaking) {
    // Pause: cancel any in-flight fetch, stop current audio
    speakCancelToken++;
    stopAudio();
    isSpeaking = false;
    if (btn) btn.classList.remove('playing');
    return;
  }

  isSpeaking = true;
  if (btn) btn.classList.add('playing');

  var token = speakCancelToken;
  speakJP(s.jp, token)
    .catch(function(err) {
      if (err) {
        console.error('TTS error:', err);
        alert('Audio failed. Check your API key or internet connection.');
      }
    })
    .then(function() {
      isSpeaking = false;
      if (btn) btn.classList.remove('playing');
    });
}

function resetAudioBtn() {
  speakCancelToken++; // cancel any in-flight fetch
  stopAudio();
  isSpeaking = false;
  var btn = document.getElementById('cardAudioBtn');
  if (btn) btn.classList.remove('playing');
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
