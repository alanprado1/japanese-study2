/* ============================================================
   積む — storyreader.js
   Phase 4 Session C: Full story reader implementation

   Load order: 7th — after storybuilder.js, before app.js

   Audio architecture:
   ─ Page button:    speakJP(allPageText, pageBtn) — identical to every
                     other audio button in the app. speakJP handles
                     play / pause / resume / stop natively.
   ─ Segment button: speakJP(segText, segBtn) — same pattern.
   ─ Navigation:     stopAudio() — tts.js hard-stop used on page change.
   No custom polling, no custom state flags, no race conditions.

   Image architecture:
   ─ Tries IDB first (pre-generated during story creation).
   ─ Falls back to direct Pollinations URL (deterministic seed) so images
     always show even if deck image-gen was off at generation time.
   ============================================================ */

// ─── Swipe state (no audio state — speakJP owns that) ─────────
var _srSwipeStartX = 0;
var _srSwipeStartY = 0;
var _srSwipeDir    = null;   // 'h' | 'v' | null
var _srSwipeWired  = false;  // prevent double-wiring

// ─── Page reflow ──────────────────────────────────────────────
// charsPerPage setting → max cells per reader page:
//   short  (≤80)  → 2 cells
//   medium (≤120) → 3 cells
//   long   (≥200) → 5 cells
// totalPages tells Gemini how much to write; reader pages are derived here.
var _srPages   = null;
var _srPagesId = null;

function _srMaxCells(story) {
  var c = story && story.settings && story.settings.charsPerPage;
  if (!c || c >= 200) return 5;
  if (c >= 120)       return 3;
  return 2;
}

function _srBuildPages(story) {
  var max  = _srMaxCells(story);
  var out  = [];
  for (var pi = 0; pi < story.pages.length; pi++) {
    var segs  = story.pages[pi].segments || [];
    var cells = _srSliceCells(segs);
    for (var ci = 0; ci < cells.length; ci += max) {
      out.push({ cells: cells.slice(ci, ci + max), srcPageIdx: pi });
    }
  }
  return out.length ? out : null;
}

// ─── Open the reader ──────────────────────────────────────────
function openStoryReader(story) {
  if (!story || !story.pages || !story.pages.length) return;

  currentStory   = story;
  currentPageIdx = 0;
  _srStopAudio();

  // Build cell-capped pages once per story
  if (_srPagesId !== story.id) {
    _srPages   = _srBuildPages(story);
    _srPagesId = story.id;
  }

  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  // Pre-fetch page 0 background before render so it arrives ASAP
  var _p0key = story.id + '_p0';
  if (typeof _imgCache === 'undefined' || !_imgCache[_p0key]) {
    var _applyP0 = function(dataUrl) {
      var ov = document.getElementById('storyReaderOverlay');
      if (ov && ov.getAttribute('data-sr-bg-key') === _p0key) {
        ov.style.backgroundImage = 'url(' + dataUrl + ')';
        ov.classList.add('sr-has-bg');
      }
    };
    var _fetchP0 = function() { _srBgFetch(_p0key, _srBuildPrompt(story, 0), _applyP0); };
    if (typeof _idbGet === 'function') {
      _idbGet(_p0key).then(function(rec) {
        if (rec) {
          var url = typeof rec === 'string' ? rec : (rec && rec.dataUrl);
          if (url) { if (typeof _imgCache !== 'undefined') _imgCache[_p0key] = url; _applyP0(url); return; }
        }
        _fetchP0();
      }).catch(_fetchP0);
    } else { _fetchP0(); }
  }

  _srRenderPage();

  if (!_srSwipeWired) {
    _srWireSwipe(overlay);
    _srSwipeWired = true;
  }
}

// ─── Close the reader ─────────────────────────────────────────
function closeStoryReader() {
  _srStopAudio();
  _srUnmountFontControls();
  currentStory   = null;
  currentPageIdx = 0;
  _srPages       = null;
  _srPagesId     = null;
  var overlay = document.getElementById('storyReaderOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ─── Navigate pages ───────────────────────────────────────────
function _srGoTo(idx) {
  if (!currentStory) return;
  var total = _srPages ? _srPages.length : currentStory.pages.length;
  if (idx < 0 || idx >= total) return;
  _srStopAudio();
  currentPageIdx = idx;
  _srRenderPage();
}

// ─── Stop audio — delegates entirely to tts.js stopAudio() ────
// stopAudio() resets: currentAudio, currentGain, isSpeaking, isPaused,
// playToken, _listAudioBtn (and resets that button's innerHTML to ▶).
// This correctly handles both page-level and segment-level audio.
function _srStopAudio() {
  if (typeof stopAudio === 'function') stopAudio();
}

// ─── Render a single page ─────────────────────────────────────
function _srRenderPage() {
  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay || !currentStory) return;

  var story    = currentStory;
  var pageIdx  = currentPageIdx;

  // Use reflowed pages if available
  var rPage    = _srPages ? _srPages[pageIdx] : null;
  var total    = _srPages ? _srPages.length : story.pages.length;
  var bgIdx    = rPage ? rPage.srcPageIdx : pageIdx;
  var cells    = rPage ? rPage.cells : null;

  // Fallback: raw page segments → slice on the fly
  if (!cells) {
    var rawPage  = story.pages[pageIdx];
    var segments = rawPage ? rawPage.segments : [];
    cells = _srSliceCells(segments);
  }

  var isFirst  = pageIdx === 0;
  var isLast   = pageIdx === total - 1;

  // ── Background image ───────────────────────────────────────
  _srSetBackground(overlay, story, bgIdx);

  // ── Title block — page 0 only ──────────────────────────────
  var titleHTML = '';
  if (isFirst) {
    titleHTML =
      '<div class="sr-title-block">' +
        '<div class="sr-title-ja">' + _srEsc(story.title   || '') + '</div>' +
        '<div class="sr-title-en">' + _srEsc(story.titleEn || '') + '</div>' +
      '</div>';
  }

  // ── Nav bar ────────────────────────────────────────────────
  var prevDis = isFirst ? ' disabled' : '';
  var nextDis = isLast  ? ' disabled' : '';
  var navHTML =
    '<div class="sr-nav">' +
      '<button class="sr-nav-btn" onclick="_srGoTo(' + (pageIdx - 1) + ')"' + prevDis + '>← Prev</button>' +
      '<div class="sr-page-counter">' + (pageIdx + 1) + ' / ' + total + '</div>' +
      '<button class="sr-nav-btn" onclick="_srGoTo(' + (pageIdx + 1) + ')"' + nextDis + '>Next →</button>' +
    '</div>';

  // ── Story cells ────────────────────────────────────────────
  var bodyHTML = '<div class="sr-story-body">';
  for (var i = 0; i < cells.length; i++) {
    bodyHTML += _srRenderCell(cells[i]);
  }
  bodyHTML += '</div>';

  // ── Bottom bar: play icon + furigana toggle + translate button ───
  // ICON_PLAY is defined in tts.js (loaded before storyreader.js).
  // Using the same SVG var means the button always looks like the icon —
  // no "Play page" text flash on navigation; speakJP overwrites with
  // ICON_PAUSE when playing, restores ICON_PLAY / &#9654; on stop.
  var furActive = (typeof showFurigana !== 'undefined' && showFurigana) ? ' active' : '';
  var trActive  = _srShowTranslation ? ' active' : '';
  var playIcon  = (typeof ICON_PLAY !== 'undefined') ? ICON_PLAY : '&#9654;';

  var bottomHTML =
    '<div class="sr-bottom-bar">' +
      '<button class="sr-bar-btn' + furActive + '" ' +
        'onclick="_srToggleFurigana()" title="Toggle furigana">振</button>' +
      '<button class="sr-page-audio-btn" id="srPageAudioBtn" ' +
        'onclick="_srTogglePageAudio(this)" title="Play / pause whole page">' +
        playIcon +
      '</button>' +
      '<button class="sr-bar-btn' + trActive + '" id="srTranslBtn" ' +
        'onclick="_srToggleTranslation()" title="Toggle translation">訳</button>' +
    '</div>';

  // ── Translation column — one item per CELL ───────────────────
  // Anchor cells: look up English from sentences[] (instant).
  // Filler/mixed cells: show the cell text for async MyMemory translation.
  var translHTML = '<div class="sr-transl-col">';
  for (var ti = 0; ti < cells.length; ti++) {
    var cell = cells[ti];
    var cellEnText = '';
    // Try to find English for the first anchor sentence in this cell
    if (cell.anchorIds.length > 0 && typeof sentences !== 'undefined') {
      for (var si = 0; si < sentences.length; si++) {
        if (String(sentences[si].id) === String(cell.anchorIds[0])) {
          cellEnText = sentences[si].en || '';
          break;
        }
      }
    }
    var hasEn  = cellEnText.length > 0;
    var safeJP = !hasEn ? cell.text.replace(/"/g, '&quot;') : '';
    translHTML +=
      '<div class="sr-transl-item' + (!hasEn ? ' sr-transl-filler' : '') + '"' +
        (safeJP ? ' data-sr-jp="' + safeJP + '"' : '') + '>' +
        (hasEn ? _srEsc(cellEnText) : '…') +
      '</div>';
  }
  translHTML += '</div>';

  // ── Close button only — font btn/panel live on body (see _srMountFontControls) ──
  var closeHTML =
    '<button class="sr-close-btn" onclick="closeStoryReader()" title="Close (Esc)">✕</button>';

  // ── Assemble ───────────────────────────────────────────────
  overlay.innerHTML =
    closeHTML +
    titleHTML +
    '<div class="sr-content">' +
      navHTML +
      '<div class="sr-body-row">' +
        bodyHTML +
        translHTML +
      '</div>' +
      bottomHTML +
    '</div>';

  // ── Mount font controls on body (outside overlay stacking context) ──
  _srMountFontControls();

  // ── Restore translation visibility after re-render ───────────
  if (_srShowTranslation) {
    var _content = document.querySelector('#storyReaderOverlay .sr-content');
    if (_content) _content.classList.add('sr-show-translation');
    _srFetchFillerTranslations();
  }

  // ── Prefetch this page's audio ─────────────────────────────
  if (typeof prefetchJP === 'function') {
    var _prefetchText = cells
      .map(function(c) { return c.text.trim(); })
      .filter(function(t) { return t.length > 0; })
      .join('\u3002');
    if (_prefetchText) prefetchJP(_prefetchText);
  }

  // ── Prefetch next page's background image ─────────────────
  // Starts fetching page N+1's illustration in the background so it's
  // ready in _imgCache when the user navigates — no waiting at all.
  if (!isLast) {
    var nextRPage = _srPages ? _srPages[pageIdx + 1] : null;
    var nextBgIdx = nextRPage ? nextRPage.srcPageIdx : pageIdx + 1;
    _srPrefetchBackground(story, nextBgIdx);
  }
}

// ─── Slice segments into short audio cells ───────────────────
//
// APPROACH: flatten all segments into an annotated char stream
// (each char tagged anchor|filler), then slice into ~15-char cells
// at natural Japanese break points (。！？ first, 、 as fallback).
//
// This produces 7-9 cells per page with ~15 chars each — short enough
// for comfortable per-cell audio playback. The slice order faithfully
// follows Gemini's narrative sequence, so anchor and filler text
// appears interleaved exactly as generated (never rearranged).
//
// Each cell is styled based on its dominant content type:
//   sr-seg-anchor  → cell is entirely / mostly anchor text
//   sr-seg-filler  → cell is entirely / mostly filler text
//   sr-seg-mixed   → cell spans an anchor↔filler boundary
//
// Returns an array of cell objects:
//   { text, dominant, anchorChars, fillerChars, anchorSegIds }
//
var _SR_TARGET_CHARS  = 20;   // ideal cell length → ~6 cells per 120-char page
var _SR_MAX_CHARS     = 32;   // hard ceiling before forced break
var _SR_MIN_SENTENCE  = 15;   // minimum chars before a sentence-end triggers a break
var _SR_SENTENCE_END  = { '。':1, '！':1, '？':1, '…':1 };
var _SR_CLAUSE_BREAK  = { '、':1, '，':1 };

function _srSliceCells(segs) {
  // Build annotated char stream: [{ch, type, segIdx}]
  var stream = [];
  for (var si = 0; si < segs.length; si++) {
    var text = segs[si].text;
    for (var ci = 0; ci < text.length; ci++) {
      stream.push({ ch: text[ci], type: segs[si].type, segIdx: si });
    }
  }

  var cells = [];
  var pos   = 0;
  var n     = stream.length;

  while (pos < n) {
    var start      = pos;
    var bestBreak  = -1;   // last good break index (exclusive end)
    var hardEnd    = Math.min(pos + _SR_MAX_CHARS, n);

    for (var j = pos; j < hardEnd; j++) {
      var ch    = stream[j].ch;
      var count = j - start + 1;

      if (_SR_SENTENCE_END[ch]) {
        bestBreak = j + 1;
        if (count >= _SR_MIN_SENTENCE) break;  // natural sentence end → stop
        // Very short sentence (< 10 chars) → record but keep going
      } else if (_SR_CLAUSE_BREAK[ch] && count >= _SR_TARGET_CHARS) {
        bestBreak = j + 1;
        break;
      }
    }

    var end = (bestBreak > start) ? bestBreak : hardEnd;

    // Extract cell chars
    var cellChars = stream.slice(start, end);
    var cellText  = cellChars.map(function(t){ return t.ch; }).join('');

    // Count anchor vs filler chars
    var aCnt = 0, fCnt = 0;
    for (var k = 0; k < cellChars.length; k++) {
      if (cellChars[k].type === 'anchor') aCnt++; else fCnt++;
    }

    // Collect anchor sentenceIds in this cell for translation lookup
    var anchorIds = [];
    var seenIds   = {};
    for (var k = 0; k < cellChars.length; k++) {
      var sIdx = cellChars[k].segIdx;
      if (cellChars[k].type === 'anchor' && segs[sIdx].sentenceId && !seenIds[sIdx]) {
        seenIds[sIdx] = true;
        anchorIds.push(segs[sIdx].sentenceId);
      }
    }

    var dominant = aCnt > fCnt ? 'anchor' : (fCnt > aCnt ? 'filler' : 'mixed');

    // Build runs: consecutive same-type chars → [{text, type}]
    // Used by _srRenderCell to wrap anchor/filler text in separate spans.
    var runs = [];
    if (cellChars.length) {
      var rType = cellChars[0].type;
      var rText = cellChars[0].ch;
      for (var r = 1; r < cellChars.length; r++) {
        if (cellChars[r].type === rType) {
          rText += cellChars[r].ch;
        } else {
          runs.push({ text: rText, type: rType });
          rType = cellChars[r].type;
          rText = cellChars[r].ch;
        }
      }
      runs.push({ text: rText, type: rType });
    }

    cells.push({
      text:        cellText,
      dominant:    dominant,
      anchorChars: aCnt,
      fillerChars: fCnt,
      anchorIds:   anchorIds,
      runs:        runs
    });

    pos = end;
  }

  return cells;
}

// ─── Render one cell ─────────────────────────────────────────
// Each run is a <span> — anchor runs get font-weight:700 via .sr-run-anchor,
// filler runs get normal weight + slight opacity via .sr-run-filler.
// buildJPHTML is called per run so furigana applies correctly within each span.
function _srRenderCell(cell) {
  var cls = 'sr-seg sr-seg-' + cell.dominant;

  var innerText;
  if (cell.runs && cell.runs.length > 1) {
    // Multiple runs: wrap each in a typed span
    innerText = '';
    for (var ri = 0; ri < cell.runs.length; ri++) {
      var run    = cell.runs[ri];
      var rClass = run.type === 'anchor' ? 'sr-run-anchor' : 'sr-run-filler';
      var rHTML  = (typeof buildJPHTML === 'function')
        ? buildJPHTML(run.text)
        : _srEsc(run.text);
      innerText += '<span class="' + rClass + '">' + rHTML + '</span>';
    }
  } else if (cell.runs && cell.runs.length === 1) {
    // Single run: still wrap for consistent weight
    var rClass = cell.runs[0].type === 'anchor' ? 'sr-run-anchor' : 'sr-run-filler';
    var rHTML  = (typeof buildJPHTML === 'function')
      ? buildJPHTML(cell.runs[0].text)
      : _srEsc(cell.runs[0].text);
    innerText = '<span class="' + rClass + '">' + rHTML + '</span>';
  } else {
    // Fallback: no runs data
    innerText = (typeof buildJPHTML === 'function')
      ? buildJPHTML(cell.text)
      : _srEsc(cell.text);
  }

  var safeText = cell.text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  var audioBtn =
    '<button class="sr-seg-audio-btn" ' +
      'onclick="event.stopPropagation();_srPlaySegment(\'' + safeText + '\',this)" ' +
      'title="Play">&#9654;</button>';

  return (
    '<div class="' + cls + '">' +
      '<div class="sr-seg-text">' + innerText + '</div>' +
      audioBtn +
    '</div>'
  );
}

// ─── Background image ─────────────────────────────────────────
// Loads a Ghibli illustration for each story page.
//
// Cache hierarchy (fastest → slowest):
//   1. _imgCache[key]   in-memory, instant
//   2. _idbGet(key)     IndexedDB, survives refresh
//   3. fetch pipeline   primary URL → retry → fallback URL
//      Identical to _fetchImage() in images.js (proven working).
//
// Errors are logged to console only — no visible toast (the retry
// and fallback logic handles transient failures silently).

// ── Shared helpers used by both _srSetBackground and _srPrefetchBackground ─

function _srBuildPrompt(story, pageIdx) {
  var parts = [];
  if (story.titleEn) parts.push(story.titleEn);
  var page = story.pages && story.pages[pageIdx];
  if (page && page.segments) {
    for (var i = 0; i < page.segments.length; i++) {
      var seg = page.segments[i];
      if (seg.type === 'anchor' && seg.sentenceId &&
          typeof sentences !== 'undefined') {
        for (var si = 0; si < sentences.length; si++) {
          if (String(sentences[si].id) === String(seg.sentenceId)) {
            if (sentences[si].en) parts.push(sentences[si].en);
            break;
          }
        }
      }
    }
  }
  var scene = parts.join('. ').trim().slice(0, 200);
  return 'Ghibli style: ' + (scene || (story.titleEn || story.title || 'peaceful Japanese scene'));
}

function _srBgDim(px) { return Math.round(Math.min(px, 1024) / 8) * 8; }

function _srBgPrimaryUrl(idbKey, prompt) {
  var seed = (typeof _seedFromId === 'function') ? _seedFromId(idbKey)
    : Math.abs(idbKey.split('').reduce(function(h,c){return((h<<5)-h)+c.charCodeAt(0)|0;},0)) % 100000;
  var key = (typeof POLLINATIONS_KEY !== 'undefined') ? POLLINATIONS_KEY : '';
  return 'https://gen.pollinations.ai/image/' + encodeURIComponent(prompt) +
    '?model=flux&width=' + _srBgDim(window.innerWidth) +
    '&height=' + _srBgDim(window.innerHeight) +
    '&seed=' + seed + '&enhance=true&key=' + key;
}

function _srBgFallbackUrl(idbKey, prompt) {
  var seed = (typeof _seedFromId === 'function') ? _seedFromId(idbKey)
    : Math.abs(idbKey.split('').reduce(function(h,c){return((h<<5)-h)+c.charCodeAt(0)|0;},0)) % 100000;
  var key = (typeof POLLINATIONS_KEY !== 'undefined') ? POLLINATIONS_KEY : '';
  return 'https://gen.pollinations.ai/image/' + encodeURIComponent(prompt) +
    '?model=flux&width=' + _srBgDim(window.innerWidth) +
    '&height=' + _srBgDim(window.innerHeight) +
    '&seed=' + seed + '&enhance=true&key=' + key;
}

// fetch → blob → dataURL → _imgCache + _idbSet → callback(dataUrl)
// Silent version (no overlay, no toast): used by prefetch.
// onDone(dataUrl) called on success; onDone(null) never called on failure.
function _srBgFetch(idbKey, prompt, onDone) {
  function tryFetch(url, endpoint, retryCount) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function() { if (controller) controller.abort(); }, 45000);

    function onError(err) {
      clearTimeout(timer);
      var msg = (err && err.message) ? err.message : String(err);
      console.warn('[sr-bg]', idbKey, endpoint, retryCount, msg);
      if (endpoint === 'primary' && retryCount < 1) {
        setTimeout(function() { tryFetch(_srBgPrimaryUrl(idbKey, prompt), 'primary', retryCount + 1); }, 3000);
      } else if (endpoint !== 'fallback') {
        setTimeout(function() { tryFetch(_srBgFallbackUrl(idbKey, prompt), 'fallback', 0); }, 2000);
      } else if (retryCount < 1) {
        setTimeout(function() { tryFetch(_srBgFallbackUrl(idbKey, prompt), 'fallback', 1); }, 5000);
      }
      // else: give up silently
    }

    fetch(url, controller ? { signal: controller.signal } : {})
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
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
        clearTimeout(timer);
        if (typeof _imgCache !== 'undefined') _imgCache[idbKey] = dataUrl;
        if (typeof _idbSet   === 'function')  _idbSet(idbKey, dataUrl);
        onDone(dataUrl);
      })
      .catch(function(err) {
        if (err && err.name === 'AbortError') return;
        onError(err);
      });
  }
  tryFetch(_srBgPrimaryUrl(idbKey, prompt), 'primary', 0);
}

// ── Set overlay background for the current page ────────────────
function _srSetBackground(overlay, story, pageIdx) {
  overlay.style.backgroundImage = '';
  overlay.classList.remove('sr-has-bg');

  var idbKey = story.id + '_p' + pageIdx;

  // Navigation guard — stamp overlay with key, check before applying
  overlay.setAttribute('data-sr-bg-key', idbKey);
  function isCurrent() { return overlay.getAttribute('data-sr-bg-key') === idbKey; }

  function applyDataUrl(dataUrl) {
    if (!isCurrent()) return;
    overlay.style.backgroundImage = 'url(' + dataUrl + ')';
    overlay.classList.add('sr-has-bg');
    console.log('[sr-bg] ✓', idbKey);
  }

  // 1. In-memory hit
  if (typeof _imgCache !== 'undefined' && _imgCache[idbKey]) {
    applyDataUrl(_imgCache[idbKey]);
    return;
  }

  // 2. IDB hit
  if (typeof _idbGet === 'function') {
    _idbGet(idbKey).then(function(record) {
      if (!isCurrent()) return;
      if (record) {
        var dataUrl = typeof record === 'string' ? record : (record && record.dataUrl);
        if (dataUrl) {
          if (typeof _imgCache !== 'undefined') _imgCache[idbKey] = dataUrl;
          applyDataUrl(dataUrl);
          return;
        }
      }
      // 3. Network fetch — uses shared _srBgFetch
      _srBgFetch(idbKey, _srBuildPrompt(story, pageIdx), function(dataUrl) {
        applyDataUrl(dataUrl);
      });
    }).catch(function() {
      if (isCurrent()) {
        _srBgFetch(idbKey, _srBuildPrompt(story, pageIdx), function(dataUrl) {
          applyDataUrl(dataUrl);
        });
      }
    });
  } else {
    _srBgFetch(idbKey, _srBuildPrompt(story, pageIdx), function(dataUrl) {
      applyDataUrl(dataUrl);
    });
  }
}

// ── Prefetch the next page's background image silently ─────────
// Called after rendering page N so page N+1's image is in _imgCache
// by the time the user navigates. Mirrors prefetchCardImage() in images.js.
// In-flight guard uses _imgCache to avoid duplicate requests.
function _srPrefetchBackground(story, pageIdx) {
  var idbKey = story.id + '_p' + pageIdx;

  // Skip if already cached in memory
  if (typeof _imgCache !== 'undefined' && _imgCache[idbKey]) {
    console.log('[sr-bg] prefetch: already in memory', idbKey);
    return;
  }

  // Check IDB first; on miss, fetch silently
  if (typeof _idbGet === 'function') {
    _idbGet(idbKey).then(function(record) {
      if (record) {
        var dataUrl = typeof record === 'string' ? record : (record && record.dataUrl);
        if (dataUrl) {
          if (typeof _imgCache !== 'undefined') _imgCache[idbKey] = dataUrl;
          console.log('[sr-bg] prefetch: IDB hit', idbKey);
          return;
        }
      }
      console.log('[sr-bg] prefetch: fetching', idbKey);
      _srBgFetch(idbKey, _srBuildPrompt(story, pageIdx), function() {
        console.log('[sr-bg] prefetch: cached', idbKey);
      });
    }).catch(function() {
      _srBgFetch(idbKey, _srBuildPrompt(story, pageIdx), function() {});
    });
  } else {
    _srBgFetch(idbKey, _srBuildPrompt(story, pageIdx), function() {});
  }
}


// ─── Font controls — mounted on document.body ─────────────────
// By living on body (outside #storyReaderOverlay), the font btn and panel
// are in the root stacking context. z-index:410 places them above the
// overlay (z-index:400). The overlay's > * { position:relative } rule
// CANNOT affect them here. Shown/hidden via _srMountFontControls().

// Outside-click listener reference — stored so we can remove it on unmount.
var _srFontOutsideClickHandler = null;

function _srMountFontControls() {
  // Remove any previous instance (page re-render)
  var old = document.getElementById('srFontBtn');
  if (old) old.remove();
  var oldP = document.getElementById('srFontPanel');
  if (oldP) oldP.remove();
  if (_srFontOutsideClickHandler) {
    document.removeEventListener('click', _srFontOutsideClickHandler, true);
    _srFontOutsideClickHandler = null;
  }

  var curSize = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--sr-jp-size') || '1.4'
  );

  var btn = document.createElement('button');
  btn.id = 'srFontBtn';
  btn.className = 'sr-font-btn';
  btn.title = 'Font size';
  btn.textContent = 'A';
  document.body.appendChild(btn);

  var panel = document.createElement('div');
  panel.id = 'srFontPanel';
  panel.className = 'sr-font-panel';
  panel.innerHTML =
    '<label>FONT SIZE</label>' +
    '<input type="range" min="0.8" max="2.4" step="0.1" value="' + curSize.toFixed(1) + '" ' +
      'oninput="_srSetFontSize(this.value)">' +
    '<span class="sr-font-val" id="srFontVal">' + curSize.toFixed(1) + 'rem</span>';
  document.body.appendChild(panel);

  // Toggle on btn click — stopPropagation prevents the outside-click handler
  // from immediately closing the panel on the same click that opens it.
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    panel.classList.toggle('open');
  });

  // Outside-click: close panel when clicking anywhere outside btn or panel.
  // Uses capture phase so it fires before any other handlers.
  _srFontOutsideClickHandler = function(e) {
    if (panel.classList.contains('open') &&
        !btn.contains(e.target) &&
        !panel.contains(e.target)) {
      panel.classList.remove('open');
    }
  };
  document.addEventListener('click', _srFontOutsideClickHandler, true);
}

function _srUnmountFontControls() {
  if (_srFontOutsideClickHandler) {
    document.removeEventListener('click', _srFontOutsideClickHandler, true);
    _srFontOutsideClickHandler = null;
  }
  var btn = document.getElementById('srFontBtn');
  if (btn) btn.remove();
  var panel = document.getElementById('srFontPanel');
  if (panel) panel.remove();
}

function _srToggleFontPanel() {
  var panel = document.getElementById('srFontPanel');
  if (panel) panel.classList.toggle('open');
}

function _srSetFontSize(val) {
  var rem = parseFloat(val).toFixed(1);
  document.documentElement.style.setProperty('--sr-jp-size', rem + 'rem');
  var label = document.getElementById('srFontVal');
  if (label) label.textContent = rem + 'rem';
  try { localStorage.setItem('jpStudy_srJpSize', rem + 'rem'); } catch(e) {}
}

// ─── Furigana toggle ──────────────────────────────────────────
// Flips showFurigana (global from app.js) and re-renders the current page
// so segments immediately show/hide ruby text. Active state on button
// is baked into bottomHTML at render time via furActive class.
function _srToggleFurigana() {
  if (typeof showFurigana !== 'undefined') {
    showFurigana = !showFurigana;
    try { localStorage.setItem('jpStudy_furigana', showFurigana); } catch(e) {}
  }
  _srRenderPage();
}

// ─── Translation toggle ────────────────────────────────────────
// Shows/hides the .sr-transl-col side panel next to each page.
// Anchor translations come from sentences[] (instant).
// Filler translations are fetched from MyMemory API (free, no key needed)
// and cached in _srTranslCache so switching pages doesn't re-fetch.
var _srShowTranslation = false;
var _srTranslCache = {};  // jp text → translated English string

function _srToggleTranslation() {
  _srShowTranslation = !_srShowTranslation;
  var content = document.querySelector('#storyReaderOverlay .sr-content');
  if (content) {
    content.classList.toggle('sr-show-translation', _srShowTranslation);
  }
  // Update the button active state
  var btn = document.getElementById('srTranslBtn');
  if (btn) btn.classList.toggle('active', _srShowTranslation);

  // When turning ON: fetch any unfilled filler translations
  if (_srShowTranslation) _srFetchFillerTranslations();
}

// Fetch translations for filler items in the side translation column.
// Uses MyMemory free API — no key, 500 words/day free.
function _srFetchFillerTranslations() {
  var fillers = document.querySelectorAll(
    '#storyReaderOverlay .sr-transl-filler[data-sr-jp]'
  );
  fillers.forEach(function(el) {
    var jp = el.getAttribute('data-sr-jp');
    if (!jp) return;
    if (_srTranslCache[jp] !== undefined) {
      el.textContent = _srTranslCache[jp] || '—';
      return;
    }
    if (el.getAttribute('data-sr-fetching')) return;
    el.setAttribute('data-sr-fetching', '1');
    el.textContent = '…';
    var url = 'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(jp) + '&langpair=ja|en';
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var tr = (data && data.responseData && data.responseData.translatedText) || '—';
        _srTranslCache[jp] = tr;
        el.textContent = tr;
        el.removeAttribute('data-sr-fetching');
      })
      .catch(function() {
        _srTranslCache[jp] = '—';
        el.textContent = '—';
        el.removeAttribute('data-sr-fetching');
      });
  });
}

// ─── Page-level TTS ───────────────────────────────────────────
// Joins all segments into one string and hands the button to speakJP.
// speakJP natively handles: play → pause → resume → end → reset button.
// This is IDENTICAL in architecture to every other audio button in the app.
function _srTogglePageAudio(btn) {
  if (!btn) btn = document.getElementById('srPageAudioBtn');
  if (!btn || !currentStory || typeof speakJP !== 'function') return;

  var pageCells = _srPages
    ? (_srPages[currentPageIdx] ? _srPages[currentPageIdx].cells : [])
    : _srSliceCells((currentStory.pages[currentPageIdx] || {}).segments || []);

  if (!pageCells.length) return;

  var allText = pageCells
    .map(function(c) { return c.text.trim(); })
    .filter(function(t) { return t.length > 0; })
    .join('\u3002');

  if (!allText) return;
  speakJP(allText, btn).catch(function() {});
}

// ─── Per-segment TTS ──────────────────────────────────────────
// speakJP automatically stops whatever is currently playing (page or another
// segment) before starting this segment, via the "NEW play" path in speakJP.
function _srPlaySegment(text, btnEl) {
  if (typeof speakJP !== 'function') return;
  speakJP(text, btnEl).catch(function() {});
}

// ─── Swipe gesture wiring ─────────────────────────────────────
function _srWireSwipe(overlay) {
  overlay.addEventListener('touchstart', _srOnTouchStart, { passive: true });
  overlay.addEventListener('touchmove',  _srOnTouchMove,  { passive: true });
  overlay.addEventListener('touchend',   _srOnTouchEnd,   { passive: true });
}

function _srOnTouchStart(e) {
  if (e.touches.length !== 1) return;
  _srSwipeStartX = e.touches[0].clientX;
  _srSwipeStartY = e.touches[0].clientY;
  _srSwipeDir    = null;
}

function _srOnTouchMove(e) {
  if (!e.touches.length || _srSwipeDir) return;
  var dx = e.touches[0].clientX - _srSwipeStartX;
  var dy = e.touches[0].clientY - _srSwipeStartY;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
    _srSwipeDir = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
  }
}

function _srOnTouchEnd(e) {
  var t  = e.changedTouches[0];
  var dx = t.clientX - _srSwipeStartX;
  var dy = t.clientY - _srSwipeStartY;
  if (_srSwipeDir === 'h' && Math.abs(dx) > 50) {
    if (dx < 0) _srGoTo(currentPageIdx + 1);
    else         _srGoTo(currentPageIdx - 1);
  } else if (_srSwipeDir === 'v' && dy > 80) {
    closeStoryReader();
  }
  _srSwipeDir = null;
}

// ─── Keyboard ─────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  var overlay = document.getElementById('storyReaderOverlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (e.key === 'Escape')     closeStoryReader();
  if (e.key === 'ArrowRight') _srGoTo(currentPageIdx + 1);
  if (e.key === 'ArrowLeft')  _srGoTo(currentPageIdx - 1);
});

// ─── HTML escape ──────────────────────────────────────────────
function _srEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
