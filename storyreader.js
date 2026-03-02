/* ============================================================
   積む — storyreader.js  (Phase 4, Session C)

   Layout: two-column CSS grid.
   ─ Left cell  (#srImageCell): image panel with placeholder + real <img>.
   ─ Right cell (.sr-text-cell): scrollable text — title, nav, segments, audio bar.

   Images:
   ─ Path 1: IDB data-URL hit → instant, replaces placeholder with <img>.
   ─ Path 2: Pollinations network fetch → fetched as blob→dataURL, cached
     in IDB, then shown. Placeholder stays visible the whole time.
   ─ Path 3: Fetch fails → placeholder stays, no blank void.

   Audio:
   ─ speakJP(text, btn) — identical to all other audio buttons.
   ─ stopAudio() called on page navigation and reader close.
   ─ Page audio prefetched in background so Play responds instantly.
   ============================================================ */

// ─── Swipe state ──────────────────────────────────────────────
var _srSwipeStartX = 0;
var _srSwipeStartY = 0;
var _srSwipeDir    = null;
var _srSwipeWired  = false;

// ─── Open ─────────────────────────────────────────────────────
function openStoryReader(story) {
  if (!story || !story.pages || !story.pages.length) return;
  currentStory   = story;
  currentPageIdx = 0;
  _srStopAudio();

  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  _srRenderPage();

  if (!_srSwipeWired) { _srWireSwipe(overlay); _srSwipeWired = true; }
}

// ─── Close ────────────────────────────────────────────────────
function closeStoryReader() {
  _srStopAudio();
  currentStory   = null;
  currentPageIdx = 0;
  var overlay = document.getElementById('storyReaderOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ─── Navigate ─────────────────────────────────────────────────
function _srGoTo(idx) {
  if (!currentStory) return;
  if (idx < 0 || idx >= currentStory.pages.length) return;
  _srStopAudio();
  currentPageIdx = idx;
  _srRenderPage();
}

// ─── Audio stop ───────────────────────────────────────────────
function _srStopAudio() {
  if (typeof stopAudio === 'function') stopAudio();
}

// ─── Render page ──────────────────────────────────────────────
function _srRenderPage() {
  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay || !currentStory) return;

  var story    = currentStory;
  var pageIdx  = currentPageIdx;
  var page     = story.pages[pageIdx];
  var total    = story.pages.length;
  var segments = page ? page.segments : [];
  var isFirst  = pageIdx === 0;
  var isLast   = pageIdx === total - 1;

  var titleHTML = '';
  if (isFirst) {
    titleHTML =
      '<div class="sr-title-block">' +
        '<div class="sr-title-ja">' + _srEsc(story.title   || '') + '</div>' +
        '<div class="sr-title-en">' + _srEsc(story.titleEn || '') + '</div>' +
      '</div>';
  }

  var prevDis = isFirst ? ' disabled' : '';
  var nextDis = isLast  ? ' disabled' : '';
  var navHTML =
    '<div class="sr-nav">' +
      '<button class="sr-nav-btn" onclick="_srGoTo(' + (pageIdx - 1) + ')"' + prevDis + '>← Prev</button>' +
      '<div class="sr-page-counter">' + (pageIdx + 1) + ' / ' + total + '</div>' +
      '<button class="sr-nav-btn" onclick="_srGoTo(' + (pageIdx + 1) + ')"' + nextDis + '>Next →</button>' +
    '</div>';

  var bodyHTML = '<div class="sr-story-body">';
  for (var i = 0; i < segments.length; i++) { bodyHTML += _srRenderSegment(segments[i]); }
  bodyHTML += '</div>';

  var bottomHTML =
    '<div class="sr-bottom-bar">' +
      '<button class="sr-page-audio-btn" id="srPageAudioBtn" ' +
        'onclick="_srTogglePageAudio(this)" title="Play / pause whole page">' +
        '&#9654; Play page' +
      '</button>' +
    '</div>';

  var closeHTML =
    '<button class="sr-close-btn" onclick="closeStoryReader()" title="Close (Esc)">✕</button>';

  // ── Two-column grid layout ──
  // Left cell:  image panel (srImageCell) — plain div, no z-index tricks
  // Right cell: text panel (sr-text-cell) — scrollable, naturally in front
  overlay.innerHTML =
    closeHTML +
    '<div class="sr-grid">' +
      '<div class="sr-image-cell" id="srImageCell">' +
        '<div class="sr-image-placeholder"><span>絵</span></div>' +
      '</div>' +
      '<div class="sr-text-cell">' +
        titleHTML +
        navHTML +
        bodyHTML +
        bottomHTML +
      '</div>' +
    '</div>';

  // Load image into the left cell
  _srLoadImage(story, pageIdx);

  // Prefetch this page's TTS audio so Play button responds immediately
  _srPrefetchPageAudio(page);
}

// ─── Image loading ───────────────────────────────────────────
// Loads image into the left grid cell (#srImageCell).
// Path 1: IDB data-URL hit → instant, replace placeholder with <img>.
// Path 2: Pollinations fetch → show <img> when loaded, cache in IDB.
// Path 3: Fetch fails → placeholder stays visible, no blank void.
function _srLoadImage(story, pageIdx) {
  var cell = document.getElementById('srImageCell');
  if (!cell) return;

  var idbKey   = story.id + '_p' + pageIdx;
  var storyRef = story;
  var pageRef  = pageIdx;

  function isStale() {
    return currentStory !== storyRef || currentPageIdx !== pageRef;
  }

  // Replace the placeholder div with a real <img>
  function showImage(src) {
    if (isStale()) return;
    var c = document.getElementById('srImageCell');
    if (!c) return;
    var img = document.createElement('img');
    img.className = 'sr-image';
    img.alt = '';
    img.onload = function() {
      if (isStale()) return;
      // Remove placeholder once image is painted
      var ph = c.querySelector('.sr-image-placeholder');
      if (ph) ph.style.display = 'none';
      img.classList.add('sr-image-loaded');
    };
    img.onerror = function() {
      // Image element failed — remove it, placeholder stays
      if (img.parentNode) img.parentNode.removeChild(img);
    };
    c.appendChild(img);
    img.src = src; // set src AFTER appending so onload fires reliably
  }

  function tryPollinations() {
    if (typeof _buildPrimaryUrl !== 'function') return; // placeholder stays
    var descText = story.titleEn || story.title || '';
    var pg = story.pages && story.pages[pageIdx];
    if (pg && pg.segments) {
      for (var i = 0; i < pg.segments.length; i++) {
        if (pg.segments[i].type === 'filler') {
          descText = pg.segments[i].text.slice(0, 90);
          break;
        }
      }
    }
    var url = _buildPrimaryUrl({ id: idbKey, en: descText, jp: descText });
    // Fetch as blob → dataURL so we can cache it in IDB
    _srUrlToDataUrl(url, function(dataUrl) {
      if (isStale()) return;
      if (dataUrl) {
        if (typeof _idbSet === 'function') _idbSet(idbKey, dataUrl);
        showImage(dataUrl);
      }
      // No dataUrl = fetch failed, placeholder stays
    });
  }

  // Try IDB first
  if (typeof _idbGet === 'function') {
    _idbGet(idbKey).then(function(record) {
      if (isStale()) return;
      if (record) {
        var url = typeof record === 'string' ? record : (record && record.dataUrl);
        if (url) { showImage(url); return; }
      }
      tryPollinations();
    }).catch(function() { if (!isStale()) tryPollinations(); });
  } else {
    tryPollinations();
  }
}

// Fetch a URL and convert to data URL, async, no-throw
function _srUrlToDataUrl(url, cb) {
  fetch(url)
    .then(function(r) { return r.ok ? r.blob() : Promise.reject(r.status); })
    .then(function(blob) {
      var reader = new FileReader();
      reader.onloadend = function() { cb(reader.result); };
      reader.onerror   = function() { cb(null); };
      reader.readAsDataURL(blob);
    })
    .catch(function() { cb(null); });
}

// ─── Prefetch page audio ──────────────────────────────────────
// Starts TTS synthesis in background. By the time user presses Play,
// audio is cached and plays immediately instead of waiting for synthesis.
function _srPrefetchPageAudio(page) {
  if (!page || typeof prefetchJP !== 'function') return;
  var allText = page.segments
    .map(function(s) { return s.text.trim(); })
    .filter(function(t) { return t.length > 0; })
    .join('\u3002');
  if (allText) prefetchJP(allText);
}

// ─── Page-level TTS ───────────────────────────────────────────
function _srTogglePageAudio(btn) {
  if (!btn) btn = document.getElementById('srPageAudioBtn');
  if (!btn || !currentStory || typeof speakJP !== 'function') return;
  var page = currentStory.pages[currentPageIdx];
  if (!page || !page.segments.length) return;
  var allText = page.segments
    .map(function(s) { return s.text.trim(); })
    .filter(function(t) { return t.length > 0; })
    .join('\u3002');
  if (!allText) return;
  speakJP(allText, btn).catch(function() {});
}

// ─── Per-segment TTS ──────────────────────────────────────────
function _srPlaySegment(text, btnEl) {
  if (typeof speakJP !== 'function') return;
  speakJP(text, btnEl).catch(function() {});
}

// ─── Segment renderer ─────────────────────────────────────────
function _srRenderSegment(seg) {
  var isAnchor = seg.type === 'anchor';
  var cls      = 'sr-seg ' + (isAnchor ? 'sr-seg-anchor' : 'sr-seg-filler');
  var jpHTML   = (typeof buildJPHTML === 'function') ? buildJPHTML(seg.text) : _srEsc(seg.text);
  var safeText = seg.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  var audioBtn =
    '<button class="sr-seg-audio-btn" ' +
      'onclick="event.stopPropagation();_srPlaySegment(\'' + safeText + '\',this)" ' +
      'title="Play">&#9654;</button>';
  return '<div class="' + cls + '"><div class="sr-seg-text">' + jpHTML + '</div>' + audioBtn + '</div>';
}

// ─── Swipe ────────────────────────────────────────────────────
function _srWireSwipe(overlay) {
  overlay.addEventListener('touchstart', _srOnTouchStart, { passive: true });
  overlay.addEventListener('touchmove',  _srOnTouchMove,  { passive: true });
  overlay.addEventListener('touchend',   _srOnTouchEnd,   { passive: true });
}
function _srOnTouchStart(e) {
  if (e.touches.length !== 1) return;
  _srSwipeStartX = e.touches[0].clientX;
  _srSwipeStartY = e.touches[0].clientY;
  _srSwipeDir    = null;
}
function _srOnTouchMove(e) {
  if (!e.touches.length || _srSwipeDir) return;
  var dx = e.touches[0].clientX - _srSwipeStartX;
  var dy = e.touches[0].clientY - _srSwipeStartY;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8)
    _srSwipeDir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
}
function _srOnTouchEnd(e) {
  var t = e.changedTouches[0];
  var dx = t.clientX - _srSwipeStartX;
  var dy = t.clientY - _srSwipeStartY;
  if (_srSwipeDir === 'h' && Math.abs(dx) > 50) {
    if (dx < 0) _srGoTo(currentPageIdx + 1);
    else         _srGoTo(currentPageIdx - 1);
  } else if (_srSwipeDir === 'v' && dy > 80) {
    closeStoryReader();
  }
  _srSwipeDir = null;
}

// ─── Keyboard ─────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  var ov = document.getElementById('storyReaderOverlay');
  if (!ov || ov.style.display === 'none') return;
  if (e.key === 'Escape')     closeStoryReader();
  if (e.key === 'ArrowRight') _srGoTo(currentPageIdx + 1);
  if (e.key === 'ArrowLeft')  _srGoTo(currentPageIdx - 1);
});

// ─── HTML escape ──────────────────────────────────────────────
function _srEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
