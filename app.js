/* ============================================================
   積む — app.js  (load order: 4th / last)
   Core state, SRS, rendering, navigation
   ============================================================ */

// ─── global state ────────────────────────────────────────────
var sentences       = [];
var currentIdx      = 0;
var showTranslation = true;
var showFurigana    = false;
var isListView      = false;
var isReviewMode    = false;
var reviewQueue     = [];
var reviewIdx       = 0;
var srsData         = {};

var INTERVALS  = { again: 1, hard: 3, good: 10, easy: 30 }; // minutes
var isDeleteMode = false;

// ─── length filter ───────────────────────────────────────────
// null = show all; otherwise 'SHORT','MEDIUM','LONG','VERY LONG'
var currentLengthFilter = null;

var LENGTH_LABELS = ['SHORT', 'MEDIUM', 'LONG', 'VERY LONG'];

function getSentencesForFilter() {
  if (!currentLengthFilter) return sentences;
  return sentences.filter(function(s) {
    return lengthLabel(s.jp.length) === currentLengthFilter;
  });
}

function setLengthFilter(label) {
  var key = label.split(' ')[0];
  if (key === 'VERY') key = 'VERY LONG';
  currentLengthFilter = (currentLengthFilter === key) ? null : key;
  try { localStorage.setItem('jpStudy_lengthFilter', currentLengthFilter || ''); } catch(e) {}
  currentIdx = 0;
  render();
}

// ─── SRS ─────────────────────────────────────────────────────
function getDueCards() {
  var now = Date.now();
  return sentences.filter(function(s) {
    var d = srsData[s.id];
    return !d || d.due <= now;
  });
}

// ─── delete sentence ─────────────────────────────────────────
function deleteSentence(id) {
  sentences = sentences.filter(function(s) { return s.id !== id; });
  delete srsData[id];
  // Clamp index
  if (currentIdx >= sentences.length) currentIdx = Math.max(0, sentences.length - 1);
  // Also remove from review queue if present
  reviewQueue = reviewQueue.filter(function(s) { return s.id !== id; });
  if (reviewIdx >= reviewQueue.length) reviewIdx = Math.max(0, reviewQueue.length - 1);
  saveCurrentDeck();
  render();
}

function updateDueBadge() {
  var due   = getDueCards().length;
  var badge = document.getElementById('dueBadge');
  badge.style.display = due > 0 ? '' : 'none';
  badge.textContent   = due;
}

function reviewCard(rating) {
  var card = isReviewMode ? reviewQueue[reviewIdx] : sentences[currentIdx];
  if (!card) return;

  var now  = Date.now();
  var prev = srsData[card.id] || { interval: 0, ease: 2.5, reps: 0 };

  var interval = INTERVALS[rating];
  if (prev.reps > 0 && rating !== 'again') {
    interval = Math.round(prev.interval * prev.ease * (rating === 'hard' ? 0.8 : rating === 'easy' ? 1.3 : 1));
    interval = Math.max(interval, INTERVALS[rating]);
  }

  var ease = prev.ease + (rating === 'easy' ? 0.15 : rating === 'hard' ? -0.15 : rating === 'again' ? -0.2 : 0);
  if (ease < 1.3) ease = 1.3;

  srsData[card.id] = { interval: interval, due: now + interval * 60000, ease: ease, reps: prev.reps + 1, lastRating: rating };
  saveCurrentDeck();

  if (isReviewMode) {
    reviewIdx++;
    if (reviewIdx >= reviewQueue.length) {
      isReviewMode = false;
      alert('Review complete! Reviewed ' + reviewQueue.length + ' cards.');
      render();
      return;
    }
    // Only re-render the card content — don't rebuild list view
    renderCard();
  } else {
    nextCard();
  }
}

// ─── furigana via kuromoji (self-hosted dict) ─────────────────
// kuromoji@0.1.2 browser build + dict files hosted in /dict/ folder.
// This is the ONLY approach that reliably works in plain HTML on GitHub Pages.
// Dict files must be present at ./dict/ — see README for setup instructions.
//
// How it works:
//  1. kuromoji.js is loaded as a <script> tag (exposes window.kuromoji)
//  2. On page load, kuromoji reads the dict files from ./dict/
//  3. Once ready (~1-2s), all sentences are pre-tokenized and cached in localStorage
//  4. Furigana is synchronous after that — instant on every render

var kuromojiTokenizer = null;
var kuromojiReady     = false;

// localStorage cache: full Japanese sentence → ruby HTML string
// Key: full Japanese sentence → ruby HTML string
// Each sentence processed once, then instant forever.
var furiganaCache = {};

function loadFuriganaCache() {
  try {
    var raw = localStorage.getItem('jpStudy_furigana_cache');
    if (raw) furiganaCache = JSON.parse(raw);
  } catch(e) { furiganaCache = {}; }
}

function saveFuriganaCache() {
  try { localStorage.setItem('jpStudy_furigana_cache', JSON.stringify(furiganaCache)); } catch(e) {}
}

// Debounced save — coalesces rapid successive calls into one write.
// When switching to list view with 100+ sentences, buildJPHTML is called
// for every sentence. Without debouncing this causes 100+ synchronous
// localStorage.setItem calls, each serialising the whole cache = O(n²) freeze.
var _saveFuriganaTimer = null;
function saveFuriganaCacheDebounced() {
  if (_saveFuriganaTimer) clearTimeout(_saveFuriganaTimer);
  _saveFuriganaTimer = setTimeout(saveFuriganaCache, 800);
}

function katakanaToHiragana(str) {
  return str.replace(/[\u30a1-\u30f6]/g, function(m) { return String.fromCharCode(m.charCodeAt(0) - 0x60); });
}

function hasKanji(str) {
  return /[\u4e00-\u9faf\u3400-\u4dbf]/.test(str);
}

function initKuromoji() {
  if (!window.kuromoji) return;
  kuromoji.builder({ dicPath: './dict' }).build(function(err, tokenizer) {
    if (err) { console.error('Kuromoji failed:', err); return; }
    kuromojiTokenizer = tokenizer;
    kuromojiReady = true;
    // Pre-tokenize all sentences in background (both furigana ON and OFF variants)
    sentences.forEach(function(s) {
      var savedShow = showFurigana;
      showFurigana = false; buildJPHTML(s.jp);
      showFurigana = true;  buildJPHTML(s.jp);
      showFurigana = savedShow;
    });
    if (showFurigana) render();
  });
}

// ── addFurigana: ruby ONLY above kanji, never above hiragana ──
//
// Key insight from kuromoji's actual tokenization:
//   "食べる" → token { surface_form: "食べ", reading: "タベ" }
//              (kuromoji splits the trailing inflection "る" into a
//               separate token, so surface already ends in hiragana okurigana)
//   "高い"   → token { surface_form: "高い", reading: "タカイ" }
//   "お金"   → token { surface_form: "お金", reading: "オカネ" }
//   "飲み物" → token { surface_form: "飲み物", reading: "ノミモノ" }
//              (middle hiragana — handled by fallback below)
//
// Algorithm:
//   1. No kanji → return surface as-is (pure kana tokens never get ruby)
//   2. Strip matching trailing hiragana chars from both surface and reading
//   3. Strip matching leading hiragana chars from both surface and reading
//   4. Wrap what remains: <ruby>kanjiPart<rt>readingPart</rt></ruby>
//   5. Fallback if stripping left nothing to annotate (middle-hiragana words
//      like 飲み物): wrap the whole surface — still better than nothing,
//      and these are genuinely uncommon in study sentences.

function addFurigana(token) {
  var surface = token.surface_form;
  var reading = token.reading;

  // Guard: no kanji, or no reading, or reading is identical to surface → plain text
  if (!hasKanji(surface) || !reading) return surface;
  var hira = katakanaToHiragana(reading);
  if (hira === surface) return surface;

  var surf = surface.split('');
  var read = hira.split('');

  // ── Strip matching trailing hiragana (okurigana suffix) ──
  // Only strip hiragana [\u3041-\u3096], NOT katakana or kanji
  var suffix = '';
  while (
    surf.length > 0 &&
    read.length > 0 &&
    /^[\u3041-\u3096]$/.test(surf[surf.length - 1]) &&
    surf[surf.length - 1] === read[read.length - 1]
  ) {
    suffix = surf.pop() + suffix;
    read.pop();
  }

  // ── Strip matching leading hiragana (okurigana prefix, e.g. お金) ──
  var prefix = '';
  while (
    surf.length > 0 &&
    read.length > 0 &&
    /^[\u3041-\u3096]$/.test(surf[0]) &&
    surf[0] === read[0]
  ) {
    prefix += surf.shift();
    read.shift();
  }

  var kanjiPart   = surf.join('');
  var readingPart = read.join('');

  // Fallback: if stripping left an empty kanji or reading part, wrap whole surface.
  // This handles middle-hiragana compounds (飲み物 etc.) — not perfect but safe.
  if (!kanjiPart || !readingPart) {
    return '<ruby>' + surface + '<rt>' + hira + '</rt></ruby>';
  }

  return prefix + '<ruby>' + kanjiPart + '<rt>' + readingPart + '</rt></ruby>' + suffix;
}

// ── buildJPHTML ───────────────────────────────────────────────
// Builds clickable-span HTML for a Japanese sentence.
// Cache key includes a version stamp so stale cached HTML from old
// buggy versions is automatically discarded on first load.
var FURIGANA_CACHE_VERSION = 'v3';

function buildJPHTML(text) {
  if (!kuromojiReady) return text;

  var cacheKey = FURIGANA_CACHE_VERSION + ':' + (showFurigana ? 'f:' : 'n:') + text;
  if (furiganaCache[cacheKey]) return furiganaCache[cacheKey];

  var tokens = kuromojiTokenizer.tokenize(text);
  var html = '';

  for (var i = 0; i < tokens.length; i++) {
    var token   = tokens[i];
    var surface = token.surface_form;
    var inner   = showFurigana ? addFurigana(token) : surface;

    // Wrap Japanese tokens in clickable spans; leave punctuation (記号) as plain text
    if (token.pos !== '記号') {
      html += '<span class="jp-word" data-word="' +
        surface.replace(/"/g, '&quot;') +
        '" data-reading="' + (token.reading || '') +
        '" onclick="lookupWord(this)">' + inner + '</span>';
    } else {
      html += inner;
    }
  }

  furiganaCache[cacheKey] = html;
  saveFuriganaCacheDebounced();
  return html;
}

// ─── word lookup popup ───────────────────────────────────────
function lookupWord(el) {
  document.querySelectorAll('.jp-word.selected').forEach(function(e) { e.classList.remove('selected'); });
  el.classList.add('selected');
  var word    = el.dataset.word;
  var reading = el.dataset.reading
    ? katakanaToHiragana(el.dataset.reading)
    : (kuromojiReady
        ? katakanaToHiragana(kuromojiTokenizer.tokenize(word).map(function(t) { return t.reading || t.surface_form; }).join(''))
        : '—');

  document.getElementById('popupWord').textContent    = word;
  document.getElementById('popupReading').textContent = reading || '—';
  document.getElementById('popupMeaning').textContent = 'Open jisho.org for full meaning →';

  var examples = sentences.filter(function(s) { return s.jp.indexOf(word) !== -1; }).slice(0, 3);
  document.getElementById('popupExamples').innerHTML = examples.length
    ? examples.map(function(ex) {
        var safeJP = ex.jp.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return '<div class="popup-example">' +
          '<div class="popup-example-jp">' + ex.jp + '</div>' +
          '<div class="popup-example-en">' + ex.en + '</div>' +
          '<button class="popup-audio-btn" onclick="speakJP(\'' + safeJP + '\').catch(function(){})">&#9654; Audio</button>' +
          '</div>';
      }).join('')
    : '<div style="color:var(--text3);font-size:0.8rem;font-family:\'DM Mono\',monospace">No examples in your collection yet.</div>';

  document.getElementById('wordPopup').classList.add('active');
}

// ─── helpers ─────────────────────────────────────────────────
function lengthLabel(len) {
  if (len <= 8)  return 'SHORT';
  if (len <= 16) return 'MEDIUM';
  if (len <= 24) return 'LONG';
  return 'VERY LONG';
}

// ─── render: flashcard ───────────────────────────────────────
function renderCard() {
  var filtered = getSentencesForFilter();
  if (!filtered.length) {
    document.getElementById('emptyState').style.display = '';
    document.getElementById('cardArea').style.display   = 'none';
    document.getElementById('statsBar').style.display   = 'none';
    return;
  }

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('cardArea').style.display   = '';
  document.getElementById('statsBar').style.display   = 'flex';

  var src = isReviewMode ? reviewQueue : getSentencesForFilter();
  var idx = isReviewMode ? reviewIdx  : currentIdx;
  var s   = src[idx];
  if (!s) return;

  // Re-trigger card animation
  var card = document.getElementById('mainCard');
  card.style.animation = 'none';
  card.offsetHeight; // reflow
  card.style.animation = '';

  document.getElementById('jpText').innerHTML      = buildJPHTML(s.jp);

  // Delete button on card
  var existingDelBtn = document.getElementById('cardDeleteBtn');
  if (existingDelBtn) existingDelBtn.remove();
  if (isDeleteMode) {
    var delBtn = document.createElement('button');
    delBtn.id        = 'cardDeleteBtn';
    delBtn.className = 'card-delete-btn';
    delBtn.innerHTML = '✕';
    delBtn.title     = 'Delete this sentence';
    delBtn.onclick   = function() {
      if (confirm('Delete this sentence?')) deleteSentence(s.id);
    };
    document.getElementById('mainCard').appendChild(delBtn);
  }

  var transEl = document.getElementById('transText');
  transEl.textContent = s.en;
  transEl.classList.toggle('hidden', !showTranslation);

  document.getElementById('reviewBtns').style.display = isReviewMode ? 'flex' : 'none';
  document.getElementById('cardNav').style.display    = isReviewMode ? 'none' : 'flex';

  document.getElementById('statCard').textContent      = (idx + 1) + ' / ' + src.length;
  document.getElementById('progressFill').style.width  = src.length ? ((idx + 1) / src.length * 100) + '%' : '0%';

  updateDueBadge();

  // Prefetch next card's audio
  if (typeof prefetchJP === 'function') {
    var nextSrc  = src[isReviewMode ? reviewIdx + 1 : currentIdx + 1];
    if (nextSrc) prefetchJP(nextSrc.jp);
  }
}

function renderListView() {
  var container = document.getElementById('listView');

  if (!sentences.length) {
    container.innerHTML = '<div class="empty-state"><div class="kanji">\u7121</div>' +
      '<p>No sentences yet. Add some to begin.</p>' +
      '<button class="btn btn-accent" onclick="openAddModal()">+ Add Sentences</button></div>';
    return;
  }

  var groups = {
    'SHORT (\u22648)':    [],
    'MEDIUM (9\u201316)': [],
    'LONG (17\u201324)':  [],
    'VERY LONG (25+)':    []
  };
  var sentencesToGroup = getSentencesForFilter();
  sentencesToGroup.forEach(function(s) {
    var l = s.jp.length;
    if      (l <= 8)  groups['SHORT (\u22648)'].push(s);
    else if (l <= 16) groups['MEDIUM (9\u201316)'].push(s);
    else if (l <= 24) groups['LONG (17\u201324)'].push(s);
    else              groups['VERY LONG (25+)'].push(s);
  });

  var frag = document.createDocumentFragment();

  Object.keys(groups).forEach(function(label) {
    var items = groups[label];
    if (!items.length) return;

    var groupEl = document.createElement('div');
    groupEl.className = 'length-group';

    var titleEl = document.createElement('div');
    var filterKey = label.split(' ')[0] === 'VERY' ? 'VERY LONG' : label.split(' ')[0];
    var isActive  = (currentLengthFilter === filterKey);
    titleEl.className = 'length-group-title' + (isActive ? ' filter-active' : '');
    titleEl.title = isActive ? 'Click to show all lengths' : 'Click to filter to ' + filterKey + ' only';
    titleEl.innerHTML = label + ' \u00b7 ' + items.length + ' sentences' +
      ' <span class="filter-badge">' + (isActive ? '\u2715 clear filter' : '\u25bc filter') + '</span>';
    titleEl.style.cursor = 'pointer';
    titleEl.addEventListener('click', function() { setLengthFilter(label); });
    groupEl.appendChild(titleEl);

    items.forEach(function(s, i) {
      var srs = srsData[s.id];
      var statusClass = srs
        ? (srs.lastRating === 'again' ? 'again' : srs.lastRating === 'hard' ? 'hard' : 'good')
        : '';

      var item = document.createElement('div');
      item.className = 'list-item';
      item.addEventListener('click', function() { openListCard(item); });

      var safeJP = s.jp.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

      item.innerHTML =
        '<div class="list-item-num">' + (i + 1) + '</div>' +
        '<div class="list-item-content">' +
          '<div class="list-item-jp">' + buildJPHTML(s.jp) + '</div>' +
          '<div class="list-item-en' + (showTranslation ? '' : ' hidden') + '">' + s.en + '</div>' +
        '</div>' +
        '<div class="list-item-status">' +
          '<div class="status-dot ' + statusClass + '"></div>' +
          '<button class="popup-audio-btn" onclick="event.stopPropagation();speakJP(\'' + safeJP + '\').catch(function(){})">\u25b6</button>' +
          (isDeleteMode ? '<button class="list-delete-btn" onclick="event.stopPropagation();(confirm(\'Delete this sentence?\')&&deleteSentence(\'' + s.id + '\'))" title="Delete">\u2715</button>' : '') +
        '</div>';

      groupEl.appendChild(item);
    });

    frag.appendChild(groupEl);
  });

  container.innerHTML = '';
  container.appendChild(frag);
}

function openListCard(el) {
  document.querySelectorAll('.list-item').forEach(function(e) { e.classList.remove('reviewing'); });
  el.classList.add('reviewing');
}

// ─── length filter pills (card/review/list mode) ────────────
function toggleLengthPill(key) {
  currentLengthFilter = (currentLengthFilter === key) ? null : key;
  try { localStorage.setItem('jpStudy_lengthFilter', currentLengthFilter || ''); } catch(e) {}

  if (isReviewMode) {
    // Rebuild review queue from all due cards, then apply the length filter
    var allDue = getDueCards();
    reviewQueue = currentLengthFilter
      ? allDue.filter(function(s) { return lengthLabel(s.jp.length) === currentLengthFilter; })
      : allDue;
    reviewIdx = 0;
    if (!reviewQueue.length) {
      // No due cards match — gracefully exit review mode
      isReviewMode = false;
      currentIdx = 0;
    }
  } else {
    currentIdx = 0;
  }

  render();
}

function updateLengthFilterBar() {
  var bar = document.getElementById('lengthFilterBar');
  if (!bar) return;
  // Show in ALL modes — card, review, and list
  var show = sentences.length > 0;
  bar.style.display = show ? 'flex' : 'none';
  if (!show) return;
  // Set active state on each pill — handle "All" pill separately
  bar.querySelectorAll('.length-filter-pill').forEach(function(pill) {
    var onclick   = pill.getAttribute('onclick') || '';
    var isAllPill = onclick.indexOf('null') !== -1;
    if (isAllPill) {
      pill.classList.toggle('active', currentLengthFilter === null);
    } else {
      var match   = onclick.match(/toggleLengthPill\('([^']+)'\)/);
      var pillKey = match ? match[1] : null;
      pill.classList.toggle('active', pillKey !== null && pillKey === currentLengthFilter);
    }
  });
}

// ─── main render ─────────────────────────────────────────────
function render() {
  if (isListView) renderListView();
  else            renderCard();
  updateDueBadge();
  updateLengthFilterBar();
}

// ─── navigation ──────────────────────────────────────────────
function prevCard() {
  if (isReviewMode) return;
  if (currentIdx > 0) { currentIdx--; resetAudioBtn(); saveCurrentDeck(); renderCard(); }
}

function nextCard() {
  if (isReviewMode) return;
  var filtered = getSentencesForFilter();
  if (currentIdx < filtered.length - 1) { currentIdx++; resetAudioBtn(); saveCurrentDeck(); renderCard(); }
}

// ─── init ────────────────────────────────────────────────────
initDecks();         // decks.js  — loads deck data into globals (sentences, srsData, currentIdx)
loadUIPrefs();       // ui.js     — restores theme, font, toggles, and sets isListView
loadVoicePref();     // tts.js    — restores selected voice
loadFuriganaCache(); // load cached furigana readings from localStorage
updateDeckUI();      // decks.js  — sets deck button label + modal content
applyViewState();    // ui.js     — syncs DOM to isListView/isReviewMode flags

if (window.speechSynthesis) { speechSynthesis.onvoiceschanged = function() {}; speechSynthesis.getVoices(); }

render();

// Init kuromoji after first render — loads dict files from ./dict/ (~1-2s first time)
// When ready: pre-tokenizes all sentences, then re-renders if furigana is ON
initKuromoji();

// Firebase: init last so page renders instantly from localStorage,
// then cloud data overwrites if user is signed in.
if (typeof initFirebase === 'function') initFirebase();