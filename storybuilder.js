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

  // ── Step 1: write the story as pure prose first ──────────────
  // The key insight: ask Gemini to think like an author, not a JSON formatter.
  // We separate the creative task ("write a story") from the structural task
  // ("now format it") so neither contaminates the other.

  var totalPages = settings.totalPages || 5;

  // How many prose paragraphs per page — drives the segment count
  var parasPerPage = settings.charsPerPage <= 80  ? 2 :
                     settings.charsPerPage <= 120 ? 3 : 4;

  // Target paragraph length hint for the model
  var paraLen = settings.charsPerPage <= 80  ? '2〜3文、40〜70字' :
                settings.charsPerPage <= 120 ? '3〜4文、80〜130字' : '4〜6文、150〜220字';

  // ── Level voice profiles ─────────────────────────────────────
  // Written as author direction, not grammar rules.
  // Each one describes a VOICE and gives a prose sample to imitate.
  var voices = {

    beginner:
      '【文体】幼年向け絵本のような、やさしくあたたかい日本語。\n' +
      'ひらがなを中心に、N5〜N4レベルの漢字のみ使う。\n' +
      '一文は短く（10〜20字）、です・ます調で統一する。\n' +
      'でも、文章には感情・場面・流れがある。教科書の例文を羅列するのではなく、\n' +
      '登場人物の気持ちと出来事をつなげて書く。\n\n' +
      '【良い例】\n' +
      '「はるかは、コンビニのまえで、ふかく息をすいました。\n' +
      ' ガラスのドアに、自分の顔がうつっています。\n' +
      ' 「だいじょうぶ」と、こころのなかで言いました。\n' +
      ' ドアがひらいて、つめたい空気がほおにふれました。」\n\n' +
      '【悪い例（やってはいけない）】\n' +
      '「今日は月曜日です。学校が終わりました。窓の外を見ます。空は青くてきれいです。」\n' +
      '→ これは文の羅列であり、物語ではない。感情も流れもない。絶対に避けること。',

    intermediate:
      '【文体】現代の短編小説・ライトノベルに近い自然な日本語。\n' +
      '地の文は普通体、会話は口語体で書く。\n' +
      'N3〜N2レベルの語彙と漢字。〜ので、〜けど、〜てしまう などを自然に使う。\n' +
      '短い文と長い文を混ぜてリズムをつくる。\n' +
      '登場人物の内面（思い、迷い、感情）を地の文に織り込む。\n\n' +
      '【良い例】\n' +
      '「改札を出た瞬間、雨のにおいがした。\n' +
      ' 傘を持ってこなかったことを後悔しながら、莉子は空を見上げた。\n' +
      ' 灰色の雲が低くたれこめている。今日だけは、早く帰りたくなかったのに。\n' +
      ' スマホの画面には、母からのメッセージが三件届いていた。」\n\n' +
      '【悪い例】\n' +
      '「電車に乗りました。駅に着きました。雨が降っています。傘がありません。」\n' +
      '→ 物語として読めない。感情も描写もない。',

    advanced:
      '【文体】芥川龍之介・村上春樹・川端康成を参照した、文学的な日本語散文。\n' +
      'N1レベルの語彙・漢字を積極的に使う。\n' +
      '文の長短を大胆に変える。一語だけの文も、長い複文も、どちらも使う。\n' +
      '描写・内省・余白を重視する。説明せず、見せる（show, don\'t tell）。\n' +
      '心理描写、感覚描写、時制の揺らぎなどを自由に使う。\n\n' +
      '【良い例】\n' +
      '「光が、消えた。\n' +
      ' 彼女が部屋を出て行ってから、もう三年が経つというのに、\n' +
      ' 朝の白い空気の中で紅茶を飲むたびに、僕はあの夜のことを思い出さずにはいられない。\n' +
      ' 記憶とは残酷なものだ——忘れたいものほど、鮮明に残る。」\n\n' +
      '【悪い例】\n' +
      '「今日は仕事がありました。疲れました。家に帰りました。ご飯を食べました。」\n' +
      '→ 文体も深みもない。上級者向けには絶対に書かないこと。',

    custom:
      '【文体】ユーザーのプロンプトの指示に完全に従うこと。\n' +
      'レベル・ジャンル・雰囲気はすべてプロンプトで指定されたものを優先する。\n' +
      '自然な日本語で書く。翻訳調にならないこと。'
  };

  var voice = voices[levelType] || voices.custom;

  return (
    'あなたの返答はすべて、ひとつの有効なJSONオブジェクトでなければなりません。\n' +
    'マークダウン、コードフェンス（```）、説明文は一切不要です。JSONのみ返してください。\n\n' +

    '=== 創作指示 ===\n\n' +

    'あなたは優れた日本の小説家です。\n' +
    '以下のテーマをもとに、' + totalPages + 'ページの短編小説を日本語で書いてください。\n\n' +

    '【テーマ・設定】\n' +
    topic + '\n\n' +

    voice + '\n\n' +

    '【構成の要件】\n' +
    '- ページ数：ちょうど' + totalPages + 'ページ\n' +
    '- 各ページ：' + parasPerPage + '段落\n' +
    '- 各段落：' + paraLen + '\n' +
    '- 物語全体に一貫した流れを持たせること（起承転結、あるいは緊張と解放）\n' +
    '- 同じ登場人物・世界・出来事の糸が最初から最後まで続くこと\n' +
    '- 各ページは前のページから自然につながること\n' +
    '- 書き出しは状況説明でなく、場面の中心に読者を引き込む一文から始めること\n\n' +

    '【禁止事項】\n' +
    '- 無関係な文を並べるだけの「例文集」スタイルは絶対に禁止\n' +
    '- 「今日は〜です。〜しました。〜です。」という単調な羅列は禁止\n' +
    '- 英語を直訳したような不自然な日本語は禁止\n' +
    '- 登場人物や場面が突然変わるのは禁止\n\n' +

    '=== JSON形式 ===\n\n' +
    '以下の形式で返してください。\n' +
    'titleは日本語のタイトル、titleEnは英語のサブタイトルです。\n' +
    'segmentsの各textは、ひとつの段落（複数文で構成された散文）です。\n\n' +
    '{\n' +
    '  "title": "日本語タイトル",\n' +
    '  "titleEn": "English subtitle",\n' +
    '  "pages": [\n' +
    '    {\n' +
    '      "segments": [\n' +
    '        { "type": "filler", "text": "段落ひとつ分の散文。複数の文で構成される。" },\n' +
    '        { "type": "filler", "text": "次の段落。前の段落から自然につながる。" }\n' +
    '      ]\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    '※ typeはすべて "filler" です。anchorは使いません。\n' +
    '※ 各segmentのtextは段落単位の散文で、1〜4文を含みます。\n' +
    '※ JSONの外に何も書かないでください。\n\n' +
    'それでは、物語を始めてください：'
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