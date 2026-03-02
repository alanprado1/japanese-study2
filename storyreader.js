/* ============================================================
   積む — storyreader.js
   Phase 4 Session C: Full story reader implementation

   Load order: 7th — after storybuilder.js, before app.js

   Audio architecture:
   ─ Page button:    speakJP(allPageText, pageBtn) — identical to every
                     other audio button in the app. speakJP handles
                     play / pause / resume / stop natively.
   ─ Segment button: speakJP(segText, segBtn) — same pattern.
   ─ Navigation:     stopAudio() — tts.js hard-stop used on page change.
   No custom polling, no custom state flags, no race conditions.

   Image architecture:
   ─ Tries IDB first (pre-generated during story creation).
   ─ Falls back to direct Pollinations URL (deterministic seed) so images
     always show even if deck image-gen was off at generation time.
   ============================================================ */

// ─── Swipe state (no audio state — speakJP owns that) ─────────
var _srSwipeStartX = 0;
var _srSwipeStartY = 0;
var _srSwipeDir    = null;   // 'h' | 'v' | null
var _srSwipeWired  = false;  // prevent double-wiring

// ─── Open the reader ──────────────────────────────────────────
function openStoryReader(story) {
  if (!story || !story.pages || !story.pages.length) return;

  currentStory   = story;
  currentPageIdx = 0;
  _srStopAudio();

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
  _srStopAudio();
  currentStory   = null;
  currentPageIdx = 0;
  var overlay = document.getElementById('storyReaderOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ─── Navigate pages ───────────────────────────────────────────
function _srGoTo(idx) {
  if (!currentStory) return;
  var total = currentStory.pages.length;
  if (idx < 0 || idx >= total) return;
  _srStopAudio();
  currentPageIdx = idx;
  _srRenderPage();
}

// ─── Stop audio — delegates entirely to tts.js stopAudio() ────
// stopAudio() resets: currentAudio, currentGain, isSpeaking, isPaused,
// playToken, _listAudioBtn (and resets that button's innerHTML to ▶).
// This correctly handles both page-level and segment-level audio.
function _srStopAudio() {
  if (typeof stopAudio === 'function') stopAudio();
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
  _srSetBackground(overlay, story, pageIdx);

  // ── Title block — page 0 only ──────────────────────────────
  var titleHTML = '';
  if (isFirst) {
    titleHTML =
      '<div class="sr-title-block">' +
        '<div class="sr-title-ja">' + _srEsc(story.title   || '') + '</div>' +
        '<div class="sr-title-en">' + _srEsc(story.titleEn || '') + '</div>' +
      '</div>';
  }

  // ── Nav bar ────────────────────────────────────────────────
  var prevDis = isFirst ? ' disabled' : '';
  var nextDis = isLast  ? ' disabled' : '';
  var navHTML =
    '<div class="sr-nav">' +
      '<button class="sr-nav-btn" onclick="_srGoTo(' + (pageIdx - 1) + ')"' + prevDis + '>← Prev</button>' +
      '<div class="sr-page-counter">' + (pageIdx + 1) + ' / ' + total + '</div>' +
      '<button class="sr-nav-btn" onclick="_srGoTo(' + (pageIdx + 1) + ')"' + nextDis + '>Next →</button>' +
    '</div>';

  // ── Story segments ─────────────────────────────────────────
  var bodyHTML = '<div class="sr-story-body">';
  for (var i = 0; i < segments.length; i++) {
    bodyHTML += _srRenderSegment(segments[i]);
  }
  bodyHTML += '</div>';

  // ── Bottom bar: page audio button ─────────────────────────
  // Button is passed to speakJP — it manages innerHTML (▶ / pause-icon) itself.
  var bottomHTML =
    '<div class="sr-bottom-bar">' +
      '<button class="sr-page-audio-btn" id="srPageAudioBtn" ' +
        'onclick="_srTogglePageAudio(this)" title="Play / pause whole page">' +
        '&#9654; Play page' +
      '</button>' +
    '</div>';

  // ── Close button ───────────────────────────────────────────
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

// ─── Render one segment ───────────────────────────────────────
function _srRenderSegment(seg) {
  var isAnchor = seg.type === 'anchor';
  var cls      = 'sr-seg ' + (isAnchor ? 'sr-seg-anchor' : 'sr-seg-filler');

  // buildJPHTML adds furigana and wires lookupWord() click handlers
  var jpHTML = (typeof buildJPHTML === 'function')
    ? buildJPHTML(seg.text)
    : _srEsc(seg.text);

  // Escape text for inline onclick attribute
  var safeText = seg.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  var audioBtn =
    '<button class="sr-seg-audio-btn" ' +
      'onclick="event.stopPropagation();_srPlaySegment(\'' + safeText + '\',this)" ' +
      'title="Play">&#9654;</button>';

  return (
    '<div class="' + cls + '">' +
      '<div class="sr-seg-text">' + jpHTML + '</div>' +
      audioBtn +
    '</div>'
  );
}

// ─── Background image ─────────────────────────────────────────
// Step 1: try IDB (pre-generated data URL).
// Step 2: fall back to direct Pollinations URL (same deterministic seed).
// Both paths always show an image — deck imageGen setting irrelevant here.
function _srSetBackground(overlay, story, pageIdx) {
  overlay.style.backgroundImage = '';
  overlay.classList.remove('sr-has-bg');

  var idbKey   = story.id + '_p' + pageIdx;
  var snapshot = { story: story, pageIdx: pageIdx }; // closure guard values

  function applyUrl(url) {
    if (!url) return;
    // Guard: user may have navigated away before async resolved
    if (currentStory !== snapshot.story || currentPageIdx !== snapshot.pageIdx) return;
    overlay.style.backgroundImage = 'url(' + url + ')';
    overlay.classList.add('sr-has-bg');
  }

  // Fallback: build deterministic Pollinations URL from page data
  function tryPollinations() {
    if (typeof _buildPrimaryUrl !== 'function') return;
    var descText = story.titleEn || story.title || '';
    var page     = story.pages && story.pages[pageIdx];
    if (page && page.segments) {
      for (var i = 0; i < page.segments.length; i++) {
        if (page.segments[i].type === 'filler') {
          descText = page.segments[i].text.slice(0, 90);
          break;
        }
      }
    }
    applyUrl(_buildPrimaryUrl({ id: idbKey, en: descText, jp: descText }));
  }

  if (typeof _idbGet === 'function') {
    _idbGet(idbKey).then(function(record) {
      if (record) {
        var url = typeof record === 'string' ? record : (record && record.dataUrl);
        if (url) { applyUrl(url); return; }
      }
      tryPollinations();
    }).catch(tryPollinations);
  } else {
    tryPollinations();
  }
}

// ─── Page-level TTS ───────────────────────────────────────────
// Joins all segments into one string and hands the button to speakJP.
// speakJP natively handles: play → pause → resume → end → reset button.
// This is IDENTICAL in architecture to every other audio button in the app.
function _srTogglePageAudio(btn) {
  if (!btn) btn = document.getElementById('srPageAudioBtn');
  if (!btn || !currentStory || typeof speakJP !== 'function') return;

  var page = currentStory.pages[currentPageIdx];
  if (!page || !page.segments.length) return;

  // Concatenate segments. 。between them gives a natural TTS pause.
  var allText = page.segments
    .map(function(s) { return s.text.trim(); })
    .filter(function(t) { return t.length > 0; })
    .join('\u3002');

  if (!allText) return;

  // speakJP with the button element:
  //  - 1st click while idle    → plays,   btn shows pause icon
  //  - 2nd click while playing → pauses,  btn shows ▶
  //  - 3rd click while paused  → resumes, btn shows pause icon
  //  - audio ends naturally    → btn shows ▶
  speakJP(allText, btn).catch(function() {});
}

// ─── Per-segment TTS ──────────────────────────────────────────
// speakJP automatically stops whatever is currently playing (page or another
// segment) before starting this segment, via the "NEW play" path in speakJP.
function _srPlaySegment(text, btnEl) {
  if (typeof speakJP !== 'function') return;
  speakJP(text, btnEl).catch(function() {});
}

// ─── Swipe gesture wiring ─────────────────────────────────────
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
