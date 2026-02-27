/* ============================================================
   積む — images.js
   Ghibli-style AI card illustrations via Pollinations.ai
   ============================================================ */

var POLLINATIONS_KEY = 'sk_qu92tw0tCoYDRIEZHLmNAgJ8j9phHCE9';

// Bump this version whenever the URL format changes.
// On mismatch, the old cache is discarded so stale URLs don't persist.
var IMAGE_CACHE_VERSION = 'v4';

// Cache: sentenceId → URL string
var imageUrlCache = {};
// Track active loads to avoid duplicate requests
var _imageLoading = {};

function loadImageUrlCache() {
  try {
    var version = localStorage.getItem('jpStudy_image_cache_ver');
    if (version !== IMAGE_CACHE_VERSION) {
      // URL format changed — old cached URLs are invalid, start fresh
      localStorage.removeItem('jpStudy_image_urls');
      localStorage.setItem('jpStudy_image_cache_ver', IMAGE_CACHE_VERSION);
      imageUrlCache = {};
      return;
    }
    var raw = localStorage.getItem('jpStudy_image_urls');
    if (raw) imageUrlCache = JSON.parse(raw);
  } catch(e) { imageUrlCache = {}; }
}

var _imageUrlSaveTimer = null;
function _saveImageUrlCache() {
  if (_imageUrlSaveTimer) clearTimeout(_imageUrlSaveTimer);
  _imageUrlSaveTimer = setTimeout(function() {
    try { localStorage.setItem('jpStudy_image_urls', JSON.stringify(imageUrlCache)); } catch(e) {}
  }, 800);
}

// ─── helpers ─────────────────────────────────────────────────

function isImageGenEnabled() {
  var d = (typeof decks !== 'undefined' && typeof currentDeckId !== 'undefined')
    ? decks[currentDeckId] : null;
  return !!(d && d.imageGenEnabled);
}

// Deterministic seed — same card always gets the same Ghibli scene
function _seedFromId(id) {
  var hash = 0, str = String(id);
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100000;
}

// Responsive dimensions matching .card-image CSS
function _imageSize() {
  return window.innerWidth <= 600
    ? { w: 360, h: 280 }
    : { w: 520, h: 300 };
}

// ─── dual-endpoint URL builders ───────────────────────────────
// Primary:   image.pollinations.ai with ?token=KEY
//            Official authenticated endpoint — works on desktop & mobile.
// Fallback:  gen.pollinations.ai with ?key=KEY
//            Authenticated newer API — used if primary fails.

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

// ─── core update ─────────────────────────────────────────────

function updateCardImage(sentence) {
  var el = document.getElementById('cardImage');
  if (!el) return;

  // Cancel any pending load for the previous card
  var prevId = _currentSentenceId(el);
  if (prevId) delete _imageLoading[prevId];

  // Reset
  el.classList.remove('loaded');
  var existing = el.querySelector('img');
  if (existing) existing.remove();
  el.removeAttribute('data-sentence-id');
  _setPlaceholderText(el, '絵');

  if (!sentence || !isImageGenEnabled()) return;

  _setPlaceholderText(el, '...');

  // Cache the primary URL for this sentence (once per session)
  if (!imageUrlCache[sentence.id]) {
    imageUrlCache[sentence.id] = _buildPrimaryUrl(sentence);
    _saveImageUrlCache();
  }

  _loadImage(el, sentence, imageUrlCache[sentence.id], 'primary', 0);
}

// ─── load with endpoint fallback + retry ─────────────────────
// endpoint: 'primary' | 'fallback'
// retryCount: retries on the current endpoint (max 1 each)

function _loadImage(el, sentence, url, endpoint, retryCount) {
  el.setAttribute('data-sentence-id', String(sentence.id));
  _imageLoading[sentence.id] = true;

  var img = document.createElement('img');
  img.alt = '';

  // 45-second timeout — Pollinations AI generation can be slow
  var timeoutId = setTimeout(function() {
    if (_imageLoading[sentence.id]) {
      img.src = '';
      handleError();
    }
  }, 45000);

  function handleError() {
    clearTimeout(timeoutId);
    delete _imageLoading[sentence.id];
    if (img.parentNode) img.parentNode.removeChild(img);

    // Bail if user navigated away
    if (_currentSentenceId(el) !== String(sentence.id)) return;

    if (endpoint === 'primary' && retryCount < 1) {
      // Retry primary once after 3s
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== String(sentence.id)) return;
        var freshUrl = _buildPrimaryUrl(sentence);
        imageUrlCache[sentence.id] = freshUrl;
        _saveImageUrlCache();
        _loadImage(el, sentence, freshUrl, 'primary', retryCount + 1);
      }, 3000);

    } else if (endpoint !== 'fallback') {
      // Primary exhausted — switch to fallback endpoint
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== String(sentence.id)) return;
        var fallbackUrl = _buildFallbackUrl(sentence);
        imageUrlCache[sentence.id] = fallbackUrl;
        _saveImageUrlCache();
        _loadImage(el, sentence, fallbackUrl, 'fallback', 0);
      }, 2000);

    } else if (endpoint === 'fallback' && retryCount < 1) {
      // Retry fallback once after 5s
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== String(sentence.id)) return;
        var freshUrl = _buildFallbackUrl(sentence);
        imageUrlCache[sentence.id] = freshUrl;
        _saveImageUrlCache();
        _loadImage(el, sentence, freshUrl, 'fallback', retryCount + 1);
      }, 5000);

    } else {
      // All endpoints and retries exhausted
      delete imageUrlCache[sentence.id];
      _saveImageUrlCache();
      _setPlaceholderText(el, '✕');
    }
  }

  img.onload = function() {
    clearTimeout(timeoutId);
    delete _imageLoading[sentence.id];
    if (_currentSentenceId(el) !== String(sentence.id)) return;
    el.classList.add('loaded');
    _setPlaceholderText(el, '絵');
  };

  img.onerror = handleError;

  // Append BEFORE setting src — ensures img is in DOM if onload fires synchronously
  // (happens on browser disk-cache hits)
  el.appendChild(img);
  img.src = url;
}

// ─── prefetch next card ───────────────────────────────────────

function prefetchCardImage(sentence) {
  if (!sentence || !isImageGenEnabled()) return;
  if (imageUrlCache[sentence.id]) return;

  var url = _buildPrimaryUrl(sentence);
  imageUrlCache[sentence.id] = url;
  _saveImageUrlCache();

  var img = new Image();
  img.src = url;
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
  var sentenceId = _currentSentenceId(el);
  if (!sentenceId) return;
  if (el.classList.contains('loaded')) return;
  if (_imageLoading[sentenceId]) return;

  // Find the sentence object and retry from primary
  if (typeof sentences !== 'undefined') {
    for (var i = 0; i < sentences.length; i++) {
      if (String(sentences[i].id) === sentenceId) {
        var s = sentences[i];
        var url = _buildPrimaryUrl(s);
        imageUrlCache[sentenceId] = url;
        _loadImage(el, s, url, 'primary', 0);
        return;
      }
    }
  }
});

// ─── init ─────────────────────────────────────────────────────
loadImageUrlCache();
