/* ============================================================
   積む — storyreader.js  (Phase 4, Session C)

   Audio: speakJP(text, btn) — identical to all other audio buttons.
          stopAudio() on page navigation. Zero custom polling state.

   Images:
   ─ A dedicated <div id="srBgDiv"> child is used for the background image.
     This completely avoids CSS cascade conflicts with the overlay's own
     background shorthand property.
   ─ Path 1: IDB data-URL hit (stories generated with current code) → instant.
   ─ Path 2: Pollinations network fetch (old stories or IDB miss) → uses
     Image() preloader so the background appears only once loaded; result
     is cached in IDB for instant display next time.
   ─ Loading indicator shown while image fetches.
   ─ Audio for the whole page is prefetched in the background when a page
     renders so the Play button responds instantly.
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

  // ── Background div: sits as first child, behind everything ──
  // Using a dedicated child <div> completely avoids CSS cascade conflicts
  // with the overlay element's own background shorthand property.
  var bgHTML = '<div id="srBgDiv" class="sr-bg-div"></div>';

  overlay.innerHTML =
    bgHTML +
    closeHTML +
    titleHTML +
    '<div class="sr-content">' +
      navHTML +
      bodyHTML +
      bottomHTML +
    '</div>';

  // Load background image into the dedicated div
  _srLoadBg(story, pageIdx);

  // Prefetch this page's TTS audio so Play button responds immediately
  _srPrefetchPageAudio(page);
}

// ─── Background image loading ─────────────────────────────────
// Uses a dedicated child div (id="srBgDiv") — zero CSS cascade conflicts.
// Path 1: IDB data-URL → instant (no network).
// Path 2: Pollinations URL → Image() preloader → show when loaded → cache in IDB.
function _srLoadBg(story, pageIdx) {
  var bgDiv = document.getElementById('srBgDiv');
  if (!bgDiv) return;

  var idbKey   = story.id + '_p' + pageIdx;
  var storyRef = story;    // closure guard
  var pageRef  = pageIdx;

  function isStale() {
    return currentStory !== storyRef || currentPageIdx !== pageRef;
  }

  function applyDataUrl(dataUrl) {
    if (isStale()) return;
    var d = document.getElementById('srBgDiv');
    if (!d) return;
    d.style.backgroundImage = 'url(' + dataUrl + ')';
    d.classList.add('sr-bg-loaded');
  }

  function fetchAndApplyUrl(pollinationsUrl) {
    if (isStale()) return;
    // Show subtle loading pulse while image fetches
    var d = document.getElementById('srBgDiv');
    if (d) d.classList.add('sr-bg-loading');

    var img   = new Image();
    img.onload = function() {
      if (isStale()) return;
      var d2 = document.getElementById('srBgDiv');
      if (!d2) return;
      d2.classList.remove('sr-bg-loading');
      d2.style.backgroundImage = 'url(' + pollinationsUrl + ')';
      d2.classList.add('sr-bg-loaded');
      // Cache as blob→dataURL in IDB so next view is instant
      if (typeof _idbSet === 'function') {
        _srUrlToDataUrl(pollinationsUrl, function(dataUrl) {
          if (dataUrl) _idbSet(idbKey, dataUrl);
        });
      }
    };
    img.onerror = function() {
      var d2 = document.getElementById('srBgDiv');
      if (d2) d2.classList.remove('sr-bg-loading');
    };
    img.src = pollinationsUrl;
  }

  function tryPollinations() {
    if (typeof _buildPrimaryUrl !== 'function') return;
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
    fetchAndApplyUrl(url);
  }

  // Try IDB first
  if (typeof _idbGet === 'function') {
    _idbGet(idbKey).then(function(record) {
      if (isStale()) return;
      if (record) {
        var url = typeof record === 'string' ? record : (record && record.dataUrl);
        if (url) { applyDataUrl(url); return; }
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
