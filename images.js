/* ============================================================
   積む — images.js
   Ghibli-style AI card illustrations via Pollinations.ai
   ============================================================
   Architecture:
   · Per-deck opt-in toggle (imageGenEnabled on deck object)
   · URL cache in localStorage: sentence ID → image URL
     (URLs are tiny; images are served from Pollinations CDN)
   · Shimmer placeholder shows while image loads
   · Same sentence always gets the same image (deterministic seed)
   · Background prefetch for the next card
   · Responsive: different pixel sizes for desktop vs mobile
   ============================================================ */

var POLLINATIONS_KEY = 'sk_qu92tw0tCoYDRIEZHLmNAgJ8j9phHCE9';

// Cache: sentenceId → URL string
// Keyed by id (not text) so renamed sentences still work.
var imageUrlCache = {};

function loadImageUrlCache() {
  try {
    var raw = localStorage.getItem('jpStudy_image_urls');
    if (raw) imageUrlCache = JSON.parse(raw);
  } catch(e) { imageUrlCache = {}; }
}

// Debounced save — avoids thrashing on rapid navigation
var _imageUrlSaveTimer = null;
function saveImageUrlCacheDebounced() {
  if (_imageUrlSaveTimer) clearTimeout(_imageUrlSaveTimer);
  _imageUrlSaveTimer = setTimeout(function() {
    try { localStorage.setItem('jpStudy_image_urls', JSON.stringify(imageUrlCache)); } catch(e) {}
  }, 600);
}

// ─── helpers ────────────────────────────────────────────────

// Returns true if the current deck has AI images enabled
function isImageGenEnabled() {
  var d = (typeof decks !== 'undefined' && typeof currentDeckId !== 'undefined')
    ? decks[currentDeckId] : null;
  return !!(d && d.imageGenEnabled);
}

// Deterministic seed from sentence ID — same prompt always yields
// the same Ghibli scene, avoiding regeneration jitter on re-render.
function _seedFromId(id) {
  var hash = 0;
  var str  = String(id);
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0; // force 32-bit int
  }
  return Math.abs(hash) % 1000000;
}

// Returns responsive pixel dimensions matching the CSS card sizes.
// Desktop : .card-image is height:352px, width ~70% of ~800px card ≈ 560px
// Mobile (≤600px): .card-image is height:352px, width:90% — request 360px
function _imageSize() {
  if (window.innerWidth <= 600) {
    return { w: 360, h: 352 };
  }
  return { w: 560, h: 352 };
}

// Build the Pollinations URL for a given sentence
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

// ─── core update function ────────────────────────────────────
// Called by renderCard() every time the displayed card changes.
// If image gen is off → clear to placeholder (shimmer stays in HTML).
// If image gen is on  → check URL cache → display or fetch.

function updateCardImage(sentence) {
  var el = document.getElementById('cardImage');
  if (!el) return;

  // Always clear the previous image first
  el.classList.remove('loaded');
  var existing = el.querySelector('img');
  if (existing) existing.remove();
  delete el.dataset.sentenceId;

  if (!sentence || !isImageGenEnabled()) return;

  // Build or retrieve URL — Pollinations generates server-side, so the
  // URL itself is the request. Store it immediately so cache is consistent.
  if (!imageUrlCache[sentence.id]) {
    imageUrlCache[sentence.id] = _buildImageUrl(sentence);
    saveImageUrlCacheDebounced();
  }

  _displayImage(el, imageUrlCache[sentence.id], sentence.id);
}

function _displayImage(el, url, sentenceId) {
  var img    = document.createElement('img');
  img.alt    = '';
  img.onload = function() {
    // Verify the container still belongs to this sentence (user may have
    // navigated away while the image was loading — don't paint a stale image)
    if (el.dataset.sentenceId === String(sentenceId)) {
      el.classList.add('loaded');
    }
  };
  img.onerror = function() {
    img.remove();
    el.classList.remove('loaded');
    // Keep the URL in cache — Pollinations may be temporarily slow;
    // a re-visit will retry naturally without re-generating the URL.
  };
  // Tag the container with the sentence id so the onload callback can
  // verify freshness even after rapid navigation
  el.dataset.sentenceId = String(sentenceId);
  img.src = url;
  el.appendChild(img);
}

// ─── prefetch ────────────────────────────────────────────────
// Called by renderCard() for the NEXT card. Fires a silent background
// request so the image is in the browser HTTP cache before the user
// navigates to it. Skipped if already cached or images are off.
function prefetchCardImage(sentence) {
  if (!sentence || !isImageGenEnabled()) return;
  if (imageUrlCache[sentence.id]) return; // browser already has it cached

  var url = _buildImageUrl(sentence);
  imageUrlCache[sentence.id] = url;
  saveImageUrlCacheDebounced();

  // A hidden Image object triggers a real HTTP request that the browser caches
  var img = new Image();
  img.src = url;
  // Best-effort — no onload/onerror needed for a prefetch
}

// ─── toggle (called from deck modal button) ──────────────────
function toggleImageGen(deckId) {
  var d = decks[deckId];
  if (!d) return;
  d.imageGenEnabled = !d.imageGenEnabled;
  // saveDeck persists to localStorage and (if signed in) to Firestore
  if (typeof saveDeck === 'function') saveDeck(deckId);
  // Refresh deck modal so button label updates
  if (typeof updateDeckUI === 'function') updateDeckUI();
  // Immediately show/hide image on the current card
  if (deckId === currentDeckId && typeof render === 'function') render();
}

// ─── init ────────────────────────────────────────────────────
loadImageUrlCache();
