/* ============================================================
   積む — images.js
   Ghibli-style AI card illustrations via Pollinations.ai
   ============================================================ */

var POLLINATIONS_KEY = 'sk_qu92tw0tCoYDRIEZHLmNAgJ8j9phHCE9';

// Cache: sentenceId → URL string
var imageUrlCache = {};
// Track which sentences are currently loading (to avoid double-requests)
var _imageLoading = {};

function loadImageUrlCache() {
  try {
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

// Deterministic seed per sentence — same card always gets the same scene
function _seedFromId(id) {
  var hash = 0, str = String(id);
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100000;
}

// Responsive dimensions matching .card-image CSS
// Desktop: card-image is 70% width × 352px tall → request 520×300
// Mobile (≤600px CSS): card-image is 90% width × 352px tall → request 360×280
function _imageSize() {
  return window.innerWidth <= 600
    ? { w: 360, h: 280 }
    : { w: 520, h: 300 };
}

// Build URL using gen.pollinations.ai with API key.
// This is the authenticated endpoint — bypasses rate limiting that blocks mobile
// (mobile carriers use NAT: many phones share one IP, hitting free-tier limits instantly).
function _buildImageUrl(sentence) {
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

// ─── core update function ─────────────────────────────────────
// Called by renderCard() on every card change.

function updateCardImage(sentence) {
  var el = document.getElementById('cardImage');
  if (!el) return;

  // Cancel any pending load for the previous card
  var prevId = _currentSentenceId(el);
  if (prevId) delete _imageLoading[prevId];

  // Clear previous state
  el.classList.remove('loaded');
  var existing = el.querySelector('img');
  if (existing) existing.remove();
  el.removeAttribute('data-sentence-id');
  _setPlaceholderText(el, '絵');

  if (!sentence || !isImageGenEnabled()) return;

  _setPlaceholderText(el, '...');

  // Build URL once, cache it
  if (!imageUrlCache[sentence.id]) {
    imageUrlCache[sentence.id] = _buildImageUrl(sentence);
    _saveImageUrlCache();
  }

  _loadImage(el, imageUrlCache[sentence.id], sentence.id, 0);
}

// ─── load with retry ─────────────────────────────────────────
// retryCount: number of times we've already retried (max 2)

function _loadImage(el, url, sentenceId, retryCount) {
  el.setAttribute('data-sentence-id', String(sentenceId));
  _imageLoading[sentenceId] = true;

  var img = document.createElement('img');
  img.alt = '';

  // Timeout: Pollinations can be slow. If nothing after 45s, trigger error handler.
  var timeoutId = setTimeout(function() {
    if (_imageLoading[sentenceId]) {
      img.src = ''; // abort
      handleError();
    }
  }, 45000);

  function handleError() {
    clearTimeout(timeoutId);
    delete _imageLoading[sentenceId];
    if (img.parentNode) img.parentNode.removeChild(img);

    // Check this card is still displayed
    if (_currentSentenceId(el) !== String(sentenceId)) return;

    if (retryCount < 2) {
      // Retry after a short delay — mobile network hiccup or server busy
      var delay = (retryCount + 1) * 3000; // 3s, then 6s
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== String(sentenceId)) return;
        // Rebuild URL fresh on retry (clears any bad cached state)
        var freshUrl = _buildImageUrl({ id: sentenceId, en: '', jp: '' });
        // Try to find the actual sentence for the proper prompt
        if (typeof sentences !== 'undefined') {
          for (var i = 0; i < sentences.length; i++) {
            if (String(sentences[i].id) === String(sentenceId)) {
              freshUrl = _buildImageUrl(sentences[i]);
              break;
            }
          }
        }
        imageUrlCache[sentenceId] = freshUrl;
        _saveImageUrlCache();
        _loadImage(el, freshUrl, sentenceId, retryCount + 1);
      }, delay);
    } else {
      // All retries exhausted — clear cache so next navigation tries fresh
      delete imageUrlCache[sentenceId];
      _saveImageUrlCache();
      _setPlaceholderText(el, '✕');
    }
  }

  img.onload = function() {
    clearTimeout(timeoutId);
    delete _imageLoading[sentenceId];
    if (_currentSentenceId(el) !== String(sentenceId)) return;
    el.classList.add('loaded');
    _setPlaceholderText(el, '絵');
  };

  img.onerror = handleError;

  // Append to DOM BEFORE setting src so onload fires with img in tree
  el.appendChild(img);
  img.src = url;
}

// ─── prefetch for next card ───────────────────────────────────

function prefetchCardImage(sentence) {
  if (!sentence || !isImageGenEnabled()) return;
  if (imageUrlCache[sentence.id]) return;

  var url = _buildImageUrl(sentence);
  imageUrlCache[sentence.id] = url;
  _saveImageUrlCache();

  var img = new Image();
  img.src = url;
}

// ─── toggle (called from deck modal button) ───────────────────

function toggleImageGen(deckId) {
  var d = decks[deckId];
  if (!d) return;
  d.imageGenEnabled = !d.imageGenEnabled;
  if (typeof saveDeck === 'function') saveDeck(deckId);
  if (typeof updateDeckUI === 'function') updateDeckUI();
  if (deckId === currentDeckId && typeof render === 'function') render();
}

// ─── page visibility: retry when tab becomes active again ─────
// Mobile: browser suspends tabs in background. When user returns,
// any pending loads may have been killed. Re-trigger the current card.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  if (!isImageGenEnabled()) return;

  var el = document.getElementById('cardImage');
  if (!el) return;

  // If the card has no image loaded and no active load in progress, retry
  var sentenceId = _currentSentenceId(el);
  if (!sentenceId) return;
  if (el.classList.contains('loaded')) return;
  if (_imageLoading[sentenceId]) return;

  // Find the sentence and re-trigger
  if (typeof sentences !== 'undefined') {
    for (var i = 0; i < sentences.length; i++) {
      if (String(sentences[i].id) === sentenceId) {
        var url = imageUrlCache[sentenceId] || _buildImageUrl(sentences[i]);
        _loadImage(el, url, sentenceId, 0);
        return;
      }
    }
  }
});

// ─── init ─────────────────────────────────────────────────────
loadImageUrlCache();
