/* ============================================================
   積む — storybuilder.js  (v2 — Level-based cohesive stories)

   Key changes from v1:
   ─ Removed SRS rating groups (again / hard / good)
   ─ Replaced with language level groups: Beginner / Intermediate / Advanced
   ─ Stories are fully AI-written, natural Japanese — no anchor sentence injection
   ─ User provides a topic/prompt for each story; AI writes coherently
   ─ Generate button sits on the LEFT of each level's card row
   ─ Custom group preserved so users can specify anything
   ─ Old stories (groupType: again/hard/good) gracefully show under Custom
   ============================================================ */

// ─── Constants ───────────────────────────────────────────────
var SB_ICONS = [
  '🌸','⛩','🗻','🌊','🎋','🏯','🌙','⛅',
  '🍃','🦋','🎑','🌺','🍁','🎐','🌿','🪷',
  '🍜','🎎','🎏','🌃','🍵','🏔','🎋','🌄'
];

// Level group definitions
var SB_LEVELS = [
  {
    type:       'beginner',
    label:      'Beginner',
    labelJa:    '初級',
    colorClass: 'sb-group-beginner',
    hint:       'Simple grammar · Short sentences · Hiragana-heavy',
    placeholder:'e.g. A day at a Japanese convenience store'
  },
  {
    type:       'intermediate',
    label:      'Intermediate',
    labelJa:    '中級',
    colorClass: 'sb-group-intermediate',
    hint:       'Mixed plain/polite · Subordinate clauses · Natural dialogue',
    placeholder:'e.g. Two friends planning a trip to Kyoto'
  },
  {
    type:       'advanced',
    label:      'Advanced',
    labelJa:    '上級',
    colorClass: 'sb-group-advanced',
    hint:       'Literary Japanese · Complex grammar · Kanji-rich',
    placeholder:'e.g. A samurai contemplating duty in Edo-period Japan'
  },
  {
    type:       'custom',
    label:      'Custom',
    labelJa:    'カスタム',
    colorClass: 'sb-group-custom',
    hint:       'Any style, any level — you describe it',
    placeholder:'e.g. A horror story set in a haunted school at N2 level'
  }
];

// Gemini proxy
var GEMINI_PROXY_URL = 'https://jpstudy-gemini.jpstudy.workers.dev/generate';

// ─── Module state ─────────────────────────────────────────────
var _sbStories     = {};
var _sbDeckId      = null;
var _sbLoading     = false;
var _sbGenerating  = false;

// Generation settings — persisted to localStorage
var _sbGenSettings = { totalPages: 5, charsPerPage: 120 };

// Which level's Generate button was clicked
var _sbPendingLevel = null;

// Loading animation
var _sbGenKanjiChars = ['語','話','文','書','物','夢','旅','星','風','花','心','月'];
var _sbGenAnimTimer  = null;
var _sbGenAnimIdx    = 0;

// ─── Helpers ──────────────────────────────────────────────────
function _sbIcon(storyId) {
  var hash = 0, s = String(storyId);
  for (var i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return SB_ICONS[Math.abs(hash) % SB_ICONS.length];
}

function _sbMakeId() {
  return 'story_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function _sbEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _sbFindLevel(type) {
  for (var i = 0; i < SB_LEVELS.length; i++) {
    if (SB_LEVELS[i].type === type) return SB_LEVELS[i];
  }
  return SB_LEVELS[3]; // fallback to custom
}

// ─── Firebase reference ───────────────────────────────────────
function _sbFireRef() {
  if (typeof firebaseReady === 'undefined' || !firebaseReady) return null;
  if (typeof currentUser   === 'undefined' || !currentUser)   return null;
  return firebaseDB.collection('users').doc(currentUser.uid).collection('stories');
}

// ─── localStorage helpers ─────────────────────────────────────
function _sbLocalKey(deckId) { return 'jpStudy_stories_' + deckId; }

function _sbWriteLocal(deckId) {
  try {
    var arr = [];
    var keys = Object.keys(_sbStories);
    for (var i = 0; i < keys.length; i++) {
      var s = _sbStories[keys[i]];
      if (s.deckId === deckId) arr.push(s);
    }
    localStorage.setItem(_sbLocalKey(deckId), JSON.stringify(arr));
  } catch(e) { console.warn('[sb] localStorage write failed:', e); }
}

function _sbReadLocal(deckId) {
  try {
    var raw = localStorage.getItem(_sbLocalKey(deckId));
    if (!raw) return {};
    var arr = JSON.parse(raw);
    var map = {};
    for (var i = 0; i < arr.length; i++) map[arr[i].id] = arr[i];
    return map;
  } catch(e) { return {}; }
}

// ─── Load stories ─────────────────────────────────────────────
function _sbLoadStories(deckId, callback) {
  var ref = _sbFireRef();
  if (!ref) { callback(_sbReadLocal(deckId)); return; }

  _sbLoading = true;
  _sbRenderLoading();

  ref.where('deckId', '==', deckId).get().then(function(snapshot) {
    var map = {};
    snapshot.forEach(function(docSnap) {
      var d = docSnap.data();
      d.id  = docSnap.id;
      map[d.id] = d;
    });
    var local    = _sbReadLocal(deckId);
    var localKeys = Object.keys(local);
    for (var i = 0; i < localKeys.length; i++) {
      if (!map[localKeys[i]]) map[localKeys[i]] = local[localKeys[i]];
    }
    _sbLoading = false;
    callback(map);
  }).catch(function(err) {
    console.warn('[sb] Firebase load failed:', err);
    _sbLoading = false;
    callback(_sbReadLocal(deckId));
  });
}

// ─── Save / Delete ────────────────────────────────────────────
function sbSaveStory(story) {
  if (!story.id)     story.id     = _sbMakeId();
  if (!story.deckId) story.deckId = currentDeckId;
  _sbStories[story.id] = story;
  _sbWriteLocal(story.deckId);
  var ref = _sbFireRef();
  if (!ref) return Promise.resolve(story);
  return ref.doc(story.id).set(story).then(function() { return story; })
    .catch(function(err) { console.warn('[sb] save failed:', err); return story; });
}

function sbDeleteStory(storyId) {
  var story = _sbStories[storyId];
  if (!story) return Promise.resolve();
  var deckId = story.deckId;
  delete _sbStories[storyId];
  _sbWriteLocal(deckId);
  var ref = _sbFireRef();
  if (!ref) return Promise.resolve();
  return ref.doc(storyId).delete().catch(function(err) {
    console.warn('[sb] delete failed:', err);
  });
}

// ─── Stories for a level ──────────────────────────────────────
function _sbStoriesForLevel(levelType) {
  var result = [];
  var keys   = Object.keys(_sbStories);
  for (var i = 0; i < keys.length; i++) {
    var s = _sbStories[keys[i]];
    // Support both new (level) and old (groupType) field names
    var lvl = s.level || s.groupType || 'custom';
    // Map old SRS group names to custom
    if (lvl === 'again' || lvl === 'hard' || lvl === 'good') lvl = 'custom';
    if (lvl === levelType && s.deckId === currentDeckId) result.push(s);
  }
  result.sort(function(a, b) { return (b.generatedAt || 0) - (a.generatedAt || 0); });
  return result;
}

// ─── View state management ────────────────────────────────────
function enterStoryMode() {
  isStoryMode = true;
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.classList.add('story-active');
  var ss = document.getElementById('storyScreen');
  if (ss) ss.style.display = 'block';
  var btn = document.getElementById('btnStoryBuilder');
  if (btn) btn.classList.add('active');

  if (_sbDeckId !== currentDeckId) {
    _sbDeckId  = currentDeckId;
    _sbStories = {};
    _sbLoading = true;
    _sbRenderLoading();
    _sbLoadStories(currentDeckId, function(map) {
      _sbStories = map;
      _sbLoading = false;
      renderStoryScreen();
    });
    return;
  }
  renderStoryScreen();
}

function exitStoryMode() {
  isStoryMode = false;
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.classList.remove('story-active');
  var ss = document.getElementById('storyScreen');
  if (ss) ss.style.display = 'none';
  var btn = document.getElementById('btnStoryBuilder');
  if (btn) btn.classList.remove('active');
  render();
}

function toggleStoryMode() {
  if (isStoryMode) exitStoryMode();
  else             enterStoryMode();
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
function renderStoryScreen() {
  var container = document.getElementById('sbGroupsContainer');
  if (!container) return;
  if (_sbGenerating) return;

  if (_sbDeckId !== currentDeckId) {
    _sbDeckId  = currentDeckId;
    _sbStories = {};
    _sbLoading = true;
    _sbRenderLoading();
    _sbLoadStories(currentDeckId, function(map) {
      _sbStories = map;
      _sbLoading = false;
      renderStoryScreen();
    });
    return;
  }
  if (_sbLoading) { _sbRenderLoading(); return; }

  // Info bar
  var totalStories = 0;
  var keys = Object.keys(_sbStories);
  for (var k = 0; k < keys.length; k++) {
    if (_sbStories[keys[k]].deckId === currentDeckId) totalStories++;
  }

  var infoEl = document.getElementById('sbInfoBar');
  if (infoEl) {
    infoEl.textContent =
      (typeof sentences !== 'undefined' ? sentences.length : 0) + ' sentences in deck  ·  ' +
      totalStories + ' ' + (totalStories === 1 ? 'story' : 'stories') + ' saved';
  }

  // Render level groups
  var html = '';
  for (var i = 0; i < SB_LEVELS.length; i++) {
    html += _sbRenderLevelGroup(SB_LEVELS[i]);
  }
  container.innerHTML = html;
}

// ─── Level group HTML ─────────────────────────────────────────
function _sbRenderLevelGroup(level) {
  var stories = _sbStoriesForLevel(level.type);

  var html = '<div class="sb-group ' + level.colorClass + '">';

  // Header row
  html += '<div class="sb-group-header">';
  html +=   '<div class="sb-group-label-wrap">';
  html +=     '<div class="sb-group-label">' + _sbEsc(level.label) + '</div>';
  html +=     '<div class="sb-group-label-ja">' + _sbEsc(level.labelJa) + '</div>';
  html +=   '</div>';
  html +=   '<div class="sb-group-hint-text">' + _sbEsc(level.hint) + '</div>';
  html += '</div>';

  // Body: [Generate btn] + [story cards]
  html += '<div class="sb-level-row">';

  // Generate button — left side, tall card
  html += '<button class="sb-gen-card" onclick="sbOpenGenModal(\'' + level.type + '\')">';
  html +=   '<span class="sb-gen-card-plus">+</span>';
  html +=   '<span class="sb-gen-card-label">New Story</span>';
  html += '</button>';

  // Story cards scroll area
  html += '<div class="sb-cards-scroll">';
  if (stories.length === 0) {
    html += '<div class="sb-cards-empty">No stories yet — generate your first one.</div>';
  } else {
    for (var i = 0; i < stories.length; i++) {
      html += _sbRenderStoryCard(stories[i]);
    }
  }
  html += '</div>'; // .sb-cards-scroll

  html += '</div>'; // .sb-level-row
  html += '</div>'; // .sb-group
  return html;
}

// ─── Story card HTML ──────────────────────────────────────────
function _sbRenderStoryCard(story) {
  var icon  = _sbIcon(story.id);
  var title = story.title || '—';
  var pages = (story.pages && story.pages.length) ? story.pages.length + 'p' : '—';
  var date  = story.generatedAt
    ? new Date(story.generatedAt).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })
    : '?';
  var sid = story.id;

  return (
    '<div class="sb-story-card" onclick="sbReadStory(\'' + sid + '\')" title="' + _sbEsc(title) + '">' +
      '<button class="sb-story-regen"  onclick="event.stopPropagation();sbRegenerateStory(\'' + sid + '\')" title="Regenerate">↻</button>' +
      '<button class="sb-story-delete" onclick="event.stopPropagation();sbConfirmDelete(\'' + sid + '\')" title="Delete">✕</button>' +
      '<div class="sb-story-icon">' + icon + '</div>' +
      '<div class="sb-story-title">' + _sbEsc(title) + '</div>' +
      '<div class="sb-story-meta">' + pages + ' · ' + _sbEsc(date) + '</div>' +
    '</div>'
  );
}

// ─── Generate modal ───────────────────────────────────────────
function sbOpenGenModal(levelType) {
  _sbPendingLevel = levelType;

  var level   = _sbFindLevel(levelType);
  var titleEl = document.getElementById('sbGenModalTitle');
  if (titleEl) titleEl.textContent = level.label + ' — ' + level.labelJa;

  // Set placeholder on the topic input
  var topicEl = document.getElementById('sbTopicInput');
  if (topicEl) {
    topicEl.value       = '';
    topicEl.placeholder = level.placeholder;
  }

  // Restore sliders
  var pagesSlider = document.getElementById('sbPagesSlider');
  var pagesVal    = document.getElementById('sbPagesVal');
  if (pagesSlider) {
    pagesSlider.value = _sbGenSettings.totalPages;
    if (pagesVal) pagesVal.textContent = _sbGenSettings.totalPages;
  }

  var densityBtns = document.querySelectorAll('.sb-density-btn');
  for (var i = 0; i < densityBtns.length; i++) {
    var b = densityBtns[i];
    b.classList.toggle('active', parseInt(b.dataset.chars, 10) === _sbGenSettings.charsPerPage);
  }

  var overlay = document.getElementById('sbGenModal');
  if (overlay) overlay.classList.add('active');

  // Focus topic input
  setTimeout(function() { if (topicEl) topicEl.focus(); }, 80);
}

function sbCloseGenModal() {
  var overlay = document.getElementById('sbGenModal');
  if (overlay) overlay.classList.remove('active');
  _sbPendingLevel = null;
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

function sbConfirmGenerate() {
  if (!_sbPendingLevel) return;

  var topicEl = document.getElementById('sbTopicInput');
  var topic   = topicEl ? topicEl.value.trim() : '';

  if (!topic) {
    if (topicEl) {
      topicEl.style.borderColor = 'var(--danger)';
      topicEl.focus();
      setTimeout(function() { topicEl.style.borderColor = ''; }, 1500);
    }
    return;
  }

  var levelType = _sbPendingLevel;
  var settings  = Object.assign({}, _sbGenSettings, { topic: topic, levelType: levelType });

  sbCloseGenModal();
  _sbRunGeneration(levelType, settings);
}

// ─── Story actions ────────────────────────────────────────────
function sbReadStory(storyId) {
  var story = _sbStories[storyId];
  if (!story)                            { sbShowToast('Story not found.', 2000); return; }
  if (!story.pages || !story.pages.length) { sbShowToast('Story has no pages — try regenerating.', 2500); return; }
  if (typeof openStoryReader === 'function') openStoryReader(story);
}

function sbConfirmDelete(storyId) {
  var story = _sbStories[storyId];
  if (!story) return;
  if (!confirm('Delete「' + (story.title || 'this story') + '」?\nThis cannot be undone.')) return;
  sbDeleteStory(storyId).then(function() {
    sbShowToast('Story deleted.', 1800);
    renderStoryScreen();
  });
}

// ─── Toast ────────────────────────────────────────────────────
function sbShowToast(msg, duration) {
  var existing = document.getElementById('sbToast');
  if (existing) existing.remove();
  var toast       = document.createElement('div');
  toast.id        = 'sbToast';
  toast.className = 'sb-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(function() {
    requestAnimationFrame(function() { toast.classList.add('sb-toast-visible'); });
  });
  setTimeout(function() {
    toast.classList.remove('sb-toast-visible');
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 400);
  }, duration || 2500);
}

// ═══════════════════════════════════════════════════════════════
//   AI STORY GENERATION  (natural, cohesive, level-based)
// ═══════════════════════════════════════════════════════════════

// ─── Level-calibrated prompt builder ─────────────────────────
function _sbBuildPrompt(levelType, topic, settings) {

  var levelInstructions = {
    beginner: (
      'LEVEL: Beginner (初級)\n' +
      '- Very short sentences (under 20 characters each)\n' +
      '- Polite masu/desu form only\n' +
      '- Simple て-form connectives\n' +
      '- Common everyday vocabulary\n' +
      '- Mostly hiragana, minimal kanji (JLPT N5-N4 kanji only)\n' +
      '- No relative clauses, no complex grammar\n' +
      '- Example style: 「今日は晴れです。公園へ行きます。花がきれいです。」'
    ),
    intermediate: (
      'LEVEL: Intermediate (中級)\n' +
      '- Mix of polite and plain form within narration\n' +
      '- Natural dialogue in plain form\n' +
      '- Subordinate clauses (〜ので、〜から、〜けど)\n' +
      '- Moderate kanji (JLPT N3-N2 level)\n' +
      '- Some complex grammar (〜てしまう、〜ようにする、conditionals)\n' +
      '- Varied sentence length — short punchy lines mixed with longer ones\n' +
      '- Example style: 「電車が遅れたので、会議に間に合わなかった。田中さんはため息をついた。」'
    ),
    advanced: (
      'LEVEL: Advanced (上級)\n' +
      '- Natural literary Japanese prose\n' +
      '- Complex grammar freely (〜ざるを得ない、〜に過ぎない、〜にもかかわらず)\n' +
      '- Rich kanji usage (JLPT N1 level vocabulary welcome)\n' +
      '- Varied rhythm: sentence fragments, long flowing sentences\n' +
      '- Internal monologue, atmosphere, subtext\n' +
      '- Write like a published Japanese author\n' +
      '- Example style: 「窓の外には、昨夜の雨に濡れた石畳が静かに光を反射していた。彼女はその光景を眺めながら、あの夜のことを思い出さずにはいられなかった。」'
    ),
    custom: (
      'LEVEL: Follow the instructions in the topic/prompt below exactly.\n' +
      'Adapt your grammar, vocabulary, and style to whatever the user specifies.'
    )
  };

  var levelGuide = levelInstructions[levelType] || levelInstructions.custom;
  var totalPages = settings.totalPages || 5;
  var charsHint  = settings.charsPerPage <= 80  ? '60-90'  :
                   settings.charsPerPage <= 120 ? '100-150' : '180-260';

  return (
    'IMPORTANT: Your entire response must be ONE valid JSON object. ' +
    'No markdown, no code fences, no explanation. Pure JSON only.\n\n' +

    'You are a skilled Japanese author writing a short story for a language learner.\n\n' +

    'WRITING PRINCIPLES:\n' +
    '- Write a COHESIVE, NATURAL story — every sentence must serve the narrative\n' +
    '- No random topic changes. One story, one world, one consistent thread\n' +
    '- Characters introduced early must appear throughout\n' +
    '- Each page flows naturally from the last\n' +
    '- Write REAL Japanese, not translated English — think in Japanese\n\n' +

    levelGuide + '\n\n' +

    'TOPIC / PROMPT FROM USER:\n' +
    topic + '\n\n' +

    'STORY REQUIREMENTS:\n' +
    '- Exactly ' + totalPages + ' pages\n' +
    '- Each page: ' + charsHint + ' Japanese characters of story text\n' +
    '- Every page has 3-6 segments (sentence groups)\n' +
    '- Segments are short paragraphs of 1-3 sentences\n' +
    '- The story must feel complete: beginning, middle, satisfying end\n' +
    '- All segments are type "filler" (there are no anchor sentences in this mode)\n' +
    '- Generate a compelling Japanese title and an evocative English subtitle\n\n' +

    'JSON STRUCTURE (return EXACTLY this shape):\n' +
    '{\n' +
    '  "title": "日本語のタイトル",\n' +
    '  "titleEn": "English Subtitle",\n' +
    '  "pages": [\n' +
    '    {\n' +
    '      "segments": [\n' +
    '        { "type": "filler", "text": "Sentence one. Sentence two." },\n' +
    '        { "type": "filler", "text": "Next paragraph here." }\n' +
    '      ]\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Begin the JSON now:'
  );
}

// ─── Gemini API call ──────────────────────────────────────────
function _sbCallGemini(prompt) {
  return fetch(GEMINI_PROXY_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: prompt, temperature: 0.9, maxOutputTokens: 16384 })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) throw new Error(data.error);
    if (!data.text) throw new Error('Unexpected proxy response:\n' + JSON.stringify(data).slice(0, 400));
    return data.text;
  });
}

// ─── Response parser ──────────────────────────────────────────
function _sbParseGeminiResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  var cleaned = rawText.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/,      '')
    .replace(/\s*```$/,      '')
    .trim();

  try {
    var parsed = JSON.parse(cleaned);
    if (typeof parsed.title !== 'string' || !parsed.title.trim()) return null;
    if (!Array.isArray(parsed.pages)     || !parsed.pages.length)  return null;

    if (typeof parsed.titleEn !== 'string' || !parsed.titleEn.trim()) {
      parsed.titleEn = parsed.title;
    }

    for (var i = 0; i < parsed.pages.length; i++) {
      var page = parsed.pages[i];
      if (!Array.isArray(page.segments)) {
        if (Array.isArray(page)) {
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
        // In cohesive mode everything is filler (prose) — no anchors
        seg.type = 'filler';
      }
    }

    return parsed;
  } catch(e) { return null; }
}

// ─── Loading UI ───────────────────────────────────────────────
function _sbShowGenLoading(statusText) {
  _sbStopGenLoading();
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
function _sbShowGenError(rawText) {
  _sbGenerating = false;
  _sbStopGenLoading();
  var container = document.getElementById('sbGroupsContainer');
  if (!container) return;
  container.innerHTML =
    '<div class="sb-gen-error">' +
      '<div class="sb-gen-error-title">⚠ Generation Failed</div>' +
      '<div class="sb-gen-error-hint">Raw response (for debugging):</div>' +
      '<pre class="sb-gen-error-raw">' + _sbEsc(rawText || '(no response)') + '</pre>' +
      '<div class="sb-gen-error-actions">' +
        '<button class="btn" onclick="renderStoryScreen()">← Back to Stories</button>' +
      '</div>' +
    '</div>';
}

// ─── Page image generation ────────────────────────────────────
function _sbFetchPageImage(sentence) {
  return new Promise(function(resolve) {
    if (typeof _buildPrimaryUrl !== 'function') { resolve(null); return; }
    var url = _buildPrimaryUrl(sentence);
    var tid = setTimeout(function() { resolve(null); }, 35000);
    fetch(url)
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function(blob) {
        return new Promise(function(res, rej) {
          var reader = new FileReader();
          reader.onloadend = function() { res(reader.result); };
          reader.onerror   = rej;
          reader.readAsDataURL(blob);
        });
      })
      .then(function(dataUrl) { clearTimeout(tid); resolve(dataUrl); })
      .catch(function() { clearTimeout(tid); resolve(null); });
  });
}

function _sbGeneratePageImages(story) {
  var pages = story.pages;
  var total = pages.length;

  function doPage(idx) {
    if (idx >= total) return Promise.resolve();
    _sbUpdateGenStatus('Generating illustration ' + (idx + 1) + '\u00a0/\u00a0' + total + '\u2026');

    var descText = story.titleEn || story.title || '';
    for (var i = 0; i < pages[idx].segments.length; i++) {
      descText = pages[idx].segments[i].text.slice(0, 90);
      break;
    }
    var synth = { id: story.id + '_p' + idx, en: descText, jp: descText };

    return _sbFetchPageImage(synth).then(function(dataUrl) {
      if (dataUrl && typeof _idbSet === 'function') _idbSet(synth.id, dataUrl);
      return doPage(idx + 1);
    });
  }
  return doPage(0);
}

// ─── Main generation ──────────────────────────────────────────
function _sbRunGeneration(levelType, settings, existingStoryId) {
  _sbGenerating = true;
  _sbShowGenLoading('Writing story…');

  var prompt = _sbBuildPrompt(levelType, settings.topic || '', settings);

  _sbCallGemini(prompt)
    .then(function(rawText) {
      _sbUpdateGenStatus('Parsing…');
      var parsed = _sbParseGeminiResponse(rawText);
      if (!parsed) { _sbShowGenError(rawText); return; }

      var storyId = existingStoryId || _sbMakeId();
      var story = {
        id:          storyId,
        deckId:      currentDeckId,
        level:       levelType,
        title:       parsed.title,
        titleEn:     parsed.titleEn,
        topic:       settings.topic || '',
        generatedAt: Date.now(),
        settings:    { totalPages: settings.totalPages, charsPerPage: settings.charsPerPage },
        pages:       parsed.pages
      };

      _sbGeneratePageImages(story).then(function() {
        _sbUpdateGenStatus('Saving…');
        sbSaveStory(story).then(function() {
          _sbGenerating = false;
          _sbStopGenLoading();
          sbShowToast('✦ Story generated!', 2800);
          if (typeof isStoryMode !== 'undefined' && isStoryMode) renderStoryScreen();
        }).catch(function(err) {
          _sbShowGenError('Save failed: ' + (err && err.message ? err.message : String(err)));
        });
      });
    })
    .catch(function(err) {
      _sbShowGenError(err && err.message ? err.message : String(err));
    });
}

// ─── Regenerate ───────────────────────────────────────────────
function sbRegenerateStory(storyId) {
  var story = _sbStories[storyId];
  if (!story) { sbShowToast('Story not found.', 2000); return; }
  if (!confirm('Regenerate「' + (story.title || 'this story') + '」?\nThis will overwrite the current version.')) return;

  var settings = Object.assign(
    {},
    _sbGenSettings,
    story.settings || {},
    { topic: story.topic || '', levelType: story.level || 'custom' }
  );

  // Prompt user to update topic
  var newTopic = prompt('Story topic (leave blank to reuse previous):', story.topic || '');
  if (newTopic === null) return; // cancelled
  if (newTopic.trim()) settings.topic = newTopic.trim();

  if (!settings.topic) { sbShowToast('A topic is required to generate.', 2000); return; }

  _sbRunGeneration(story.level || 'custom', settings, storyId);
}

// ─── Keyboard shortcut ────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  var genModal = document.getElementById('sbGenModal');
  if (genModal && genModal.classList.contains('active')) { sbCloseGenModal(); return; }
  if (typeof isStoryMode !== 'undefined' && isStoryMode) exitStoryMode();
});

// ─── Nav button interceptors ──────────────────────────────────
(function _sbWireNavExit() {
  var navIds = ['btnListView', 'btnCardView', 'btnReviewMode'];
  for (var n = 0; n < navIds.length; n++) {
    (function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function() {
        if (typeof isStoryMode === 'undefined' || !isStoryMode) return;
        isStoryMode = false;
        var mainEl = document.querySelector('main');
        if (mainEl) mainEl.classList.remove('story-active');
        var ss  = document.getElementById('storyScreen');
        if (ss) ss.style.display = 'none';
        var sbBtn = document.getElementById('btnStoryBuilder');
        if (sbBtn) sbBtn.classList.remove('active');
      }, true);
    })(navIds[n]);
  }
})();

// ─── Init ─────────────────────────────────────────────────────
(function _sbInit() {
  try {
    var rawSettings = localStorage.getItem('jpStudy_sbGenSettings');
    if (rawSettings) {
      var ps = JSON.parse(rawSettings);
      if (ps.totalPages   >= 1   && ps.totalPages   <= 20)  _sbGenSettings.totalPages   = ps.totalPages;
      if (ps.charsPerPage >= 60  && ps.charsPerPage <= 250) _sbGenSettings.charsPerPage = ps.charsPerPage;
    }
  } catch(e) {}
})();
