/* ============================================================
   積む — images.js
   Card illustration system.
   Phase 1: placeholder only (shimmer + icon).
   Phase 2: Pollinations.ai AI image generation (coming next).
   ============================================================ */

// ─── image cache ─────────────────────────────────────────────
// Key: sentence id → image URL string
// Stored in localStorage so images are only ever generated once per sentence.
var imageCache = {};

function loadImageCache() {
  try {
    var raw = localStorage.getItem('jpStudy_image_cache');
    if (raw) imageCache = JSON.parse(raw);
  } catch(e) { imageCache = {}; }
}

function saveImageCache() {
  try { localStorage.setItem('jpStudy_image_cache', JSON.stringify(imageCache)); } catch(e) {}
}

// ─── updateCardImage ──────────────────────────────────────────
// Called by renderCard() every time the card changes.
// Phase 1: just shows the placeholder (shimmer + 絵 icon).
// Phase 2: will check imageCache first, then call generateImage() if needed.
function updateCardImage(sentence) {
  var el = document.getElementById('cardImage');
  if (!el) return;

  // Remove loaded state — reset to placeholder for this card
  el.classList.remove('loaded');

  // Remove any previously injected <img>
  var existing = el.querySelector('img');
  if (existing) existing.remove();

  // Phase 2 will go here:
  // if (imageCache[sentence.id]) {
  //   showCardImage(el, imageCache[sentence.id]);
  // } else {
  //   generateImage(sentence, function(url) {
  //     imageCache[sentence.id] = url;
  //     saveImageCache();
  //     showCardImage(el, url);
  //   });
  // }
}

// ─── showCardImage ────────────────────────────────────────────
// Injects a loaded <img> into the card image area and hides the placeholder.
function showCardImage(el, url) {
  if (!el) return;
  var img = document.createElement('img');
  img.alt = '';
  img.onload = function() {
    el.classList.add('loaded');
  };
  img.onerror = function() {
    // Image failed — stay on placeholder silently
    img.remove();
    el.classList.remove('loaded');
  };
  img.src = url;
  el.appendChild(img);
}

// ─── generateImage ────────────────────────────────────────────
// Phase 2: generates a Ghibli-style image via Pollinations.ai.
// Uses the English translation as the scene prompt.
// Will be activated in the next phase.
//
// function generateImage(sentence, callback) {
//   var prompt = encodeURIComponent(
//     'Studio Ghibli anime style, soft watercolour painting, peaceful Japanese scene, ' +
//     sentence.en + ', detailed background, warm light, no text, no characters'
//   );
//   var url = 'https://image.pollinations.ai/prompt/' + prompt +
//     '?width=800&height=500&nologo=true&seed=' + Math.abs(hashCode(sentence.id));
//   callback(url);
// }
//
// function hashCode(str) {
//   var hash = 0;
//   for (var i = 0; i < str.length; i++) {
//     hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
//   }
//   return hash;
// }

// ─── init ────────────────────────────────────────────────────
loadImageCache();
