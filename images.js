/* ============================================================
   積む — images.js
   Card illustration system.
   Phase 1: placeholder only (shimmer + icon).
   Phase 2: Pollinations.ai AI image generation (coming next).
   ============================================================ */

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

function updateCardImage(sentence) {
  var el = document.getElementById('cardImage');
  if (!el) return;
  el.classList.remove('loaded');
  var existing = el.querySelector('img');
  if (existing) existing.remove();
  // Phase 2: will call generateImage(sentence, ...) here
}

function showCardImage(el, url) {
  if (!el) return;
  var img = document.createElement('img');
  img.alt = '';
  img.onload  = function() { el.classList.add('loaded'); };
  img.onerror = function() { img.remove(); el.classList.remove('loaded'); };
  img.src = url;
  el.appendChild(img);
}

loadImageCache();
