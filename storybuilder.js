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

// ─── Session B: generation state ─────────────────────────────
var GEMINI_KEY = 'AIzaSyCZ8FFfL2OaOZqaiY-qQzIu2yOHvvqUio4';
var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_KEY;

// Loading animation
var _sbGenKanjiChars = ['語','話','文','書','物','夢','旅','星','風','花','心','月'];
var _sbGenAnimTimer  = null;
var _sbGenAnimIdx    = 0;

// True while a generation is running — prevents renderStoryScreen() from
// overwriting the loading / error UI that generation owns.
var _sbGenerating = false;

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

  // Session B: generation owns the screen — don't overwrite the loading/error UI
  if (_sbGenerating) return;

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
    '<button class="sb-story-regen"  onclick="event.stopPropagation();sbRegenerateStory(\'' + sid + '\')" title="Regenerate story">↻</button>' +
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

  // Capture groupType NOW — sbCloseGenModal() sets _sbPendingGroup = null,
  // so reading _sbPendingGroup after that call would pass null to _sbRunGeneration.
  var groupType = _sbPendingGroup;

  // Session B hook: if _sbRunGeneration is defined, delegate to it.
  if (typeof _sbRunGeneration === 'function') {
    sbCloseGenModal();
    _sbRunGeneration(groupType, Object.assign({}, _sbGenSettings));
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

// ═══════════════════════════════════════════════════════════════
//   SESSION B: AI STORY GENERATION
//   Gemini 1.5 Flash → parse JSON → Pollinations images → save
// ═══════════════════════════════════════════════════════════════

// ─── Prompt builder ───────────────────────────────────────────
function _sbBuildPrompt(anchors, settings) {
  var anchorList = anchors.map(function(s, i) {
    return (i + 1) + '. ' + s.jp;
  }).join('\n');

  return (
    'IMPORTANT: Your entire response must be ONE valid JSON object. ' +
    'No markdown, no code fences (```), no explanation. JSON only.\n\n' +
    'You are a Japanese story writer creating immersive content for a language learner.\n\n' +
    'TASK: Write a ' + settings.totalPages + '-page Japanese story that naturally ' +
    'incorporates the anchor sentences below verbatim (character for character, unchanged).\n\n' +
    'ANCHOR SENTENCES (copy each one into the story exactly as written):\n' +
    anchorList + '\n\n' +
    'REQUIREMENTS:\n' +
    '- Exactly ' + settings.totalPages + ' pages\n' +
    '- Each page: approximately ' + settings.charsPerPage + ' Japanese characters of filler prose\n' +
    '- Filler prose: natural Japanese at the same difficulty level as the anchors\n' +
    '- Distribute anchor sentences across pages — one anchor per page where possible\n' +
    '- "title": a compelling Japanese story title\n' +
    '- "titleEn": an evocative English subtitle\n\n' +
    'JSON STRUCTURE (return exactly this — every field required):\n' +
    '{\n' +
    '  "title": "物語のタイトル",\n' +
    '  "titleEn": "English Subtitle Here",\n' +
    '  "pages": [\n' +
    '    {\n' +
    '      "segments": [\n' +
    '        { "type": "filler", "text": "Japanese narrative prose connecting the story" },\n' +
    '        { "type": "anchor", "text": "exact anchor sentence verbatim", "anchorIdx": 1 }\n' +
    '      ]\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Segment rules:\n' +
    '- "filler" segments: your narrative prose (compelling, natural, matches anchor difficulty)\n' +
    '- "anchor" segments: the anchor sentence copied EXACTLY, with "anchorIdx" set to its number above\n' +
    '- A page may have only filler if no anchor fits naturally there\n' +
    '- Do not modify anchor sentences — not even punctuation or spacing\n\n' +
    'Begin the JSON now:'
  );
}

// ─── Gemini API call ──────────────────────────────────────────
function _sbCallGemini(prompt) {
  return fetch(GEMINI_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.85, maxOutputTokens: 8192 }
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    // Surface API-level errors (bad key, quota, etc.) as readable messages
    if (data.error) {
      throw new Error('Gemini error ' + data.error.code + ': ' + (data.error.message || JSON.stringify(data.error)));
    }
    if (!data.candidates || !data.candidates.length || !data.candidates[0].content) {
      throw new Error('Unexpected Gemini response:\n' + JSON.stringify(data).slice(0, 400));
    }
    return data.candidates[0].content.parts[0].text;
  });
}

// ─── Response parser ──────────────────────────────────────────
// Returns a validated story structure or null on any failure.
function _sbParseGeminiResponse(rawText, anchors) {
  if (!rawText || typeof rawText !== 'string') return null;

  // Strip markdown code fences Gemini sometimes emits despite instructions
  var cleaned = rawText.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/,      '')
    .replace(/\s*```$/,      '')
    .trim();

  try {
    var parsed = JSON.parse(cleaned);

    // ── Required top-level fields ──
    if (typeof parsed.title !== 'string' || !parsed.title.trim()) return null;
    if (!Array.isArray(parsed.pages)     || !parsed.pages.length)  return null;

    // titleEn fallback
    if (typeof parsed.titleEn !== 'string' || !parsed.titleEn.trim()) {
      parsed.titleEn = parsed.title;
    }

    // ── Validate + normalise pages ──
    for (var i = 0; i < parsed.pages.length; i++) {
      var page = parsed.pages[i];
      // Handle Gemini occasionally wrapping segments inside a "page" object differently
      if (!Array.isArray(page.segments)) {
        if (Array.isArray(page)) {
          // Some models return pages as an array-of-segment-arrays
          parsed.pages[i] = { segments: page };
          page = parsed.pages[i];
        } else {
          return null;
        }
      }
      if (!page.segments.length) return null;

      for (var j = 0; j < page.segments.length; j++) {
        var seg = page.segments[j];
        if (typeof seg.text !== 'string' || !seg.text.trim()) return null;

        // Normalise type — anything not 'anchor' becomes 'filler'
        seg.type = (seg.type === 'anchor') ? 'anchor' : 'filler';

        // Inject sentenceId so Session C can highlight anchor segments
        if (seg.type === 'anchor' && seg.anchorIdx) {
          var anchorRef = anchors[parseInt(seg.anchorIdx, 10) - 1];
          if (anchorRef) seg.sentenceId = String(anchorRef.id);
        }
      }
    }

    return parsed;
  } catch(e) {
    return null;
  }
}

// ─── Loading UI ───────────────────────────────────────────────

function _sbShowGenLoading(statusText) {
  _sbStopGenLoading(); // clear any previous interval
  _sbGenAnimIdx = 0;

  var container = document.getElementById('sbGroupsContainer');
  if (!container) return;

  container.innerHTML =
    '<div class="sb-gen-loading" id="sbGenLoadingEl">' +
      '<div class="sb-gen-kanji" id="sbGenKanjiEl">' + _sbGenKanjiChars[0] + '</div>' +
      '<div class="sb-gen-status" id="sbGenStatusEl">' + _sbEsc(statusText) + '</div>' +
    '</div>';

  _sbGenAnimTimer = setInterval(function() {
    _sbGenAnimIdx = (_sbGenAnimIdx + 1) % _sbGenKanjiChars.length;
    var el = document.getElementById('sbGenKanjiEl');
    if (el) el.textContent = _sbGenKanjiChars[_sbGenAnimIdx];
  }, 160);
}

function _sbUpdateGenStatus(text) {
  var el = document.getElementById('sbGenStatusEl');
  if (el) el.textContent = text;
}

function _sbStopGenLoading() {
  if (_sbGenAnimTimer) { clearInterval(_sbGenAnimTimer); _sbGenAnimTimer = null; }
}

// ─── Error UI ─────────────────────────────────────────────────
// Shows raw Gemini output inline on the story screen for debugging.

function _sbShowGenError(rawText) {
  _sbGenerating = false;
  _sbStopGenLoading();

  var container = document.getElementById('sbGroupsContainer');
  if (!container) return;

  container.innerHTML =
    '<div class="sb-gen-error">' +
      '<div class="sb-gen-error-title">⚠ Generation Failed</div>' +
      '<div class="sb-gen-error-hint">Raw response from Gemini (for debugging):</div>' +
      '<pre class="sb-gen-error-raw">' + _sbEsc(rawText || '(no response)') + '</pre>' +
      '<div class="sb-gen-error-actions">' +
        '<button class="btn" onclick="renderStoryScreen()">← Back to Stories</button>' +
      '</div>' +
    '</div>';
}

// ─── Silent page image fetcher ────────────────────────────────
// Reuses Pollinations URL builder + IDB helpers from images.js.
// Returns a Promise<dataUrl|null> — never rejects.

function _sbFetchPageImage(sentence) {
  return new Promise(function(resolve) {
    if (typeof _buildPrimaryUrl !== 'function') { resolve(null); return; }

    var url = _buildPrimaryUrl(sentence);
    var tid = setTimeout(function() { resolve(null); }, 35000); // 35s hard timeout

    fetch(url)
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function(blob) {
        return new Promise(function(res, rej) {
          var reader    = new FileReader();
          reader.onloadend = function() { res(reader.result); };
          reader.onerror   = rej;
          reader.readAsDataURL(blob);
        });
      })
      .then(function(dataUrl) {
        clearTimeout(tid);
        resolve(dataUrl);
      })
      .catch(function() {
        clearTimeout(tid);
        resolve(null); // image failure is non-fatal — story still saved
      });
  });
}

// ─── Sequential page image generation ────────────────────────
// Generates one Ghibli-style image per page, stored in IDB.
// Status bar updated after each page so the user sees progress.

function _sbGeneratePageImages(story) {
  // Honour the deck's image-gen toggle (set in deck settings)
  if (typeof isImageGenEnabled !== 'function' || !isImageGenEnabled()) {
    return Promise.resolve();
  }

  var pages = story.pages;
  var total = pages.length;

  function doPage(idx) {
    if (idx >= total) return Promise.resolve();

    _sbUpdateGenStatus(
      'Generating illustration ' + (idx + 1) + '\u00a0/\u00a0' + total + '\u2026'
    );

    // Use first filler segment text as the image prompt description
    var descText = story.titleEn || story.title || '';
    for (var i = 0; i < pages[idx].segments.length; i++) {
      if (pages[idx].segments[i].type === 'filler') {
        // Trim to 90 chars — Pollinations prompt cap
        descText = pages[idx].segments[i].text.slice(0, 90);
        break;
      }
    }

    // Synthetic sentence object matching the shape _buildPrimaryUrl expects
    var synth = {
      id: story.id + '_p' + idx,
      en: descText,
      jp: descText
    };

    return _sbFetchPageImage(synth).then(function(dataUrl) {
      // Store in IDB so Session C reader can retrieve it by key
      if (dataUrl && typeof _idbSet === 'function') {
        _idbSet(synth.id, dataUrl);
      }
      return doPage(idx + 1);
    });
  }

  return doPage(0);
}

// ─── Main generation entry point ─────────────────────────────
// Called by sbConfirmGenerate() hook (Session A stub detects this function).
// Also called by sbRegenerateStory() with an existingStoryId to overwrite.

function _sbRunGeneration(groupType, settings, existingStoryId) {

  // ── 1. Gather anchor pool for this group ──
  var byRating = sbGetSentencesByRating();
  var pool     = (groupType === 'custom')
    ? _sbCustomSentences()
    : (byRating[groupType] || []);

  if (pool.length < SB_MIN_SENTENCES) {
    sbShowToast('Not enough rated sentences to generate.', 2500);
    return;
  }

  // ── 2. Random subset — ~1.2 anchors per page, min 2, capped at pool ──
  var numAnchors = Math.min(
    pool.length,
    Math.max(2, Math.round(settings.totalPages * 1.2))
  );
  var shuffled = pool.slice().sort(function() { return Math.random() - 0.5; });
  var anchors  = shuffled.slice(0, numAnchors);

  // ── 3. Lock screen: show animated loading ──
  _sbGenerating = true;
  _sbShowGenLoading('Contacting Gemini\u2026');

  // ── 4. Build prompt + call API ──
  var prompt = _sbBuildPrompt(anchors, settings);

  _sbCallGemini(prompt)
    .then(function(rawText) {

      _sbUpdateGenStatus('Parsing story\u2026');

      // ── 5. Parse + validate ──
      var parsed = _sbParseGeminiResponse(rawText, anchors);

      if (!parsed) {
        _sbShowGenError(rawText);
        return;
      }

      // ── 6. Build story object ──
      var storyId = existingStoryId || _sbMakeId();
      var story = {
        id:          storyId,
        deckId:      currentDeckId,
        groupType:   groupType,
        title:       parsed.title,
        titleEn:     parsed.titleEn,
        generatedAt: Date.now(),
        anchorIds:   anchors.map(function(s) { return s.id; }),
        settings:    { totalPages: settings.totalPages, charsPerPage: settings.charsPerPage },
        pages:       parsed.pages
      };

      // ── 7. Generate illustrations (blocking — user waits) ──
      _sbGeneratePageImages(story)
        .then(function() {

          // ── 8. Save to Firebase + localStorage ──
          _sbUpdateGenStatus('Saving story\u2026');

          sbSaveStory(story)
            .then(function() {
              _sbGenerating = false;
              _sbStopGenLoading();
              sbShowToast('\u2736 Story generated!', 2800);
              // Re-render only if the user is still on the story screen
              if (typeof isStoryMode !== 'undefined' && isStoryMode) {
                renderStoryScreen();
              }
            })
            .catch(function(err) {
              _sbShowGenError(
                'Save failed: ' + (err && err.message ? err.message : String(err))
              );
            });
        });
    })
    .catch(function(err) {
      _sbShowGenError(err && err.message ? err.message : String(err));
    });
}

// ─── Public: Regenerate an existing story ────────────────────
// Overwrites the story in-place (same ID → same card position in the UI).

function sbRegenerateStory(storyId) {
  var story = _sbStories[storyId];
  if (!story) { sbShowToast('Story not found.', 2000); return; }

  if (!confirm(
    'Regenerate \u300c' + (story.title || 'this story') + '\u300d?\n' +
    'This will overwrite the current version.'
  )) return;

  // Re-use the original settings if available, otherwise fall back to current modal settings
  var settings = (story.settings && story.settings.totalPages)
    ? { totalPages: story.settings.totalPages, charsPerPage: story.settings.charsPerPage }
    : Object.assign({}, _sbGenSettings);

  _sbRunGeneration(story.groupType, settings, storyId);
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
