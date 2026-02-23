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

// ─── furigana ────────────────────────────────────────────────
var furiganaMap = {
  // People & family
  '私':'わたし','僕':'ぼく','彼':'かれ','彼女':'かのじょ','皆':'みな','父':'ちち','母':'はは',
  '兄':'あに','姉':'ねえ','弟':'おとうと','妹':'いもうと','子供':'こども','友達':'ともだち','人':'ひと',
  // Time
  '今':'いま','今日':'きょう','明日':'あした','昨日':'きのう','毎日':'まいにち','毎年':'まいとし',
  '今年':'ことし','来年':'らいねん','去年':'きょねん','時間':'じかん','時':'とき','朝':'あさ',
  '昼':'ひる','夜':'よる','午前':'ごぜん','午後':'ごご','週':'しゅう','月':'つき','年':'ねん',
  // Places
  '学校':'がっこう','大学':'だいがく','家':'いえ','部屋':'へや','町':'まち','国':'くに',
  '日本':'にほん','東京':'とうきょう','外国':'がいこく','海外':'かいがい','会社':'かいしゃ',
  '店':'みせ','駅':'えき','公園':'こうえん','病院':'びょういん','図書館':'としょかん',
  // Common verbs (noun forms)
  '勉強':'べんきょう','仕事':'しごと','電話':'でんわ','食事':'しょくじ','運動':'うんどう',
  '旅行':'りょこう','買物':'かいもの','料理':'りょうり','掃除':'そうじ','洗濯':'せんたく',
  // Nature & things
  '水':'みず','空':'そら','山':'やま','川':'かわ','海':'うみ','花':'はな','木':'き',
  '魚':'さかな','犬':'いぬ','猫':'ねこ','車':'くるま','電車':'でんしゃ','飛行機':'ひこうき',
  // Adjectives (noun forms)
  '好き':'すき','嫌い':'きらい','元気':'げんき','大切':'たいせつ','大丈夫':'だいじょうぶ',
  '有名':'ゆうめい','大変':'たいへん','暇':'ひま','親切':'しんせつ',
  // Entertainment & culture
  '映画':'えいが','音楽':'おんがく','歌':'うた','話':'はなし','本':'ほん','日本語':'にほんご',
  '英語':'えいご','言葉':'ことば','夢':'ゆめ','気持ち':'きもち',
  // Other frequent nouns
  '名前':'なまえ','言葉':'ことば','気':'き','目':'め','手':'て','口':'くち','頭':'あたま',
  '心':'こころ','声':'こえ','顔':'かお','体':'からだ','足':'あし','食べ物':'たべもの',
  '飲み物':'のみもの','天気':'てんき','冷蔵庫':'れいぞうこ','自慢':'じまん','遅刻':'ちこく',
  '退屈':'たいくつ','興味':'きょうみ','廃墟':'はいきょ','屋敷':'やしき','少年':'しょうねん',
  '王都':'おうと','敷地':'しきち','古書':'こしょ','庭':'にわ','森':'もり','北':'きた'
};

function buildClickableJP(text) {
  var re = /([一-龯々ヵヶ]+(?:[ぁ-ん]*)|[ぁ-ん]+|[ァ-ヶー]+|[a-zA-Z0-9]+|[^\s])/g;
  var match, result = '';
  while ((match = re.exec(text)) !== null) {
    var t = match[0];
    if (/[一-龯ぁ-んァ-ヶ]/.test(t)) {
      var inner = t;
      if (showFurigana) {
        Object.keys(furiganaMap).forEach(function(kanji) {
          inner = inner.replace(new RegExp(kanji, 'g'), '<ruby>' + kanji + '<rt>' + furiganaMap[kanji] + '</rt></ruby>');
        });
      }
      result += '<span class="jp-word" data-word="' + t.replace(/"/g, '&quot;') + '" onclick="lookupWord(this)">' + inner + '</span>';
    } else {
      result += t;
    }
  }
  return result;
}

// ─── mini dictionary ─────────────────────────────────────────
var miniDict = {
  'こと':   { reading: 'こと',        meaning: 'thing; matter; fact; case; circumstance' },
  'ない':   { reading: 'ない',        meaning: 'nonexistent; not (verb negation)' },
  '私':     { reading: 'わたし',     meaning: 'I; me (formal)' },
  '僕':     { reading: 'ぼく',       meaning: 'I; me (masculine)' },
  '彼':     { reading: 'かれ',       meaning: 'he; him; boyfriend' },
  '彼女':   { reading: 'かのじょ',   meaning: 'she; her; girlfriend' },
  '人':     { reading: 'ひと',       meaning: 'person; people; human' },
  '子供':   { reading: 'こども',     meaning: 'child; children' },
  '友達':   { reading: 'ともだち',   meaning: 'friend; companion' },
  '父':     { reading: 'ちち',       meaning: 'father (humble)' },
  '母':     { reading: 'はは',       meaning: 'mother (humble)' },
  '今':     { reading: 'いま',       meaning: 'now; at the moment' },
  '今日':   { reading: 'きょう',     meaning: 'today; this day' },
  '明日':   { reading: 'あした',     meaning: 'tomorrow' },
  '昨日':   { reading: 'きのう',     meaning: 'yesterday' },
  '毎日':   { reading: 'まいにち',   meaning: 'every day; daily' },
  '時間':   { reading: 'じかん',     meaning: 'time; hours' },
  '朝':     { reading: 'あさ',       meaning: 'morning' },
  '昼':     { reading: 'ひる',       meaning: 'noon; daytime' },
  '夜':     { reading: 'よる',       meaning: 'night; evening' },
  '学校':   { reading: 'がっこう',   meaning: 'school' },
  '大学':   { reading: 'だいがく',   meaning: 'university; college' },
  '家':     { reading: 'いえ',       meaning: 'house; home; family' },
  '部屋':   { reading: 'へや',       meaning: 'room' },
  '町':     { reading: 'まち',       meaning: 'town; city; street' },
  '国':     { reading: 'くに',       meaning: 'country; nation; homeland' },
  '日本':   { reading: 'にほん',     meaning: 'Japan' },
  '会社':   { reading: 'かいしゃ',   meaning: 'company; workplace' },
  '駅':     { reading: 'えき',       meaning: 'station (train/subway)' },
  '病院':   { reading: 'びょういん', meaning: 'hospital' },
  '勉強':   { reading: 'べんきょう', meaning: 'study; learning; diligence' },
  '仕事':   { reading: 'しごと',     meaning: 'work; job; occupation' },
  '電話':   { reading: 'でんわ',     meaning: 'telephone; phone call' },
  '旅行':   { reading: 'りょこう',   meaning: 'travel; trip; journey' },
  '料理':   { reading: 'りょうり',   meaning: 'cooking; cuisine; dish' },
  '水':     { reading: 'みず',       meaning: 'water' },
  '空':     { reading: 'そら',       meaning: 'sky; air' },
  '山':     { reading: 'やま',       meaning: 'mountain; hill' },
  '川':     { reading: 'かわ',       meaning: 'river; stream' },
  '海':     { reading: 'うみ',       meaning: 'sea; ocean; beach' },
  '花':     { reading: 'はな',       meaning: 'flower; blossom; petal; bloom' },
  '木':     { reading: 'き',         meaning: 'tree; wood' },
  '魚':     { reading: 'さかな',     meaning: 'fish; fish as food' },
  '犬':     { reading: 'いぬ',       meaning: 'dog' },
  '猫':     { reading: 'ねこ',       meaning: 'cat' },
  '車':     { reading: 'くるま',     meaning: 'car; vehicle' },
  '電車':   { reading: 'でんしゃ',   meaning: 'train; electric train' },
  '飛行機': { reading: 'ひこうき',   meaning: 'airplane; aircraft' },
  '好き':   { reading: 'すき',       meaning: 'liked; favourite; in love with' },
  '嫌い':   { reading: 'きらい',     meaning: 'disliked; hated' },
  '元気':   { reading: 'げんき',     meaning: 'healthy; energetic; lively' },
  '大切':   { reading: 'たいせつ',   meaning: 'important; precious; valuable' },
  '大丈夫': { reading: 'だいじょうぶ', meaning: "all right; okay; no problem" },
  '映画':   { reading: 'えいが',     meaning: 'movie; film; cinema' },
  '音楽':   { reading: 'おんがく',   meaning: 'music' },
  '歌':     { reading: 'うた',       meaning: 'song; singing; poem' },
  '話':     { reading: 'はなし',     meaning: 'talk; speech; conversation; story' },
  '本':     { reading: 'ほん',       meaning: 'book; volume' },
  '日本語': { reading: 'にほんご',   meaning: 'Japanese language' },
  '英語':   { reading: 'えいご',     meaning: 'English language' },
  '夢':     { reading: 'ゆめ',       meaning: 'dream; vision; ambition' },
  '気持ち': { reading: 'きもち',     meaning: 'feeling; mood; sensation' },
  '名前':   { reading: 'なまえ',     meaning: 'name; full name' },
  '心':     { reading: 'こころ',     meaning: 'heart; mind; spirit; feeling' },
  '声':     { reading: 'こえ',       meaning: 'voice; sound' },
  '顔':     { reading: 'かお',       meaning: 'face; look; expression' },
  '体':     { reading: 'からだ',     meaning: 'body; health' },
  '外国':   { reading: 'がいこく',   meaning: 'foreign country; abroad' },
  '天気':   { reading: 'てんき',     meaning: 'weather; the elements' },
  '退屈':   { reading: 'たいくつ',   meaning: 'boredom; tedium; dull' },
  '興味':   { reading: 'きょうみ',   meaning: 'interest; curiosity' },
  '少年':   { reading: 'しょうねん', meaning: 'boy; juvenile; young man' },
  '王都':   { reading: 'おうと',     meaning: 'royal capital; capital city' },
  '庭':     { reading: 'にわ',       meaning: 'garden; yard' },
  '森':     { reading: 'もり',       meaning: 'forest; woods' },
  '北':     { reading: 'きた',       meaning: 'north' },
  '行':     { reading: 'い(く)',     meaning: 'to go; to move toward; to proceed' },
  '見':     { reading: 'み(る)',     meaning: 'to see; to look; to watch; to observe' },
  '食':     { reading: 'た(べる)',   meaning: 'to eat; to consume' },
  '聞':     { reading: 'き(く)',     meaning: 'to listen; to hear; to ask' }
};

function lookupWord(el) {
  document.querySelectorAll('.jp-word.selected').forEach(function(e) { e.classList.remove('selected'); });
  el.classList.add('selected');
  var word = el.dataset.word;
  var info = miniDict[word];
  document.getElementById('popupWord').textContent    = word;
  document.getElementById('popupReading').textContent = info ? info.reading : '—';
  document.getElementById('popupMeaning').textContent = info ? info.meaning : 'Meaning not in local dictionary. Try jpdb.io or jisho.org!';

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

// ─── render: flashcard ────────────────────────────────────────
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

  document.getElementById('cardBadge').textContent = isReviewMode ? 'REVIEW' : 'STUDY';
  document.getElementById('cardNum').textContent   = (idx + 1) + ' / ' + src.length;
  document.getElementById('jpText').innerHTML      = buildClickableJP(s.jp);

  // Delete button on card
  var existingDelBtn = document.getElementById('cardDeleteBtn');
  if (existingDelBtn) existingDelBtn.remove();
  if (isDeleteMode) {
    var delBtn = document.createElement('button');
    delBtn.id = 'cardDeleteBtn';
    delBtn.className = 'card-delete-btn';
    delBtn.innerHTML = '✕';
    delBtn.title = 'Delete this sentence';
    delBtn.onclick = function() {
      if (confirm('Delete this sentence?')) deleteSentence(s.id);
    };
    document.getElementById('mainCard').appendChild(delBtn);
  }

  var transEl = document.getElementById('transText');
  transEl.textContent = s.en;
  transEl.classList.toggle('hidden', !showTranslation);

  document.getElementById('lengthBadge').textContent  = lengthLabel(s.jp.length) + ' \u00b7 ' + s.jp.length + ' chars';
  document.getElementById('reviewBtns').style.display = isReviewMode ? 'flex' : 'none';
  document.getElementById('cardNav').style.display    = isReviewMode ? 'none' : 'flex';

  // Stats bar always reflects the current active source (review queue or filtered sentences)
  document.getElementById('statCard').textContent     = (idx + 1) + ' / ' + src.length;
  document.getElementById('progressFill').style.width = src.length ? ((idx + 1) / src.length * 100) + '%' : '0%';

  updateDueBadge();

  // Prefetch next card's audio in the background for near-zero delay on next press
  if (typeof prefetchJP === 'function') {
    var nextIdx = isReviewMode ? reviewIdx + 1 : currentIdx + 1;
    var nextCard = src[nextIdx];
    if (nextCard) prefetchJP(nextCard.jp);
  }
}

// ─── render: list view (fast DocumentFragment build) ─────────
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
  // Use all sentences for group counts/display, but respect filter for which groups to show
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
    // Derive the filter key from this label
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

      // Safe JP for audio button
      var safeJP = s.jp.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

      item.innerHTML =
        '<div class="list-item-num">' + (i + 1) + '</div>' +
        '<div class="list-item-content">' +
          '<div class="list-item-jp">' + buildClickableJP(s.jp) + '</div>' +
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
initDecks();     // decks.js  — loads deck data into globals (sentences, srsData, currentIdx)
loadUIPrefs();   // ui.js     — restores theme, font, toggles, and sets isListView
loadVoicePref(); // tts.js    — restores selected voice
updateDeckUI();  // decks.js  — sets deck button label + modal content
applyViewState();// ui.js     — syncs DOM to isListView/isReviewMode flags

if (window.speechSynthesis) { speechSynthesis.onvoiceschanged = function() {}; speechSynthesis.getVoices(); }

render();

// Firebase: init last so page renders instantly from localStorage,
// then cloud data overwrites if user is signed in.
if (typeof initFirebase === 'function') initFirebase();
