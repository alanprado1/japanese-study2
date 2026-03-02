/* ============================================================
   積む — storyreader.js
   Phase 4 Session C: Full story reader implementation

   Load order: 7th — after storybuilder.js, before app.js

   Features:
   ─ Full-screen single-column story reader
   ─ Filler text: accent-red coloured font
   ─ Anchor text: highlighted background (study sentences)
   ─ Word tap → existing word-lookup popup (z-index fixed)
   ─ Ghibli page image as 50%-opacity background
   ─ Per-page TTS button at bottom (reads all segments sequentially)
   ─ Per-segment TTS button (proper pause/resume)
   ─ Furigana respects global showFurigana toggle
   ─ Page counter "2 / 5"
   ─ Prev/Next buttons + left/right swipe on mobile
   ─ Swipe-down to close on mobile
   ─ Escape + ArrowKeys keyboard support
   ─ X button top-left, title 5px from top
   ─ Next button does nothing on the last page
   ============================================================ */

// ─── Module state ─────────────────────────────────────────────
var _srSwipeStartX   = 0;
var _srSwipeStartY   = 0;
var _srSwipeDir      = null;  // 'h' | 'v' | null — locked after 8px
var _srPagePlayToken = 0;     // increments to cancel in-flight page audio
var _srPagePlaying   = false; // true while page-level TTS is running
var _srSwipeWired    = false; // prevent double-wiring swipe listeners

// ─── Open the reader ──────────────────────────────────────────
function openStoryReader(story) {
  if (!story || !story.pages || !story.pages.length) return;

  currentStory   = story;
  currentPageIdx = 0;
  _srStopPageAudio();

  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  _srRenderPage();

  if (!_srSwipeWired) {
    _srWireSwipe(overlay);
    _srSwipeWired = true;
  }
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
  if (idx < 0 || idx >= total) return; // next does nothing on last page
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
  var isFirst  = pageIdx === 0;
  var isLast   = pageIdx === total - 1;

  // ── Background image ───────────────────────────────────────
  _srSetBackground(overlay, story.id + '_p' + pageIdx);

  // ── Title — fixed at top, only page 0 ─────────────────────
  var titleHTML = '';
  if (isFirst) {
    titleHTML =
      '<div class="sr-title-block">' +
        '<div class="sr-title-ja">' + _srEsc(story.title  || '') + '</div>' +
        '<div class="sr-title-en">' + _srEsc(story.titleEn || '') + '</div>' +
      '</div>';
  }

  // ── Nav bar (top: prev · counter · next) ──────────────────
  var prevDis = isFirst ? ' disabled' : '';
  var nextDis = isLast  ? ' disabled' : '';
  var navHTML =
    '<div class="sr-nav">' +
      '<button class="sr-nav-btn sr-nav-prev" onclick="_srGoTo(' + (pageIdx - 1) + ')"' + prevDis + '>← Prev</button>' +
      '<div class="sr-page-counter">' + (pageIdx + 1) + ' / ' + total + '</div>' +
      '<button class="sr-nav-btn sr-nav-next" onclick="_srGoTo(' + (pageIdx + 1) + ')"' + nextDis + '>Next →</button>' +
    '</div>';

  // ── Story body — single flowing column ─────────────────────
  var bodyHTML = '<div class="sr-story-body">';
  for (var i = 0; i < segments.length; i++) {
    bodyHTML += _srRenderSegment(segments[i], i);
  }
  bodyHTML += '</div>';

  // ── Bottom bar: page audio button ─────────────────────────
  var bottomHTML =
    '<div class="sr-bottom-bar">' +
      '<button class="sr-page-audio-btn" id="srPageAudioBtn" ' +
        'onclick="_srTogglePageAudio()" title="Play whole page">' +
        '&#9654; Play page' +
      '</button>' +
    '</div>';

  // ── Close button (top-left) ────────────────────────────────
  var closeHTML =
    '<button class="sr-close-btn" onclick="closeStoryReader()" title="Close (Esc)">✕</button>';

  // ── Assemble ───────────────────────────────────────────────
  overlay.innerHTML =
    closeHTML +
    titleHTML +
    '<div class="sr-content">' +
      navHTML +
      bodyHTML +
      bottomHTML +
    '</div>';
}

// ─── Render a single segment ──────────────────────────────────
function _srRenderSegment(seg, segIdx) {
  var isAnchor = seg.type === 'anchor';
  var cls      = 'sr-seg ' + (isAnchor ? 'sr-seg-anchor' : 'sr-seg-filler');

  // Japanese text with furigana — buildJPHTML already wires lookupWord()
  var jpHTML = (typeof buildJPHTML === 'function')
    ? buildJPHTML(seg.text)
    : _srEsc(seg.text);

  // Per-segment audio button
  var safeText = seg.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  var audioBtnHTML =
    '<button class="sr-seg-audio-btn" ' +
      'onclick="event.stopPropagation();_srPlaySegment(\'' + safeText + '\',this)" ' +
      'title="Play">&#9654;</button>';

  return (
    '<div class="' + cls + '">' +
      '<div class="sr-seg-text">' + jpHTML + '</div>' +
      audioBtnHTML +
    '</div>'
  );
}

// ─── Background image ─────────────────────────────────────────
function _srSetBackground(overlay, idbKey) {
  overlay.style.backgroundImage = '';
  overlay.classList.remove('sr-has-bg');
  if (typeof _idbGet !== 'function') return;

  _idbGet(idbKey).then(function(record) {
    if (!record) return;
    // _idbGet returns { id, dataUrl, ts }
    var url = typeof record === 'string' ? record : record.dataUrl;
    if (!url) return;
    if (document.getElementById('storyReaderOverlay') !== overlay) return;
    overlay.style.backgroundImage = 'url(' + url + ')';
    overlay.classList.add('sr-has-bg');
  }).catch(function() {});
}

// ─── Per-segment TTS ──────────────────────────────────────────
// Only stops page-level audio — lets speakJP handle its own pause/resume.
function _srPlaySegment(text, btnEl) {
  if (typeof speakJP !== 'function') return;
  if (_srPagePlaying) _srStopPageAudio(); // only kill page-level, not segment
  speakJP(text, btnEl).catch(function() {});
}

// ─── Page-level TTS ───────────────────────────────────────────
function _srTogglePageAudio() {
  if (_srPagePlaying) { _srStopPageAudio(); return; }

  if (!currentStory) return;
  var page = currentStory.pages[currentPageIdx];
  if (!page || !page.segments.length) return;
  if (typeof speakJP !== 'function') return;

  var texts = page.segments
    .map(function(s) { return s.text.trim(); })
    .filter(function(t) { return t.length > 0; });
  if (!texts.length) return;

  _srPagePlaying = true;
  _srPagePlayToken++;
  var myToken = _srPagePlayToken;

  var btn = document.getElementById('srPageAudioBtn');
  if (btn) { btn.innerHTML = '&#9646;&#9646; Stop'; btn.classList.add('sr-page-audio-playing'); }

  function playNext(idx) {
    if (myToken !== _srPagePlayToken) return;
    if (idx >= texts.length) { _srStopPageAudio(); return; }
    var p = speakJP(texts[idx], null);
    if (p && typeof p.then === 'function') {
      _srWaitForEnd(myToken, function() { playNext(idx + 1); });
    } else {
      playNext(idx + 1);
    }
  }
  playNext(0);
}

// Polls tts.js globals until audio finishes or token changes
function _srWaitForEnd(token, cb) {
  var elapsed = 0;
  function tick() {
    if (token !== _srPagePlayToken) return;
    elapsed += 150;
    if (elapsed > 120000) { _srStopPageAudio(); return; }
    var playing = (typeof isSpeaking !== 'undefined' && isSpeaking) ||
                  (typeof isPaused   !== 'undefined' && isPaused);
    if (playing) setTimeout(tick, 150);
    else         setTimeout(cb,   120);
  }
  setTimeout(tick, 150);
}

function _srStopPageAudio() {
  _srPagePlayToken++;
  _srPagePlaying = false;

  // Stop tts.js engine
  if (typeof playToken !== 'undefined') playToken++;
  if (typeof currentGain !== 'undefined' && currentGain) {
    try { currentGain.gain.cancelScheduledValues(0); currentGain.gain.setValueAtTime(0, 0); } catch(e) {}
  }
  if (typeof currentAudio !== 'undefined' && currentAudio) {
    try { currentAudio.pause(); } catch(e) {}
    currentAudio = null;
  }
  if (typeof currentGain  !== 'undefined') currentGain  = null;
  if (typeof isSpeaking   !== 'undefined') isSpeaking   = false;
  if (typeof isPaused     !== 'undefined') isPaused     = false;

  var btn = document.getElementById('srPageAudioBtn');
  if (btn) { btn.innerHTML = '&#9654; Play page'; btn.classList.remove('sr-page-audio-playing'); }
}

// ─── Touch swipe ──────────────────────────────────────────────
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
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
    _srSwipeDir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
  }
}

function _srOnTouchEnd(e) {
  var t  = e.changedTouches[0];
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
  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (e.key === 'Escape')     closeStoryReader();
  if (e.key === 'ArrowRight') _srGoTo(currentPageIdx + 1);
  if (e.key === 'ArrowLeft')  _srGoTo(currentPageIdx - 1);
});

// ─── HTML escape ──────────────────────────────────────────────
function _srEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
