/* ============================================================
   積む — storyreader.js
   Phase 4: Story reader overlay

   Load order: 7th — after storybuilder.js, before app.js

   Session A: Stub only.
   Session C: Full implementation — book-page reader, segment
              rendering (anchor vs filler), furigana, TTS, swipe.
   ============================================================ */

// ─── Open the reader for a given story object ─────────────────
// Called by storybuilder.js sbReadStory(storyId)
// Session C replaces the body with full reader logic.
function openStoryReader(story) {
  if (!story) return;

  currentStory   = story;
  currentPageIdx = 0;

  var overlay = document.getElementById('storyReaderOverlay');
  if (overlay) overlay.style.display = '';

  // Session C: render first page, wire navigation, TTS, swipe, etc.
  sbShowToast('📖 Story reader coming in Session C!', 3000);
}

// ─── Close the reader overlay ─────────────────────────────────
function closeStoryReader() {
  currentStory   = null;
  currentPageIdx = 0;

  var overlay = document.getElementById('storyReaderOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ─── Keyboard shortcut: Escape closes reader ──────────────────
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  var overlay = document.getElementById('storyReaderOverlay');
  if (overlay && overlay.style.display !== 'none') {
    closeStoryReader();
  }
});
