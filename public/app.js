/* ============================================================================
   CoopQueue — client. No framework, no build step: edit, push, done.
   Routing is hash-based (#/g/<slug>/<view>) so the whole thing stays a static
   file with no server-side rewrite rules.
   ========================================================================== */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  me: null,
  groups: [],
  group: null,      // { slug, name, maxPlayers, role }
  members: [],
  games: [],
  model: { mean: 7.26, sd: 1.29 },
  queue: [],
  qIndex: 0,
  rateMode: 'played',   // 'played' | 'want' — see renderQueue
  nextAttendees: null,  // selected member ids; null means everybody in the workspace
  history: null,        // current member's missing shared-history facts
  view: 'queue',
  cache: {},
};

/* Fixed categorical slots, assigned by position in the member list. Colour
   follows the person, never their rank, so filtering never repaints anyone.

   The order is chosen by scripts/validate-palette.mjs, and it has been revised
   twice for reasons worth keeping:

   1. Numeric order gave a four-person group blue/orange/aqua/yellow. Orange vs
      yellow is ΔE 34 to normal vision but only 9 under deuteranopia — two
      columns that read identically to some people.
   2. Fixing that by maximising the worst ΔE across all three vision conditions
      picked blue/yellow/magenta/red, whose weakest pair scored 25 under every
      condition — including normal vision, where magenta vs red is only ΔE 25.
      Balanced for colour blindness, too alike for everyone else.

   This order optimises the worst *normal-vision* pair while holding the
   colour-blind floor above ~15: blue/orange/magenta/green scores ΔE 52 normal,
   16 deuteranopic, 17 protanopic. Double the sighted separation of the previous
   order for an acceptable CVD cost.

   Violet was tried for the third slot and is measurably worse, not better: it
   collapses against blue under protanopia at ΔE 2. */
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-5)', 'var(--series-6)',
                'var(--series-4)', 'var(--series-8)', 'var(--series-3)', 'var(--series-7)'];
const colorOf = (steamId) => {
  const i = state.members.findIndex((m) => m.steam_id === steamId);
  return i >= 0 && i < SERIES.length ? SERIES[i] : 'var(--text-muted)';
};
const nameOf = (steamId) =>
  state.members.find((m) => m.steam_id === steamId)?.short_name || 'Someone';

const STATUS_LABEL = {
  backlog: 'Backlog', playing: 'Playing', finished: 'Finished',
  unfinished: 'Failed to finish', dropped: 'Dropped', sampled: 'Sampled',
};

// The library payload's viability is for the workspace's usual headcount. Play
// Next can select a different crew, so it must recompute the same rule locally.
const viabilityFor = (game, need) => {
  const cap = game.max_players;
  if (cap == null) return { ok: null, label: 'unknown', reason: 'Player count not set yet' };
  if (cap >= need) return { ok: true, label: `${cap}p`, reason: null };
  if (game.coop_note && /remote play|only the host|manual/i.test(game.coop_note)) {
    return { ok: 'workaround', label: `${cap}p`, reason: game.coop_note };
  }
  return {
    ok: false,
    label: `${cap}p`,
    reason: game.coop_note || `Caps out at ${cap} player${cap === 1 ? '' : 's'}, and ${need} are selected`,
  };
};

/* ─────────────────────────────── api ─────────────────────────────────── */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { showLanding(); throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}
/** Group-scoped call. Every data endpoint lives under /api/g/<slug>/. */
const gapiFor = (slug, path, options) => api(`/api/g/${encodeURIComponent(slug)}${path}`, options);
const gapi = (path, options) => gapiFor(state.group.slug, path, options);
const invalidateViewCache = () => { state.cache = {}; };

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const steamStoreUrl = (appid) => {
  const id = Number(appid);
  return Number.isSafeInteger(id) && id > 0 ? `https://store.steampowered.com/app/${id}/` : null;
};
const fmt = (n, d = 2) => (n == null ? '–' : Number(n).toFixed(d));
const roundedHours = (n) => n == null ? null : Math.round(Number(n) * 10) / 10;
const fmtHours = (n) => n == null ? '–' : roundedHours(n).toLocaleString(undefined, {
  maximumFractionDigits: 1,
});
/** Rough relative time. Comment threads read better in "2 days ago" than dates. */
const when = (epoch) => {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - Number(epoch || 0));
  const steps = [[60, 'just now'], [3600, 'm'], [86400, 'h'], [604800, 'd']];
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(Number(epoch) * 1000).toLocaleDateString();
};
/** 1029444 -> "1.0M". Steam review counts run to seven figures. */
const compact = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n);

/**
 * Trailer playback. Steam retired progressive mp4s, so `trailer_url` is now
 * almost always a segmented HLS manifest: Safari plays that natively, everything
 * else needs hls.js. One <video> is reused for every card in the queue, so the
 * previous player has to be torn down before the next attaches or the instances
 * (and their buffers) pile up as you rate.
 */
let hls = null;
let hlsLoad = null;
let trailerSeq = 0;

/** hls.js is roughly 530 KB, so only fetch it when an HLS trailer is shown. */
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLoad) return hlsLoad;
  hlsLoad = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.min.js?v=1.6.17';
    script.onload = () => resolve(window.Hls || null);
    script.onerror = () => resolve(null);
    document.head.append(script);
  });
  return hlsLoad;
}

function detachTrailer(video) {
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src');
  video.load();
}

/* Trailers autoplay, and every browser only allows that while muted. The choice
   is remembered for the session rather than per card, so unmuting once carries
   through the rest of the queue instead of making you reach for the speaker on
   every game. Deliberately not persisted: it is a per-sitting decision, and
   surprising someone with sound on a fresh visit is worse than one extra click. */
let trailerMuted = true;

/** Start a trailer, degrading to muted rather than leaving a card sitting paused. */
function playTrailer(video) {
  video.muted = trailerMuted;
  const start = () => video.play().catch(() => {
    // Unmuted playback needs a user gesture the page may not have had yet; a
    // muted retry is what the autoplay policy actually permits.
    if (video.muted) return;
    video.muted = true;
    video.play().catch(() => { /* nothing left to try — the poster still shows */ });
  });

  start();
  /* ...and again when there is actually something to play. hls.js attaches its
     buffer asynchronously, so this first call usually lands at readyState 0 and
     rejects — which looked exactly like a blocked autoplay: muted, loaded, paused
     at 0:00. One `canplay` retry is the difference between the trailer running and
     the card sitting still. */
  video.addEventListener('canplay', start, { once: true });
}

/** Attach `url` to `video`; false means this browser cannot play it at all. */
async function attachTrailer(video, url, current = () => true) {
  detachTrailer(video);
  if (!/\.m3u8(\?|$)/i.test(url)) {           // a progressive file needs no help
    video.src = url;
    return true;
  }
  // hls.js is tried BEFORE native playback, and the order matters. Chromium
  // answers canPlayType('application/vnd.apple.mpegurl') with "maybe" — truthy —
  // while being unable to play HLS at all, so native support cannot be trusted
  // wherever MSE exists. iOS Safari is the mirror image: no MSE for hls.js to
  // use, but genuine native HLS. Trusting canPlayType first silently produces a
  // video that never starts in exactly the browsers this group uses.
  // Browsers with MediaSource may be able to use hls.js. Load it on demand,
  // then re-check the card: a group switch during the download must not attach
  // the old group's trailer to the new card.
  const Hls = window.MediaSource ? await loadHls() : null;
  if (!current()) return false;
  if (Hls?.isSupported()) {
    // A rating card is a glance, not a sitting — a short buffer keeps the queue
    // snappy and avoids pulling megabytes for a game about to be skipped.
    hls = new Hls({ maxBufferLength: 12, maxMaxBufferLength: 30 });
    hls.loadSource(url);
    hls.attachMedia(video);
    return true;
  }
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    return true;
  }
  return false;
}

const show = (id) => {
  for (const s of ['landing', 'onboard', 'claim', 'app']) $('#' + s).hidden = s !== id;
};

/* ─────────────────────────────── boot ────────────────────────────────── */
async function boot() {
  const params = new URLSearchParams(location.search);

  const err = params.get('error');
  if (err) {
    const messages = {
      cancelled: 'Sign-in was cancelled.',
      steam_rejected: 'Steam could not verify that login. Try again.',
      steam_unavailable: 'Steam did not answer in time. Try signing in again.',
      no_steamid: 'Steam did not return an ID. Try again.',
      not_allowed: `This instance is invite-only and that account is not on the list. Your Steam ID is ${params.get('id') || 'unknown'}.`,
    };
    showLanding(messages[err] || 'Something went wrong signing in.');
    history.replaceState(null, '', '/');
    return;
  }

  let me;
  try {
    me = await api('/api/me');
  } catch {
    // Not signed in. Keep any invite code so it survives the Steam round-trip.
    const join = params.get('join');
    if (join) $$('#landing a[href^="/api/auth/steam"]').forEach((a) => {
      a.href = `/api/auth/steam?join=${encodeURIComponent(join)}`;
    });
    showLanding();
    return;
  }

  state.me = me.user;
  state.groups = me.groups;

  // Arrived via an invite link.
  const join = params.get('join');
  if (join) {
    history.replaceState(null, '', '/');
    try {
      const r = await api('/api/groups/join', { method: 'POST', body: { code: join } });
      state.groups = (await api('/api/me')).groups;
      location.hash = `#/g/${r.slug}/queue`;
      toast(r.alreadyMember ? `You're already in ${r.name}` : `Joined ${r.name}`);
    } catch (e) {
      toast(e.message);
    }
  }

  if (!state.groups.length) return showOnboard();
  await openFromHash();
}

function showLanding(message) {
  show('landing');
  wireLandingShowcase();
  const box = $('#landing-error');
  box.hidden = !message;
  if (message) box.textContent = message;
}

let landingShowcaseWired = false;
function wireLandingShowcase() {
  if (landingShowcaseWired) return;
  landingShowcaseWired = true;
  $$('.landing-shot-choice').forEach((button) => {
    button.addEventListener('click', () => {
      const selected = button.dataset.showcaseShot;
      $$('.landing-shot-choice').forEach((choice) => {
        choice.setAttribute('aria-pressed', String(choice === button));
      });
      $$('.landing-shot-panel').forEach((panel) => {
        panel.hidden = panel.dataset.showcasePanel !== selected;
      });
    });
  });
}

/* ───────────────────────── onboarding: no groups ─────────────────────── */
function showOnboard() {
  show('onboard');
  $('#onboard-name').textContent = state.me.displayName || 'stranger';

  const syncCreateMode = () => {
    const personal = $('[name="create-mode"]:checked').value === 'personal';
    $('#create-size-field').hidden = personal;
    $('#create-name-label').textContent = personal ? 'Library name' : 'Group name';
    $('#create-name').placeholder = personal ? 'My games' : 'Wednesday Night Crew';
    $('#create-submit').textContent = personal ? 'Create personal library' : 'Create group';
  };
  $$('[name="create-mode"]').forEach((radio) => { radio.onchange = syncCreateMode; });
  syncCreateMode();

  $('#create-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#create-name').value.trim();
    const mode = $('[name="create-mode"]:checked').value;
    const maxPlayers = mode === 'personal' ? 1 : Number($('#create-size').value) || 4;
    $('#onboard-status').textContent = 'Creating…';
    try {
      const r = await api('/api/groups', { method: 'POST', body: { name, maxPlayers, mode } });
      state.groups = (await api('/api/me')).groups;
      location.hash = `#/g/${r.slug}/queue`;
      await openFromHash();
      toast(mode === 'personal'
        ? `${r.name} is ready — add the first game`
        : `${r.name} created — invite the others from the Group tab`);
    } catch (err) { $('#onboard-status').textContent = err.message; }
  };

  $('#join-form').onsubmit = async (e) => {
    e.preventDefault();
    $('#onboard-status').textContent = 'Looking up that code…';
    try {
      const r = await api('/api/groups/join', { method: 'POST', body: { code: $('#join-code').value } });
      state.groups = (await api('/api/me')).groups;
      location.hash = `#/g/${r.slug}/queue`;
      await openFromHash();
      toast(`Joined ${r.name}`);
    } catch (err) { $('#onboard-status').textContent = err.message; }
  };
}

/* ───────────────────────────── routing ───────────────────────────────── */
function parseHash() {
  const m = location.hash.match(/^#\/g\/([^/]+)(?:\/([a-z]+))?/);
  return m ? { slug: decodeURIComponent(m[1]), view: m[2] || 'queue' } : null;
}

async function openFromHash() {
  const route = parseHash();
  const slug = route?.slug && state.groups.some((g) => g.slug === route.slug)
    ? route.slug
    : state.groups[0]?.slug;
  if (!slug) return showOnboard();

  if (state.group?.slug !== slug) {
    state.group = { slug };
    state.qIndex = 0;
    const loaded = await loadGroup(slug);
    if (!loaded || loaded === 'claim') return;
  }
  if (state.group?.slug !== slug) return;
  setView(route?.view || 'queue');
}

window.addEventListener('hashchange', () => {
  const route = parseHash();
  if (!route) return;
  if (route.slug !== state.group?.slug) openFromHash();
  else if (route.view !== state.view) setView(route.view);
});

let groupLoadSeq = 0;
let historySeq = 0;

async function loadGroup(expectedSlug = state.group?.slug) {
  if (!expectedSlug) return false;
  const seq = ++groupLoadSeq;
  const [lib, q, claim] = await Promise.all([
    gapiFor(expectedSlug, '/games'),
    gapiFor(expectedSlug, '/skip'),
    gapiFor(expectedSlug, '/claim'),
  ]);
  // A slow response from the group we just left must never overwrite the group
  // the person is now looking at. This also drops an earlier reload superseded by
  // a newer mutation in the same group.
  if (seq !== groupLoadSeq || state.group?.slug !== expectedSlug) return false;
  state.games = lib.games;
  state.members = lib.members;
  state.group = lib.group;
  state.model = lib.model;
  state.queue = q.queue;
  state.nextAttendees = null;
  state.history = null;
  historySeq++;
  invalidateViewCache();
  browseSeq++;
  browse.page = 0;
  browse.items = [];
  browse.hasMore = false;

  // Offer the imported identity before showing the app, once per group.
  if (claim.canClaim && claim.unclaimed.length) {
    showClaim(claim.unclaimed);
    return 'claim';
  }

  renderChrome();
  show('app');
  return 'app';
}

async function reloadGroupView(slug, view = state.view) {
  if (state.group?.slug !== slug) return false;
  const loaded = await loadGroup(slug);
  if (loaded !== 'app' || state.group?.slug !== slug) return false;
  setView(view);
  return true;
}

function showClaim(unclaimed) {
  show('claim');
  $('#claim-options').innerHTML = unclaimed
    .map((u) => `<button class="claim-opt" data-seed="${esc(u.seedId)}" data-name="${esc(u.name)}" data-ratings="${u.ratings}"><b>${esc(u.name)}</b><span>claim ${u.ratings} rating${u.ratings === 1 ? '' : 's'}</span></button>`)
    .join('');
  $$('#claim-options .claim-opt').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm(`Claim ${btn.dataset.ratings} rating${btn.dataset.ratings === '1' ? '' : 's'} from ${btn.dataset.name}? This cannot be undone.`)) return;
      btn.disabled = true;
      const slug = state.group.slug;
      try {
        const r = await gapiFor(slug, '/claim', { method: 'POST', body: { seedId: btn.dataset.seed } });
        if (!await reloadGroupView(slug, 'queue')) return;
        toast(`Welcome back, ${r.shortName}`);
      } catch (e) { toast(e.message); btn.disabled = false; }
    })
  );
  $('[data-claim-skip]').onclick = async () => {
    renderChrome();
    show('app');
    setView('queue');
  };
}

function renderChrome() {
  $('#me-name').textContent = state.members.find((m) => m.steam_id === state.me.steamId)?.short_name
    || state.me.displayName || '';
  if (state.me.avatar) $('#me-avatar').src = state.me.avatar;
  $('#group-name').textContent = state.group.name;
  $('#workspace-tab').textContent = state.group.mode === 'personal' ? 'Settings' : 'Group';
  $('#queue-empty-copy').textContent = state.group.mode === 'personal'
    ? 'You have rated or skipped everything in this library. Add a game, or revisit one you already rated.'
    : 'You have rated or skipped everything in this group. Add a game, or go argue on the Play next tab.';
  $('#browse-fit-option').textContent = state.group.mode === 'personal' ? 'Recommended for me' : 'Recommended for us';
  $('#browse-coop-label span').textContent = state.group.mode === 'personal' ? 'Co-op catalogue only' : 'Co-op only';
  $('#browse-fits-label').hidden = state.group.mode === 'personal';
  if (state.group.mode === 'personal') $('#browse-fits').checked = false;
  $('#browse-intro').textContent = state.group.mode === 'personal'
    ? 'A co-op-first Steam catalogue, ranked from your ratings. Add any other Steam game with + Add game.'
    : 'Popular online co-op games on Steam. Add the ones this group might actually play — only games in your library appear in anyone’s rating queue, which keeps the votes focused.';
  $('#queue-count').textContent = state.queue.length || '';
  renderMyCoverage();
  renderGroupMenu();
  renderLibHead();
  wireOnce();
}

function renderGroupMenu() {
  const items = state.groups.map((g) => `
    <button class="group-item${g.slug === state.group.slug ? ' is-current' : ''}" data-slug="${esc(g.slug)}" role="menuitem">
      <span class="group-item-name">${esc(g.name)}</span>
      <span class="group-item-meta">${g.mode === 'personal' ? 'Personal' : `${g.members} member${g.members === 1 ? '' : 's'}`} · ${g.games} games${
        g.unrated ? ` · <b>${g.unrated} to rate</b>` : ''}</span>
    </button>`).join('');
  $('#group-menu').innerHTML = items + `
    <div class="group-menu-sep"></div>
    <button class="group-item" data-new role="menuitem"><span class="group-item-name">+ New workspace</span></button>
    <button class="group-item" data-joincode role="menuitem"><span class="group-item-name">Join with a code</span></button>`;

  $$('#group-menu .group-item').forEach((b) => b.addEventListener('click', async () => {
    closeGroupMenu();
    /* `in`, not truthiness: these are valueless attributes, so `dataset.new` is the
       empty string — falsy. The old check never fired and both items fell through
       to a navigation to `#/g/undefined/queue`, which is why they did nothing. */
    const wantsNew = 'new' in b.dataset;
    const wantsJoin = 'joincode' in b.dataset;
    if (wantsNew || wantsJoin) {
      state.group = null;
      showOnboard();
      (wantsJoin ? $('#join-code') : $('#create-name')).focus();
      return;
    }
    location.hash = `#/g/${b.dataset.slug}/queue`;
  }));
}

const closeGroupMenu = () => {
  $('#group-menu').hidden = true;
  $('#group-btn').setAttribute('aria-expanded', 'false');
};

/* ───────────────────────────── navigation ────────────────────────────── */
const VIEWS = ['queue', 'next', 'library', 'browse', 'stats', 'members'];

function setView(view) {
  if (!VIEWS.includes(view)) view = 'queue';
  /* Leaving the queue stops the trailer. Hiding the section does not: a <video> in
     a display:none subtree keeps playing, so you walk to the Library and the audio
     follows you. detach, not just pause — otherwise hls.js carries on pulling
     segments for a card nobody is looking at. */
  if (state.view === 'queue' && view !== 'queue') {
    trailerSeq++;
    const v = $('#rate-video');
    if (v) { v.pause(); detachTrailer(v); }
  }
  /* Arriving at the Library resets it to the default. Deliberately only when
     coming from ANOTHER view — the detail dialog re-renders the current one on
     save, and having that silently undo your sort would be maddening. */
  if (view === 'library' && state.view !== 'library') resetLibControls();
  state.view = view;
  const want = `#/g/${state.group.slug}/${view}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  $$('.tab').forEach((t) => {
    const current = t.dataset.view === view;
    if (current) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
    if (current && matchMedia('(max-width: 720px)').matches) {
      t.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  ({ queue: renderQueue, next: renderNext, library: () => {
       renderLibrary();
       void loadHistory();
     },
     browse: () => renderBrowse(true), stats: renderStats, members: renderMembers }[view])();
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;

  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $$('[data-open-add]').forEach((b) => b.addEventListener('click', openAdd));

  $('#group-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#group-menu');
    menu.hidden = !menu.hidden;
    $('#group-btn').setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) menu.querySelector('.is-current, .group-item')?.focus();
  });
  document.addEventListener('click', closeGroupMenu);
  $('#group-menu').addEventListener('click', (e) => e.stopPropagation());
  $('#group-menu').addEventListener('keydown', (e) => {
    const items = $$('.group-item', e.currentTarget);
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      closeGroupMenu();
      $('#group-btn').focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else return;
    e.preventDefault();
  });

  $('#score-range').addEventListener('input', (e) => { $('#score-out').textContent = fmt(e.target.value, 1); });
  $('#btn-save').addEventListener('click', saveRating);
  $$('#rate-modes .seg').forEach((b) => b.addEventListener('click', () => {
    state.rateMode = b.dataset.mode;
    state.qIndex = 0;
    renderQueue();
  }));
  // The logo is the way back to the thing you came here to do.
  $('#brand-home').addEventListener('click', (e) => { e.preventDefault(); setView('queue'); });
  $('#btn-skip').addEventListener('click', () => skipGame(false));
  $('#btn-notplayed').addEventListener('click', () => skipGame(true));
  $('#btn-unskip').addEventListener('click', unskipGame);
  // Unmuting one trailer means you want sound for the rest of the sitting.
  $('#rate-video').addEventListener('volumechange', (e) => { trailerMuted = e.target.muted; });

  $('#lib-search').addEventListener('input', renderLibrary);
  $('#lib-status').addEventListener('change', renderLibrary);
  $('#lib-sort').addEventListener('change', () => {
    libSort = null;              // dropdown wins again; clears the column arrow
    renderLibHead();
    renderLibrary();
  });
  $('#lib-mine').addEventListener('change', renderLibrary);
  $('#lib-score').addEventListener('change', renderLibrary);
  $('#lib-reset').addEventListener('click', () => {
    resetLibControls();
    renderLibHead();      // clears the column sort arrow too
    renderLibrary();
  });
  $('#lib-played').addEventListener('change', renderLibrary);
  $('#lib-archived').addEventListener('change', renderLibrary);
  $('#hide-unviable').addEventListener('change', renderNext);
  $('#hide-ea').addEventListener('change', renderNext);

  let browseTimer;
  $('#browse-search').addEventListener('input', () => {
    clearTimeout(browseTimer);
    browseTimer = setTimeout(() => renderBrowse(true), 280);
  });
  $('#browse-sort').addEventListener('change', () => renderBrowse(true));
  $('#browse-fits').addEventListener('change', () => renderBrowse(true));
  $('#browse-coop').addEventListener('change', () => renderBrowse(true));
  // Re-render only; the server result is unchanged, this filter is client-side.
  $('#browse-hide-owned').addEventListener('change', () => renderBrowse(false));
  $('#browse-more').addEventListener('click', () => { browse.page++; renderBrowse(false); });

  $('#man-add').addEventListener('click', addManual);
  $('#man-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addManual(); }
  });

  let searchTimer;
  $('#add-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 260);
  });

  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (state.view !== 'queue' || $('#queue-card').hidden) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || $('#add-dialog').open || $('#detail-dialog').open) return;

  const range = $('#score-range');
  if (/^[0-9]$/.test(e.key)) {
    range.value = e.key === '0' ? 10 : Number(e.key);
    $('#score-out').textContent = fmt(range.value, 1);
    e.preventDefault();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    range.value = Number(range.value) + (e.key === 'ArrowRight' ? 0.5 : -0.5);
    $('#score-out').textContent = fmt(range.value, 1);
    e.preventDefault();
  } else if (e.key === 'Enter') { saveRating(); e.preventDefault(); }
  else if (e.key.toLowerCase() === 's') { skipGame(false); e.preventDefault(); }
  else if (e.key.toLowerCase() === 'n' && state.rateMode === 'played') { skipGame(true); e.preventDefault(); }
}

const gameById = (id) => state.games.find((g) => g.id === id);

/* ══════════════════════════════ RATE ══════════════════════════════════ */
/**
 * The queue asks two unrelated questions — "how good was it?" of games you have
 * played, and "how much do you want to play this?" of ones you have not — and a
 * silently mixed list is why that is confusing. They are split into modes, and
 * Played is the default whenever it has anything in it: it is the smaller set and
 * the more perishable, because memory of a game fades in a way that curiosity
 * about one does not.
 *
 * Partitioned on the client from data it already has. The queue endpoint returns
 * ids and the library carries each game's status, so this needed no new API.
 */
/**
 * Which hours figure to show, and whether it is a measurement or a bound.
 * A saved number wins; its provenance says whether it was typed or accepted from
 * an estimate. Live estimates are upper bounds and carry their participant count.
 * An accepted estimate is a snapshot, so never relabel it with a later sync's count.
 */
const APPROXIMATE_FACT_SOURCES = new Set([
  'release-date', 'steam-hours', 'steam-last-played', 'achievement',
]);
const FACT_SOURCE_LABEL = {
  manual: 'Entered by the group',
  'release-date': 'Steam release-date fallback',
  'steam-hours': 'Steam group-hours estimate',
  'steam-last-played': 'Latest play Steam exposes',
  achievement: 'Steam achievement evidence',
};
const factSource = (g, field) => g.factSources?.[field] || null;
const factIsApproximate = (g, field) =>
  APPROXIMATE_FACT_SOURCES.has(factSource(g, field)?.source);
const factSourceHelp = (g, field) => {
  const fact = factSource(g, field);
  if (!fact) return '';
  const label = state.group.mode === 'personal' && fact.source === 'manual'
    ? 'Entered by you'
    : state.group.mode === 'personal' && fact.source === 'steam-hours'
      ? 'Your Steam playtime'
      : FACT_SOURCE_LABEL[fact.source] || 'Recorded source';
  const who = fact.setByName
    ? ` · ${fact.source === 'manual' ? 'entered' : 'accepted'} by ${esc(fact.setByName)}`
    : '';
  return `<p class="field-help fact-source${factIsApproximate(g, field) ? ' is-approx' : ''}">
    ${factIsApproximate(g, field) ? 'Approximate · ' : ''}${esc(label)}${who}.
  </p>`;
};

/* When the group finished, on the same rule as hours: a typed date always wins, an
   accepted Steam suggestion keeps its approximate marker and provenance. */
const endedOn = (g) => {
  if (g.finished) return { value: g.finished, manual: !factIsApproximate(g, 'finished') };
  if (g.finished_estimated) return { value: g.finished_estimated, manual: false };
  return { value: null, manual: false };
};
/** ISO day -> "Mar 2026", which is the precision these dates actually carry. */
const shortDate = (iso) => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(+d) ? iso
    : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const hoursOf = (g) => {
  if (g.hours != null) {
    const approximate = factIsApproximate(g, 'hours');
    return {
      value: roundedHours(g.hours),
      manual: !approximate,
      accepted: approximate,
      participants: approximate ? null : g.hours_participants ?? 0,
    };
  }
  if (g.hours_estimated != null) {
    return { value: roundedHours(g.hours_estimated), manual: false, participants: g.hours_participants ?? 0 };
  }
  return { value: null, manual: false };
};

/** Archived games are out of everything except the Library's archived filter. */
const isActive = (g) => !g.archived_at;
const activeGames = () => state.games.filter(isActive);

// A game you failed to finish is still one you played and can score.
const PLAYED_STATUS = new Set(['finished', 'unfinished', 'dropped', 'sampled']);
const modeOf = (g) => (PLAYED_STATUS.has(g.status) ? 'played' : 'want');

async function renderQueueMedia(g) {
  const token = ++trailerSeq;
  const slug = state.group.slug;
  const video = $('#rate-video');
  const image = $('#rate-image');
  const media = $('.rate-media');
  const note = $('#rate-notrailer');
  const current = () => token === trailerSeq
    && state.group?.slug === slug
    && currentCard()?.id === g.id
    && state.view === 'queue';

  video.pause();
  detachTrailer(video);
  video.hidden = true;
  if (g.header_image) {
    image.src = g.header_image;
    image.hidden = false;
    note.hidden = true;
    media.classList.remove('is-blank');
  } else {
    image.hidden = true;
    note.hidden = false;
    note.textContent = g.trailer_url ? 'Loading trailer…'
      : 'Not linked to Steam yet — open it from the Library and paste a store link for art and a trailer';
    media.classList.toggle('is-blank', !g.trailer_url);
  }

  if (!g.trailer_url) {
    if (g.header_image) {
      note.hidden = false;
      note.textContent = 'No trailer on Steam';
    }
    return;
  }

  const supported = await attachTrailer(video, g.trailer_url, current);
  if (!current()) return;
  if (supported) {
    video.poster = g.header_image || '';
    video.hidden = false;
    image.hidden = true;
    note.hidden = true;
    media.classList.remove('is-blank');
    playTrailer(video);
  } else {
    video.hidden = true;
    note.hidden = false;
    note.textContent = 'Trailer will not play in this browser';
    media.classList.toggle('is-blank', !g.header_image);
  }
}

/**
 * The three lists behind the Rate tab.
 *
 * `played` and `want` come from the queue — games I have not scored. `rated` is the
 * opposite set and exists so a rating can be changed: the queue by definition never
 * offers a game back once you have scored it, which left no way to revise one.
 * Name order, because in that mode you are looking for a specific game rather than
 * working through a pile.
 */
function queuesByMode() {
  const out = { played: [], want: [], rated: [], skipped: [] };
  for (const id of state.queue) {
    const g = gameById(id);
    if (g && isActive(g)) out[modeOf(g)].push(id);
  }
  for (const g of activeGames()) {
    if (g.votes[state.me.steamId] != null) out.rated.push(g.id);
    // Skipped AND unrated. Rating one clears the skip server-side, so a game can
    // never be in both lists — but check anyway rather than rely on that.
    else if (g.mySkip) out.skipped.push(g.id);
  }
  return out;
}

function renderQueue() {
  const byMode = queuesByMode();

  // Default to whichever mode has work, preferring Played. Also auto-advances
  // when the mode you were in empties, so the queue never looks broken.
  if (!byMode[state.rateMode]?.length) {
    // Never auto-select 'rated': it is a place you go on purpose, not a backlog.
    state.rateMode = byMode.played.length ? 'played' : 'want';
    state.qIndex = 0;
  }
  const queue = byMode[state.rateMode];

  const modes = $('#rate-modes');
  modes.hidden = !(byMode.played.length || byMode.want.length
                   || byMode.rated.length || byMode.skipped.length);
  $('#mode-played-n').textContent = byMode.played.length || '';
  $('#mode-want-n').textContent = byMode.want.length || '';
  $('#mode-rated-n').textContent = byMode.rated.length || '';
  $('#mode-skipped-n').textContent = byMode.skipped.length || '';
  // Most people never skip anything; no reason to show them an empty tab.
  $('#rate-modes .seg[data-mode="skipped"]').hidden = !byMode.skipped.length;
  $$('#rate-modes .seg').forEach((b) => {
    const on = b.dataset.mode === state.rateMode;
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
    b.disabled = !byMode[b.dataset.mode].length;
  });
  $('#rate-ask').textContent = {
    played: 'How good was it? Rate what you have already played, while you still remember.',
    want:   'How much do you want to play this? These are the ones that decide what comes next.',
    rated:  'Everything you have already scored. Move the slider and save to change your mind.',
    skipped: 'Games you passed on. Score one to add it, or put it back in the queue for later.',
  }[state.rateMode];
  // Only meaningful for games the group has finished: you cannot "not have played"
  // something nobody has played yet, where the question is interest, not memory.
  $('#btn-notplayed').hidden = state.rateMode !== 'played';
  $('#btn-unskip').hidden = state.rateMode !== 'skipped';
  // Skipping something you have already scored is not an action — the score is the
  // opinion, and clearing it is what the queue would call unrated again.
  $('#btn-skip').hidden = state.rateMode === 'rated' || state.rateMode === 'skipped';

  const empty = !queue.length;
  $('#queue-empty').hidden = !empty;
  $('#queue-card').hidden = empty;
  renderQueueList(queue);
  if (empty) {
    trailerSeq++;
    const video = $('#rate-video');
    video.pause();
    detachTrailer(video);
    return;
  }

  if (state.qIndex >= queue.length) state.qIndex = 0;
  const g = gameById(queue[state.qIndex]);
  if (!g) { state.queue = state.queue.filter((id) => id !== queue[state.qIndex]); return renderQueue(); }

  $('#rate-title').textContent = g.name;
  $('#rate-pos').textContent = (state.rateMode === 'rated' || state.rateMode === 'skipped')
    ? `${state.qIndex + 1} of ${queue.length}`
    : `${state.qIndex + 1} of ${queue.length} left`;
  $('#rate-desc').textContent = g.short_description || '';
  $('#score-hint').textContent = state.rateMode === 'played'
    ? 'how good was it?'
    : 'how much do you want to play this?';

  void renderQueueMedia(g);

  const store = $('#btn-store');
  if (g.steam_appid) {
    store.href = `https://store.steampowered.com/app/${g.steam_appid}`;
    store.hidden = false;
  } else store.hidden = true;

  $('#rate-meta').innerHTML = metaChips(g);

  // coop_note only: imported spreadsheet text now lives in the comment thread.
  const caveat = g.coop_note || '';
  $('#rate-notes').hidden = !caveat;
  $('#rate-notes').textContent = caveat;

  const others = Object.entries(g.votes).filter(([id]) => id !== state.me.steamId);
  const satOut = (g.notPlayed || []).filter((id) => id !== state.me.steamId)
    .map((id) => `<span class="other-vote other-out"><i class="dot" style="background:${colorOf(id)}"></i>${esc(nameOf(id))} didn't play</span>`)
    .join('');
  if (state.group.mode === 'personal') {
    $('#rate-others').innerHTML = '';
  } else if (state.group.blindRating) {
    // Say that opinions exist without revealing them, so the queue still tells
    // you whether you are the first to look at this.
    $('#rate-others').innerHTML = `<span class="other-vote" style="color:var(--text-muted)">${
      others.length
        ? `${others.length} other ${others.length === 1 ? 'rating' : 'ratings'} hidden`
        : 'Nobody else has rated this yet'}</span>`;
  } else {
    $('#rate-others').innerHTML = others.length
      ? others.map(([id, s]) =>
          `<span class="other-vote"><i class="dot" style="background:${colorOf(id)}"></i>${esc(nameOf(id))} <b>${fmt(s, 1)}</b></span>`
        ).join('')
      : '<span class="other-vote" style="color:var(--text-muted)">Nobody else has rated this yet</span>';
  }
  // Who sat it out is not a score, so it shows even under blind rating.
  if (state.group.mode !== 'personal') $('#rate-others').innerHTML += satOut;

  // The slider normally opens on the group's current average, which is a second
  // and less obvious source of anchoring: hiding the numbers but still starting
  // the handle on them would defeat the point. Neutral 7.5 when hidden.
  /* Revising opens on YOUR current score — the number you are there to change.
     Otherwise the slider starts on the group average, and blind rating starts it
     neutral, since anchoring the handle on hidden numbers would defeat the point. */
  const mine = g.votes[state.me.steamId];
  const start = state.rateMode === 'rated' && mine != null
    ? mine
    : (others.length && !state.group.blindRating) ? Math.round(g.raw * 2) / 2 : 7.5;
  $('#score-range').value = start;
  $('#score-out').textContent = fmt(start, 1);
}

function metaChips(g, fit = g.viability, need = state.group.maxPlayers) {
  const chips = [];
  if (g.genre) chips.push(`<span class="chip">${esc(g.genre)}</span>`);
  const v = fit;
  if (v.ok === true)              chips.push(`<span class="chip chip-good">${esc(v.label)} co-op</span>`);
  else if (v.ok === 'workaround') chips.push(`<span class="chip chip-warn">works for ${need} with a workaround</span>`);
  else if (v.ok === false)        chips.push(`<span class="chip chip-bad">only ${esc(v.label)} — we can't all play</span>`);
  else                            chips.push(`<span class="chip">player count unknown</span>`);
  if (g.price)        chips.push(`<span class="chip">${esc(g.price)}</span>`);
  if (g.release_date) chips.push(`<span class="chip">${esc(g.release_date)}</span>`);
  if (g.metacritic)   chips.push(`<span class="chip" title="Metacritic critic score out of 100">Metacritic ${g.metacritic}</span>`);
  // Steam's own verdict, from the catalogue. Worth showing next to the group's
  // score: it is the outside view, on a far larger sample than four friends.
  if (g.steam_review_hint) {
    chips.push(`<span class="chip">${esc(g.steam_review_hint)}${
      g.steam_review_count ? ` · ${compact(g.steam_review_count)} reviews` : ''}</span>`);
  }
  /* Still in development. Worth flagging even when everyone wants to play it: the
     content is unfinished and a group that starts now may find the ending missing. */
  if (g.early_access) {
    chips.push('<span class="chip chip-warn" title="Still in Early Access on Steam — '
             + 'the game is unfinished, so it may be worth waiting">Early access</span>');
  }
  const ownership = ownershipChip(g);
  if (ownership) chips.push(ownership);
  if (g.status !== 'backlog') chips.push(`<span class="chip">${STATUS_LABEL[g.status]}</span>`);
  /* Who put this on the list. Only when we can name them — most of an imported
     library has no attribution, and "Added by Someone" is worse than silence. */
  const adder = g.added_by && state.members.find((m) => m.steam_id === g.added_by);
  if (adder) {
    chips.push(`<span class="chip"><i class="dot" style="background:${colorOf(g.added_by)}"></i>`
             + `Added by ${esc(adder.short_name)}</span>`);
  }
  return chips.join('');
}

function ownershipChip(g) {
  if (!g.steam_appid || !g.ownership) return '';
  const states = state.members.map((member) => g.ownership[member.steam_id]);
  const owned = states.filter((value) => value === true).length;
  const missing = states.filter((value) => value === false).length;
  const unknown = states.length - owned - missing;
  if (!owned && !missing) {
    return '<span class="chip" title="Sync Steam libraries from Group to check ownership">ownership unknown</span>';
  }
  if (!missing && !unknown) return '<span class="chip chip-good">everyone owns it</span>';
  const detail = [missing ? `${missing} do not own` : '', unknown ? `${unknown} unknown` : '']
    .filter(Boolean).join(' · ');
  return `<span class="chip${missing ? ' chip-warn' : ''}" title="${esc(detail)}">${owned}/${states.length} own</span>`;
}

/** The game on screen. qIndex indexes the ACTIVE MODE's queue, not state.queue. */
const currentCard = () => gameById(queuesByMode()[state.rateMode]?.[state.qIndex]);

async function saveRating() {
  const g = currentCard();
  if (!g) return;
  const slug = state.group.slug;
  const score = Number($('#score-range').value);
  $('#btn-save').disabled = true;
  try {
    await gapiFor(slug, '/rate', { method: 'POST', body: { gameId: g.id, score } });
    if (state.group?.slug !== slug) return;
    invalidateViewCache();
    state.queue = state.queue.filter((id) => id !== g.id);
    $('#queue-count').textContent = state.queue.length || '';
    g.votes[state.me.steamId] = score;
    // rate.js deletes any skip on the same game, so the local copy has to agree or
    // the card lingers in the Skipped list until the next reload.
    g.mySkip = null;
    /* Revising does not shrink the list it came from, so nothing moves you along —
       step forward by hand, or the card sits there looking like it did not save. */
    if (state.rateMode === 'rated') state.qIndex++;
    renderMyCoverage();   // the bar should move on every save, that is the point
    toast(`${g.name}: ${fmt(score, 1)}`);
    renderQueue();
    void gapiFor(slug, '/games').then((lib) => {
      if (state.group?.slug !== slug) return;
      state.games = lib.games;
      state.model = lib.model;
    }).catch(() => { /* the optimistic score is already saved; the next reload reconciles */ });
  } catch (e) { toast(e.message); }
  finally { $('#btn-save').disabled = false; }
}

/**
 * Take the current card off my queue. `notPlayed` distinguishes "I wasn't part of
 * this one" from "no opinion" — only the first removes the game from my coverage
 * denominator, so it has to update the local copy too or the bar above the queue
 * disagrees with the server until the next reload.
 */
/**
 * The rest of the queue, so it is a list you can steer rather than a conveyor belt.
 * Rebuilt on every card because the queue shrinks as you rate, and the current
 * position has to stay marked.
 */
function renderQueueList(queue) {
  const box = $('#rate-list');
  box.hidden = queue.length < 2;          // a list of one is just the card again
  if (box.hidden) return;

  $('#rate-list-n').textContent = `All ${queue.length} in this queue`;
  $('#rate-list-items').innerHTML = queue.map((id, i) => {
    const g = gameById(id);
    if (!g) return '';
    return `<li><button type="button" class="rate-jump${i === state.qIndex ? ' is-current' : ''}"
              data-i="${i}"${i === state.qIndex ? ' aria-current="true"' : ''}>
              <span class="rate-jump-name">${esc(g.name)}</span>
              ${state.rateMode === 'rated'
                ? `<span class="rate-jump-meta">you: ${fmt(g.votes[state.me.steamId], 1)}</span>`
                : state.rateMode === 'skipped'
                ? `<span class="rate-jump-meta">${g.mySkip === 'not-played' ? "didn't play" : 'no opinion'}</span>`
                : g.n ? `<span class="rate-jump-meta">${fmt(g.raw, 1)} · ${g.n}</span>`
                      : '<span class="rate-jump-meta">no votes yet</span>'}
            </button></li>`;
  }).join('');

  $$('#rate-list-items .rate-jump').forEach((b) => b.addEventListener('click', () => {
    state.qIndex = Number(b.dataset.i);
    // Collapse on the way out: you picked a game, so the list has done its job and
    // leaving it open just buries the card you asked for.
    box.open = false;
    renderQueue();
  }));
}

/** Undo a skip: back into the queue, where it can be rated like anything else. */
async function unskipGame() {
  const g = currentCard();
  if (!g) return;
  const slug = state.group.slug;
  try {
    await gapiFor(slug, '/skip', { method: 'DELETE', body: { gameId: g.id } });
    if (state.group?.slug !== slug) return;
    invalidateViewCache();
    g.mySkip = null;
    if (!state.queue.includes(g.id)) state.queue.push(g.id);
    $('#queue-count').textContent = state.queue.length || '';
    renderMyCoverage();
    toast(`${g.name} is back in your queue`);
    renderQueue();
  } catch (e) { toast(e.message); }
}

async function skipGame(notPlayed = false) {
  const g = currentCard();
  if (!g) return;
  const slug = state.group.slug;
  try {
    await gapiFor(slug, '/skip', { method: 'POST', body: { gameId: g.id, notPlayed } });
    if (state.group?.slug !== slug) return;
    invalidateViewCache();
    if (notPlayed && !(g.notPlayed || []).includes(state.me.steamId)) {
      g.notPlayed = [...(g.notPlayed || []), state.me.steamId];
    }
    // Keep the local copy in step, or the Skipped tab does not appear until a
    // reload — and the game you just skipped is unreachable until then.
    g.mySkip = notPlayed ? 'not-played' : 'no-opinion';
    state.queue = state.queue.filter((id) => id !== g.id);
    $('#queue-count').textContent = state.queue.length || '';
    renderMyCoverage();
    renderQueue();
  } catch (e) { toast(e.message); }
}

/* ══════════════════════════════ PLAY NEXT ═════════════════════════════ */
function renderNext() {
  renderAttendeeFilter();
  const attendees = state.nextAttendees || state.members.map((member) => member.steam_id);
  const selected = new Set(attendees);
  const need = attendees.length;
  const names = attendees.map(nameOf);
  $('#next-sub').textContent = need
    ? `Ranked using only ratings from ${names.join(', ')}. `
      + 'Verified player caps are checked against the selected player count; unknown caps stay visible.'
    : 'Select at least one player to rank the backlog.';

  if (!need) {
    $('#next-list').innerHTML = '<p class="view-sub">Choose who is playing above.</p>';
    $('#unviable-block').innerHTML = '';
    return;
  }

  /* Early access is filtered here rather than merely flagged: Play next answers
     "what should we start", and starting something unfinished is usually the wrong
     answer however much the group wants it. Off this list, not out of the library. */
  const hideEa = $('#hide-ea').checked;
  const backlog = activeGames()
    .filter((g) => g.status === 'backlog')
    .filter((g) => !(hideEa && g.early_access))
    .map((g) => {
      const votes = Object.entries(g.votes || {})
        .filter(([steamId]) => selected.has(steamId))
        .map(([, score]) => Number(score));
      return {
        ...g,
        attendeeScore: votes.length ? votes.reduce((sum, score) => sum + score, 0) / votes.length : null,
        attendeeVotes: votes.length,
        attendeeFit: viabilityFor(g, need),
      };
    })
    .filter((g) => g.attendeeVotes > 0);
  const hide = $('#hide-unviable').checked;
  const rank = (a, b) => b.attendeeScore - a.attendeeScore
    || b.attendeeVotes - a.attendeeVotes || a.name.localeCompare(b.name);
  const playable = backlog.filter((g) => g.attendeeFit.ok !== false).sort(rank);
  const blocked  = backlog.filter((g) => g.attendeeFit.ok === false).sort(rank);

  $('#next-list').innerHTML = playable.map((g, i) => `
    <li class="rank-row" data-id="${g.id}">
      <div class="rank-num">${i + 1}</div>
      ${g.header_image
        ? `<img class="rank-art" src="${esc(g.header_image)}" alt="" loading="lazy" decoding="async">`
        : '<span class="rank-art rank-art-none" aria-hidden="true"></span>'}
      <div class="rank-main">
        <div class="rank-name">${esc(g.name)}</div>
        <div class="rank-meta">${metaChips(g, g.attendeeFit, need)}${
          g.attendeeVotes === 1 && need > 1 ? '<span class="chip chip-warn">only 1 selected player rated it</span>' : ''}</div>
      </div>
      <div class="rank-score"><b>${fmt(g.attendeeScore, 1)}</b><span>${g.attendeeVotes} selected vote${g.attendeeVotes === 1 ? '' : 's'}</span></div>
    </li>`).join('') || '<p class="view-sub">None of the selected players has rated a backlog game yet.</p>';

  $('#unviable-block').innerHTML = (hide || !blocked.length)
    ? (blocked.length ? `<h3>${blocked.length} more ${blocked.length === 1 ? 'doesn’t' : 'don’t'} fit ${need} player${need === 1 ? '' : 's'}</h3><p>Untick the box above to see them.</p>` : '')
    : `<h3>These don't fit ${need} player${need === 1 ? '' : 's'}</h3>
       <p>Verified player caps. They stay on the list so nobody re-suggests them.</p>
       ${blocked.map((g) => `
         <div class="unviable-row" data-id="${g.id}">
           <span class="unviable-game">${g.header_image
             ? `<img class="rank-art rank-art-small" src="${esc(g.header_image)}" alt="" loading="lazy" decoding="async">`
             : '<span class="rank-art rank-art-small rank-art-none" aria-hidden="true"></span>'}<span><strong>${esc(g.name)}</strong> · ${fmt(g.attendeeScore, 1)}</span></span>
           <span class="why">${esc(g.attendeeFit.reason || `caps at ${g.max_players}`)}</span>
         </div>`).join('')}`;

  $$('#next-list .rank-row, #unviable-block .unviable-row')
    .forEach((r) => r.addEventListener('click', () => openDetail(Number(r.dataset.id))));
}

function renderAttendeeFilter() {
  const box = $('#pn-attendees');
  const signature = `${state.group.slug}|${state.members.map((member) => member.steam_id).join('|')}`;
  if (box.dataset.members === signature) return;
  box.dataset.members = signature;
  const selected = new Set(state.nextAttendees || state.members.map((member) => member.steam_id));
  box.innerHTML = state.members.map((member) => `
    <label class="attendee">
      <input type="checkbox" value="${esc(member.steam_id)}" ${selected.has(member.steam_id) ? 'checked' : ''}>
      <i class="dot" style="background:${colorOf(member.steam_id)}"></i>
      <span>${esc(member.short_name)}</span>
    </label>`).join('');
  $$('input', box).forEach((input) => input.addEventListener('change', () => {
    state.nextAttendees = $$('input:checked', box).map((checked) => checked.value);
    renderNext();
  }));
}

/* ══════════════════════════════ LIBRARY ═══════════════════════════════ */
/**
 * Column sort, layered over the sort dropdown rather than replacing it. Clicking
 * a header takes over; picking from the dropdown hands control back. Text columns
 * open A–Z, numeric ones open highest-first, because that is what you want on the
 * first click in each case.
 */
/* The Library's default view, and the single definition of it.

   The default follows the group's play history: current games first, the backlog
   last, and newest start dates first everywhere in between and inside those two
   groups. Explicit choices such as Best first still sort the whole filtered library
   exactly as labelled. */
const LIB_DEFAULTS = {
  'lib-search': '', 'lib-status': '', 'lib-sort': 'started',
  'lib-mine': '', 'lib-score': '', 'lib-played': '',
  // 'active', not '': that select has no empty option, and setting a value no
  // option carries leaves selectedIndex at -1 — the control renders blank AND the
  // archived filter matches neither branch, so archived games leak into the
  // default view. Both symptoms of the same typo.
  'lib-archived': 'active',
};

const libraryStatusBucket = (status) => status === 'playing' ? 0 : status === 'backlog' ? 2 : 1;

/** Put every Library control back to its default. Returns true if anything moved. */
function resetLibControls() {
  let changed = libSort !== null;
  libSort = null;
  for (const [id, v] of Object.entries(LIB_DEFAULTS)) {
    const el = $('#' + id);
    if (!el || el.value === v) continue;
    el.value = v;
    // A default naming an option that does not exist would silently blank the
    // control and disable its filter; fall back rather than ship a dead select.
    if (el.tagName === 'SELECT' && el.selectedIndex < 0) el.selectedIndex = 0;
    changed = true;
  }
  return changed;
}

/** Is the Library showing anything other than the default? Drives the reset button. */
function libIsDefault() {
  return libSort === null
    && Object.entries(LIB_DEFAULTS).every(([id, v]) => ($('#' + id)?.value ?? v) === v);
}

let libSort = null;   // { key, dir } — null means the dropdown is in charge

const LIB_COLUMNS = () => [
  { key: 'name',     label: 'Game',     cls: 'c-name', type: 'text', title: 'Game title' },
  { key: 'genre',    label: 'Genre',    cls: 'c-genre', type: 'text' },
  { key: 'status',   label: 'Status',   cls: 'c-status', type: 'text' },
  { key: 'players',  label: 'Players',  cls: 'c-num c-players', type: 'num',
    title: 'Max simultaneous online co-op players' },
  ...state.members.map((m) => ({
    key: `p:${m.steam_id}`, label: m.short_name, cls: 'c-p', type: 'num',
    color: colorOf(m.steam_id), title: `${m.short_name}'s own score` })),
  { key: 'raw',      label: 'Avg',      cls: 'c-num c-avg', type: 'num',
    title: 'The group\'s score: the plain mean of what people gave it. '
         + 'Read it next to Votes — a 9.0 from one person is not a 9.0 from four.' },
  { key: 'n',        label: 'Votes',    cls: 'c-num c-votes', type: 'num',
    title: 'How many of you have scored this. A high average from one person is '
         + 'thin evidence; this is the column that tells you so.' },
  { key: 'started',  label: 'Started',  cls: 'c-date', type: 'text',
    title: 'When you first played it. Steam publishes no first-played date, so this '
         + 'is typed by hand in the game\'s details.' },
  { key: 'hours',    label: 'Hrs',      cls: 'c-num c-hours', type: 'num',
    title: 'Hours logged for this game, entered by hand' },
];

const libValue = (g, key) => {
  if (key === 'players') return g.max_players;
  if (key === 'started') return g.started || null;
  if (key === 'hours')   return hoursOf(g).value;
  if (key === 'status')  return STATUS_LABEL[g.status];
  if (key.startsWith('p:')) return g.votes[key.slice(2)];
  return g[key];
};

function renderLibHead() {
  $('#lib-head').innerHTML = LIB_COLUMNS().map((c) => {
    const active = libSort?.key === c.key;
    const arrow = active ? (libSort.dir === 'asc' ? '▲' : '▼') : '';
    const ariaSort = active ? (libSort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="${c.cls} th-sort${active ? ' is-sorted' : ''}" aria-sort="${ariaSort}"
      ${c.color ? `style="color:${c.color}"` : ''}
      ${c.title ? `title="${esc(c.title)}"` : ''}>
        <button type="button" class="th-sort-btn" data-sort="${esc(c.key)}">
          ${esc(c.label)}<span aria-hidden="true">${arrow}</span>
        </button>
      </th>`;
  }).join('');

  $$('#lib-head .th-sort-btn').forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.sort;
    const col = LIB_COLUMNS().find((c) => c.key === key);
    libSort = libSort?.key === key
      ? { key, dir: libSort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: col.type === 'text' ? 'asc' : 'desc' };
    renderLibHead();
    renderLibrary();
  }));
}

/**
 * My own coverage, shown above the rating queue. Deliberately my number rather
 * than the group's: the group bars on the Group tab create the comparison, this
 * one just makes the personal debt impossible to miss while I am standing in
 * front of the thing that clears it.
 */
function renderMyCoverage() {
  const box = $('#my-coverage');
  const active = activeGames();
  // Games I marked "didn't play" leave my denominator entirely — I cannot rate
  // a session I wasn't in, so counting them would be a debt I can never clear.
  const mine = active.filter((g) => !(g.notPlayed || []).includes(state.me.steamId));
  const total = mine.length;
  if (!total) { box.hidden = true; return; }

  const rated = mine.filter((g) => g.votes[state.me.steamId] != null).length;
  const pct = Math.round((rated / total) * 100);
  const left = total - rated;

  $('#my-cov-left').textContent = left
    ? `${left} game${left === 1 ? '' : 's'} you haven't rated`
    : 'You have rated everything';
  $('#my-cov-pct').textContent = `${rated} of ${total} · ${pct}%`;
  $('#my-cov-fill').style.width = `${pct}%`;
  $('#my-cov-fill').style.background = colorOf(state.me.steamId);
  box.hidden = false;
}

const HISTORY_FIELD_LABEL = {
  started: 'First played', finished: 'Last played', hours: 'Hours together',
};
const historyFieldLabel = (field) => field === 'hours' && state.group.mode === 'personal'
  ? 'Hours played' : HISTORY_FIELD_LABEL[field];

async function loadHistory(force = false) {
  const slug = state.group?.slug;
  if (!slug || state.view !== 'library') return;
  if (state.history && !force) { renderHistoryCard(); return; }
  const seq = ++historySeq;
  try {
    const history = await gapiFor(slug, '/history');
    if (seq !== historySeq || state.group?.slug !== slug || state.view !== 'library') return;
    state.history = history;
    renderHistoryCard();
  } catch (e) {
    if (seq === historySeq && state.group?.slug === slug && state.view === 'library') toast(e.message);
  }
}

function renderHistoryCard() {
  const box = $('#history-card');
  const personal = state.group.mode === 'personal';
  $('#history-heading').textContent = personal ? 'Complete my history' : 'Complete our history';
  $('#history-intro').textContent = personal
    ? 'One small gap at a time, starting with facts Steam can suggest or you may remember.'
    : 'One small gap at a time, shown first to people most likely to remember.';
  const item = state.history?.items?.[0];
  if (!item) { box.hidden = true; return; }
  box.hidden = false;
  const total = Number(state.history.total) || 0;
  $('#history-count').textContent = `${total} gap${total === 1 ? '' : 's'} for you`;
  const suggestion = item.suggestion;
  const value = suggestion
    ? item.field === 'hours'
      ? `≈${fmt(suggestion.value, 1)} hours`
      : shortDate(suggestion.value)
    : null;
  const acceptLabel = suggestion
    ? item.field === 'hours' ? `Use ≈${fmt(suggestion.value, 1)} h`
      : suggestion.source === 'release-date' ? `Use release date · ${shortDate(suggestion.value)}`
      : `Use as approximate · ${shortDate(suggestion.value)}`
    : '';

  $('#history-prompt').innerHTML = `
    <div class="history-item">
      ${item.image
        ? `<img class="history-art" src="${esc(item.image)}" alt="" loading="lazy" decoding="async">`
        : '<span class="history-art history-art-none" aria-hidden="true">?</span>'}
      <div class="history-copy">
        <div class="rank-meta">
          <span class="chip">${esc(historyFieldLabel(item.field))}</span>
          ${suggestion ? `<span class="chip chip-warn">Approximate suggestion</span>` : ''}
        </div>
        <h4>${esc(item.game)}</h4>
        <p>${esc(item.prompt)}</p>
        ${suggestion ? `<div class="history-suggestion">
          <strong>${esc(value)}</strong>
          <span>${esc(suggestion.label)} · ${esc(suggestion.detail)}</span>
        </div>` : `<p class="history-no-suggestion">No trustworthy automatic suggestion is available.</p>`}
        ${item.likely ? '<p class="history-target">You rated, played, or added this game, so it came to you first.</p>' : ''}
      </div>
    </div>
    <div class="history-actions">
      ${suggestion ? `<button class="btn btn-primary" id="history-accept">${esc(acceptLabel)}</button>` : ''}
      <button class="btn${suggestion ? '' : ' btn-primary'}" id="history-edit">Enter a value</button>
      <button class="btn btn-ghost" id="history-snooze">Remind me next week</button>
      <button class="btn btn-ghost" id="history-dismiss">I don't know</button>
    </div>`;

  $('#history-accept')?.addEventListener('click', () => historyAction('accept'));
  $('#history-edit').addEventListener('click', () => openDetail(item.gameId, item.field));
  $('#history-snooze').addEventListener('click', () => historyAction('snooze'));
  $('#history-dismiss').addEventListener('click', () => historyAction('dismiss'));
}

async function historyAction(action) {
  const item = state.history?.items?.[0];
  const slug = state.group?.slug;
  if (!item || !slug) return;
  $$('#history-card button').forEach((button) => { button.disabled = true; });
  try {
    await gapiFor(slug, '/history', {
      method: 'POST', body: { gameId: item.gameId, field: item.field, action },
    });
    if (state.group?.slug !== slug) return;
    if (action === 'accept') {
      if (!await reloadGroupView(slug, 'library')) return;
      toast(`${historyFieldLabel(item.field)} saved as an approximate value`);
      return;
    }
    state.history = null;
    await loadHistory(true);
    toast(action === 'snooze' ? 'I’ll ask again next week'
      : state.group.mode === 'personal' ? 'Removed from your history prompts' : 'Left for somebody else to answer');
  } catch (e) {
    toast(e.message);
    renderHistoryCard();
  }
}

function renderLibrary() {
  $('#lib-reset').hidden = libIsDefault();
  const q = $('#lib-search').value.trim().toLowerCase();
  const status = $('#lib-status').value;
  const sort = $('#lib-sort').value;
  const mine = $('#lib-mine').value;
  const minScore = Number($('#lib-score').value) || 0;
  const played = $('#lib-played').value;
  const archived = $('#lib-archived').value;

  // Filters on the group average — the same number the table and Play next show.
  // Unclaimed seed identities count as voters — their imported ratings are real
  // scores, so a game they rated is not missing anyone's opinion.
  const voters = state.members.length;
  const rows = state.games.filter((g) => {
    // Archived is the first gate: an archived game should not show up in a status
    // or score filter unless it was explicitly asked for.
    if (archived === 'active' && g.archived_at) return false;
    if (archived === 'archived' && !g.archived_at) return false;
    if (status && g.status !== status) return false;
    if (q && !g.name.toLowerCase().includes(q) && !(g.genre || '').toLowerCase().includes(q)) return false;
    if (minScore && !(g.raw >= minScore)) return false;
    const eff = hoursOf(g).value;
    if (played === 'yes' && !(eff > 0)) return false;
    if (played === 'no' && eff > 0) return false;
    if (mine === 'unrated' && g.votes[state.me.steamId] != null) return false;
    if (mine === 'rated' && g.votes[state.me.steamId] == null) return false;
    if (mine === 'incomplete' && g.n >= voters) return false;
    return true;
  });

  if (libSort) {
    // Missing values always sink, whichever direction — a blank is not "smallest",
    // it is absent, and floating blanks to the top of an ascending sort makes the
    // table useless for exactly the question you asked it.
    const { key, dir } = libSort;
    const flip = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const x = libValue(a, key), y = libValue(b, key);
      const xm = x == null || x === '', ym = y == null || y === '';
      if (xm && ym) return a.name.localeCompare(b.name);
      if (xm) return 1;
      if (ym) return -1;
      return (typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x).localeCompare(String(y))) * flip;
    });
  } else {
    rows.sort({
      /* Keep the active story legible: games in progress lead, settled games share
         the date-sorted middle, and the backlog waits at the bottom. Missing dates
         sink within their tier and use the title as a deterministic fallback. */
      started:  (a, b) => {
        const byStatusBucket = libraryStatusBucket(a.status) - libraryStatusBucket(b.status);
        if (byStatusBucket) return byStatusBucket;
        if (a.started && b.started) return b.started.localeCompare(a.started);
        if (a.started) return -1;
        if (b.started) return 1;
        return a.name.localeCompare(b.name);
      },
      best:     (a, b) => (b.raw ?? -1) - (a.raw ?? -1),
      name:     (a, b) => a.name.localeCompare(b.name),
      spread:   (a, b) => (b.spread ?? -1) - (a.spread ?? -1),
      hours:    (a, b) => (hoursOf(b).value ?? -1) - (hoursOf(a).value ?? -1),
      votes:    (a, b) => a.n - b.n,
    }[sort]);
  }

  $('#lib-table tbody').innerHTML = rows.map((g) => `
    <tr data-id="${g.id}"${g.archived_at ? ' class="is-archived"' : ''}>
      <td class="c-name cell-strong">
        <button type="button" class="lib-open" aria-label="Open details for ${esc(g.name)}">
        <span class="lib-game">${g.header_image
          ? `<img class="lib-art" src="${esc(g.header_image)}" alt="" loading="lazy" decoding="async">`
          : '<span class="lib-art lib-art-none"></span>'}<span>${esc(g.name)}</span>${
        g.viability.ok === false ? ' <span class="chip chip-bad">' + esc(g.viability.label) + '</span>' : ''}${
        g.early_access ? ' <span class="chip chip-warn" title="Still in Early Access on Steam">EA</span>' : ''}</span>
        <span class="lib-mobile-meta">${g.archived_at ? 'Archived' : STATUS_LABEL[g.status]} · ${g.max_players ?? '?'} players · ${fmt(g.raw, 1)} avg · ${g.n || 0} votes</span>
        </button></td>
      <td class="c-genre">${esc(g.genre || '—')}</td>
      <td class="c-status">${g.archived_at
        ? '<span class="status-tag status-archived">Archived</span>'
        : `<span class="status-tag status-${esc(g.status)}">${STATUS_LABEL[g.status]}</span>`}</td>
      <td class="c-num c-players">${g.max_players ?? '?'}</td>
      ${state.members.map((m) => {
        const v = g.votes[m.steam_id];
        return v == null ? '<td class="c-p miss">·</td>' : `<td class="c-p">${fmt(v, 1)}</td>`;
      }).join('')}
      <td class="c-num c-avg cell-strong">${fmt(g.raw, 1)}</td>
      <td class="c-num c-votes">${g.n || '–'}</td>
      <td class="c-date">${g.started
        ? `<span${factIsApproximate(g, 'started') ? ' class="est"' : ''}
             title="${factIsApproximate(g, 'started') ? 'Approximate · ' : ''}Started ${esc(g.started)}">${
               factIsApproximate(g, 'started') ? '≈' : ''}${esc(shortDate(g.started))}</span>`
        : '–'}</td>
      <td class="c-num c-hours">${(() => {
        const h = hoursOf(g);
        if (!h.value) return '–';
        return h.manual
          ? fmtHours(h.value)
          : h.accepted
            ? `<span class="est" title="Approximate: accepted from an earlier Steam group-hours estimate. A snapshot, not a measurement.">≈${fmtHours(h.value)}</span>`
            : `<span class="est" title="Estimated: the smallest playtime among the ${h.participants} of you who played it. An upper bound on time played together, not a measurement.">≈${fmtHours(h.value)}</span>`;
      })()}</td>
    </tr>`).join('');

  $$('#lib-table tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => openDetail(Number(tr.dataset.id))));
  $$('#lib-table .lib-open').forEach((button) => button.addEventListener('click', (e) => {
    e.stopPropagation();
    openDetail(Number(button.closest('tr').dataset.id));
  }));
}

/* ══════════════════════════════ STATS ═════════════════════════════════ */
let statsSeq = 0;
let statsGenreMetric = 'games';

const STATUS_STAT_ORDER = ['backlog', 'playing', 'finished', 'sampled', 'unfinished', 'dropped'];

function renderStatusStats(s) {
  const items = STATUS_STAT_ORDER
    .map((status) => ({ status, count: s.statusCounts?.[status] || 0 }))
    .filter((item) => item.count > 0);
  const total = items.reduce((sum, item) => sum + item.count, 0);
  $('#status-shape').innerHTML = total ? `
    <div class="shape-bar" role="img" aria-label="${esc(items.map((item) =>
      `${STATUS_LABEL[item.status]} ${item.count}`).join(', '))}">
      ${items.map((item) => `<i class="shape-${item.status}"
        style="width:${(item.count / total) * 100}%"
        title="${esc(STATUS_LABEL[item.status])}: ${item.count}"></i>`).join('')}
    </div>
    <div class="shape-legend">
      ${items.map((item) => `<span><i class="shape-${item.status}"></i>
        <b>${item.count}</b> ${esc(STATUS_LABEL[item.status])}</span>`).join('')}
    </div>` : '';
}

function renderGenreStats(s) {
  const genres = s.genres || [];
  const coverage = s.genreCoverage || { games: 0, hoursGames: 0, ratedGames: 0 };
  const hasMetric = {
    games: genres.some((genre) => genre.games > 0),
    hours: genres.some((genre) => genre.hoursGames > 0),
    rating: genres.some((genre) => genre.ratedGames > 0),
  };
  if (!hasMetric[statsGenreMetric]) statsGenreMetric = 'games';

  let items, max, decimals, note;
  if (statsGenreMetric === 'hours') {
    items = genres.filter((genre) => genre.hoursGames > 0)
      .map((genre) => ({ label: genre.genre, value: genre.hours, display: `${fmtHours(genre.hours)}h` }))
      .sort((a, b) => b.value - a.value);
    max = Math.max(1, ...items.map((item) => item.value));
    decimals = 0;
    note = `Recorded hours for ${coverage.hoursGames} of ${coverage.games} played games with a genre. Missing time stays unknown.`;
  } else if (statsGenreMetric === 'rating') {
    items = genres.filter((genre) => genre.ratedGames > 0)
      .map((genre) => ({
        label: `${genre.genre} (${genre.ratedGames})`, value: genre.avg,
      })).sort((a, b) => b.value - a.value);
    max = 10;
    decimals = 2;
    note = 'Average score by genre. The number in brackets is how many played games had a rating.';
  } else {
    items = genres.filter((genre) => genre.games > 0)
      .map((genre) => ({ label: genre.genre, value: genre.games }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    max = Math.max(1, ...items.map((item) => item.value));
    decimals = 0;
    note = 'Games with a played outcome: finished, failed to finish, dropped or sampled.';
  }

  $('#genre-note').textContent = note;
  $('#genre-chart').innerHTML = barChart(
    items, max,
    statsGenreMetric === 'rating' ? (value) => (value >= 8 ? 'good' : value < 6.5 ? 'bad' : '') : () => '',
    decimals
  );
  $$('#genre-metrics button').forEach((button) => {
    const active = button.dataset.metric === statsGenreMetric;
    button.setAttribute('aria-pressed', String(active));
    button.disabled = !hasMetric[button.dataset.metric];
    button.onclick = () => {
      statsGenreMetric = button.dataset.metric;
      renderGenreStats(s);
    };
  });
}

function compactTimeline(items) {
  if (items.length <= 10) return items;
  const recent = items.slice(-9);
  const earlier = items.slice(0, -9).reduce((sum, item) => ({
    year: 'Earlier', started: sum.started + item.started, finished: sum.finished + item.finished,
  }), { started: 0, finished: 0 });
  return [earlier, ...recent];
}

function renderTimelineStats(s) {
  const timeline = compactTimeline(s.timeline || []);
  const coverage = s.timelineCoverage || {};
  $('#timeline-note').textContent = `Recorded ${coverage.started || 0} of ${coverage.startEligible || 0} starts and ${coverage.finished || 0} of ${coverage.finishEligible || 0} finishes.`;
  const max = Math.max(1, ...timeline.flatMap((year) => [year.started, year.finished]));
  $('#timeline-chart').innerHTML = timeline.length ? `
    <div class="timeline-legend"><span><i></i>Started</span><span><i></i>Finished</span></div>
    <div class="timeline-scroll">
      <div class="timeline-bars" style="--timeline-years:${timeline.length}">
        ${timeline.map((year) => `<div class="timeline-year" aria-label="${esc(String(year.year))}: ${year.started} started, ${year.finished} finished">
          <div class="timeline-columns">
            <span><b>${year.started || ''}</b><i style="height:${(year.started / max) * 100}%"></i></span>
            <span><b>${year.finished || ''}</b><i style="height:${(year.finished / max) * 100}%"></i></span>
          </div>
          <strong>${esc(String(year.year))}</strong>
        </div>`).join('')}
      </div>
    </div>` : '';
}

function renderScatterStats(s) {
  const points = s.timeVsRating || [];
  if (points.length < 6) {
    $('#scatter-chart').innerHTML = '';
    return;
  }
  const highest = Math.max(...points.map((point) => point.hours));
  const maxHours = Math.max(10, Math.ceil(highest / 10) * 10);
  $('#scatter-chart').innerHTML = `
    <div class="scatter-layout">
      <div class="scatter-y"><span>10</span><span>7</span><span>4</span><span>1</span></div>
      <div class="scatter-main">
        <div class="scatter-plot">
          <i style="bottom:0%"></i><i style="bottom:33.33%"></i>
          <i style="bottom:66.66%"></i><i style="bottom:100%"></i>
          ${points.map((point) => {
            const left = Math.max(2, Math.min(98, (point.hours / maxHours) * 100));
            const bottom = Math.max(2, Math.min(98, ((point.rating - 1) / 9) * 100));
            const pointHours = roundedHours(point.hours);
            const label = `${point.name} · ${fmt(point.rating, 1)} rating · ${fmtHours(point.hours)} hour${pointHours === 1 ? '' : 's'}`;
            const tone = point.rating >= 8 ? 'good' : point.rating < 6.5 ? 'bad' : '';
            const edge = left > 75 ? 'right' : left < 25 ? 'left' : '';
            return `<button type="button" class="scatter-point" data-id="${point.id}"
              data-tone="${tone}" data-edge="${edge}" data-label="${esc(label)}"
              aria-label="${esc(label)}" style="left:${left}%;bottom:${bottom}%"></button>`;
          }).join('')}
        </div>
        <div class="scatter-x"><span>0h</span><span>Hours played</span><span>${fmt(maxHours, 0)}h</span></div>
      </div>
    </div>`;
  $$('#scatter-chart .scatter-point').forEach((point) => {
    point.onclick = () => openDetail(Number(point.dataset.id));
  });
}

function renderPersonalStats(s) {
  const p = s.personalStats;
  if (!p) return;
  const completion = p.completion || {};
  const backlog = p.backlog || {};
  $('#personal-progress').innerHTML = [
    completion.rate == null ? '' : `<div class="callout-stat"><span>Finished</span>
      <strong>${completion.rate}%</strong><span>${completion.finished} of ${completion.outcomes} played outcomes</span></div>`,
    completion.medianFinishedHours == null ? '' : `<div class="callout-stat"><span>Typical finished game</span>
      <strong>${fmtHours(completion.medianFinishedHours)}h</strong><span>median recorded playtime</span></div>`,
    `<div class="callout-stat"><span>Still being figured out</span><strong>${completion.sampled || 0}</strong>
      <span>sampled game${completion.sampled === 1 ? '' : 's'}</span></div>`,
    `<div class="callout-stat"><span>Backlog check-in</span><strong>${backlog.unplayed || 0}</strong>
      <span>owned games never launched · ${backlog.unratedPlayed || 0} played but unrated</span></div>`,
    backlog.stalePlaying ? `<div class="callout-stat"><span>Paused runs</span><strong>${backlog.stalePlaying}</strong>
      <span>marked Playing with no Steam activity in six months</span></div>` : '',
  ].join('');

  const ratings = p.ratingDistribution || [];
  $('#personal-ratings').innerHTML = barChart(
    ratings.map((item) => ({ label: fmt(item.score, 1), value: item.count, display: String(item.count) })),
    Math.max(1, ...ratings.map((item) => item.count)), () => '', 0
  );

  const hourBands = (p.hourBands || []).filter((band) => band.count > 0);
  $('#personal-hours').innerHTML = barChart(
    hourBands.map((band) => ({ label: band.label, value: band.count, display: String(band.count) })),
    Math.max(1, ...hourBands.map((band) => band.count)), () => '', 0
  );
  const records = p.records || {};
  $('#personal-records').innerHTML = [
    records.biggestTimeSink ? `<div class="callout-stat"><span>Biggest time sink</span>
      <strong>${esc(records.biggestTimeSink.name)}</strong><span>${fmtHours(records.biggestTimeSink.hours)} hours</span></div>` : '',
    records.favoriteShort ? `<div class="callout-stat"><span>Short and excellent</span>
      <strong>${esc(records.favoriteShort.name)}</strong><span>${fmt(records.favoriteShort.rating, 1)} rating in ${fmtHours(records.favoriteShort.hours)} hours</span></div>` : '',
  ].join('');

  const achievements = p.achievements || {};
  $('#personal-achievement-note').textContent = achievements.syncedGames
    ? `${achievements.syncedGames} games analyzed from your public Steam achievements.`
    : 'Analyze your Steam achievements from Personal library settings to unlock this cabinet.';
  $('#personal-achievement-summary').innerHTML = achievements.syncedGames ? `
    <div class="callout-stat"><span>Unlocked</span><strong>${achievements.unlocked}</strong>
      <span>of ${achievements.total} achievements across synced games</span></div>
    <div class="callout-stat"><span>Perfect games</span><strong>${achievements.perfectGames}</strong>
      <span>every achievement unlocked</span></div>` : '';

  const suggestions = p.completionSuggestions || [];
  $('#personal-completion-suggestions').innerHTML = suggestions.length ? `
    <h4 class="stats-detail-label">Likely finished</h4>
    <div class="completion-suggestions">${suggestions.map((game) => `
      <div class="completion-suggestion">
        <span><strong>${esc(game.name)}</strong><small>${esc(game.evidence)} unlocked</small></span>
        <button class="btn btn-sm" type="button" data-finish-game="${game.id}">Mark finished</button>
      </div>`).join('')}</div>` : '';
  $$('#personal-completion-suggestions [data-finish-game]').forEach((button) => {
    button.onclick = async () => {
      const slug = state.group.slug;
      button.disabled = true;
      try {
        await gapiFor(slug, `/games/${button.dataset.finishGame}`, {
          method: 'PATCH', body: { status: 'finished' },
        });
        if (await reloadGroupView(slug, 'stats')) toast('Marked as finished');
      } catch (error) { toast(error.message); button.disabled = false; }
    };
  });

  const near = achievements.nearComplete || [];
  const recent = achievements.recentUnlocks || [];
  $('#personal-near-complete').innerHTML = [
    near.length ? `<h4 class="stats-detail-label">Close to 100%</h4><div class="compact-list">${near.map((game) =>
      `<span><b>${esc(game.name)}</b><em>${game.achieved}/${game.total}</em></span>`).join('')}</div>` : '',
    recent.length ? `<h4 class="stats-detail-label">Latest unlocks</h4><div class="compact-list">${recent.map((item) =>
      `<span><b>${esc(item.name)}</b><em>${esc(item.game)} · ${when(item.unlocktime)}</em></span>`).join('')}</div>` : '',
  ].join('');
}

async function renderStats() {
  const slug = state.group.slug;
  const seq = ++statsSeq;
  let s;
  try {
    s = state.cache.stats?.slug === slug
      ? state.cache.stats.data
      : await gapiFor(slug, '/stats');
  } catch (e) {
    if (seq === statsSeq && state.group?.slug === slug && state.view === 'stats') toast(e.message);
    return;
  }
  if (seq !== statsSeq || state.group?.slug !== slug || state.view !== 'stats') return;
  state.cache.stats = { slug, data: s };
  const personal = state.group.mode === 'personal';

  $('#stat-tiles').innerHTML = personal ? `
    ${tile(s.totals.games, 'games tracked')}
    ${tile(s.totals.finished, 'finished')}
    ${tile(s.totals.backlog, 'in the backlog')}
    ${tile(fmtHours(s.totals.hours), 'hours played', 'Steam sync or saved history')}
    ${tile(s.totals.ratings, 'ratings given')}
    ${s.totals.groupMean == null ? '' : tile(fmt(s.totals.groupMean, 2), 'average rating')}` : `
    ${tile(s.totals.games, 'games tracked')}
    ${tile(s.totals.finished, 'finished together')}
    ${tile(fmtHours(s.totals.hours), 'hours logged', 'manual or accepted history entries')}
    ${tile(s.totals.ratings, 'ratings given')}
    ${s.totals.groupMean == null ? '' : tile(fmt(s.totals.groupMean, 2), 'group average', 'across every score anyone has given')}
    ${tile(s.totals.unviableBacklog, 'backlog games we cannot play', `fewer than ${s.totals.maxPlayers} co-op slots`, true)}`;

  $('#people-list').innerHTML = s.people.map((p) => `
    <div class="person">
      <div class="person-swatch" style="background:${colorOf(p.steamId)}"></div>
      <div>
        <div class="person-name">${esc(p.name)}</div>
        <div class="person-sub">${p.count} ratings · ${p.coverage}% of the library · range ${fmt(p.min, 1)}–${fmt(p.max, 1)}</div>
        <div class="person-bar"><i style="width:${p.coverage}%;background:${colorOf(p.steamId)}"></i></div>
      </div>
      <div class="person-mean"><b>${fmt(p.mean, 2)}</b><span>avg · ±${fmt(p.sd, 2)}</span></div>
    </div>`).join('');

  renderStatusStats(s);
  renderGenreStats(s);
  renderTimelineStats(s);
  renderScatterStats(s);
  if (personal) renderPersonalStats(s);

  $('#arg-legend').innerHTML = state.members.map((m) =>
    `<span><i class="dot" style="background:${colorOf(m.steam_id)}"></i>${esc(m.short_name)}</span>`).join('');
  $('#arg-chart').innerHTML = s.arguments.length
    ? s.arguments.map((a) => `
        <div class="dot-row">
          <span class="bar-label">${esc(a.name)}</span>
          <div class="dot-track">${Object.entries(a.votes).map(([id, v]) =>
            `<i class="dot-mark" style="left:${((v - 1) / 9) * 100}%;background:${colorOf(id)}" title="${esc(nameOf(id))}: ${fmt(v, 1)}"></i>`
          ).join('')}</div>
          <span class="dot-spread">${fmt(a.spread, 1)}</span>
        </div>`).join('') + '<div class="dot-axis"><span>1</span><span>4</span><span>7</span><span>10</span></div>'
    : '<p class="panel-sub">Nothing to argue about yet — two people need to rate the same played game.</p>';

  $('#top-chart').innerHTML = barChart(s.topRated.map((g) => ({ label: g.name, value: g.raw })), 10);

  /* ── who agrees with whom ───────────────────────────────────────────────── */
  // Lower gap = more alike, so the bar is inverted: a long bar means agreement,
  // which is the way round people expect to read it.
  const maxGap = Math.max(1, ...s.pairs.map((p) => p.gap));
  $('#pairs-chart').innerHTML = s.pairs.length
    ? s.pairs.map((p) => `
      <div class="bar-row">
        <div class="bar-label">${esc(p.a)} &amp; ${esc(p.b)} <span class="bar-sub">${p.n}</span></div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.round((1 - p.gap / (maxGap * 1.15)) * 100)}%"></div>
        </div>
        <div class="c-num">${fmt(p.gap, 2)}</div>
      </div>`).join('')
    : '<p class="panel-sub" style="margin:0">Not enough overlap yet — five games rated by the same two people.</p>';

  $('#twins-summary').innerHTML = [
    s.tasteTwins ? `<div class="callout-stat"><span>Closest taste</span>
      <strong>${esc(s.tasteTwins.a)} &amp; ${esc(s.tasteTwins.b)}</strong>
      <span>${fmt(s.tasteTwins.gap, 2)} apart on average</span></div>` : '',
    s.tasteOpposites ? `<div class="callout-stat"><span>Never let these two pick</span>
      <strong>${esc(s.tasteOpposites.a)} &amp; ${esc(s.tasteOpposites.b)}</strong>
      <span>${fmt(s.tasteOpposites.gap, 2)} apart on average</span></div>` : '',
  ].join('');

  /* ── who is out on a limb ───────────────────────────────────────────────── */
  $('#contrarian-chart').innerHTML = s.contrarian.length
    ? barChart(s.contrarian.map((c) => ({ label: c.name, value: c.gap })),
               Math.max(1, ...s.contrarian.map((c) => c.gap)))
    : '<p class="panel-sub" style="margin:0">Needs a few games where two others also voted.</p>';

  $('#offbeat-list').innerHTML = s.offbeat.map((o) => `
    <div class="callout-stat">
      <span>${esc(o.name)} on ${esc(o.genre)}</span>
      <strong>${o.diff > 0 ? '+' : ''}${fmt(o.diff, 1)}</strong>
      <span>vs the others, over ${o.n} game${o.n === 1 ? '' : 's'}</span>
    </div>`).join('');

  /* ── nobody has an opinion ──────────────────────────────────────────────── */
  $('#shrugged-list').innerHTML = s.shrugged.length
    ? s.shrugged.map((g) => `
        <button class="shrug" data-id="${g.id}">
          <span>${esc(g.name)}</span>
          <span class="chip">${g.skips} skipped it</span>
        </button>`).join('')
    : '<p class="panel-sub" style="margin:0">Nothing has been collectively shrugged at. Good sign.</p>';
  $$('#shrugged-list .shrug').forEach((b) =>
    b.addEventListener('click', () => openDetail(Number(b.dataset.id))));
  $('#hours-chart').innerHTML = barChart(
    s.mostHours.map((g) => ({ label: g.name, value: g.hours, display: `${fmtHours(g.hours)}h` })),
    Math.max(...s.mostHours.map((g) => g.hours), 1), () => '', 0);

  // An empty chart is not a statistic. Personal workspaces also omit every
  // comparison that needs another person, while retaining their own history,
  // genres, ratings and playtime.
  const panelData = {
    'stats-shape': s.totals.games > 0,
    'stats-timeline': s.timeline.length > 0,
    'stats-scatter': s.timeVsRating.length >= 6,
    'stats-people': !personal && s.people.some((person) => person.count > 0),
    'stats-genres': s.genres.some((genre) => genre.games > 0),
    'stats-pairs': !personal && s.pairs.length > 0,
    'stats-outliers': !personal && (s.contrarian.length > 0 || s.offbeat.length > 0),
    'stats-top': s.topRated.length > 0,
    'stats-hours': s.mostHours.length > 0,
    'stats-shrugged': !personal && s.shrugged.length > 0,
    'stats-arguments': !personal && s.arguments.length > 0,
    'stats-personal-progress': personal && (s.personalStats?.completion?.outcomes > 0
      || s.personalStats?.backlog?.unplayed > 0),
    'stats-personal-ratings': personal && s.personalStats?.ratingDistribution?.length > 0,
    'stats-personal-hours': personal && s.personalStats?.hourBands?.some((band) => band.count > 0),
    'stats-personal-achievements': personal && (s.personalStats?.achievements?.syncedGames > 0
      || s.personalStats?.completionSuggestions?.length > 0),
  };
  for (const [id, visible] of Object.entries(panelData)) $(`#${id}`).hidden = !visible;
  $$('.stats-grid').forEach((row) => {
    const visible = [...row.children].filter((panel) => !panel.hidden).length;
    row.hidden = visible === 0;
    row.classList.toggle('single', visible === 1);
  });
}

const tile = (val, label, note = '', alert = false) => `
  <div class="tile${alert ? ' tile-alert' : ''}">
    <div class="tile-val">${val}</div><div class="tile-label">${label}</div>
    ${note ? `<div class="tile-note">${note}</div>` : ''}
  </div>`;

function barChart(items, max, tone = () => '', decimals = 2) {
  if (!items.length) return '<p class="panel-sub">Nothing here yet.</p>';
  return items.map((it) => `
    <div class="bar-row"${tone(it.value) ? ` data-tone="${tone(it.value)}"` : ''}>
      <span class="bar-label" title="${esc(it.label)}">${esc(it.label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (it.value / max) * 100)}%"></div></div>
      <span class="bar-val">${it.display ?? fmt(it.value, decimals)}</span>
    </div>`).join('');
}

/* ══════════════════════════════ GROUP ═════════════════════════════════ */
let membersSeq = 0;

async function renderMembers() {
  const slug = state.group.slug;
  const seq = ++membersSeq;
  let d;
  try {
    d = state.cache.members?.slug === slug
      ? state.cache.members.data
      : await gapiFor(slug, '/members');
  } catch (e) {
    if (seq === membersSeq && state.group?.slug === slug && state.view === 'members') toast(e.message);
    return;
  }
  if (seq !== membersSeq || state.group?.slug !== slug || state.view !== 'members') return;
  state.cache.members = { slug, data: d };
  const isOwner = d.group.role === 'owner';
  const personal = d.group.mode === 'personal';
  $('#workspace-heading').textContent = personal ? 'Personal library settings' : 'Group';
  $('#group-coverage-panel').hidden = personal;
  $('#group-members-panel').hidden = personal;
  $('#group-invite-panel').hidden = personal;
  $('#workspace-settings-grid').classList.toggle('single', personal);
  $('#playtime-title').textContent = personal ? 'Your Steam playtime' : 'Steam playtime';
  $('#playtime-copy').innerHTML = personal
    ? 'Sync your public Steam library to fill ownership, playtime and recent-played hints. '
      + 'Steam never exposes a first-played date, so that remains yours to record.'
    : 'Group hours are estimated from Steam: the smallest playtime among the people who actually '
      + 'played a game. That is an upper bound on time you played it <em>together</em> — Steam records '
      + 'how long each of you played, never when or with whom. A figure saved in the Library stays put; '
      + 'accepted estimates remain visibly approximate.';
  $('#pt-import').hidden = !personal;
  $('#pt-achievements').hidden = !personal;
  $('#pt-enrich').hidden = !personal;

  /* ── coverage leaderboard ──────────────────────────────────────────────── */
  const active = activeGames();
  const ranked = d.members
    .map((m) => {
      // Per-person denominator: everyone has their own set of games they sat out.
      const total = active.filter((g) => !(g.notPlayed || []).includes(m.steam_id)).length;
      return { ...m, total, pct: total ? Math.round((m.ratings / total) * 100) : 0 };
    })
    .sort((a, b) => b.pct - a.pct || a.short_name.localeCompare(b.short_name));

  $('#coverage-bars').innerHTML = ranked.map((m) => `
    <div class="bar-row">
      <div class="bar-label">${esc(m.short_name)} <span class="bar-sub">${m.ratings}/${m.total}</span></div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${m.pct}%;background:${colorOf(m.steam_id)}"></div>
      </div>
      <div class="c-num">${m.pct}%</div>
    </div>`).join('');

  // Name the percentage-point gap rather than comparing raw rating counts: each
  // person can have a different denominator after marking games they did not play.
  const note = $('#coverage-note');
  // active.length, not `total` — that was a group-wide count before denominators
  // went per person, and referencing it after the rename threw here, killing every
  // panel rendered further down this function (Members, Settings, Invite).
  if (ranked.length < 2 || !active.length) {
    note.textContent = '';
  } else {
    const lead = ranked[0];
    const last = ranked[ranked.length - 1];
    const gap = lead.pct - last.pct;
    note.textContent = gap
      ? `${last.short_name} is ${gap} percentage point${gap === 1 ? '' : 's'} behind ${lead.short_name}.`
      : 'Everyone has the same rating coverage.';
  }

  $('#member-list').innerHTML = d.members.map((m) => `
    <div class="person">
      <div class="person-swatch" style="background:${colorOf(m.steam_id)}"></div>
      <div>
        <div class="person-name">${esc(m.short_name)}
          ${m.role === 'owner' ? '<span class="chip">owner</span>' : ''}
          ${m.is_seed ? '<span class="chip chip-warn">unclaimed</span>' : ''}</div>
        <div class="person-sub">${m.ratings} ratings${
          m.is_seed ? ' · waiting for someone to claim it' : ` · ${esc(m.display_name || '')}`}</div>
      </div>
      <div>${(isOwner && m.steam_id !== state.me.steamId) || m.steam_id === state.me.steamId
        ? `<button class="btn btn-sm btn-ghost" data-remove="${esc(m.steam_id)}">${
            m.steam_id === state.me.steamId ? 'Leave' : 'Remove'}</button>` : ''}</div>
    </div>`).join('');

  $$('#member-list [data-remove]').forEach((b) => b.addEventListener('click', async () => {
    const slug = state.group.slug;
    const self = b.dataset.remove === state.me.steamId;
    if (!confirm(self ? 'Leave this group? Your ratings here are deleted.'
                      : 'Remove this member and all their ratings?')) return;
    try {
      await gapiFor(slug, '/members', { method: 'DELETE', body: { steamId: b.dataset.remove } });
      if (state.group?.slug !== slug) return;
      if (self) { state.groups = (await api('/api/me')).groups; state.group = null; location.hash = ''; return boot(); }
      if (await reloadGroupView(slug, 'members')) toast('Removed');
    } catch (e) { toast(e.message); }
  }));

  $('#group-settings').innerHTML = `
    <div class="detail-field">
      <label for="s-myname">${personal ? 'Your display name' : 'Your name in this group'}</label>
      <input id="s-myname" class="input" maxlength="16" value="${esc(
        d.members.find((m) => m.steam_id === state.me.steamId)?.short_name || '')}">
    </div>
    <div class="detail-field" style="margin-top:12px">
      <label for="s-name">Workspace name</label>
      <input id="s-name" class="input" maxlength="60" value="${esc(d.group.name)}" ${isOwner ? '' : 'disabled'}>
    </div>
    <div class="detail-field" style="margin-top:12px">
      <label for="s-mode">Workspace type</label>
      <select id="s-mode" class="input" ${isOwner ? '' : 'disabled'}>
        <option value="coop"${personal ? '' : ' selected'}>Co-op group</option>
        <option value="personal"${personal ? ' selected' : ''}${d.members.length > 1 ? ' disabled' : ''}>Personal library</option>
      </select>
    </div>
    <p class="field-help">${d.members.length > 1
      ? 'A group can become personal only after the other members leave or are removed.'
      : 'You can switch a one-person group without losing its games, ratings or history.'}</p>
    <div class="detail-field" id="s-size-wrap" style="margin-top:12px" ${personal ? 'hidden' : ''}>
      <label for="s-size">How many of you play together</label>
      <input id="s-size" class="input" type="number" min="2" max="64" value="${d.group.maxPlayers < 2 ? 4 : d.group.maxPlayers}" ${isOwner ? '' : 'disabled'}>
    </div>
    <p class="field-help" id="s-size-help" ${personal ? 'hidden' : ''}>Games that can't fit this many get flagged on Play next.</p>
    <button class="btn btn-primary" id="s-save" style="margin-top:12px">Save</button>

    ${isOwner ? `
    <hr class="settings-rule">
    <div class="danger">
      <strong>Delete this ${personal ? 'personal library' : 'group'}</strong>
      <p class="field-help">Removes the workspace and everything in it — every game, every rating,
        every comment and every member. There is no undo. Download a portable backup first;
        archiving a single game is on its row in the Library.</p>
      <div class="export-links" aria-label="Download ${personal ? 'personal library' : 'group'} backup">
        <a class="btn btn-sm" href="/api/g/${encodeURIComponent(slug)}/export?format=json">Download JSON backup</a>
        <span>CSV:</span>
        ${['games', 'history', 'ratings', 'comments', 'members'].map((table) =>
          `<a href="/api/g/${encodeURIComponent(slug)}/export?format=csv&table=${table}">${table}</a>`).join(' · ')}
      </div>
      <label class="field">
        <span>Type <code>${esc(d.group.name)}</code> to confirm</span>
        <input class="input" id="s-del-name" autocomplete="off" placeholder="${esc(d.group.name)}">
      </label>
      <button class="btn btn-danger" id="s-delete">Delete ${personal ? 'library' : 'group'} permanently</button>
      <p id="s-del-status" class="add-status"></p>
    </div>` : ''}

    ${personal ? '' : `<hr class="settings-rule">
    <label class="toggle" for="s-blind">
      <input type="checkbox" id="s-blind" ${d.group.blindRating ? 'checked' : ''} ${isOwner ? '' : 'disabled'}>
      Everyone rates blind
    </label>
    <p class="field-help">${isOwner
      ? 'Hides everyone\'s ratings from each other while rating, for the whole group, and stops the '
        + 'slider opening on the current average — which anchors just as much as seeing the numbers. '
        + 'Applies immediately.'
      : 'Only the group owner can change this. It applies to everyone, because one person rating '
        + 'blind while the rest see the numbers achieves nothing.'}</p>`}`;

  if (isOwner) $('#s-delete').addEventListener('click', async () => {
    const slug = state.group.slug;
    const typed = $('#s-del-name').value.trim();
    if (typed !== d.group.name) {
      $('#s-del-status').textContent = 'Type the group name exactly to confirm.';
      return;
    }
    if (!confirm(`Delete "${d.group.name}" and every rating in it? This cannot be undone.`)) return;
    $('#s-delete').disabled = true;
    try {
      const r = await gapiFor(slug, '/group', { method: 'DELETE', body: { confirmName: typed } });
      if (state.group?.slug !== slug) return;
      toast(`Deleted ${d.group.name} — ${r.deleted.games} games, ${r.deleted.ratings} ratings`);
      state.groups = (await api('/api/me')).groups;
      state.group = null;
      location.hash = '';
      return boot();
    } catch (e) {
      $('#s-del-status').textContent = e.message;
      $('#s-delete').disabled = false;
    }
  });

  void renderPlaytime();
  $('#pt-sync').addEventListener('click', syncPlaytime);
  $('#pt-import').onclick = openSteamImport;
  $('#pt-achievements').onclick = analyzeAchievements;
  $('#pt-enrich').onclick = enrichSteamMetadata;

  if (isOwner) $('#s-blind')?.addEventListener('change', async (e) => {
    const slug = state.group.slug;
    try {
      await gapiFor(slug, '/members', { method: 'PATCH', body: { blindRating: e.target.checked } });
      if (!await reloadGroupView(slug, state.view)) return;
      toast(e.target.checked ? 'Everyone now rates blind' : 'Ratings visible to everyone again');
      if (state.view === 'queue') renderQueue();
    } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  });

  $('#s-save').addEventListener('click', async () => {
    const slug = state.group.slug;
    const patch = { myName: $('#s-myname').value };
    if (isOwner) {
      patch.name = $('#s-name').value;
      patch.mode = $('#s-mode').value;
      if (patch.mode === 'coop') patch.maxPlayers = Number($('#s-size').value);
    }
    try {
      await gapiFor(slug, '/members', { method: 'PATCH', body: patch });
      if (state.group?.slug !== slug) return;
      state.groups = (await api('/api/me')).groups;
      if (await reloadGroupView(slug, 'members')) toast('Saved');
    } catch (e) { toast(e.message); }
  });

  $('#s-mode')?.addEventListener('change', (event) => {
    const isPersonal = event.target.value === 'personal';
    $('#s-size-wrap').hidden = isPersonal;
    $('#s-size-help').hidden = isPersonal;
  });

  const link = d.group.inviteCode ? `${location.origin}/?join=${d.group.inviteCode}` : null;
  $('#invite-panel').innerHTML = !isOwner
    ? '<p class="panel-sub">Ask the group owner for an invite link.</p>'
    : link
      ? `<p class="panel-sub">Anyone with this link can join. Rotate it if it leaks.</p>
         <div class="invite-row">
           <input class="input" id="invite-link" readonly value="${esc(link)}">
           <button class="btn" id="invite-copy">Copy</button>
           <button class="btn btn-ghost" id="invite-rotate">Rotate</button>
           <button class="btn btn-ghost" id="invite-off">Disable</button>
         </div>`
      : `<p class="panel-sub">Joining by link is disabled — nobody new can get in.</p>
         <button class="btn btn-primary" id="invite-on">Create an invite link</button>`;

  $('#invite-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
    catch { $('#invite-link').select(); toast('Press Ctrl+C to copy'); }
  });
  const setInvite = async (mode) => {
    const slug = state.group.slug;
    try {
      await gapiFor(slug, '/members', { method: 'PATCH', body: { invite: mode } });
      await reloadGroupView(slug, 'members');
    }
    catch (e) { toast(e.message); }
  };
  $('#invite-rotate')?.addEventListener('click', () => setInvite('rotate'));
  $('#invite-off')?.addEventListener('click', () => setInvite('off'));
  $('#invite-on')?.addEventListener('click', () => setInvite('rotate'));
}

/* ══════════════════════════════ ADD GAME ══════════════════════════════ */
let steamSearchSeq = 0;

function openAdd() {
  steamSearchSeq++;
  $('#add-manual').open = false;
  ['#man-name', '#man-genre', '#man-players'].forEach((sel) => { $(sel).value = ''; });
  $('#man-status').textContent = '';
  $('#add-input').value = '';
  $('#add-results').innerHTML = '';
  $('#add-status').textContent = 'Search Steam, or paste a store link.';
  $('#add-dialog').showModal();
  setTimeout(() => $('#add-input').focus(), 50);
}

async function runSearch(term) {
  const seq = ++steamSearchSeq;
  if (!term || term.trim().length < 2) { $('#add-results').innerHTML = ''; return; }
  $('#add-status').textContent = 'Searching Steam…';
  try {
    const { results } = await api(`/api/steam/search?q=${encodeURIComponent(term.trim())}`);
    if (seq !== steamSearchSeq || !$('#add-dialog').open) return;
    if (!results.length) { $('#add-status').textContent = 'No matches on Steam.'; $('#add-results').innerHTML = ''; return; }
    $('#add-status').textContent = '';
    // Whether it is already on the list is the first thing you want to know here;
    // finding out by getting a 409 after clicking Add is a poor substitute.
    const byAppid = new Map(state.games.filter((g) => g.steam_appid).map((g) => [g.steam_appid, g]));
    $('#add-results').innerHTML = results.map((r) => {
      const appid = Number(r.appid);
      const storeUrl = steamStoreUrl(appid);
      if (!storeUrl) return '';
      const have = byAppid.get(appid);
      return `
      <div class="add-hit${have ? ' is-have' : ''}" data-appid="${appid}">
        <img src="${esc(r.image || '')}" alt="" loading="lazy">
        <span class="add-hit-copy">
          <b>${esc(r.name)}</b><br><span>${esc(r.price || '')} ${esc(r.release || '')}</span><br>
          <a class="add-hit-store" href="${storeUrl}" target="_blank" rel="noopener"
             aria-label="Open ${esc(r.name)} on Steam (new tab)">Steam page ↗</a>
        </span>
        ${have
          ? `<span class="chip chip-good">already in ${esc(STATUS_LABEL[have.status] || 'your library')}</span>`
          : `<button type="button" class="btn btn-sm" data-add-appid="${appid}">Add</button>`}
      </div>`;
    }).join('');
    $$('#add-results [data-add-appid]').forEach((b) =>
      b.addEventListener('click', () => addGame(b.dataset.addAppid, b)));
  } catch (e) {
    if (seq === steamSearchSeq && $('#add-dialog').open) $('#add-status').textContent = e.message;
  }
}

async function addGame(appid, btn) {
  const slug = state.group.slug;
  btn.disabled = true;
  $('#add-status').textContent = 'Adding…';
  try {
    const r = await gapiFor(slug, '/games', { method: 'POST', body: { input: appid } });
    if (!await reloadGroupView(slug, 'queue')) return;
    $('#add-dialog').close();
    toast(`Added ${r.name}. Set its player count so we know if we can all play.`);
  } catch (e) { $('#add-status').textContent = e.message; btn.disabled = false; }
}

/** Add a game that has no Steam page at all. */
async function addManual() {
  const name = $('#man-name').value.trim();
  if (name.length < 2) { $('#man-status').textContent = 'Give the game a name.'; return; }
  const btn = $('#man-add');
  const slug = state.group.slug;
  btn.disabled = true;
  $('#man-status').textContent = 'Adding…';
  try {
    const r = await gapiFor(slug, '/games', {
      method: 'POST',
      body: {
        manual: true,
        name,
        genre: $('#man-genre').value.trim() || null,
        maxPlayers: Number($('#man-players').value) || null,
      },
    });
    if (!await reloadGroupView(slug, 'queue')) return;
    $('#add-dialog').close();
    toast(`Added ${r.name} by hand. No trailer — set a player count from the Library if it needs one.`);
  } catch (e) {
    $('#man-status').textContent = e.message;
  } finally { btn.disabled = false; }
}

/** Who the playtime sync can and cannot read. */
let playtimeSeq = 0;

async function renderPlaytime() {
  const slug = state.group.slug;
  const seq = ++playtimeSeq;
  const box = $('#pt-members');
  try {
    const result = state.cache.playtime?.slug === slug
      ? state.cache.playtime.data
      : await gapiFor(slug, '/playtime');
    if (seq !== playtimeSeq || state.group?.slug !== slug || state.view !== 'members') return;
    state.cache.playtime = { slug, data: result };
    const { members } = result;
    box.innerHTML = members.map((m) => {
      // Three genuinely different states, and conflating them is what makes a
      // privacy warning feel like nagging: a placeholder has no account to read,
      // an unsynced member has simply not been asked yet, and a private profile
      // is the only one that needs the person to do something.
      const state = m.seed
        ? '<span class="chip">placeholder — no Steam account yet</span>'
        : m.syncedAt == null
          ? '<span class="chip">not synced yet</span>'
          : m.readable
            ? `<span class="chip chip-good">${m.played} games with playtime</span>`
            : `<span class="chip chip-warn">${m.owned > 0 ? 'playtime hidden' : 'library hidden'}</span>`;
      return `
        <div class="person">
          <div class="person-swatch" style="background:${colorOf(m.steamId)}"></div>
          <div>
            <div class="person-name">${esc(m.name)}</div>
            <div class="person-sub">${m.syncedAt ? `synced ${when(m.syncedAt)}` : 'never synced'}</div>
          </div>
          <div>${state}</div>
        </div>`;
    }).join('');

    // One line per distinct cause, because the two fixes are different settings.
    const blocked = members.filter((m) => m.readable === false);
    $('#pt-status').innerHTML = blocked.length
      ? blocked.map((m) => `<span class="pt-fix">${esc(m.name)}: ${esc(m.reason || '')}</span>`).join('')
        + (state.group.mode === 'personal' ? '' : '<span class="pt-fix">Estimates still work from whoever we can read.</span>')
      : '';
  } catch (e) {
    if (seq === playtimeSeq && state.group?.slug === slug && state.view === 'members') {
      box.innerHTML = `<p class="panel-sub" style="margin:0">${esc(e.message)}</p>`;
    }
  }
}

async function syncPlaytime() {
  const slug = state.group.slug;
  const btn = $('#pt-sync');
  btn.disabled = true;
  $('#pt-status').textContent = 'Asking Steam…';
  try {
    const r = await gapiFor(slug, '/playtime', { method: 'POST' });
    if (!await reloadGroupView(slug, 'members')) return;
    await renderPlaytime();
    const ok = r.members.filter((m) => m.ok).length;
    toast(state.group.mode === 'personal'
      ? 'Your Steam library is up to date'
      : `Synced ${ok}/${r.members.length} — ${r.gamesEstimated} games got an estimate`);
  } catch (e) {
    $('#pt-status').textContent = e.message;
  } finally { btn.disabled = false; }
}

const STEAM_IMPORT_LIMIT = 50;
const steamImport = {
  items: [], selected: new Set(), nextOffset: 0, hasMore: false, ambiguousPlaytime: false,
};

function renderSteamImportList() {
  $('#steam-import-list').innerHTML = steamImport.items.map((game) => `
    <label class="steam-import-item">
      <input type="checkbox" value="${game.appid}" ${steamImport.selected.has(game.appid) ? 'checked' : ''}>
      ${game.image ? `<img src="${esc(game.image)}" alt="" loading="lazy">` : '<span class="steam-import-placeholder"></span>'}
      <span><strong>${esc(game.name)}</strong><small>${game.played
        ? `${fmtHours(game.hours)}h${game.lastPlayed ? ` · last played ${esc(game.lastPlayed)}` : ''}`
        : 'Owned, never launched'}</small></span>
      <a href="${steamStoreUrl(game.appid)}" target="_blank" rel="noopener" aria-label="Open ${esc(game.name)} on Steam">Steam ↗</a>
    </label>`).join('') || '<p class="panel-sub">Nothing new to import with these filters.</p>';
  $$('#steam-import-list input').forEach((checkbox) => {
    checkbox.onchange = () => {
      const appid = Number(checkbox.value);
      if (checkbox.checked && steamImport.selected.size >= STEAM_IMPORT_LIMIT) {
        checkbox.checked = false;
        $('#steam-import-status').textContent = `Import up to ${STEAM_IMPORT_LIMIT} games at a time.`;
      } else if (checkbox.checked) steamImport.selected.add(appid);
      else steamImport.selected.delete(appid);
      $('#steam-import-selected').textContent = `${steamImport.selected.size} selected`;
    };
  });
  $('#steam-import-selected').textContent = `${steamImport.selected.size} selected`;
  $('#steam-import-select').textContent = steamImport.items.length
    && steamImport.items.every((game) => steamImport.selected.has(game.appid))
    ? 'Clear selection'
    : steamImport.items.length > STEAM_IMPORT_LIMIT ? `Select first ${STEAM_IMPORT_LIMIT}` : 'Select all shown';
  $('#steam-import-more').hidden = !steamImport.hasMore;
}

async function loadSteamImport(reset = false) {
  const slug = state.group.slug;
  if (reset) {
    steamImport.items = [];
    steamImport.selected.clear();
    steamImport.nextOffset = 0;
    steamImport.hasMore = false;
    steamImport.ambiguousPlaytime = false;
  }
  $('#steam-import-status').textContent = 'Reading your public Steam library…';
  try {
    const result = await gapiFor(slug, '/steam-import', {
      method: 'POST', body: {
        action: 'preview', offset: steamImport.nextOffset,
        includeUnplayed: $('#steam-import-unplayed').checked,
      },
    });
    if (state.group?.slug !== slug || !$('#steam-import-dialog').open) return;
    for (const game of result.items) {
      if (!steamImport.items.some((item) => item.appid === game.appid)) steamImport.items.push(game);
      if (steamImport.selected.size < STEAM_IMPORT_LIMIT) steamImport.selected.add(game.appid);
    }
    steamImport.nextOffset = result.nextOffset;
    steamImport.hasMore = result.hasMore;
    steamImport.ambiguousPlaytime = !result.counts.playtimeReadable;
    $('#steam-import-summary').textContent = steamImport.ambiguousPlaytime
      ? `Steam shows zero playtime across all ${result.counts.owned} owned games. Your playtime may be hidden; only import these as Backlog if that is what you want.`
      : `${result.counts.missingPlayed} played and ${result.counts.missingUnplayed} unplayed games are not tracked yet.`;
    $('#steam-import-status').textContent = '';
    renderSteamImportList();
  } catch (error) { $('#steam-import-status').textContent = error.message; }
}

function openSteamImport() {
  $('#steam-import-unplayed').checked = false;
  $('#steam-import-dialog').showModal();
  void loadSteamImport(true);
}

$('#steam-import-unplayed').onchange = () => void loadSteamImport(true);
$('#steam-import-more').onclick = () => void loadSteamImport(false);
$('#steam-import-select').onclick = () => {
  const allSelected = steamImport.items.every((game) => steamImport.selected.has(game.appid));
  for (const game of steamImport.items) {
    if (allSelected) steamImport.selected.delete(game.appid);
    else if (steamImport.selected.size < STEAM_IMPORT_LIMIT) steamImport.selected.add(game.appid);
  }
  $('#steam-import-status').textContent = !allSelected && steamImport.items.length > STEAM_IMPORT_LIMIT
    ? `Selected the first ${STEAM_IMPORT_LIMIT}; import them before continuing.` : '';
  renderSteamImportList();
};
$('#steam-import-submit').onclick = async () => {
  const appids = [...steamImport.selected];
  if (!appids.length) { $('#steam-import-status').textContent = 'Select at least one game.'; return; }
  if (appids.length > STEAM_IMPORT_LIMIT) {
    $('#steam-import-status').textContent = `Import up to ${STEAM_IMPORT_LIMIT} games at a time.`;
    return;
  }
  const acceptAmbiguousZero = steamImport.ambiguousPlaytime
    ? confirm('Steam reports zero playtime for every owned game. Import the selection as Backlog anyway?')
    : false;
  if (steamImport.ambiguousPlaytime && !acceptAmbiguousZero) return;
  const slug = state.group.slug;
  const button = $('#steam-import-submit');
  button.disabled = true;
  $('#steam-import-status').textContent = 'Importing your games…';
  try {
    const result = await gapiFor(slug, '/steam-import', {
      method: 'POST', body: { action: 'import', appids, acceptAmbiguousZero },
    });
    if (result.metadataRemaining) {
      $('#steam-import-status').textContent = 'Adding Steam artwork for the first games…';
      await gapiFor(slug, '/steam-import', { method: 'POST', body: { action: 'enrich' } });
    }
    $('#steam-import-dialog').close();
    if (!await reloadGroupView(slug, 'members')) return;
    toast(`Imported ${result.imported} game${result.imported === 1 ? '' : 's'} from Steam`);
  } catch (error) { $('#steam-import-status').textContent = error.message; }
  finally { button.disabled = false; }
};

async function analyzeAchievements() {
  const slug = state.group.slug;
  const button = $('#pt-achievements');
  const key = `achievement-scan:${slug}`;
  let afterId = Number(sessionStorage.getItem(key)) || 0;
  let total = 0, synced = 0, failures = [];
  button.disabled = true;
  try {
    for (let batch = 0; batch < 3; batch++) {
      $('#pt-status').textContent = `Analyzing achievements… ${total} games checked`;
      const result = await gapiFor(slug, '/achievement-scan', {
        method: 'POST', body: { afterId },
      });
      total += result.processed;
      synced += result.synced;
      failures = failures.concat(result.report.filter((item) => !item.ok));
      afterId = result.nextCursor;
      if (!result.hasMore || !result.processed) {
        sessionStorage.removeItem(key);
        break;
      }
      sessionStorage.setItem(key, String(afterId));
    }
    state.cache.stats = null;
    const detail = failures.length ? ` ${failures.length} had private or unavailable achievement data.` : '';
    $('#pt-status').textContent = total
      ? `Checked ${total} games and synced ${synced}.${detail}`
      : 'Your achievement data is already up to date.';
    toast(total ? `Achievement analysis checked ${total} games` : 'Achievements already up to date');
  } catch (error) { $('#pt-status').textContent = error.message; }
  finally { button.disabled = false; }
}

async function enrichSteamMetadata() {
  const slug = state.group.slug;
  const button = $('#pt-enrich');
  button.disabled = true;
  $('#pt-status').textContent = 'Filling artwork and store details for the next games…';
  try {
    const result = await gapiFor(slug, '/steam-import', {
      method: 'POST', body: { action: 'enrich' },
    });
    if (result.enriched) await reloadGroupView(slug, 'members');
    $('#pt-status').textContent = result.remaining
      ? `Added details for ${result.enriched}. ${result.remaining} games remain; use this again to continue.`
      : result.enriched ? 'All imported games now have Steam details.' : 'Game details are already complete.';
  } catch (error) { $('#pt-status').textContent = error.message; }
  finally { button.disabled = false; }
}

/* ══════════════════════════════ BROWSE ════════════════════════════════ */
/**
 * The global catalogue. /api/coop is group-blind by design, so "already in your
 * library" is worked out here by comparing appids against the group library the
 * client already holds — no group data crosses that endpoint.
 */
const browse = { page: 0, items: [], hasMore: false };

// Latest request wins. Refusing to start a new fetch while one is in flight
// looks like a safe guard but silently drops keystrokes — type during a slow
// response and the search you asked for never happens. Sequence-numbering lets
// every request start and discards only the answers that arrived too late.
let browseSeq = 0;

async function renderBrowse(reset) {
  const slug = state.group.slug;
  if (reset) { browse.page = 0; browse.items = []; browse.hasMore = false; }

  const q = $('#browse-search').value.trim();
  const sort = $('#browse-sort').value;
  // "we can all play" can only mean games with a *verified* cap that covers the
  // group. Unknown caps are left out rather than optimistically included.
  const minPlayers = $('#browse-fits').checked ? (state.group.maxPlayers || 0) : 0;

  const params = new URLSearchParams({ page: String(browse.page), sort });
  if (q) params.set('q', q);
  if (minPlayers) params.set('minPlayers', String(minPlayers));
  if (!$('#browse-coop').checked) params.set('coopOnly', '0');

  const seq = ++browseSeq;
  $('#browse-status').textContent = browse.page ? 'Loading more…' : 'Loading catalogue…';
  let d;
  try {
    /* Two endpoints, one grid. Ranking by taste needs the group's ratings, so it
       has to come from below the tenancy boundary; /api/coop is deliberately
       group-blind and stays that way. Same card shape from both — they share
       CATALOGUE_COLS — so only the URL differs here. */
    d = sort === 'fit'
      ? await gapiFor(slug, `/recommend?${params}`)
      : await api(`/api/coop?${params}`);
  }
  catch (e) {
    if (seq === browseSeq && state.group?.slug === slug && state.view === 'browse') {
      $('#browse-status').textContent = e.message;
    }
    return;
  }
  if (seq !== browseSeq || state.group?.slug !== slug || state.view !== 'browse') return;

  const got = d.games || [];   // never let a malformed page turn into a hard crash
  browse.items = browse.page ? browse.items.concat(got) : got;
  browse.hasMore = !!d.hasMore;

  if (!browse.items.length) {
    $('#browse-grid').innerHTML = '';
    $('#browse-status').textContent = d.total === 0
      ? 'The catalogue is empty — run scripts/crawl-coop.mjs to fill it.'
      : 'Nothing in the catalogue matches that.';
    $('#browse-more').hidden = true;
    return;
  }

  const owned = new Set(state.games.map((g) => g.steam_appid).filter(Boolean));

  // Filtered here rather than server-side on purpose: /api/coop knows nothing
  // about groups, and teaching it would put library membership behind an endpoint
  // that deliberately has no tenancy check. The cost is that a page of 24 can
  // come back shorter, so the count says how many were hidden instead of leaving
  // you wondering where they went.
  const hideOwned = $('#browse-hide-owned').checked;
  const shown = hideOwned ? browse.items.filter((g) => !owned.has(g.appid)) : browse.items;
  const hiddenCount = browse.items.length - shown.length;

  $('#browse-status').textContent =
    `${d.total} game${d.total === 1 ? '' : 's'} in the catalogue${q ? ' matching that search' : ''}`
    + (hiddenCount ? `, ${hiddenCount} on this page already in your library` : '') + '.';

  /* Say what the ranking is doing. A list claiming to be "recommended" without
     showing its reasoning asks people to trust a number they cannot check — and
     when the group has barely rated anything, the honest answer is that this is
     just the popularity order. */
  const why = $('#browse-why');
  if (sort !== 'fit') why.hidden = true;
  else if (d.basis === 'popularity') {
    why.hidden = false;
    why.textContent = `Not enough ratings yet to tell what ${state.group.mode === 'personal' ? 'you like' : 'this group likes'} `
      + `(${d.ratedGames} of ${d.needed} games rated) — showing the most popular instead.`;
  } else {
    why.hidden = false;
    const chips = (list, cls) => (list || [])
      .map((t) => `<span class="chip ${cls}">${esc(t.tag)} ${t.points > 0 ? '+' : ''}${t.points}</span>`)
      .join('');
    why.innerHTML = `Ranked against ${d.ratedGames} games you have rated. `
      + `${state.group.mode === 'personal' ? 'You rate' : 'This group rates'} these higher than ${
        state.group.mode === 'personal' ? 'your' : 'its own'} average: ${chips(d.likes, 'chip-good') || '—'}`
      + (d.dislikes?.length ? ` and lower: ${chips(d.dislikes, 'chip-bad')}` : '');
  }

  if (!shown.length) {
    $('#browse-grid').innerHTML = '';
    $('#browse-status').textContent = hideOwned
      ? 'Everything on this page is already in your library — load more, or untick the filter.'
      : 'Nothing in the catalogue matches that.';
    $('#browse-more').hidden = !browse.hasMore;
    return;
  }

  $('#browse-grid').innerHTML = shown.map((g) => {
    const inLibrary = owned.has(g.appid);
    const storeUrl = steamStoreUrl(g.appid);
    const cap = g.max_players
      ? `${g.max_players}p co-op`
      : '<span class="chip">player count unverified</span>';
    return `
      <article class="browse-card">
        ${g.header_image ? `<img src="${esc(g.header_image)}" alt="" loading="lazy">` : '<div class="browse-noart"></div>'}
        <div class="browse-body">
          <h3>${esc(g.name)}</h3>
          <div class="rank-meta">
            ${g.max_players ? `<span class="chip chip-good">${esc(cap)}</span>` : cap}
            ${g.genre ? `<span class="chip">${esc(g.genre)}</span>` : ''}
            ${g.price ? `<span class="chip">${esc(g.price)}</span>` : ''}
            ${g.review_hint ? `<span class="chip">${esc(g.review_hint)}</span>` : ''}
          </div>
          ${(() => { try { return JSON.parse(g.tags || '[]').includes('Early Access'); }
                     catch { return false; } })()
            ? '<p class="browse-ea">Early access — still unfinished</p>' : ''}
          ${g.why?.length
            ? `<p class="browse-fit">Matches your taste for ${g.why.map(esc).join(' and ')}</p>`
            : ''}
          ${g.short_description ? `<p>${esc(g.short_description)}</p>` : ''}
        </div>
        <div class="browse-act">
          ${storeUrl ? `<a class="btn btn-sm btn-ghost" href="${storeUrl}"
             target="_blank" rel="noopener"
             aria-label="Open ${esc(g.name)} on Steam (new tab)">Steam page ↗</a>` : ''}
          ${inLibrary
            ? '<span class="chip chip-good">in your library</span>'
            : `<button class="btn btn-sm btn-primary" data-add="${g.appid}">+ Add to library</button>`}
        </div>
      </article>`;
  }).join('');

  $$('#browse-grid [data-add]').forEach((b) => b.addEventListener('click', () => addFromCatalogue(b)));
  $('#browse-more').hidden = !browse.hasMore;
}

/** Add a catalogue game to this group's library, carrying any verified player cap. */
async function addFromCatalogue(btn) {
  const slug = state.group.slug;
  const appid = Number(btn.dataset.add);
  const entry = browse.items.find((g) => g.appid === appid);
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    // Passing maxPlayers through means an added game arrives with a real cap
    // where one is known, so the viability check works without further input.
    const r = await gapiFor(slug, '/games', {
      method: 'POST',
      body: { input: String(appid), maxPlayers: entry?.max_players ?? null },
    });
    if (!await reloadGroupView(slug, 'browse')) return;
    toast(state.group.mode === 'personal'
      ? `Added ${r.name} to your library.`
      : entry?.max_players
        ? `Added ${r.name} — it's in everyone's rating queue now.`
        : `Added ${r.name}. Set its player count so we know if we can all play.`);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = '+ Add to library';
  }
}

/* ══════════════════════════════ DETAIL ════════════════════════════════ */
let detailGameId = null;

function openDetail(id, focusField = null) {
  const g = gameById(id);
  if (!g) return;
  const slug = state.group.slug;
  const returnView = state.view;
  detailGameId = id;
  $('#detail-title').textContent = g.name;

  $('#detail-body').innerHTML = `
    <div class="detail-grid">
      ${g.header_image ? `<img src="${esc(g.header_image)}" alt="" style="width:100%;border-radius:8px">` : ''}
      <div class="rank-meta">${metaChips(g)}</div>
      ${g.short_description ? `<p class="panel-sub" style="margin:0">${esc(g.short_description)}</p>` : ''}

      <div class="detail-votes">
        ${state.members.map((m) => {
          const score = g.votes[m.steam_id];
          return `<div class="detail-vote">
            <span class="detail-vote-name" title="${esc(m.short_name)}" style="color:${colorOf(m.steam_id)}">${esc(m.short_name)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${score ? (score / 10) * 100 : 0}%;background:${colorOf(m.steam_id)}"></div></div>
            <span class="bar-val">${score == null ? '–' : fmt(score, 1)}</span>
          </div>`;
        }).join('')}
      </div>

      ${g.steam_appid && g.ownership ? `
        <section class="ownership-detail">
          <h4>Steam ownership</h4>
          <div class="ownership-people">
            ${state.members.map((member) => {
              const owned = g.ownership[member.steam_id];
              return `<span class="ownership-person ${owned === true ? 'is-owned' : owned === false ? 'is-missing' : ''}">
                <i class="dot" style="background:${colorOf(member.steam_id)}"></i>
                ${esc(member.short_name)} · ${owned === true ? 'owns it' : owned === false ? 'not in latest library sync' : 'unknown'}
              </span>`;
            }).join('')}
          </div>
          <p>Based on the latest public Steam library sync. Unknown stays unknown when a library is private or stale.</p>
        </section>` : ''}

      <div class="detail-row2">
        <div class="detail-field">
          <label for="d-status">Status</label>
          <select id="d-status" class="input">
            ${Object.entries(STATUS_LABEL).map(([v, l]) =>
              `<option value="${v}"${g.status === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="detail-field">
          <label for="d-players">Max online co-op players</label>
          <input id="d-players" class="input" type="number" min="0" max="64" value="${g.max_players ?? ''}" placeholder="unknown">
        </div>
      </div>
      <div class="detail-row2">
        <div class="detail-field">
          <label for="d-genre">Genre</label>
          <input id="d-genre" class="input" value="${esc(g.genre || '')}">
        </div>
        <div class="detail-field">
          <label for="d-hours">Hours played</label>
          <input id="d-hours" class="input" type="number" step="0.1" min="0" value="${roundedHours(g.hours) ?? ''}">
          ${factSourceHelp(g, 'hours')}
        </div>
      </div>
      <div class="detail-row2">
        <div class="detail-field">
          <label for="d-started">First played</label>
          <input id="d-started" class="input" type="date" value="${esc(g.started || '')}">
          ${factSourceHelp(g, 'started')}
        </div>
        <div class="detail-field">
          <label for="d-finished">Last played</label>
          <input id="d-finished" class="input" type="date" value="${esc(g.finished || '')}"
                 placeholder="${esc(g.finished_estimated || '')}">
          ${g.finished || !g.finished_estimated ? '' :
            `<p class="field-help">The most recent play date Steam will tell us is
              <b>${esc(shortDate(g.finished_estimated))}</b> — Steam only reports that for
              the account the API key belongs to, so treat it as a prompt rather than
              ${state.group.mode === 'personal' ? 'your final answer' : 'the group’s answer'}. Typing a date here replaces it.</p>`}
          ${factSourceHelp(g, 'finished')}
        </div>
      </div>
      ${g.started ? '' : `<p class="field-help">Steam publishes no first-played date.
        A release date or earliest achievement can only be an approximate prompt;
        enter what ${state.group.mode === 'personal' ? 'you remember' : 'the group remembers'} when you can.</p>`}

      ${state.group.mode === 'personal' ? '' : `<div class="detail-field">
        <label for="d-addedby">Added by</label>
        <select id="d-addedby" class="input">
          <option value=""${g.added_by ? '' : ' selected'}>Unknown</option>
          ${state.members.map((m) =>
            `<option value="${esc(m.steam_id)}"${g.added_by === m.steam_id ? ' selected' : ''}>${esc(m.short_name)}</option>`).join('')}
        </select>
        <p class="field-help">Filled in automatically for games added here. Imported
          games predate that, so you can set it yourself.</p>
      </div>`}
      ${g.steam_appid ? '' : `
        <div class="detail-field">
          <label for="d-link">Link to Steam (paste a store URL or appid)</label>
          <div class="invite-row">
            <input id="d-link" class="input" placeholder="https://store.steampowered.com/app/105600/">
            <button class="btn" id="d-linkbtn">Link</button>
          </div>
        </div>`}

      ${g.steam_appid ? `
        <section class="trophy" id="d-achievements">
          <h4>🏆 Trophy relay</h4>
          <p class="panel-sub" style="margin:0">Loading achievement progress…</p>
        </section>` : ''}

      <section class="thread">
        <h4 class="thread-title">Comments</h4>
        <div id="d-comments" class="thread-list">
          <p class="panel-sub" style="margin:0">Loading…</p>
        </div>
        <div class="thread-new">
          <textarea id="d-comment" class="input" rows="2" maxlength="2000"
                    placeholder="Worth playing? Anything the others should know?"></textarea>
          <button class="btn btn-primary" id="d-comment-add">Post</button>
        </div>
        <p id="d-comment-status" class="add-status"></p>
      </section>

      <div class="detail-actions">
        <button class="btn btn-primary" id="d-save">Save changes</button>
        ${g.steam_appid ? `<a class="btn btn-ghost" target="_blank" rel="noopener"
            href="https://store.steampowered.com/app/${g.steam_appid}">Steam page ↗</a>` : ''}
        ${g.archived_at
          ? `<button class="btn btn-ghost" id="d-restore" style="margin-left:auto">Restore to library</button>`
          : `<button class="btn btn-ghost" id="d-archive" style="margin-left:auto;color:var(--critical)">Remove from library</button>`}
      </div>
    </div>`;

  $('#d-save').addEventListener('click', async () => {
    try {
      await gapiFor(slug, `/games/${id}`, { method: 'PATCH', body: {
        status: $('#d-status').value,
        max_players: $('#d-players').value === '' ? null : Number($('#d-players').value),
        genre: $('#d-genre').value.trim() || null,
        hours: $('#d-hours').value === '' ? null : Number($('#d-hours').value),
        added_by: state.group.mode === 'personal' ? g.added_by : $('#d-addedby').value || null,
        started: $('#d-started').value || null,
        finished: $('#d-finished').value || null,
      }});
      if (!await reloadGroupView(slug, returnView)) return;
      $('#detail-dialog').close();
      toast('Saved');
    } catch (e) { toast(e.message); }
  });

  $('#d-linkbtn')?.addEventListener('click', async () => {
    const raw = $('#d-link').value.trim();
    const appid = Number(raw.match(/app\/(\d+)/)?.[1] || raw);
    if (!Number.isInteger(appid) || !appid) return toast('paste a Steam store link or a numeric appid');
    try {
      await gapiFor(slug, `/games/${id}`, { method: 'PUT', body: { appid } });
      if (!await reloadGroupView(slug, returnView)) return;
      $('#detail-dialog').close();
      toast('Linked to Steam');
    } catch (e) { toast(e.message); }
  });

  // Removing archives rather than deletes, so the confirmation can promise the
  // ratings survive — which is the difference that makes this safe for any member
  // to do. Saying "delete" here when nothing is deleted would be a lie that stops
  // people tidying up at all.
  if (g.archived_at) {
    $('#d-restore').addEventListener('click', async () => {
      try {
        await gapiFor(slug, `/games/${id}`, { method: 'PATCH', body: { archived: false } });
        if (!await reloadGroupView(slug, returnView)) return;
        $('#detail-dialog').close();
        toast(`${g.name} is back, with every rating it had`);
      } catch (e) { toast(e.message); }
    });
  } else {
    $('#d-archive').addEventListener('click', async () => {
      const n = Object.keys(g.votes).length;
      const kept = n ? `Its ${n} rating${n === 1 ? '' : 's'} are kept` : 'Nothing is deleted';
      if (!confirm(`Remove ${g.name} from the library?\n\n`
        + `${kept}, and it drops out of the rating queue and Play next. `
        + `You can restore it any time from Library → Archived.`)) return;
      try {
        const r = await gapiFor(slug, `/games/${id}`, { method: 'DELETE' });
        if (!await reloadGroupView(slug, returnView)) return;
        $('#detail-dialog').close();
        toast(r.keptRatings
          ? `Archived ${r.name} — ${r.keptRatings} ratings kept`
          : `Archived ${r.name}`);
      } catch (e) { toast(e.message); }
    });
  }

  void loadComments(id, slug);
  if (g.steam_appid) void loadAchievements(id, slug);
  $('#d-comment-add').addEventListener('click', () => postComment(id, slug));
  // Cmd/Ctrl+Enter posts, so a keyboard-driven queue stays keyboard-driven.
  $('#d-comment').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(id, slug); }
  });

  $('#detail-dialog').showModal();
  if (focusField) requestAnimationFrame(() => $(`#d-${focusField}`)?.focus());
}

async function loadAchievements(gameId, slug = state.group.slug) {
  const box = $('#d-achievements');
  if (!box) return;
  try {
    const view = await gapiFor(slug, `/achievements?gameId=${gameId}`);
    if (state.group?.slug !== slug || detailGameId !== gameId || !$('#detail-dialog').open) return;
    renderAchievements(gameId, slug, view);
    maybeAutoSyncAchievements(gameId, slug, view);
  } catch (error) {
    if (detailGameId === gameId && box) {
      box.innerHTML = `<h4>🏆 Trophy relay</h4><p class="panel-sub" style="margin:0">${esc(error.message)}</p>`;
    }
  }
}

const achievementAutoAttempts = new Set();
const ACHIEVEMENT_REFRESH_SECONDS = 7 * 24 * 60 * 60;

function achievementLevel(pct) {
  if (pct >= 100) return 'Completionist';
  if (pct >= 75) return 'Trophy hunter';
  if (pct >= 50) return 'Halfway hero';
  if (pct >= 25) return 'On a roll';
  return 'First steps';
}

function renderAchievements(gameId, slug, view) {
  const box = $('#d-achievements');
  if (!box) return;
  const relay = view.relay || { unlocked: 0, total: 0, synced: 0, eligible: 0, nearSweep: [], latest: [] };
  const pct = relay.total ? Math.round((relay.unlocked / relay.total) * 100) : 0;
  const syncedMembers = (view.members || []).filter((member) => member.total != null);
  const personal = state.group.mode === 'personal';
  const title = personal ? '🏆 Trophy trail' : '🏆 Trophy relay';
  box.innerHTML = `
    <div class="trophy-head">
      <div>
        <h4>${title}</h4>
        <p>${relay.total
          ? personal
            ? `${relay.unlocked}/${relay.total} achievements unlocked`
            : `${relay.unlocked}/${relay.total} different achievements unlocked somewhere in the group`
          : syncedMembers.length ? 'Steam reports no achievements for this game.'
            : personal ? 'No achievement progress synced yet.'
              : 'No one has handed off the trophy baton yet.'}</p>
      </div>
      ${relay.total ? `<div class="trophy-score"><strong>${pct}%</strong><span>${achievementLevel(pct)}</span></div>` : ''}
    </div>
    ${relay.total ? `<div class="trophy-track"><i style="width:${Math.min(100, pct)}%"></i></div>` : ''}
    <div class="trophy-people">
      ${(view.members || []).map((member) => `
        <div class="trophy-person">
          <span><i class="dot" style="background:${colorOf(member.steamId)}"></i>${esc(member.name)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${member.total ? (member.achieved / member.total) * 100 : 0}%;background:${colorOf(member.steamId)}"></div></div>
          <b>${member.total == null ? (member.account ? 'not synced' : 'no account') : `${member.achieved}/${member.total}`}</b>
        </div>`).join('')}
    </div>
    ${relay.unanimous != null ? `<p class="trophy-note">✨ ${relay.unanimous} unlocked by everyone.</p>` : ''}
    ${(relay.nearSweep || []).length ? `<div class="trophy-calls"><strong>One baton short</strong>${relay.nearSweep.map((item) =>
      `<span>${esc(item.name)} — waiting on ${esc(item.missing)}</span>`).join('')}</div>` : ''}
    ${(relay.latest || []).length ? `<div class="trophy-calls"><strong>Fresh trophies</strong>${relay.latest.map((item) =>
      `<span>${esc(item.member)} unlocked ${esc(item.name)} · ${when(item.unlocktime)}</span>`).join('')}</div>` : ''}
    <div class="trophy-actions">
      <button class="btn btn-sm" id="d-ach-sync">${
        (view.members || []).find((member) => member.steamId === state.me.steamId)?.total == null
          ? 'Sync my progress' : 'Refresh my progress'}</button>
      <span id="d-ach-status">${view.notice ? esc(view.notice) : personal
        ? (syncedMembers.length ? `Synced ${when(syncedMembers[0].fetchedAt)}` : 'Syncs automatically when you open a game')
        : `${relay.synced}/${relay.eligible} accounts synced for this game`}</span>
    </div>`;

  $('#d-ach-sync').addEventListener('click', () => syncAchievements(gameId, slug, false));
}

function maybeAutoSyncAchievements(gameId, slug, view) {
  const mine = (view.members || []).find((member) => member.steamId === state.me.steamId);
  const stale = mine?.fetchedAt != null
    && Date.now() / 1000 - Number(mine.fetchedAt) >= ACHIEVEMENT_REFRESH_SECONDS;
  const ownership = gameById(gameId)?.ownership?.[state.me.steamId];
  const key = `${slug}:${gameId}`;
  if (!mine?.account || ownership === false || (!stale && mine.total != null)
      || achievementAutoAttempts.has(key)) return;
  achievementAutoAttempts.add(key);
  void syncAchievements(gameId, slug, true);
}

async function syncAchievements(gameId, slug, automatic) {
  const button = $('#d-ach-sync');
  const status = $('#d-ach-status');
  if (!button || !status) return;
  button.disabled = true;
  status.textContent = automatic ? 'Syncing from Steam automatically…' : 'Asking Steam…';
  try {
    const updated = await gapiFor(slug, '/achievements', { method: 'POST', body: { gameId } });
    if (state.group?.slug !== slug || detailGameId !== gameId || !$('#detail-dialog').open) return;
    renderAchievements(gameId, slug, updated);
  } catch (error) {
    if (state.group?.slug !== slug || detailGameId !== gameId || !$('#detail-dialog').open) return;
    status.textContent = error.message;
    button.disabled = false;
  }
}

/** Fetched per game rather than bundled into the library payload — see the route. */
async function loadComments(gameId, slug = state.group.slug) {
  const box = $('#d-comments');
  try {
    const { comments } = await gapiFor(slug, `/comments?gameId=${gameId}`);
    if (state.group?.slug !== slug || !$('#detail-dialog').open) return;
    box.innerHTML = comments.length
      ? comments.map((c) => `
        <article class="comment">
          <div class="comment-head">
            <i class="dot" style="background:${colorOf(c.steamId)}"></i>
            <strong>${esc(c.name)}</strong>
            <time>${when(c.createdAt)}</time>
            ${c.mine || state.group.role === 'owner'
              ? `<button class="btn-x" data-del-comment="${c.id}" title="Delete">✕</button>` : ''}
          </div>
          <p>${esc(c.body)}</p>
        </article>`).join('')
      : '<p class="panel-sub" style="margin:0">No comments yet. Say something.</p>';

    $$('#d-comments [data-del-comment]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this comment?')) return;
      try {
        await gapiFor(slug, '/comments', { method: 'DELETE', body: { id: Number(b.dataset.delComment) } });
        void loadComments(gameId, slug);
      } catch (e) { toast(e.message); }
    }));
  } catch (e) {
    if (state.group?.slug === slug && $('#detail-dialog').open) {
      box.innerHTML = `<p class="panel-sub" style="margin:0">${esc(e.message)}</p>`;
    }
  }
}

async function postComment(gameId, slug = state.group.slug) {
  const el = $('#d-comment');
  const text = el.value.trim();
  if (!text) { $('#d-comment-status').textContent = 'Write something first.'; return; }
  const btn = $('#d-comment-add');
  btn.disabled = true;
  try {
    await gapiFor(slug, '/comments', { method: 'POST', body: { gameId, body: text } });
    if (state.group?.slug !== slug || !$('#detail-dialog').open) return;
    el.value = '';
    $('#d-comment-status').textContent = '';
    await loadComments(gameId, slug);
  } catch (e) {
    $('#d-comment-status').textContent = e.message;
  } finally { btn.disabled = false; }
}

boot();
