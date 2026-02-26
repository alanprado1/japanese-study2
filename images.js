/* ============================================================
   積む — images.js
   Ghibli-style AI card illustrations via Pollinations.ai
   ============================================================ */

var POLLINATIONS_KEY = 'sk_qu92tw0tCoYDRIEZHLmNAgJ8j9phHCE9';

// Cache: sentenceId → URL string
var imageUrlCache = {};

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

// Deterministic seed per sentence so the same card always gets the same scene
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

// Build Pollinations URL — using image.pollinations.ai (proven, well-documented endpoint)
function _buildImageUrl(sentence) {
  var size   = _imageSize();
  var prompt = 'Studio Ghibli style illustration: ' + (sentence.en || sentence.jp);
  var seed   = _seedFromId(sentence.id);

  return 'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(prompt) +
    '?model=flux' +
    '&width='   + size.w +
    '&height='  + size.h +
    '&seed='    + seed +
    '&nologo=true' +
    '&enhance=true';
}

// ─── show loading state in placeholder ───────────────────────
function _setPlaceholderText(el, text) {
  var span = el.querySelector('.card-image-placeholder span');
  if (span) span.textContent = text;
}

// ─── core update function ─────────────────────────────────────
function updateCardImage(sentence) {
  var el = document.getElementById('cardImage');
  if (!el) return;

  // Clear previous state
  el.classList.remove('loaded');
  var existing = el.querySelector('img');
  if (existing) existing.remove();
  el.removeAttribute('data-sentence-id');

  // Reset placeholder text
  _setPlaceholderText(el, '絵');

  if (!sentence || !isImageGenEnabled()) return;

  // Show loading indicator in placeholder
  _setPlaceholderText(el, '...');

  // Get or build URL
  if (!imageUrlCache[sentence.id]) {
    imageUrlCache[sentence.id] = _buildImageUrl(sentence);
    _saveImageUrlCache();
  }

  _loadImage(el, imageUrlCache[sentence.id], sentence.id);
}

function _loadImage(el, url, sentenceId) {
  // Tag container so onload can verify the card hasn't changed
  el.setAttribute('data-sentence-id', String(sentenceId));

  var img = document.createElement('img');
  img.alt = '';

  img.onload = function() {
    // Guard: user may have navigated to a different card while this was loading
    if (el.getAttribute('data-sentence-id') !== String(sentenceId)) return;
    el.classList.add('loaded');
    _setPlaceholderText(el, '絵');
  };

  img.onerror = function() {
    // Remove the broken image element
    if (img.parentNode) img.parentNode.removeChild(img);
    // Clear from cache so the next visit retries with a fresh request
    delete imageUrlCache[sentenceId];
    _saveImageUrlCache();
    // Show error hint in placeholder
    if (el.getAttribute('data-sentence-id') === String(sentenceId)) {
      _setPlaceholderText(el, '✕');
      el.classList.remove('loaded');
    }
  };

  // IMPORTANT: append to DOM first, THEN set src.
  // This ensures the img is in the DOM tree before any sync onload fires
  // (relevant when the browser has the image in its memory/disk cache).
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

  // Invisible Image object warms the browser cache
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

// ─── init ─────────────────────────────────────────────────────
loadImageUrlCache();
