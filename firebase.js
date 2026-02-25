/* ============================================================
   積む — firebase.js  (load order: 0th / first)
   Firebase Auth + Firestore cloud sync
   ============================================================ */

var firebaseConfig = {
  apiKey:            "AIzaSyCGecVsmUAM6NFZ_dA483DSeP9t_GMrizE",
  authDomain:        "japanese-study-b420f.firebaseapp.com",
  projectId:         "japanese-study-b420f",
  storageBucket:     "japanese-study-b420f.firebasestorage.app",
  messagingSenderId: "102954502203",
  appId:             "1:102954502203:web:ec3422f0c796b17e01b41e"
};

var firebaseApp   = null;
var firebaseAuth  = null;
var firebaseDB    = null;
var currentUser   = null;
var firebaseReady = false;

// ─── init ────────────────────────────────────────────────────
function initFirebase() {
  try {
    firebaseApp  = firebase.initializeApp(firebaseConfig);
    firebaseAuth = firebase.auth();
    firebaseDB   = firebase.firestore();
    firebaseReady = true;

    // Fires immediately on page load if session is already active,
    // OR after a fresh sign-in. Always pull cloud data either way.
    firebaseAuth.onAuthStateChanged(function(user) {
      currentUser = user;
      updateAuthUI();

      if (user) {
        pullFromFirestore().then(function() {
          syncDeckToApp();
          render();
          updateDeckUI();
        }).catch(function(e) {
          console.warn('Pull failed:', e);
        });
      }
    });

  } catch(e) {
    console.warn('Firebase init failed — local-only mode.', e);
    firebaseReady = false;
  }
}

// ─── auth ────────────────────────────────────────────────────
function signInWithGoogle() {
  if (!firebaseReady) return;
  var provider = new firebase.auth.GoogleAuthProvider();
  firebaseAuth.signInWithPopup(provider).catch(function(err) {
    console.error('Sign in failed:', err);
    alert('Sign in failed: ' + err.message);
  });
}

function signOut() {
  if (!firebaseReady) return;
  firebaseAuth.signOut();
}

function updateAuthUI() {
  var btn      = document.getElementById('btnAuth');
  var userInfo = document.getElementById('userInfo');
  if (!btn) return;

  if (currentUser) {
    btn.textContent = 'Sign Out';
    btn.onclick     = signOut;
    if (userInfo) {
      userInfo.textContent   = currentUser.displayName || currentUser.email;
      userInfo.style.display = '';
    }
  } else {
    btn.textContent = '☁ Sync';
    btn.onclick     = signInWithGoogle;
    if (userInfo) userInfo.style.display = 'none';
  }
}

// ─── Firestore reference ─────────────────────────────────────
function userDoc() {
  if (!firebaseReady || !currentUser) return null;
  return firebaseDB.collection('users').doc(currentUser.uid);
}

// ─── push one deck up ────────────────────────────────────────
// Called from decks.js saveDeck() after every local change.
function pushDeckToFirestore(deckId) {
  var ref = userDoc();
  if (!ref) return Promise.resolve();

  var d = decks[deckId];
  if (!d) return Promise.resolve();

  // Make sure in-memory state is flushed into the deck object
  if (deckId === currentDeckId) syncAppToDeck();

  var meta = {};
  Object.keys(decks).forEach(function(id) {
    meta[id] = { name: decks[id].name };
  });

  var batch   = firebaseDB.batch();
  var deckRef = ref.collection('decks').doc(deckId);

  // Write top-level user doc (deck list + active deck)
  batch.set(ref, { deckList: meta, currentDeckId: currentDeckId }, { merge: true });

  // Write full deck data
  batch.set(deckRef, {
    name:       d.name,
    sentences:  d.sentences,
    srsData:    d.srsData,
    currentIdx: d.currentIdx
  });

  return batch.commit().catch(function(e) {
    console.warn('Firestore push failed:', e);
  });
}

function pushAllDecksToFirestore() {
  if (!userDoc()) return Promise.resolve();
  return Promise.all(Object.keys(decks).map(function(id) {
    return pushDeckToFirestore(id);
  }));
}

// Push ONLY the currentDeckId field — call this right after currentDeckId changes
function pushCurrentDeckId() {
  var ref = userDoc();
  if (!ref) return;
  ref.set({ currentDeckId: currentDeckId }, { merge: true }).catch(function(e) {
    console.warn('Firestore currentDeckId update failed:', e);
  });
}

// ─── delete one deck from Firestore ──────────────────────────
// Called by deleteDeck() in decks.js right after local removal.
// Must: (1) delete the deck Firestore doc, (2) overwrite (not merge)
// the deckList on the user doc so the deleted deck is gone from cloud.
function deleteDeckFromFirestore(deckId) {
  var ref = userDoc();
  if (!ref) return Promise.resolve();

  // Build the updated deck list — deck is already removed from local `decks`
  var meta = {};
  Object.keys(decks).forEach(function(id) {
    meta[id] = { name: decks[id].name };
  });

  var batch = firebaseDB.batch();

  // Overwrite the user doc with the new deckList — NOT merge, so deleted deck
  // key is fully removed from the cloud deckList field
  batch.set(ref, { deckList: meta, currentDeckId: currentDeckId });

  // Delete the deck's own Firestore document
  batch.delete(ref.collection('decks').doc(deckId));

  return batch.commit().catch(function(e) {
    console.warn('Firestore deck delete failed:', e);
  });
}

// ─── pull all decks from Firestore ───────────────────────────
// Cloud always wins — completely replaces whatever is in memory.
function pullFromFirestore() {
  var ref = userDoc();
  if (!ref) return Promise.resolve();

  return ref.get().then(function(doc) {
    // No data in cloud yet — first sign-in, push local data up
    if (!doc.exists || !doc.data().deckList || !Object.keys(doc.data().deckList).length) {
      return pushAllDecksToFirestore();
    }

    var data         = doc.data();
    var meta         = data.deckList;
    var cloudCurrent = data.currentDeckId;

    return ref.collection('decks').get().then(function(snapshot) {
      var cloudDecks = {};

      snapshot.forEach(function(deckDoc) {
        var id = deckDoc.id;
        // ONLY include deck documents that are listed in deckList meta.
        // Orphaned docs (e.g. deleted deck whose document hasn't been purged yet)
        // must be ignored — deckList is the authoritative record of existing decks.
        if (!meta[id]) return;
        var d  = deckDoc.data();
        cloudDecks[id] = {
          name:       d.name       || meta[id].name,
          sentences:  d.sentences  || [],
          srsData:    d.srsData    || {},
          currentIdx: d.currentIdx || 0
        };
      });

      // Any decks in meta without a doc (empty decks)
      Object.keys(meta).forEach(function(id) {
        if (!cloudDecks[id]) {
          cloudDecks[id] = { name: meta[id].name, sentences: [], srsData: {}, currentIdx: 0 };
        }
      });

      // ── Preserve local currentIdx before overwriting with cloud ──
      // currentIdx is "which card you're looking at" — pure UI state.
      // Firestore stores the idx from the last push, which may lag behind
      // the local value if the user navigated cards and refreshed before
      // the async push completed. Without this guard the cloud's older
      // idx value clobbers the local one, causing the stats bar to jump
      // and a visible card-content flash on every page refresh.
      var _prePullDeckId = currentDeckId;
      var _prePullIdx    = decks[_prePullDeckId] ? decks[_prePullDeckId].currentIdx : 0;

      // Fully replace local state with cloud state
      decks = cloudDecks;

      if (cloudCurrent && decks[cloudCurrent]) {
        currentDeckId = cloudCurrent;
      } else {
        currentDeckId = Object.keys(decks)[0];
      }
      localStorage.setItem('jpStudy_currentDeck', currentDeckId);

      // If the active deck hasn't changed, restore the local card position.
      // If the active deck DID change (switched on another device) we use
      // the cloud's idx so the user lands on the correct card for that deck.
      if (currentDeckId === _prePullDeckId && decks[currentDeckId]) {
        decks[currentDeckId].currentIdx = _prePullIdx;
      }

      // Restore length filter — pullFromFirestore wipes state then calls render(),
      // so we must re-apply the saved filter here or it resets to null every refresh
      try {
        var savedFilter = localStorage.getItem('jpStudy_lengthFilter');
        currentLengthFilter = (savedFilter && savedFilter !== '') ? savedFilter : null;
      } catch(e) {}

      // Persist cloud data back to localStorage so next refresh starts fresh correctly
      var deckMeta = {};
      Object.keys(decks).forEach(function(id) {
        deckMeta[id] = { name: decks[id].name };
        try {
          localStorage.setItem('jpStudy_deck_' + id, JSON.stringify({
            name:       decks[id].name,
            sentences:  decks[id].sentences,
            srsData:    decks[id].srsData,
            currentIdx: decks[id].currentIdx
          }));
        } catch(e) { console.warn('localStorage write failed for deck', id, e); }
      });
      try {
        localStorage.setItem('jpStudy_deckList', JSON.stringify(deckMeta));
      } catch(e) {}
    });

  }).catch(function(e) {
    console.warn('Firestore pull failed — keeping local data.', e);
  });
}
