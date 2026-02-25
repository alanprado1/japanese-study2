/* ============================================================
   積む — decks.js  (load order: 1st)
   Deck management: create, switch, save, load, export
   Each deck stores its own sentences + SRS data.
   Global prefs (theme, font, voice) are shared.
   ============================================================ */

let currentDeckId = 'default';
let decks = {};

// ─── storage ────────────────────────────────────────────────

function saveDeckList() {
  try {
    var meta = {};
    Object.keys(decks).forEach(function(id) { meta[id] = { name: decks[id].name }; });
    localStorage.setItem('jpStudy_deckList',    JSON.stringify(meta));
    localStorage.setItem('jpStudy_currentDeck', currentDeckId);
  } catch(e) {}
}

function saveDeck(id) {
  var d = decks[id];
  if (!d) return;
  try {
    localStorage.setItem('jpStudy_deck_' + id, JSON.stringify({
      name: d.name, sentences: d.sentences, srsData: d.srsData, currentIdx: d.currentIdx
    }));
  } catch(e) { console.warn('saveDeck quota exceeded?', e); }
  // Mirror to Firestore if signed in
  if (typeof pushDeckToFirestore === 'function') pushDeckToFirestore(id);
}

function loadDeckFromStorage(id) {
  try {
    var raw = localStorage.getItem('jpStudy_deck_' + id);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

// ─── legacy migration ────────────────────────────────────────
function migrateLegacy() {
  var legacySentences = localStorage.getItem('jpStudy_sentences');
  var legacySrs       = localStorage.getItem('jpStudy_srs');
  if (legacySentences && !localStorage.getItem('jpStudy_deckList')) {
    decks['default'] = {
      name:       'Default',
      sentences:  JSON.parse(legacySentences),
      srsData:    legacySrs ? JSON.parse(legacySrs) : {},
      currentIdx: parseInt(localStorage.getItem('jpStudy_currentIdx') || '0', 10)
    };
    saveDeck('default');
    saveDeckList();
    ['jpStudy_sentences','jpStudy_srs','jpStudy_currentIdx'].forEach(function(k) { localStorage.removeItem(k); });
  }
}

// ─── init ────────────────────────────────────────────────────
function initDecks() {
  migrateLegacy();

  try {
    var raw  = localStorage.getItem('jpStudy_deckList');
    var meta = raw ? JSON.parse(raw) : null;

    if (meta && Object.keys(meta).length > 0) {
      Object.keys(meta).forEach(function(id) {
        var data   = loadDeckFromStorage(id);
        decks[id]  = data || { name: meta[id].name, sentences: [], srsData: {}, currentIdx: 0 };
        decks[id].sentences  = decks[id].sentences  || [];
        decks[id].srsData    = decks[id].srsData    || {};
        decks[id].currentIdx = decks[id].currentIdx || 0;
      });
      var saved = localStorage.getItem('jpStudy_currentDeck');
      currentDeckId = (saved && decks[saved]) ? saved : Object.keys(decks)[0];
    } else {
      decks['default'] = { name: 'Default', sentences: [], srsData: {}, currentIdx: 0 };
      currentDeckId = 'default';
      saveDeck('default');
      saveDeckList();
    }
  } catch(e) {
    decks['default'] = { name: 'Default', sentences: [], srsData: {}, currentIdx: 0 };
    currentDeckId = 'default';
  }

  syncDeckToApp();
}

// ─── sync ────────────────────────────────────────────────────
function syncDeckToApp() {
  var d = decks[currentDeckId];
  if (!d) return;
  sentences  = d.sentences;
  srsData    = d.srsData;
  currentIdx = (d.currentIdx < d.sentences.length) ? d.currentIdx : 0;
}

function syncAppToDeck() {
  var d = decks[currentDeckId];
  if (!d) return;
  d.sentences  = sentences;
  d.srsData    = srsData;
  d.currentIdx = currentIdx;
}

function saveCurrentDeck() {
  syncAppToDeck();
  saveDeck(currentDeckId);
}

// ─── switch ──────────────────────────────────────────────────
function switchDeck(id) {
  if (!decks[id]) return;
  if (id === currentDeckId) { closeDeckModal(); return; }

  syncAppToDeck();
  saveDeck(currentDeckId);

  currentDeckId = id;
  localStorage.setItem('jpStudy_currentDeck', id);
  syncDeckToApp();

  // Load the per-filter card positions for the new deck.
  // filterIndexes is a single in-memory object — without resetting here it
  // still holds the previous deck's positions, causing the old deck's card
  // index to bleed into every other deck when filters are used.
  if (typeof filterIndexes !== 'undefined') filterIndexes = {};
  if (typeof loadFilterIndexes === 'function') loadFilterIndexes();
  // Apply the saved position for the currently active filter in the new deck.
  // syncDeckToApp() only restores d.currentIdx (a single flat value); if a
  // filter is active we need the per-filter position from filterIndexes instead.
  if (typeof filterIndexes !== 'undefined' && typeof currentLengthFilter !== 'undefined') {
    var _fi = filterIndexes[currentLengthFilter || ''];
    if (_fi !== undefined && typeof getSentencesForFilter === 'function') {
      var _filt = getSentencesForFilter();
      currentIdx = (_fi < _filt.length) ? _fi : Math.max(0, _filt.length - 1);
    }
  }

  // Push the updated currentDeckId to Firestore NOW (after it's been set)
  // so a page refresh always restores the correct deck
  if (typeof pushCurrentDeckId === 'function') pushCurrentDeckId();

  isReviewMode = false;
  resetAudioBtn();

  applyViewState();
  render();
  updateDeckUI();
  closeDeckModal();
}

// ─── create / rename / delete ─────────────────────────────────
function createDeck(name) {
  var id = 'deck_' + Date.now();
  decks[id] = { name: name, sentences: [], srsData: {}, currentIdx: 0 };
  saveDeck(id);
  saveDeckList();
  return id;
}

function renameDeck(id, name) {
  if (!decks[id]) return;
  decks[id].name = name;
  saveDeck(id);
  saveDeckList();
}

function deleteDeck(id) {
  if (Object.keys(decks).length <= 1) return;
  var wasActive = (id === currentDeckId);
  delete decks[id];
  localStorage.removeItem('jpStudy_deck_' + id);
  saveDeckList();
  // Delete from Firestore so it doesn't come back on refresh
  if (typeof deleteDeckFromFirestore === 'function') deleteDeckFromFirestore(id);
  if (wasActive) switchDeck(Object.keys(decks)[0]);
}

// ─── export ──────────────────────────────────────────────────
function exportDeckById(id) {
  if (!decks[id]) return;
  if (id === currentDeckId) syncAppToDeck();
  var d    = decks[id];
  var text = d.sentences.map(function(s) { return s.jp + '\n' + s.en; }).join('\n\n');
  var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  var a    = document.createElement('a');
  a.href   = URL.createObjectURL(blob);
  a.download = d.name.replace(/\s+/g, '_') + '_sentences.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── add sentences ────────────────────────────────────────────
function parseSentences() {
  var textarea = document.getElementById('sentenceInput');
  var raw = (textarea ? textarea.value : '').trim();
  if (!raw) return;

  var lines    = raw.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
  var incoming = [];
  for (var i = 0; i < lines.length; i += 2) {
    var jp = lines[i];
    var en = lines[i + 1] || '';
    if (jp) incoming.push({ id: Date.now() + '_' + i, jp: jp, en: en, length: jp.length });
  }
  if (!incoming.length) return;

  var merged = sentences.concat(incoming);
  var seen   = {};
  sentences  = merged.filter(function(s) {
    if (seen[s.jp]) return false;
    seen[s.jp] = true;
    return true;
  });
  sentences.sort(function(a, b) { return a.jp.length - b.jp.length; });
  currentIdx = 0;

  textarea.value = '';
  closeAddModal();
  saveCurrentDeck();
  render();
}

// ─── deck modal ───────────────────────────────────────────────
function updateDeckUI() {
  var btn = document.getElementById('btnDeckSelect');
  if (btn) btn.textContent = '\u229e ' + (decks[currentDeckId] ? decks[currentDeckId].name : 'Deck');
  renderDeckModal();
}

function renderDeckModal() {
  var list = document.getElementById('deckList');
  if (!list) return;

  var ids      = Object.keys(decks);
  var canDel   = ids.length > 1;
  var html     = '';

  ids.forEach(function(id) {
    var d     = decks[id];
    var count = (id === currentDeckId) ? sentences.length : d.sentences.length;
    html += '<div class="deck-item' + (id === currentDeckId ? ' active' : '') + '" onclick="switchDeck(\'' + id + '\')" style="cursor:pointer">' +
      '<span class="deck-item-name">' + d.name + '</span>' +
      '<span class="deck-item-count">' + count + ' sentences</span>' +
      '<div class="deck-item-actions" onclick="event.stopPropagation()">' +
        '<button class="deck-action-btn" onclick="promptRenameDeck(\'' + id + '\')" title="Rename">\u270e</button>' +
        '<button class="deck-action-btn" onclick="exportDeckById(\'' + id + '\')" title="Export">\u2193</button>' +
        (canDel ? '<button class="deck-action-btn danger" onclick="confirmDeleteDeck(\'' + id + '\')" title="Delete">\u2715</button>' : '') +
      '</div></div>';
  });
  list.innerHTML = html;
}

function promptRenameDeck(id) {
  var name = prompt('Rename deck:', decks[id] ? decks[id].name : '');
  if (name && name.trim()) { renameDeck(id, name.trim()); updateDeckUI(); }
}

function confirmDeleteDeck(id) {
  var name = decks[id] ? decks[id].name : id;
  if (confirm('Delete deck "' + name + '"? This cannot be undone.')) { deleteDeck(id); updateDeckUI(); }
}

function openDeckModal()  { renderDeckModal(); document.getElementById('deckModal').classList.add('active'); }
function closeDeckModal() { document.getElementById('deckModal').classList.remove('active'); }
