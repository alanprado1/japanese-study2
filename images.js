/* ============================================================
   積む — images.js
   Ghibli-style AI card illustrations via Pollinations.ai

   Cache strategy:
   ─ Images are stored as dataURLs in IndexedDB (store: 'images').
   ─ On refresh the image is served instantly — zero network requests.
   ─ IndexedDB gives 50MB+ vs localStorage's 5MB, so images no longer
     compete with sentences, SRS data, and furigana cache.
   ─ In-memory layer (_imgCache) avoids redundant IDB reads within
     the same session.
   ─ On first run, existing localStorage image keys are migrated into
     IDB automatically and removed from localStorage.

   IndexedDB schema  (shared DB: jpStudy_db, opened here):
     store 'images'  keyPath:'id'   { id, dataUrl, ts }
     store 'audio'   keyPath:'key'  { key, b64, ts }   ← used by tts.js

   LRU cap: 300 images.
   ============================================================ */

var POLLINATIONS_KEY  = 'sk_qu92tw0tCoYDRIEZHLmNAgJ8j9phHCE9';
var MAX_CACHED_IMAGES = 300;

// ─── shared IndexedDB promise ─────────────────────────────────
// Exposed on window so tts.js can reuse the same connection.
var DB_NAME    = 'jpStudy_db';
var DB_VERSION = 1;

window._jpStudyDB = new Promise(function(resolve, reject) {
  var req = indexedDB.open(DB_NAME, DB_VERSION);

  req.onupgradeneeded = function(e) {
    var db = e.target.result;
    if (!db.objectStoreNames.contains('images')) {
      var imgStore = db.createObjectStore('images', { keyPath: 'id' });
      imgStore.createIndex('ts', 'ts', { unique: false });
    }
    if (!db.objectStoreNames.contains('audio')) {
      var audStore = db.createObjectStore('audio', { keyPath: 'key' });
      audStore.createIndex('ts', 'ts', { unique: false });
    }
  };

  req.onsuccess = function(e) { resolve(e.target.result); };
  req.onerror   = function(e) { reject(e.target.error); };
});

// ─── in-memory layer ─────────────────────────────────────────
var _imgCache   = {};   // sentenceId → dataURL
var _imgIndex   = {};   // sentenceId → timestamp (LRU)
var _imgLoading = {};   // sentenceId → true (in-flight guard)

// ─── IDB helpers ─────────────────────────────────────────────

function _idbGet(sentenceId) {
  return window._jpStudyDB.then(function(db) {
    return new Promise(function(resolve) {
      var tx  = db.transaction('images', 'readonly');
      var req = tx.objectStore('images').get(sentenceId);
      req.onsuccess = function() { resolve(req.result || null); };
      req.onerror   = function() { resolve(null); };
    });
  }).catch(function() { return null; });
}

function _idbSet(sentenceId, dataUrl) {
  var ts = Date.now();
  _imgIndex[sentenceId] = ts;
  return window._jpStudyDB.then(function(db) {
    return new Promise(function(resolve) {
      var tx  = db.transaction('images', 'readwrite');
      tx.objectStore('images').put({ id: sentenceId, dataUrl: dataUrl, ts: ts });
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
  }).then(function() {
    return _evictIfNeeded();
  }).catch(function() {});
}

function _idbDelete(sentenceId) {
  return window._jpStudyDB.then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction('images', 'readwrite');
      tx.objectStore('images').delete(sentenceId);
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
  }).catch(function() {});
}

function _loadImgIndex() {
  window._jpStudyDB.then(function(db) {
    var tx  = db.transaction('images', 'readonly');
    var idx = tx.objectStore('images').index('ts');
    var req = idx.openCursor();
    req.onsuccess = function(e) {
      var cursor = e.target.result;
      if (cursor) {
        _imgIndex[cursor.value.id] = cursor.value.ts;
        cursor.continue();
      }
    };
  }).catch(function() {});
}

function _evictIfNeeded() {
  var ids = Object.keys(_imgIndex);
  if (ids.length <= MAX_CACHED_IMAGES) return Promise.resolve();
  ids.sort(function(a, b) { return _imgIndex[a] - _imgIndex[b]; });
  var toRemove = ids.slice(0, ids.length - MAX_CACHED_IMAGES);
  return toRemove.reduce(function(chain, id) {
    return chain.then(function() {
      delete _imgIndex[id];
      delete _imgCache[id];
      return _idbDelete(id);
    });
  }, Promise.resolve());
}

// ─── localStorage → IndexedDB migration ──────────────────────
// Runs once on first load after IndexedDB is ready.
function _migrateFromLocalStorage() {
  window._jpStudyDB.then(function() {
    try {
      var indexRaw = localStorage.getItem('jpStudy_img_index');
      if (!indexRaw) return;
      var oldIndex = JSON.parse(indexRaw);
      var ids = Object.keys(oldIndex);
      if (!ids.length) { localStorage.removeItem('jpStudy_img_index'); return; }

      console.log('[images] Migrating', ids.length, 'images localStorage → IndexedDB');
      ids.forEach(function(id) {
        var key    = 'jpStudy_img_' + id;
        var dataUrl = localStorage.getItem(key);
        if (dataUrl) {
          _idbSet(id, dataUrl).then(function() {
            try { localStorage.removeItem(key); } catch(e) {}
          });
        }
      });
      localStorage.removeItem('jpStudy_img_index');
    } catch(e) {}
  });
}

// ─── helpers ─────────────────────────────────────────────────

function isImageGenEnabled() {
  var d = (typeof decks !== 'undefined' && typeof currentDeckId !== 'undefined')
    ? decks[currentDeckId] : null;
  return !!(d && d.imageGenEnabled);
}

function _seedFromId(id) {
  var hash = 0, str = String(id);
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100000;
}

function _imageSize() {
  return window.innerWidth <= 600
    ? { w: 360, h: 280 }
    : { w: 520, h: 300 };
}

function _buildPrimaryUrl(sentence) {
  var size   = _imageSize();
  var prompt = 'Ghibli style: ' + (sentence.en || sentence.jp);
  var seed   = _seedFromId(sentence.id);
  return 'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(prompt) +
    '?model=flux&width=' + size.w + '&height=' + size.h +
    '&seed=' + seed + '&nologo=true&enhance=true&token=' + POLLINATIONS_KEY;
}

function _buildFallbackUrl(sentence) {
  var size   = _imageSize();
  var prompt = 'Ghibli style: ' + (sentence.en || sentence.jp);
  var seed   = _seedFromId(sentence.id);
  return 'https://gen.pollinations.ai/image/' +
    encodeURIComponent(prompt) +
    '?model=flux&width=' + size.w + '&height=' + size.h +
    '&seed=' + seed + '&enhance=true&key=' + POLLINATIONS_KEY;
}

// ─── placeholder helpers ──────────────────────────────────────

function _setPlaceholderText(el, text) {
  var span = el.querySelector('.card-image-placeholder span');
  if (span) span.textContent = text;
}

function _currentSentenceId(el) {
  return el.getAttribute('data-sentence-id');
}

function _clearImgs(el) {
  var imgs = el.querySelectorAll('img');
  for (var i = 0; i < imgs.length; i++) imgs[i].remove();
}

// ─── core update ─────────────────────────────────────────────

function updateCardImage(sentence) {
  var el = document.getElementById('cardImage');
  if (!el) return;

  var prevId = _currentSentenceId(el);
  if (prevId) delete _imgLoading[prevId];

  el.classList.remove('loaded');
  _clearImgs(el);
  el.removeAttribute('data-sentence-id');
  _setPlaceholderText(el, '絵');

  if (!sentence || !isImageGenEnabled()) return;

  var sid = String(sentence.id);

  // Memory hit — instant
  if (_imgCache[sid]) {
    _imgIndex[sid] = Date.now();
    _displayDataUrl(el, _imgCache[sid], sid);
    return;
  }

  // IDB read (fast, usually <5ms)
  _setPlaceholderText(el, '...');
  el.setAttribute('data-sentence-id', sid); // set early so navigation guard works

  _idbGet(sid).then(function(record) {
    if (_currentSentenceId(el) !== sid) return; // navigated away

    if (record && record.dataUrl) {
      _imgCache[sid] = record.dataUrl;
      _idbSet(sid, record.dataUrl); // touch LRU timestamp
      _clearImgs(el);
      _displayDataUrl(el, record.dataUrl, sid);
      return;
    }

    // Cache miss — fetch from network
    if (_imgLoading[sid]) return;
    _fetchImage(el, sentence, _buildPrimaryUrl(sentence), 'primary', 0);
  });
}

function _displayDataUrl(el, dataUrl, sentenceId) {
  el.setAttribute('data-sentence-id', sentenceId);
  _setPlaceholderText(el, '絵');

  var img = document.createElement('img');
  img.alt = '';
  img.onload = function() {
    if (_currentSentenceId(el) !== sentenceId) return;
    el.classList.add('loaded');
  };
  el.appendChild(img);
  img.src = dataUrl;
}

// ─── fetch → blob → dataURL → IDB → display ──────────────────

function _fetchImage(el, sentence, url, endpoint, retryCount) {
  var sid = String(sentence.id);
  el.setAttribute('data-sentence-id', sid);
  _imgLoading[sid] = true;

  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timeoutId  = setTimeout(function() {
    if (!_imgLoading[sid]) return;
    if (controller) controller.abort();
    handleError(new Error('timeout'));
  }, 45000);

  function handleError(err) {
    clearTimeout(timeoutId);
    delete _imgLoading[sid];
    if (_currentSentenceId(el) !== sid) return;

    if (endpoint === 'primary' && retryCount < 1) {
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== sid) return;
        _fetchImage(el, sentence, _buildPrimaryUrl(sentence), 'primary', retryCount + 1);
      }, 3000);
    } else if (endpoint !== 'fallback') {
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== sid) return;
        _fetchImage(el, sentence, _buildFallbackUrl(sentence), 'fallback', 0);
      }, 2000);
    } else if (endpoint === 'fallback' && retryCount < 1) {
      _setPlaceholderText(el, '...');
      setTimeout(function() {
        if (_currentSentenceId(el) !== sid) return;
        _fetchImage(el, sentence, _buildFallbackUrl(sentence), 'fallback', retryCount + 1);
      }, 5000);
    } else {
      _setPlaceholderText(el, '✕');
    }
  }

  var fetchOpts = controller ? { signal: controller.signal } : {};

  fetch(url, fetchOpts)
    .then(function(response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.blob();
    })
    .then(function(blob) {
      return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onloadend = function() { resolve(reader.result); };
        reader.onerror   = reject;
        reader.readAsDataURL(blob);
      });
    })
    .then(function(dataUrl) {
      clearTimeout(timeoutId);
      delete _imgLoading[sid];

      // Always cache even if user navigated away
      _imgCache[sid] = dataUrl;
      _idbSet(sid, dataUrl);

      if (_currentSentenceId(el) !== sid) return;
      _clearImgs(el);
      _displayDataUrl(el, dataUrl, sid);
    })
    .catch(function(err) {
      if (err && err.name === 'AbortError') return;
      handleError(err);
    });
}

// ─── prefetch next card ───────────────────────────────────────

function prefetchCardImage(sentence) {
  if (!sentence || !isImageGenEnabled()) return;
  var sid = String(sentence.id);
  if (_imgCache[sid] || _imgLoading[sid]) return;

  _idbGet(sid).then(function(record) {
    if (record && record.dataUrl) {
      _imgCache[sid] = record.dataUrl;
      return;
    }
    _imgLoading[sid] = true;
    fetch(_buildPrimaryUrl(sentence))
      .then(function(r) { return r.ok ? r.blob() : Promise.reject(r.status); })
      .then(function(blob) {
        return new Promise(function(resolve, reject) {
          var reader = new FileReader();
          reader.onloadend = function() { resolve(reader.result); };
          reader.onerror   = reject;
          reader.readAsDataURL(blob);
        });
      })
      .then(function(dataUrl) {
        delete _imgLoading[sid];
        _imgCache[sid] = dataUrl;
        _idbSet(sid, dataUrl);
      })
      .catch(function() { delete _imgLoading[sid]; });
  });
}

// ─── toggle ───────────────────────────────────────────────────

function toggleImageGen(deckId) {
  var d = decks[deckId];
  if (!d) return;
  d.imageGenEnabled = !d.imageGenEnabled;
  if (typeof saveDeck === 'function') saveDeck(deckId);
  if (typeof updateDeckUI === 'function') updateDeckUI();
  if (deckId === currentDeckId && typeof render === 'function') render();
}

// ─── tab visibility: retry stalled loads ─────────────────────

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  if (!isImageGenEnabled()) return;
  var el = document.getElementById('cardImage');
  if (!el || el.classList.contains('loaded')) return;
  var sid = _currentSentenceId(el);
  if (!sid || _imgLoading[sid]) return;

  if (_imgCache[sid]) { _displayDataUrl(el, _imgCache[sid], sid); return; }

  _idbGet(sid).then(function(record) {
    if (record && record.dataUrl) {
      _imgCache[sid] = record.dataUrl;
      _displayDataUrl(el, record.dataUrl, sid);
      return;
    }
    if (typeof sentences !== 'undefined') {
      for (var i = 0; i < sentences.length; i++) {
        if (String(sentences[i].id) === sid) {
          _setPlaceholderText(el, '...');
          _fetchImage(el, sentences[i], _buildPrimaryUrl(sentences[i]), 'primary', 0);
          return;
        }
      }
    }
  });
});

// ─── init ─────────────────────────────────────────────────────
_loadImgIndex();
_migrateFromLocalStorage();
