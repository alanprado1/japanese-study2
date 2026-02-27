/* ============================================================
   積む — images.js
   Ghibli-style AI card illustrations via Pollinations.ai
   ============================================================
   Cache strategy: store actual image pixel data (dataURL) in
   localStorage, keyed per sentence. On refresh the image is
   served instantly from localStorage — zero network requests.

   Storage layout:
     jpStudy_img_{sentenceId}  → dataURL string  (one key per image)
     jpStudy_img_index         → JSON {sentenceId: timestamp, ...}
                                  used for LRU eviction

   Max 60 images kept; oldest evicted when limit is reached.
   ============================================================ */

var POLLINATIONS_KEY  = 'sk_qu92tw0tCoYDRIEZHLmNAgJ8j9phHCE9';
var IMG_CACHE_PREFIX  = 'jpStudy_img_';
var IMG_INDEX_KEY     = 'jpStudy_img_index';
var MAX_CACHED_IMAGES = 60;

// In-memory image cache: sentenceId → dataURL (or 'pending')
var _imgCache  = {};
// LRU index: sentenceId → timestamp of last use
var _imgIndex  = {};
// Tracks which sentence IDs are actively loading
var _imgLoading = {};

// ─── cache init ───────────────────────────────────────────────

function _loadImgIndex() {
  try {
    var raw = localStorage.getItem(IMG_INDEX_KEY);
    _imgIndex = raw ? JSON.parse(raw) : {};
  } catch(e) { _imgIndex = {}; }
}

function _saveImgIndex() {
  try { localStorage.setItem(IMG_INDEX_KEY, JSON.stringify(_imgIndex)); } catch(e) {}
}

function _getCachedDataUrl(sentenceId) {
  // Check memory first
  if (_imgCache[sentenceId] && _imgCache[sentenceId] !== 'pending') {
    return _imgCache[sentenceId];
  }
  // Read from localStorage
  try {
    var data = localStorage.getItem(IMG_CACHE_PREFIX + sentenceId);
    if (data) {
      _imgCache[sentenceId] = data; // warm memory cache
      return data;
    }
  } catch(e) {}
  return null;
}

function _setCachedDataUrl(sentenceId, dataUrl) {
  // Evict oldest entries if at limit
  var ids = Object.keys(_imgIndex);
  if (ids.length >= MAX_CACHED_IMAGES) {
    ids.sort(function(a, b) { return _imgIndex[a] - _imgIndex[b]; });
    var toRemove = ids.slice(0, ids.length - MAX_CACHED_IMAGES + 1);
    toRemove.forEach(function(id) {
      try { localStorage.removeItem(IMG_CACHE_PREFIX + id); } catch(e) {}
      delete _imgIndex[id];
      delete _imgCache[id];
    });
  }
  // Store
  try {
    localStorage.setItem(IMG_CACHE_PREFIX + sentenceId, dataUrl);
    _imgIndex[sentenceId] = Date.now();
    _saveImgIndex();
    _imgCache[sentenceId] = dataUrl;
  } catch(e) {
    // localStorage quota exceeded — evict half and try once more
    _evictHalf();
    try { localStorage.setItem(IMG_CACHE_PREFIX + sentenceId, dataUrl); } catch(e2) {}
  }
}

function _evictHalf() {
  var ids = Object.keys(_imgIndex);
  ids.sort(function(a, b) { return _imgIndex[a] - _imgIndex[b]; });
  var half = ids.slice(0, Math.ceil(ids.length / 2));
  half.forEach(function(id) {
    try { localStorage.removeItem(IMG_CACHE_PREFIX + id); } catch(e) {}
    delete _imgIndex[id];
    delete _imgCache[id];
  });
  _saveImgIndex();
}

// ─── helpers ─────────────────────────────────────────────────

function isImageGenEnabled() {
  var d = (typeof decks !== 'undefined' && typeof currentDeckId !== 'undefined')
    ? decks[currentDeckId] : null;
  return !!(d && d.imageGenEnabled);
}

function _seedFromId(id) {
  var hash = 0, str = String(id);
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100000;
}

function _imageSize() {
  return window.innerWidth <= 600
    ? { w: 360, h: 280 }
    : { w: 520, h: 300 };
}

function _buildPrimaryUrl(sentence) {
  var size   = _imageSize();
  var prompt = 'Ghibli style: ' + (sentence.en || sentence.jp);
  var seed   = _seedFromId(sentence.id);
  return 'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(prompt) +
    '?model=flux' +
    '&width='   + size.w +
    '&height='  + size.h +
    '&seed='    + seed +
    '&nologo=true' +
    '&enhance=true' +
    '&token='   + POLLINATIONS_KEY;
}

function _buildFallbackUrl(sentence) {
  var size   = _imageSize();
  var prompt = 'Ghibli style: ' + (sentence.en || sentence.jp);
  var seed   = _seedFromId(sentence.id);
  return 'https://gen.pollinations.ai/image/' +
    encodeURIComponent(prompt) +
    '?model=flux' +
    '&width='   + size.w +
    '&height='  + size.h +
    '&seed='    + seed +
    '&enhance=true' +
    '&key='     + POLLINATIONS_KEY;
}

// ─── placeholder helpers ──────────────────────────────────────

function _setPlaceholderText(el, text) {
  var span = el.querySelector('.card-image-placeholder span');
  if (span) span.textContent = text;
}

function _currentSentenceId(el) {
  return el.getAttribute('data-sentence-id');
}

// Remove ALL img children from the card-image container.
// Using querySelectorAll (not querySelector) prevents the split-image
// bug where rapid navigation leaves multiple imgs in the flex container —
// each img takes 50% width and shows as two half-images side by side.
function _clearImgs(el) {
  var imgs = el.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) imgs[i].remove();
}

// ─── core update ─────────────────────────────────────────────

function updateCardImage(sentence) {
  var el = document.getElementById('cardImage');
  if (!el) return;

  // Cancel tracking for any previous card's pending load
  var prevId = _currentSentenceId(el);
  if (prevId) delete _imgLoading[prevId];

  // Clear ALL previous imgs (fixes split-image bug)
  el.classList.remove('loaded');
  _clearImgs(el);
  el.removeAttribute('data-sentence-id');
  _setPlaceholderText(el, '絵');

  if (!sentence || !isImageGenEnabled()) return;

  var sid = String(sentence.id);

  // ── Cache hit: serve instantly from localStorage ──────────
  var cached = _getCachedDataUrl(sid);
  if (cached) {
    _imgIndex[sid] = Date.now(); // update LRU timestamp
    _saveImgIndex();
    _displayDataUrl(el, cached, sid);
    return;
  }

  // ── Cache miss: fetch from Pollinations ───────────────────
  if (_imgLoading[sid]) return; // already fetching, don't double-request

  _setPlaceholderText(el, '...');
  _fetchImage(el, sentence, _buildPrimaryUrl(sentence), 'primary', 0);
}

// Display a dataURL directly — instant, no network request
function _displayDataUrl(el, dataUrl, sentenceId) {
  el.setAttribute('data-sentence-id', sentenceId);

  var img = document.createElement('img');
  img.alt = '';
  img.onload = function() {
    if (_currentSentenceId(el) !== sentenceId) return;
    el.classList.add('loaded');
    _setPlaceholderText(el, '絵');
  };
  // Append before src for synchronous-onload safety
  el.appendChild(img);
  img.src = dataUrl;
}

// ─── fetch → convert to dataURL → cache → display ────────────
// Uses fetch() API to download the image, then converts the blob to
// a dataURL via FileReader. The dataURL is stored in localStorage so
// subsequent refreshes are instant without any network call.

function _fetchImage(el, sentence, url, endpoint, retryCount) {
  var sid = String(sentence.id);
  el.setAttribute('data-sentence-id', sid);
  _imgLoading[sid] = true;

  var controller = null;
  var timeoutId  = null;

  // Abort controller for fetch cancellation (supported on all modern browsers)
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
  }

  // 45-second timeout
  timeoutId = setTimeout(function() {
    if (!_imgLoading[sid]) return;
    if (controller) controller.abort();
    handleError(new Error('timeout'));
  }, 45000);

  function handleError(err) {
    clearTimeout(timeoutId);
    delete _imgLoading[sid];

    if (_currentSentenceId(el) !== sid) return; // user navigated away

    if (endpoint === 'primary' && retryCount < 1) {
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== sid) return;
        _fetchImage(el, sentence, _buildPrimaryUrl(sentence), 'primary', retryCount + 1);
      }, 3000);

    } else if (endpoint !== 'fallback') {
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== sid) return;
        _fetchImage(el, sentence, _buildFallbackUrl(sentence), 'fallback', 0);
      }, 2000);

    } else if (endpoint === 'fallback' && retryCount < 1) {
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== sid) return;
        _fetchImage(el, sentence, _buildFallbackUrl(sentence), 'fallback', retryCount + 1);
      }, 5000);

    } else {
      _setPlaceholderText(el, '✕');
    }
  }

  var fetchOpts = controller ? { signal: controller.signal } : {};

  fetch(url, fetchOpts)
    .then(function(response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.blob();
    })
    .then(function(blob) {
      // Convert blob to dataURL
      return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onloadend = function() { resolve(reader.result); };
        reader.onerror   = reject;
        reader.readAsDataURL(blob);
      });
    })
    .then(function(dataUrl) {
      clearTimeout(timeoutId);
      delete _imgLoading[sid];

      // Guard: user may have navigated away while fetching
      if (_currentSentenceId(el) !== sid) return;

      // Persist to localStorage — next refresh will be instant
      _setCachedDataUrl(sid, dataUrl);

      // Clear any stale imgs that may have appeared during the fetch
      _clearImgs(el);
      _displayDataUrl(el, dataUrl, sid);
    })
    .catch(function(err) {
      if (err && err.name === 'AbortError') return; // intentional abort
      handleError(err);
    });
}

// ─── prefetch next card ───────────────────────────────────────

function prefetchCardImage(sentence) {
  if (!sentence || !isImageGenEnabled()) return;
  var sid = String(sentence.id);
  if (_getCachedDataUrl(sid)) return; // already cached
  if (_imgLoading[sid]) return;       // already fetching

  // Use a detached el-like object for prefetch — doesn't render, just caches
  var phantom = document.createElement('div');
  phantom.setAttribute('data-sentence-id', sid);
  _imgLoading[sid] = true;

  var url = _buildPrimaryUrl(sentence);

  fetch(url)
    .then(function(r) { return r.ok ? r.blob() : Promise.reject(r.status); })
    .then(function(blob) {
      return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onloadend = function() { resolve(reader.result); };
        reader.onerror   = reject;
        reader.readAsDataURL(blob);
      });
    })
    .then(function(dataUrl) {
      delete _imgLoading[sid];
      _setCachedDataUrl(sid, dataUrl);
    })
    .catch(function() { delete _imgLoading[sid]; });
}

// ─── toggle ───────────────────────────────────────────────────

function toggleImageGen(deckId) {
  var d = decks[deckId];
  if (!d) return;
  d.imageGenEnabled = !d.imageGenEnabled;
  if (typeof saveDeck === 'function') saveDeck(deckId);
  if (typeof updateDeckUI === 'function') updateDeckUI();
  if (deckId === currentDeckId && typeof render === 'function') render();
}

// ─── tab visibility: retry stalled loads when user returns ────

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  if (!isImageGenEnabled()) return;

  var el = document.getElementById('cardImage');
  if (!el) return;
  var sid = _currentSentenceId(el);
  if (!sid) return;
  if (el.classList.contains('loaded')) return;
  if (_imgLoading[sid]) return;

  // Check if it was cached while tab was hidden
  var cached = _getCachedDataUrl(sid);
  if (cached) { _displayDataUrl(el, cached, sid); return; }

  // Re-fetch from primary
  if (typeof sentences !== 'undefined') {
    for (var i = 0; i < sentences.length; i++) {
      if (String(sentences[i].id) === sid) {
        _setPlaceholderText(el, '...');
        _fetchImage(el, sentences[i], _buildPrimaryUrl(sentences[i]), 'primary', 0);
        return;
      }
    }
  }
});

// ─── init ─────────────────────────────────────────────────────
_loadImgIndex();
