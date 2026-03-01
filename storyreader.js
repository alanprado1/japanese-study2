/* ============================================================
   積む — storyreader.js
   Phase 4 Session C: Full story reader implementation

   Load order: 7th — after storybuilder.js, before app.js

   Features:
   ─ Full-screen manga-panel reader overlay
   ─ 2-column panel grid on desktop, 1-column on mobile
   ─ Anchor sentences highlighted with coloured background
   ─ Ghibli page image as 50%-opacity background
   ─ Per-page TTS button (reads all segments sequentially)
   ─ Per-panel TTS button on each segment
   ─ Furigana respects global showFurigana toggle
   ─ Page counter "2 / 5"
   ─ Prev/Next buttons + left/right swipe on mobile
   ─ Swipe-down to close on mobile
   ─ Escape key + X button to close
   ─ Next button does nothing on the last page
   ============================================================ */

// ─── Module state ─────────────────────────────────────────────
var _srSwipeStartX   = 0;   // touch start X for left/right swipe
var _srSwipeStartY   = 0;   // touch start Y for swipe-down detection
var _srSwipeDir      = null; // 'h' | 'v' | null — locked after 8px
var _srPageAudioBtn  = null; // the active "play page" button element
var _srPagePlayToken = 0;    // increments to cancel in-flight page audio
var _srPagePlaying   = false; // true while page-level TTS is running

// ─── Open the reader ──────────────────────────────────────────
function openStoryReader(story) {
  if (!story || !story.pages || !story.pages.length) return;

  currentStory   = story;
  currentPageIdx = 0;

  _srStopPageAudio(); // kill any leftover audio from a previous session

  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  _srRenderPage();
  _srWireSwipe(overlay);
}

// ─── Close the reader ─────────────────────────────────────────
function closeStoryReader() {
  _srStopPageAudio();

  currentStory   = null;
  currentPageIdx = 0;

  var overlay = document.getElementById('storyReaderOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ─── Navigate pages ───────────────────────────────────────────
function _srGoTo(idx) {
  if (!currentStory) return;
  var total = currentStory.pages.length;
  if (idx < 0 || idx >= total) return; // clamp — next does nothing on last page
  _srStopPageAudio();
  currentPageIdx = idx;
  _srRenderPage();
}

// ─── Render a single page ─────────────────────────────────────
function _srRenderPage() {
  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay || !currentStory) return;

  var story    = currentStory;
  var pageIdx  = currentPageIdx;
  var page     = story.pages[pageIdx];
  var total    = story.pages.length;
  var segments = page ? page.segments : [];

  // ── Background image (50% opacity, covers full page) ──────
  var bgKey = story.id + '_p' + pageIdx;
  _srSetBackground(overlay, bgKey);

  // ── Build HTML ─────────────────────────────────────────────
  var isFirst  = pageIdx === 0;
  var isLast   = pageIdx === total - 1;

  // Title bar (only on first page)
  var titleHTML = '';
  if (isFirst) {
    titleHTML =
      '<div class="sr-title-block">' +
        '<div class="sr-title-ja">' + _srEsc(story.title || '') + '</div>' +
        '<div class="sr-title-en">' + _srEsc(story.titleEn || '') + '</div>' +
      '</div>';
  }

  // Page counter
  var counterHTML =
    '<div class="sr-page-counter">' + (pageIdx + 1) + ' / ' + total + '</div>';

  // Page-level TTS button
  var pageAudioHTML =
    '<button class="sr-page-audio-btn" id="srPageAudioBtn" ' +
      'onclick="_srTogglePageAudio()" title="Play page">' +
      '&#9654; Play page' +
    '</button>';

  // Manga panels
  var panelsHTML = '<div class="sr-panel-grid">';
  for (var i = 0; i < segments.length; i++) {
    panelsHTML += _srRenderPanel(segments[i], i, pageIdx);
  }
  panelsHTML += '</div>';

  // Navigation
  var prevDisabled = isFirst  ? ' disabled' : '';
  var nextDisabled = isLast   ? ' disabled' : '';
  var navHTML =
    '<div class="sr-nav">' +
      '<button class="sr-nav-btn sr-nav-prev" onclick="_srGoTo(' + (pageIdx - 1) + ')"' + prevDisabled + '>← Prev</button>' +
      counterHTML +
      pageAudioHTML +
      '<button class="sr-nav-btn sr-nav-next" onclick="_srGoTo(' + (pageIdx + 1) + ')"' + nextDisabled + '>Next →</button>' +
    '</div>';

  // Close button
  var closeHTML =
    '<button class="sr-close-btn" onclick="closeStoryReader()" title="Close (Esc)">✕</button>';

  // Assemble
  overlay.innerHTML =
    closeHTML +
    '<div class="sr-content">' +
      titleHTML +
      navHTML +
      panelsHTML +
    '</div>';
}

// ─── Render a single manga panel ─────────────────────────────
function _srRenderPanel(seg, segIdx, pageIdx) {
  var isAnchor  = seg.type === 'anchor';
  var panelCls  = 'sr-panel' + (isAnchor ? ' sr-panel-anchor' : ' sr-panel-filler');

  // Japanese text — furigana if enabled
  var jpHTML = (typeof buildJPHTML === 'function')
    ? buildJPHTML(seg.text)
    : _srEsc(seg.text);

  // Per-panel audio button
  var safeText = seg.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  var audioBtnHTML =
    '<button class="sr-panel-audio-btn" ' +
      'onclick="event.stopPropagation();_srPlaySegment(\'' + safeText + '\',this)" ' +
      'title="Play segment">&#9654;</button>';

  // Anchor badge
  var badgeHTML = isAnchor
    ? '<div class="sr-anchor-badge">学</div>'
    : '';

  return (
    '<div class="' + panelCls + '" data-seg-idx="' + segIdx + '">' +
      badgeHTML +
      '<div class="sr-panel-text">' + jpHTML + '</div>' +
      audioBtnHTML +
    '</div>'
  );
}

// ─── Background image loading ─────────────────────────────────
function _srSetBackground(overlay, idbKey) {
  // Clear any previous background image
  overlay.style.backgroundImage = '';
  overlay.classList.remove('sr-has-bg');

  if (typeof _idbGet !== 'function') return;

  _idbGet(idbKey).then(function(record) {
    if (!record || !record.dataUrl) return;
    // Only apply if we're still on the same overlay instance
    if (document.getElementById('storyReaderOverlay') !== overlay) return;
    overlay.style.backgroundImage = 'url(' + record.dataUrl + ')';
    overlay.classList.add('sr-has-bg');
  }).catch(function() {});
}

// ─── Per-segment TTS ──────────────────────────────────────────
function _srPlaySegment(text, btnEl) {
  if (typeof speakJP !== 'function') return;
  // Stop any running page-level TTS first
  _srStopPageAudio();
  speakJP(text, btnEl).catch(function() {});
}

// ─── Page-level TTS ──────────────────────────────────────────
// Reads all segments of the current page sequentially.

function _srTogglePageAudio() {
  var btn = document.getElementById('srPageAudioBtn');

  if (_srPagePlaying) {
    _srStopPageAudio();
    return;
  }

  if (!currentStory) return;
  var page = currentStory.pages[currentPageIdx];
  if (!page || !page.segments.length) return;
  if (typeof speakJP !== 'function') return;

  // Collect all text segments for this page
  var texts = page.segments
    .map(function(s) { return s.text.trim(); })
    .filter(function(t) { return t.length > 0; });

  if (!texts.length) return;

  _srPagePlaying  = true;
  _srPageAudioBtn = btn;
  _srPagePlayToken++;
  var myToken = _srPagePlayToken;

  if (btn) {
    btn.innerHTML = '&#9646;&#9646; Stop';
    btn.classList.add('sr-page-audio-playing');
  }

  // Chain segments one after another
  function playNext(idx) {
    if (myToken !== _srPagePlayToken) return; // cancelled
    if (idx >= texts.length) {
      _srStopPageAudio();
      return;
    }
    var p = speakJP(texts[idx], null);
    if (p && typeof p.then === 'function') {
      // speakJP resolves when audio ends or immediately on pause/resume paths.
      // We poll isSpeaking because speakJP's promise resolves right away
      // in some code paths (cache hit starts audio but resolve fires early).
      // Instead we use a small poller to detect when audio finishes.
      _srWaitForEnd(myToken, function() {
        playNext(idx + 1);
      });
    } else {
      // speakJP returned synchronously (e.g. Web Speech path) — just move on
      playNext(idx + 1);
    }
  }

  playNext(0);
}

// Polls until isSpeaking is false or the token changes (cancelled).
function _srWaitForEnd(token, cb) {
  var MAX_WAIT = 120000; // 2 min hard ceiling
  var elapsed  = 0;
  var INTERVAL = 150;

  function tick() {
    if (token !== _srPagePlayToken) return; // cancelled
    elapsed += INTERVAL;
    if (elapsed > MAX_WAIT) { _srStopPageAudio(); return; }

    // isSpeaking is a global managed by tts.js
    var stillPlaying = (typeof isSpeaking !== 'undefined' && isSpeaking) ||
                       (typeof isPaused   !== 'undefined' && isPaused);
    if (stillPlaying) {
      setTimeout(tick, INTERVAL);
    } else {
      // Small buffer so the next segment doesn't start mid-fade
      setTimeout(cb, 120);
    }
  }
  setTimeout(tick, INTERVAL);
}

function _srStopPageAudio() {
  _srPagePlayToken++; // invalidates all in-flight waits
  _srPagePlaying  = false;

  // Stop tts.js audio engine
  if (typeof playToken !== 'undefined') playToken++;
  if (typeof currentGain !== 'undefined' && currentGain) {
    try { currentGain.gain.cancelScheduledValues(0); currentGain.gain.setValueAtTime(0, 0); } catch(e) {}
  }
  if (typeof currentAudio !== 'undefined' && currentAudio) {
    try { currentAudio.pause(); } catch(e) {}
  }
  if (typeof isSpeaking !== 'undefined') isSpeaking = false;
  if (typeof isPaused   !== 'undefined') isPaused   = false;

  // Reset page button UI
  var btn = document.getElementById('srPageAudioBtn');
  if (btn) {
    btn.innerHTML = '&#9654; Play page';
    btn.classList.remove('sr-page-audio-playing');
  }
  _srPageAudioBtn = null;
}

// ─── Touch swipe wiring ───────────────────────────────────────
// Left/right → prev/next page. Down → close reader.
// Locks direction after 8px of movement so one gesture doesn't trigger both.

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
  if (!e.touches.length) return;
  var dx = e.touches[0].clientX - _srSwipeStartX;
  var dy = e.touches[0].clientY - _srSwipeStartY;
  if (!_srSwipeDir && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
    _srSwipeDir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
  }
}

function _srOnTouchEnd(e) {
  var t = e.changedTouches[0];
  var dx = t.clientX - _srSwipeStartX;
  var dy = t.clientY - _srSwipeStartY;

  if (_srSwipeDir === 'h' && Math.abs(dx) > 50) {
    if (dx < 0) _srGoTo(currentPageIdx + 1); // swipe left → next
    else         _srGoTo(currentPageIdx - 1); // swipe right → prev
  } else if (_srSwipeDir === 'v' && dy > 80) {
    closeStoryReader(); // swipe down → close
  }
  _srSwipeDir = null;
}

// ─── Keyboard ─────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay || overlay.style.display === 'none') return;

  if (e.key === 'Escape')     { closeStoryReader(); }
  if (e.key === 'ArrowRight') { _srGoTo(currentPageIdx + 1); }
  if (e.key === 'ArrowLeft')  { _srGoTo(currentPageIdx - 1); }
});

// ─── HTML escape ──────────────────────────────────────────────
function _srEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
