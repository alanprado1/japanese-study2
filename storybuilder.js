/* ============================================================
   積む — storybuilder.js
   Phase 4: Story selection screen, Firebase CRUD, SRS groups

   Load order: 6th — after images.js, before app.js

   Responsibilities (Session A):
   ─ Firebase CRUD for users/{uid}/stories subcollection
   ─ localStorage fallback when not signed in
   ─ SRS group computation from srsData + sentences globals
   ─ Story selection screen rendering
   ─ Pre-generation settings modal (Gemini call stubbed → Session B)
   ─ Enter / exit story mode, keyboard shortcut (Esc)
   ─ Toast notifications
   ─ Custom group attribute picker (persisted in localStorage)

   IMPORTANT — Firestore security rules:
   Add this to your Firebase console → Firestore → Rules:

     match /users/{uid}/stories/{storyId} {
       allow read, write: if request.auth != null && request.auth.uid == uid;
     }

   ============================================================ */

// ─── Constants ───────────────────────────────────────────────
var SB_MIN_SENTENCES = 3;   // minimum to enable Generate button

var SB_ICONS = [
  '🌸','⛩','🗻','🌊','🎋','🏯','🌙','⛅',
  '🍃','🦋','🎑','🌺','🍁','🎐','🌿','🪷'
];

// Group definitions — colorClass maps to CSS
var SB_GROUPS = [
  { type: 'again', label: 'AGAIN Focus',     ratings: ['again'],        colorClass: 'sb-group-again' },
  { type: 'hard',  label: 'HARD Challenges', ratings: ['hard'],         colorClass: 'sb-group-hard'  },
  { type: 'good',  label: 'GOOD / EASY Mix', ratings: ['good', 'easy'], colorClass: 'sb-group-good'  }
];

// ─── Module state ─────────────────────────────────────────────
var _sbStories      = {};    // { storyId: storyObject } — in-memory cache for current deck
var _sbDeckId       = null;  // which deck's stories are currently loaded
var _sbLoading      = false; // Firebase load in progress

// Generation settings — persisted to localStorage
var _sbGenSettings  = { totalPages: 5, charsPerPage: 120 };

// Custom group — which SRS ratings to include
var _sbCustomAttrs  = { again: false, hard: false, good: false };

// Which group the user is about to generate a story for
var _sbPendingGroup = null;

// ─── Deterministic story icon ─────────────────────────────────
function _sbIcon(storyId) {
  var hash = 0, s = String(storyId);
  for (var i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return SB_ICONS[Math.abs(hash) % SB_ICONS.length];
}

// ─── Story ID generation ──────────────────────────────────────
function _sbMakeId() {
  return 'story_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// ─── HTML escape ──────────────────────────────────────────────
function _sbEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Find group definition by type ───────────────────────────
function _sbFindGroup(type) {
  for (var i = 0; i < SB_GROUPS.length; i++) {
    if (SB_GROUPS[i].type === type) return SB_GROUPS[i];
  }
  return null;
}

// ─── Firebase reference ───────────────────────────────────────
function _sbFireRef() {
  if (typeof firebaseReady === 'undefined' || !firebaseReady) return null;
  if (typeof currentUser   === 'undefined' || !currentUser)   return null;
  return firebaseDB.collection('users').doc(currentUser.uid).collection('stories');
}

// ─── localStorage helpers ─────────────────────────────────────

function _sbLocalKey(deckId) {
  return 'jpStudy_stories_' + deckId;
}

function _sbWriteLocal(deckId) {
  // Write only this deck's stories
  try {
    var arr = [];
    var keys = Object.keys(_sbStories);
    for (var i = 0; i < keys.length; i++) {
      var s = _sbStories[keys[i]];
      if (s.deckId === deckId) arr.push(s);
    }
    localStorage.setItem(_sbLocalKey(deckId), JSON.stringify(arr));
  } catch(e) {
    console.warn('[sb] localStorage write failed:', e);
  }
}

function _sbReadLocal(deckId) {
  try {
    var raw = localStorage.getItem(_sbLocalKey(deckId));
    if (!raw) return {};
    var arr = JSON.parse(raw);
    var map = {};
    for (var i = 0; i < arr.length; i++) {
      map[arr[i].id] = arr[i];
    }
    return map;
  } catch(e) {
    return {};
  }
}

// ─── Load stories from Firebase (or local fallback) ───────────
function _sbLoadStories(deckId, callback) {
  var ref = _sbFireRef();

  if (!ref) {
    // Not signed in → use localStorage only
    callback(_sbReadLocal(deckId));
    return;
  }

  _sbLoading = true;
  _sbRenderLoading();

  ref.where('deckId', '==', deckId).get().then(function(snapshot) {
    var map = {};
    snapshot.forEach(function(docSnap) {
      var d   = docSnap.data();
      d.id    = docSnap.id;     // ensure id is always populated
      map[d.id] = d;
    });

    // Merge in any local stories that didn't make it to Firebase
    // (created offline, or before first sign-in)
    var local = _sbReadLocal(deckId);
    var localKeys = Object.keys(local);
    for (var i = 0; i < localKeys.length; i++) {
      var id = localKeys[i];
      if (!map[id]) map[id] = local[id];
    }

    _sbLoading = false;
    callback(map);
  }).catch(function(err) {
    console.warn('[sb] Firebase load failed — using localStorage:', err);
    _sbLoading = false;
    callback(_sbReadLocal(deckId));
  });
}

// ─── Save a story (Firebase + localStorage) ───────────────────
// Returns a Promise so callers can chain actions after save.
function sbSaveStory(story) {
  // Ensure required fields are always present
  if (!story.id)     story.id     = _sbMakeId();
  if (!story.deckId) story.deckId = currentDeckId;

  // Update in-memory cache immediately (optimistic)
  _sbStories[story.id] = story;
  _sbWriteLocal(story.deckId);

  var ref = _sbFireRef();
  if (!ref) return Promise.resolve(story);

  return ref.doc(story.id).set(story).then(function() {
    return story;
  }).catch(function(err) {
    console.warn('[sb] Firebase story save failed:', err);
    return story; // still available locally
  });
}

// ─── Delete a story (Firebase + localStorage) ─────────────────
function sbDeleteStory(storyId) {
  var story = _sbStories[storyId];
  if (!story) return Promise.resolve();
  var deckId = story.deckId;

  delete _sbStories[storyId];
  _sbWriteLocal(deckId);

  var ref = _sbFireRef();
  if (!ref) return Promise.resolve();

  return ref.doc(storyId).delete().catch(function(err) {
    console.warn('[sb] Firebase story delete failed:', err);
  });
}

// ─── SRS group computation ────────────────────────────────────
// Returns { again: [], hard: [], good: [] } of sentence objects.
// Only sentences that have been reviewed (have lastRating) are included.
// This intentionally excludes unseen sentences — they haven't been judged yet.
function sbGetSentencesByRating() {
  var result = { again: [], hard: [], good: [] };
  // Guard: globals might not exist yet during early parse
  if (typeof sentences === 'undefined' || typeof srsData === 'undefined') return result;

  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i];
    var d = srsData[s.id];
    if (!d || !d.lastRating) continue;
    if (d.lastRating === 'again') {
      result.again.push(s);
    } else if (d.lastRating === 'hard') {
      result.hard.push(s);
    } else if (d.lastRating === 'good' || d.lastRating === 'easy') {
      result.good.push(s);
    }
  }
  return result;
}

// Sentences for the custom group based on _sbCustomAttrs checkbox state
function _sbCustomSentences() {
  if (typeof sentences === 'undefined' || typeof srsData === 'undefined') return [];

  var ratings = [];
  if (_sbCustomAttrs.again) ratings.push('again');
  if (_sbCustomAttrs.hard)  ratings.push('hard');
  if (_sbCustomAttrs.good)  ratings.push('good', 'easy');
  if (!ratings.length) return [];

  var result = [];
  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i];
    var d = srsData[s.id];
    if (d && ratings.indexOf(d.lastRating) !== -1) result.push(s);
  }
  return result;
}

// Stories belonging to a specific group for the current deck, newest-first
function _sbStoriesForGroup(groupType) {
  var result = [];
  var keys = Object.keys(_sbStories);
  for (var i = 0; i < keys.length; i++) {
    var s = _sbStories[keys[i]];
    if (s.groupType === groupType && s.deckId === currentDeckId) result.push(s);
  }
  result.sort(function(a, b) { return (b.generatedAt || 0) - (a.generatedAt || 0); });
  return result;
}

// ─── View state management ────────────────────────────────────

function enterStoryMode() {
  isStoryMode = true;

  // Add CSS class to <main> — this hides flashcardView, listView, statsBar,
  // lengthFilterBar via style.css rules (no inline style manipulation so
  // there's nothing to "forget" to clear when exiting).
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.classList.add('story-active');

  // Show the story screen div itself
  var ss = document.getElementById('storyScreen');
  if (ss) ss.style.display = 'block';

  // Activate the nav button
  var btn = document.getElementById('btnStoryBuilder');
  if (btn) btn.classList.add('active');

  // If deck changed (or first visit), reload stories from Firebase/local
  if (_sbDeckId !== currentDeckId) {
    _sbDeckId = currentDeckId;
    _sbStories = {};
    _sbLoading = true;
    _sbRenderLoading();
    _sbLoadStories(currentDeckId, function(map) {
      _sbStories = map;
      _sbLoading = false;
      renderStoryScreen();
    });
    return; // renderStoryScreen() called in callback above
  }

  renderStoryScreen();
}

function exitStoryMode() {
  isStoryMode = false;

  // Remove the CSS class — unhides flashcardView, listView, statsBar, lengthFilterBar
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.classList.remove('story-active');

  // Hide the story screen div itself
  var ss = document.getElementById('storyScreen');
  if (ss) ss.style.display = 'none';

  var btn = document.getElementById('btnStoryBuilder');
  if (btn) btn.classList.remove('active');

  // render() in app.js will now show card or list view correctly
  render();
}

// Toggle — called by the header button
function toggleStoryMode() {
  if (isStoryMode) exitStoryMode();
  else             enterStoryMode();
}

// ─── DOM helpers ──────────────────────────────────────────────
function _sbShowEl(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = '';
}
function _sbHideEl(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ─── Loading state ────────────────────────────────────────────
function _sbRenderLoading() {
  var container = document.getElementById('sbGroupsContainer');
  if (!container) return;
  container.innerHTML =
    '<div class="sb-loading">' +
      '<div class="sb-spinner"></div>' +
      '<span>Loading stories…</span>' +
    '</div>';
}

// ─── Main render ──────────────────────────────────────────────
// Called by enterStoryMode(), Firebase pull callback, and render() in app.js
function renderStoryScreen() {
  var container = document.getElementById('sbGroupsContainer');
  if (!container) return;

  // Deck changed while we were in story mode (e.g. Firebase pull changed currentDeckId)
  if (_sbDeckId !== currentDeckId) {
    _sbDeckId   = currentDeckId;
    _sbStories  = {};
    _sbLoading  = true;
    _sbRenderLoading();
    _sbLoadStories(currentDeckId, function(map) {
      _sbStories = map;
      _sbLoading = false;
      renderStoryScreen();
    });
    return;
  }

  if (_sbLoading) { _sbRenderLoading(); return; }

  // Info bar counters
  var byRating = sbGetSentencesByRating();
  var totalReviewed = 0;
  var srsKeys = Object.keys(srsData);
  for (var r = 0; r < srsKeys.length; r++) {
    var d = srsData[srsKeys[r]];
    if (d && d.lastRating) totalReviewed++;
  }
  var totalStoriesForDeck = 0;
  var storyKeys = Object.keys(_sbStories);
  for (var sk = 0; sk < storyKeys.length; sk++) {
    if (_sbStories[storyKeys[sk]].deckId === currentDeckId) totalStoriesForDeck++;
  }

  var infoEl = document.getElementById('sbInfoBar');
  if (infoEl) {
    infoEl.textContent =
      sentences.length + ' sentences  ·  ' +
      totalReviewed     + ' reviewed  ·  ' +
      totalStoriesForDeck + ' ' + (totalStoriesForDeck === 1 ? 'story' : 'stories');
  }

  // ── No sentences in this deck ──
  if (!sentences.length) {
    container.innerHTML =
      '<div class="sb-empty-screen">' +
        '<div class="sb-empty-kanji">無</div>' +
        '<p>No sentences in this deck yet.</p>' +
        '<p>Add sentences and study some cards first — then come back here.</p>' +
      '</div>';
    return;
  }

  // ── Sentences exist but none reviewed yet ──
  if (!totalReviewed) {
    container.innerHTML =
      '<div class="sb-empty-screen">' +
        '<div class="sb-empty-kanji">未</div>' +
        '<p>No cards reviewed yet in this deck.</p>' +
        '<p>Study some flashcards first — your rated sentences will appear here as story groups.</p>' +
      '</div>';
    return;
  }

  // ── Render SRS groups + custom group ──
  var html = '';
  for (var i = 0; i < SB_GROUPS.length; i++) {
    var group           = SB_GROUPS[i];
    var groupSentences  = byRating[group.type] || [];
    var groupStories    = _sbStoriesForGroup(group.type);
    html += _sbRenderGroup(group, groupSentences, groupStories);
  }

  var customSents   = _sbCustomSentences();
  var customStories = _sbStoriesForGroup('custom');
  html += _sbRenderCustomGroup(customSents, customStories);

  container.innerHTML = html;
}

// ─── Group section HTML builder ───────────────────────────────
function _sbRenderGroup(group, groupSentences, groupStories) {
  var count      = groupSentences.length;
  var canGen     = count >= SB_MIN_SENTENCES;
  var genDisAttr = canGen ? '' : ' disabled title="Need at least ' + SB_MIN_SENTENCES + ' sentences (have ' + count + ')"';
  var genDisCls  = canGen ? '' : ' sb-btn-disabled';

  var html = '<div class="sb-group ' + group.colorClass + '">';

  // Header
  html += '<div class="sb-group-header">';
  html +=   '<div class="sb-group-label">' + _sbEsc(group.label) + '</div>';
  html +=   '<div class="sb-group-count">' + count + ' sentence' + (count !== 1 ? 's' : '') + '</div>';
  html += '</div>';

  // Card row
  html += '<div class="sb-card-row">';

  for (var i = 0; i < groupStories.length; i++) {
    html += _sbRenderStoryCard(groupStories[i]);
  }

  html += _sbRenderGenerateBtn(group.type, genDisAttr, genDisCls, count, canGen);

  html += '</div>'; // .sb-card-row

  // Hint when not enough sentences and no stories yet
  if (!groupStories.length && !canGen) {
    html += '<div class="sb-group-hint">' +
      'Rate ' + (SB_MIN_SENTENCES - count) + ' more card' + (SB_MIN_SENTENCES - count !== 1 ? 's' : '') + ' as <em>' + group.label.split(' ')[0].toLowerCase() + '</em> to unlock.' +
    '</div>';
  }

  html += '</div>'; // .sb-group
  return html;
}

// ─── Custom group HTML builder ────────────────────────────────
function _sbRenderCustomGroup(customSents, customStories) {
  var count  = customSents.length;
  var noneSelected = !_sbCustomAttrs.again && !_sbCustomAttrs.hard && !_sbCustomAttrs.good;
  var canGen = count >= SB_MIN_SENTENCES && !noneSelected;

  var genDisAttr = canGen
    ? ''
    : ' disabled title="' + (noneSelected ? 'Select at least one rating' : 'Need at least ' + SB_MIN_SENTENCES + ' sentences (have ' + count + ')') + '"';
  var genDisCls = canGen ? '' : ' sb-btn-disabled';

  var html = '<div class="sb-group sb-group-custom">';

  // Header
  html += '<div class="sb-group-header">';
  html +=   '<div class="sb-group-label">CUSTOM Mix</div>';
  html +=   '<div class="sb-group-count">' + count + ' sentence' + (count !== 1 ? 's' : '') + '</div>';
  html += '</div>';

  // Attribute picker
  html += '<div class="sb-custom-picker">';
  html +=   '<span class="sb-custom-label">Include ratings:</span>';

  var attrDefs = [
    { key: 'again', label: 'Again',     cls: 'attr-again' },
    { key: 'hard',  label: 'Hard',      cls: 'attr-hard'  },
    { key: 'good',  label: 'Good/Easy', cls: 'attr-good'  }
  ];
  for (var a = 0; a < attrDefs.length; a++) {
    var attr    = attrDefs[a];
    var checked = _sbCustomAttrs[attr.key];
    html += '<button class="sb-custom-attr ' + attr.cls + (checked ? ' active' : '') + '" ' +
      'onclick="sbToggleCustomAttr(\'' + attr.key + '\')">' + attr.label + '</button>';
  }

  html += '</div>'; // .sb-custom-picker

  // Card row
  html += '<div class="sb-card-row">';
  for (var ci = 0; ci < customStories.length; ci++) {
    html += _sbRenderStoryCard(customStories[ci]);
  }
  html += _sbRenderGenerateBtn('custom', genDisAttr, genDisCls, count, canGen);
  html += '</div>'; // .sb-card-row

  if (!customStories.length && noneSelected) {
    html += '<div class="sb-group-hint">Select one or more ratings above to build a mixed story.</div>';
  }

  html += '</div>'; // .sb-group
  return html;
}

// ─── Generate button HTML ─────────────────────────────────────
function _sbRenderGenerateBtn(groupType, disAttr, disCls, count, canGen) {
  return '<button class="sb-generate-btn' + disCls + '" ' +
    'onclick="sbOpenGenModal(\'' + groupType + '\')"' + disAttr + '>' +
    '<span class="sb-generate-plus">+</span>' +
    '<span>Generate</span>' +
    '</button>';
}

// ─── Story card HTML ──────────────────────────────────────────
function _sbRenderStoryCard(story) {
  var icon  = _sbIcon(story.id);
  var title = story.title || '—';
  var pages = (story.pages && story.pages.length) ? story.pages.length + 'p' : '—';
  var date  = story.generatedAt
    ? new Date(story.generatedAt).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })
    : '?';

  // story.id contains only word chars, underscores, hyphens — safe for onclick
  var sid = story.id;

  return '<div class="sb-story-card" onclick="sbReadStory(\'' + sid + '\')" title="' + _sbEsc(title) + '">' +
    '<button class="sb-story-delete" onclick="event.stopPropagation();sbConfirmDelete(\'' + sid + '\')" title="Delete story">✕</button>' +
    '<div class="sb-story-icon">' + icon + '</div>' +
    '<div class="sb-story-title">' + _sbEsc(title) + '</div>' +
    '<div class="sb-story-meta">' + pages + ' · ' + _sbEsc(date) + '</div>' +
  '</div>';
}

// ─── Custom group attr toggle ─────────────────────────────────
function sbToggleCustomAttr(key) {
  _sbCustomAttrs[key] = !_sbCustomAttrs[key];
  try { localStorage.setItem('jpStudy_sbCustomAttrs', JSON.stringify(_sbCustomAttrs)); } catch(e) {}
  renderStoryScreen();
}

// ─── Generate modal ───────────────────────────────────────────

function sbOpenGenModal(groupType) {
  _sbPendingGroup = groupType;

  // Populate modal subtitle with group name + sentence count
  var groupDef  = _sbFindGroup(groupType);
  var titleEl   = document.getElementById('sbGenModalTitle');
  if (titleEl) titleEl.textContent = groupDef ? groupDef.label : 'Custom Mix';

  var byRating  = sbGetSentencesByRating();
  var count     = groupType === 'custom'
    ? _sbCustomSentences().length
    : (byRating[groupType] || []).length;

  var countEl = document.getElementById('sbGenModalCount');
  if (countEl) countEl.textContent = count + ' anchor sentence' + (count !== 1 ? 's' : '') + ' available';

  // Restore slider values
  var pagesSlider   = document.getElementById('sbPagesSlider');
  var pagesVal      = document.getElementById('sbPagesVal');
  var densityBtns   = document.querySelectorAll('.sb-density-btn');

  if (pagesSlider) {
    pagesSlider.value = _sbGenSettings.totalPages;
    if (pagesVal) pagesVal.textContent = _sbGenSettings.totalPages;
  }

  for (var i = 0; i < densityBtns.length; i++) {
    var b = densityBtns[i];
    b.classList.toggle('active', parseInt(b.dataset.chars, 10) === _sbGenSettings.charsPerPage);
  }

  // Show modal
  var overlay = document.getElementById('sbGenModal');
  if (overlay) overlay.classList.add('active');
}

function sbCloseGenModal() {
  var overlay = document.getElementById('sbGenModal');
  if (overlay) overlay.classList.remove('active');
  _sbPendingGroup = null;
}

function sbUpdatePagesSlider(val) {
  _sbGenSettings.totalPages = parseInt(val, 10);
  var el = document.getElementById('sbPagesVal');
  if (el) el.textContent = val;
  try { localStorage.setItem('jpStudy_sbGenSettings', JSON.stringify(_sbGenSettings)); } catch(e) {}
}

function sbSetDensity(chars) {
  _sbGenSettings.charsPerPage = parseInt(chars, 10);
  var btns = document.querySelectorAll('.sb-density-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', parseInt(btns[i].dataset.chars, 10) === _sbGenSettings.charsPerPage);
  }
  try { localStorage.setItem('jpStudy_sbGenSettings', JSON.stringify(_sbGenSettings)); } catch(e) {}
}

// Called when user confirms generate in the modal.
// Session B will replace the stub body with the real Gemini API call.
function sbConfirmGenerate() {
  if (!_sbPendingGroup) return;

  // Session B hook: if _sbRunGeneration is defined, delegate to it.
  if (typeof _sbRunGeneration === 'function') {
    sbCloseGenModal();
    _sbRunGeneration(_sbPendingGroup, Object.assign({}, _sbGenSettings));
    return;
  }

  // ── Stub: Session A ──
  sbCloseGenModal();
  sbShowToast('✦ Generation coming in Session B!', 3200);
}

// ─── Story actions ────────────────────────────────────────────

function sbReadStory(storyId) {
  var story = _sbStories[storyId];
  if (!story) { sbShowToast('Story not found.', 2000); return; }

  if (!story.pages || !story.pages.length) {
    sbShowToast('This story has no pages yet — generate it first.', 2500);
    return;
  }

  // Delegate to storyreader.js (Session C provides full implementation)
  if (typeof openStoryReader === 'function') {
    openStoryReader(story);
  } else {
    sbShowToast('Story reader coming in Session C!', 2500);
  }
}

function sbConfirmDelete(storyId) {
  var story = _sbStories[storyId];
  if (!story) return;
  var title = story.title || 'this story';
  if (!confirm('Delete \u300c' + title + '\u300d?\nThis cannot be undone.')) return;

  sbDeleteStory(storyId).then(function() {
    sbShowToast('Story deleted.', 1800);
    renderStoryScreen();
  });
}

// ─── Toast notification ───────────────────────────────────────
function sbShowToast(msg, duration) {
  var existing = document.getElementById('sbToast');
  if (existing) existing.remove();

  var toast = document.createElement('div');
  toast.id            = 'sbToast';
  toast.className     = 'sb-toast';
  toast.textContent   = msg;
  document.body.appendChild(toast);

  // Defer one frame so CSS transition fires
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      toast.classList.add('sb-toast-visible');
    });
  });

  setTimeout(function() {
    toast.classList.remove('sb-toast-visible');
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 400);
  }, duration || 2500);
}

// ─── Keyboard shortcut ────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;

  // Close generate modal first if open
  var genModal = document.getElementById('sbGenModal');
  if (genModal && genModal.classList.contains('active')) {
    sbCloseGenModal();
    return;
  }

  // Then exit story mode (isStoryMode defined in app.js, exists by call time)
  if (typeof isStoryMode !== 'undefined' && isStoryMode) {
    exitStoryMode();
  }
});

// ─── Public API (used by storyreader.js + Session B) ─────────
// sbSaveStory(story)        → save/update a story
// sbDeleteStory(storyId)    → delete a story
// sbGetSentencesByRating()  → { again, hard, good }
// sbShowToast(msg, ms)      → toast notification

// ─── Nav button interceptors ──────────────────────────────────
// When the user clicks Cards, List, or Review while story mode is active,
// these capture-phase listeners run BEFORE ui.js's own handlers.
// They silently deactivate story mode so that ui.js's handler and the
// subsequent render() call see a clean non-story state.
(function _sbWireNavExit() {
  var navIds = ['btnListView', 'btnCardView', 'btnReviewMode'];
  for (var n = 0; n < navIds.length; n++) {
    (function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function() {
        if (typeof isStoryMode === 'undefined' || !isStoryMode) return;
        // Deactivate story mode — do NOT call render(), ui.js will do it
        isStoryMode = false;
        var mainEl = document.querySelector('main');
        if (mainEl) mainEl.classList.remove('story-active');
        var ss = document.getElementById('storyScreen');
        if (ss) ss.style.display = 'none';
        var sbBtn = document.getElementById('btnStoryBuilder');
        if (sbBtn) sbBtn.classList.remove('active');
      }, true); // capture phase — runs before ui.js bubble handlers
    })(navIds[n]);
  }
})();

// ─── Init ─────────────────────────────────────────────────────
// Restore persisted settings — must run at parse time (before DOM ready)
(function _sbInit() {
  try {
    var rawAttrs = localStorage.getItem('jpStudy_sbCustomAttrs');
    if (rawAttrs) {
      var parsed = JSON.parse(rawAttrs);
      // Merge conservatively — only known keys
      if (typeof parsed.again === 'boolean') _sbCustomAttrs.again = parsed.again;
      if (typeof parsed.hard  === 'boolean') _sbCustomAttrs.hard  = parsed.hard;
      if (typeof parsed.good  === 'boolean') _sbCustomAttrs.good  = parsed.good;
    }
  } catch(e) {}

  try {
    var rawSettings = localStorage.getItem('jpStudy_sbGenSettings');
    if (rawSettings) {
      var ps = JSON.parse(rawSettings);
      if (ps.totalPages   && ps.totalPages >= 1   && ps.totalPages <= 20)   _sbGenSettings.totalPages   = ps.totalPages;
      if (ps.charsPerPage && ps.charsPerPage >= 60 && ps.charsPerPage <= 250) _sbGenSettings.charsPerPage = ps.charsPerPage;
    }
  } catch(e) {}
})();
