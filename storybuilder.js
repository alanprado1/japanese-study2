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

  var totalPages = settings.totalPages || 5;

  // Target character count per page — just a guide, not a hard constraint
  var pageLen = settings.charsPerPage <= 80  ? '150〜250字' :
                settings.charsPerPage <= 120 ? '250〜400字' : '400〜600字';

  var voices = {
    beginner:
      '【文体・レベル】\n' +
      'やさしい日本語。ひらがなを中心に、N5〜N4レベルの漢字のみ。\n' +
      'です・ます調で統一。一文は短めに。\n' +
      'ただし、文章には感情・情景・流れがある。教科書の例文の羅列ではなく、\n' +
      'ちゃんと読める物語にすること。\n\n' +
      '【良い文体例】\n' +
      'はるかは、コンビニのまえで深く息を吸いました。ガラスのドアに、自分の顔が映っています。「だいじょうぶ」と、心の中で言いました。ドアが開いて、冷たい空気がほおにふれました。',

    intermediate:
      '【文体・レベル】\n' +
      '現代の短編小説に近い自然な日本語。地の文は普通体、会話は口語体。\n' +
      'N3〜N2レベルの語彙と漢字。〜ので、〜けど、〜てしまう などを自然に使う。\n' +
      '短い文と長い文を混ぜてリズムをつくる。登場人物の内面を地の文に織り込む。\n\n' +
      '【良い文体例】\n' +
      '改札を出た瞬間、雨のにおいがした。傘を持ってこなかったことを後悔しながら、莉子は空を見上げた。灰色の雲が低くたれこめている。今日だけは、早く帰りたくなかったのに。スマホの画面には、母からのメッセージが三件届いていた。',

    advanced:
      '【文体・レベル】\n' +
      '文学的な日本語散文。村上春樹・川端康成のような質感を目指す。\n' +
      'N1レベルの語彙・漢字を自由に使う。文の長短を大胆に変える。\n' +
      '描写と内省を重視し、説明より感覚で語る。\n\n' +
      '【良い文体例】\n' +
      '光が、消えた。彼女が部屋を出て行ってから、もう三年が経つというのに、朝の白い空気の中で紅茶を飲むたびに、僕はあの夜のことを思い出さずにはいられない。記憶とは残酷なものだ——忘れたいものほど、鮮明に残る。',

    custom:
      '【文体・レベル】\n' +
      'ユーザーのプロンプトの指示に完全に従うこと。\n' +
      '自然な日本語で書く。翻訳調・説明調にならないこと。'
  };

  var voice = voices[levelType] || voices.custom;

  return (
    '返答はひとつの有効なJSONオブジェクトのみ。マークダウン・コードフェンス・説明文は不要。\n\n' +

    'あなたは日本語の短編小説を書く作家です。\n' +
    '以下のテーマで、' + totalPages + 'ページの物語を書いてください。\n\n' +

    '【テーマ】\n' +
    topic + '\n\n' +

    voice + '\n\n' +

    '【構成】\n' +
    'ページ数：' + totalPages + 'ページ。各ページの目安：' + pageLen + '。\n' +
    '物語全体に一貫した流れ（起承転結）を持たせること。\n' +
    '同じ登場人物・世界が最初から最後まで続くこと。\n' +
    '各ページは前のページから自然につながること。\n\n' +

    '【JSON形式】\n' +
    'pagesの各要素は "text" フィールドひとつだけ。\n' +
    '"text" にはそのページの散文をまるごと入れる。改行は\\nで表現する。\n' +
    'セグメントへの分割は不要——ただの連続した物語文を書くこと。\n\n' +
    '{\n' +
    '  "title": "日本語タイトル",\n' +
    '  "titleEn": "English subtitle",\n' +
    '  "pages": [\n' +
    '    { "text": "ページ1の散文がここに入る。複数の文が自然につながる。" },\n' +
    '    { "text": "ページ2の散文。前のページから続く。" }\n' +
    '  ]\n' +
    '}\n\n' +
    'それでは書いてください：'
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

      // ── New flat format: page has a single "text" string ──
      // Split it into segments ourselves on sentence boundaries (。！？\n).
      if (typeof page.text === 'string' && page.text.trim()) {
        page.segments = _sbSplitIntoSegments(page.text);
        continue;
      }

      // ── Legacy segment format — still accept it ──
      if (!Array.isArray(page.segments) || !page.segments.length) return null;
      for (var j = 0; j < page.segments.length; j++) {
        var seg = page.segments[j];
        if (typeof seg.text !== 'string' || !seg.text.trim()) return null;
        seg.type = 'filler';
      }
    }

    return parsed;
  } catch(e) { return null; }
}

// Split a page of continuous prose into display segments.
// Strategy: split on sentence-ending punctuation (。！？) keeping the
// punctuation attached, then group every ~2 sentences into one segment
// so the reader shows readable chunks rather than one sentence per cell.
function _sbSplitIntoSegments(text) {
  // Normalise line breaks to spaces first
  var flat = text.replace(/\n+/g, '　');

  // Split on Japanese sentence-ending punctuation, keeping delimiter
  // Regex: split after 。！？」 (closing quote counts as sentence end too)
  var raw = flat.split(/(?<=[。！？」…])/u);

  // Filter empties
  var sentences = [];
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i].trim();
    if (s) sentences.push(s);
  }

  if (!sentences.length) {
    return [{ type: 'filler', text: text.trim() }];
  }

  // Group into segments of 2-3 sentences each
  var segments = [];
  var groupSize = 2;
  for (var i = 0; i < sentences.length; i += groupSize) {
    var chunk = sentences.slice(i, i + groupSize).join('');
    if (chunk.trim()) {
      segments.push({ type: 'filler', text: chunk.trim() });
    }
  }

  return segments.length ? segments : [{ type: 'filler', text: text.trim() }];
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