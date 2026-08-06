/* ============================================================================
   CoopQ — client. No framework, no build step: edit, push, done.
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
  view: 'queue',
};

/* Fixed categorical slots, assigned by position in the member list. Colour
   follows the person, never their rank, so filtering never repaints anyone.

   The ORDER is not 1..8 and that is the point. Taking the palette in numeric
   order gave a four-person group blue/orange/aqua/yellow, and orange vs yellow
   measures ΔE 33.9 to normal vision but only 9.2 under deuteranopia — which is
   why they read as the same colour to some people. This order was picked by
   exhaustive search over the eight validated hues, maximising the worst pairwise
   CIELAB ΔE across normal, deuteranopic and protanopic simulation, so that every
   prefix is the best available for that group size. Four people now get a worst
   pair of ΔE 25.1 instead of 9.2. Re-run the search before reordering. */
const SERIES = ['var(--series-1)', 'var(--series-4)', 'var(--series-5)', 'var(--series-8)',
                'var(--series-2)', 'var(--series-6)', 'var(--series-3)', 'var(--series-7)'];
const colorOf = (steamId) => {
  const i = state.members.findIndex((m) => m.steam_id === steamId);
  return i >= 0 && i < SERIES.length ? SERIES[i] : 'var(--text-muted)';
};
const nameOf = (steamId) =>
  state.members.find((m) => m.steam_id === steamId)?.short_name || 'Someone';

const STATUS_LABEL = {
  backlog: 'Backlog', playing: 'Playing', finished: 'Finished',
  dropped: 'Dropped', sampled: 'Sampled',
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
const gapi = (path, options) => api(`/api/g/${encodeURIComponent(state.group.slug)}${path}`, options);

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
const fmt = (n, d = 2) => (n == null ? '–' : Number(n).toFixed(d));
/** 1029444 -> "1.0M". Steam review counts run to seven figures. */
const compact = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n);

/**
 * Personal display preferences. Deliberately localStorage rather than a column:
 * these change nothing anyone else can see and are worthless to sync, so they do
 * not deserve a schema, a migration or a round-trip. Keyed per account so a
 * shared browser does not leak one person's preference to another.
 */
const PREF_DEFAULTS = { hideOthers: false };
const prefKey = () => `coopq:prefs:${state.me?.steamId || 'anon'}`;
let prefs = { ...PREF_DEFAULTS };

function loadPrefs() {
  try { prefs = { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(prefKey()) || '{}') }; }
  catch { prefs = { ...PREF_DEFAULTS }; }
}
function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(prefKey(), JSON.stringify(prefs)); } catch { /* private mode */ }
}

/**
 * Trailer playback. Steam retired progressive mp4s, so `trailer_url` is now
 * almost always a segmented HLS manifest: Safari plays that natively, everything
 * else needs hls.js. One <video> is reused for every card in the queue, so the
 * previous player has to be torn down before the next attaches or the instances
 * (and their buffers) pile up as you rate.
 */
let hls = null;

function detachTrailer(video) {
  if (hls) { hls.destroy(); hls = null; }
  video.removeAttribute('src');
  video.load();
}

/** Attach `url` to `video`; false means this browser cannot play it at all. */
function attachTrailer(video, url) {
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
  if (window.Hls?.isSupported()) {
    // A rating card is a glance, not a sitting — a short buffer keeps the queue
    // snappy and avoids pulling megabytes for a game about to be skipped.
    hls = new window.Hls({ maxBufferLength: 12, maxMaxBufferLength: 30 });
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
  loadPrefs();   // keyed on the account, so only valid once state.me is set

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
  const box = $('#landing-error');
  box.hidden = !message;
  if (message) box.textContent = message;
}

/* ───────────────────────── onboarding: no groups ─────────────────────── */
function showOnboard() {
  show('onboard');
  $('#onboard-name').textContent = state.me.displayName || 'stranger';

  $('#create-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#create-name').value.trim();
    const maxPlayers = Number($('#create-size').value) || 4;
    $('#onboard-status').textContent = 'Creating…';
    try {
      const r = await api('/api/groups', { method: 'POST', body: { name, maxPlayers } });
      state.groups = (await api('/api/me')).groups;
      location.hash = `#/g/${r.slug}/queue`;
      await openFromHash();
      toast(`${r.name} created — invite the others from the Group tab`);
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
    await loadGroup();
  }
  setView(route?.view || 'queue');
}

window.addEventListener('hashchange', () => {
  const route = parseHash();
  if (!route) return;
  if (route.slug !== state.group?.slug) openFromHash();
  else if (route.view !== state.view) setView(route.view);
});

async function loadGroup() {
  const [lib, q, claim] = await Promise.all([gapi('/games'), gapi('/skip'), gapi('/claim')]);
  state.games = lib.games;
  state.members = lib.members;
  state.group = lib.group;
  state.model = lib.model;
  state.queue = q.queue;

  // Offer the imported identity before showing the app, once per group.
  if (claim.canClaim && claim.unclaimed.length) return showClaim(claim.unclaimed);

  renderChrome();
  show('app');
}

function showClaim(unclaimed) {
  show('claim');
  $('#claim-options').innerHTML = unclaimed
    .map((u) => `<button class="claim-opt" data-seed="${esc(u.seedId)}"><b>${esc(u.name)}</b><span>claim these ratings</span></button>`)
    .join('');
  $$('#claim-options .claim-opt').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await gapi('/claim', { method: 'POST', body: { seedId: btn.dataset.seed } });
        await loadGroup();
        setView('queue');
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
      <span class="group-item-meta">${g.members} member${g.members === 1 ? '' : 's'} · ${g.games} games${
        g.unrated ? ` · <b>${g.unrated} to rate</b>` : ''}</span>
    </button>`).join('');
  $('#group-menu').innerHTML = items + `
    <div class="group-menu-sep"></div>
    <button class="group-item" data-new role="menuitem"><span class="group-item-name">+ New group</span></button>
    <button class="group-item" data-joincode role="menuitem"><span class="group-item-name">Join with a code</span></button>`;

  $$('#group-menu .group-item').forEach((b) => b.addEventListener('click', async () => {
    closeGroupMenu();
    if (b.dataset.new || b.dataset.joincode) {
      state.group = null;
      showOnboard();
      if (b.dataset.joincode) $('#join-code').focus(); else $('#create-name').focus();
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
  state.view = view;
  const want = `#/g/${state.group.slug}/${view}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  ({ queue: renderQueue, next: renderNext, library: renderLibrary,
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
  });
  document.addEventListener('click', closeGroupMenu);
  $('#group-menu').addEventListener('click', (e) => e.stopPropagation());

  $('#score-range').addEventListener('input', (e) => { $('#score-out').textContent = fmt(e.target.value, 1); });
  $('#btn-save').addEventListener('click', saveRating);
  $$('#rate-modes .seg').forEach((b) => b.addEventListener('click', () => {
    state.rateMode = b.dataset.mode;
    state.qIndex = 0;
    renderQueue();
  }));
  $('#btn-skip').addEventListener('click', skipGame);

  $('#lib-search').addEventListener('input', renderLibrary);
  $('#lib-status').addEventListener('change', renderLibrary);
  $('#lib-sort').addEventListener('change', () => {
    libSort = null;              // dropdown wins again; clears the column arrow
    renderLibHead();
    renderLibrary();
  });
  $('#lib-mine').addEventListener('change', renderLibrary);
  $('#lib-score').addEventListener('change', renderLibrary);
  $('#lib-played').addEventListener('change', renderLibrary);
  $('#hide-unviable').addEventListener('change', renderNext);

  let browseTimer;
  $('#browse-search').addEventListener('input', () => {
    clearTimeout(browseTimer);
    browseTimer = setTimeout(() => renderBrowse(true), 280);
  });
  $('#browse-sort').addEventListener('change', () => renderBrowse(true));
  $('#browse-fits').addEventListener('change', () => renderBrowse(true));
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
  else if (e.key.toLowerCase() === 's') { skipGame(); e.preventDefault(); }
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
const PLAYED_STATUS = new Set(['finished', 'dropped', 'sampled']);
const modeOf = (g) => (PLAYED_STATUS.has(g.status) ? 'played' : 'want');

function queuesByMode() {
  const out = { played: [], want: [] };
  for (const id of state.queue) {
    const g = gameById(id);
    if (g) out[modeOf(g)].push(id);
  }
  return out;
}

function renderQueue() {
  const byMode = queuesByMode();

  // Default to whichever mode has work, preferring Played. Also auto-advances
  // when the mode you were in empties, so the queue never looks broken.
  if (!byMode[state.rateMode]?.length) {
    state.rateMode = byMode.played.length ? 'played' : 'want';
    state.qIndex = 0;
  }
  const queue = byMode[state.rateMode];

  const modes = $('#rate-modes');
  modes.hidden = !(byMode.played.length || byMode.want.length);
  $('#mode-played-n').textContent = byMode.played.length || '';
  $('#mode-want-n').textContent = byMode.want.length || '';
  $$('#rate-modes .seg').forEach((b) => {
    const on = b.dataset.mode === state.rateMode;
    b.setAttribute('aria-selected', String(on));
    b.classList.toggle('is-on', on);
    b.disabled = !byMode[b.dataset.mode].length;
  });
  $('#rate-ask').textContent = state.rateMode === 'played'
    ? 'How good was it? Rate what you have already played, while you still remember.'
    : 'How much do you want to play this? These are the ones that decide what comes next.';

  const empty = !queue.length;
  $('#queue-empty').hidden = !empty;
  $('#queue-card').hidden = empty;
  if (empty) return;

  if (state.qIndex >= queue.length) state.qIndex = 0;
  const g = gameById(queue[state.qIndex]);
  if (!g) { state.queue = state.queue.filter((id) => id !== queue[state.qIndex]); return renderQueue(); }

  $('#rate-title').textContent = g.name;
  $('#rate-pos').textContent = `${state.qIndex + 1} of ${queue.length} left`;
  $('#rate-desc').textContent = g.short_description || '';
  $('#score-hint').textContent = state.rateMode === 'played'
    ? 'how good was it?'
    : 'how much do you want to play this?';

  const video = $('#rate-video');
  const image = $('#rate-image');
  const media = $('.rate-media');
  const note  = $('#rate-notrailer');
  video.pause();
  if (g.trailer_url && attachTrailer(video, g.trailer_url)) {
    video.poster = g.header_image || '';
    video.hidden = false; image.hidden = true; note.hidden = true;
    media.classList.remove('is-blank');
  } else if (g.header_image) {
    detachTrailer(video); video.hidden = true;
    image.src = g.header_image; image.hidden = false;
    note.hidden = false;
    note.textContent = g.trailer_url
      ? 'Trailer will not play in this browser'
      : 'No trailer on Steam';
    media.classList.remove('is-blank');
  } else {
    // Not linked to Steam yet — a slim prompt beats a viewport-sized black box.
    detachTrailer(video); video.hidden = true; image.hidden = true;
    note.hidden = false;
    note.textContent = 'Not linked to Steam yet — open it from the Library and paste a store link for art and a trailer';
    media.classList.add('is-blank');
  }

  const store = $('#btn-store');
  if (g.steam_appid) {
    store.href = `https://store.steampowered.com/app/${g.steam_appid}`;
    store.hidden = false;
  } else store.hidden = true;

  $('#rate-meta').innerHTML = metaChips(g);

  const caveat = [g.coop_note, g.notes].filter(Boolean).join(' · ');
  $('#rate-notes').hidden = !caveat;
  $('#rate-notes').textContent = caveat;

  const others = Object.entries(g.votes).filter(([id]) => id !== state.me.steamId);
  if (prefs.hideOthers) {
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

  // The slider normally opens on the group's current average, which is a second
  // and less obvious source of anchoring: hiding the numbers but still starting
  // the handle on them would defeat the point. Neutral 7.5 when hidden.
  const start = (others.length && !prefs.hideOthers) ? Math.round(g.raw * 2) / 2 : 7.5;
  $('#score-range').value = start;
  $('#score-out').textContent = fmt(start, 1);
}

function metaChips(g) {
  const need = state.group.maxPlayers;
  const chips = [];
  if (g.genre) chips.push(`<span class="chip">${esc(g.genre)}</span>`);
  const v = g.viability;
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
  if (g.status !== 'backlog') chips.push(`<span class="chip">${STATUS_LABEL[g.status]}</span>`);
  return chips.join('');
}

/** The game on screen. qIndex indexes the ACTIVE MODE's queue, not state.queue. */
const currentCard = () => gameById(queuesByMode()[state.rateMode]?.[state.qIndex]);

async function saveRating() {
  const g = currentCard();
  if (!g) return;
  const score = Number($('#score-range').value);
  $('#btn-save').disabled = true;
  try {
    await gapi('/rate', { method: 'POST', body: { gameId: g.id, score } });
    state.queue = state.queue.filter((id) => id !== g.id);
    $('#queue-count').textContent = state.queue.length || '';
    g.votes[state.me.steamId] = score;
    renderMyCoverage();   // the bar should move on every save, that is the point
    toast(`${g.name}: ${fmt(score, 1)}`);
    renderQueue();
    gapi('/games').then((lib) => { state.games = lib.games; state.model = lib.model; });
  } catch (e) { toast(e.message); }
  finally { $('#btn-save').disabled = false; }
}

async function skipGame() {
  const g = currentCard();
  if (!g) return;
  try {
    await gapi('/skip', { method: 'POST', body: { gameId: g.id } });
    state.queue = state.queue.filter((id) => id !== g.id);
    $('#queue-count').textContent = state.queue.length || '';
    renderQueue();
  } catch (e) { toast(e.message); }
}

/* ══════════════════════════════ PLAY NEXT ═════════════════════════════ */
function renderNext() {
  const need = state.group.maxPlayers;
  $('#next-sub').textContent =
    `Backlog games ranked by the group's average score. ` +
    `toward the middle when only one person has voted. Anything that can't fit ${need} players is flagged.`;

  const backlog = state.games.filter((g) => g.status === 'backlog' && g.n > 0);
  const hide = $('#hide-unviable').checked;
  const playable = backlog.filter((g) => g.viability.ok !== false).sort((a, b) => b.raw - a.raw);
  const blocked  = backlog.filter((g) => g.viability.ok === false).sort((a, b) => b.raw - a.raw);

  $('#next-list').innerHTML = playable.map((g, i) => `
    <li class="rank-row" data-id="${g.id}">
      <div class="rank-num">${i + 1}</div>
      <div class="rank-main">
        <div class="rank-name">${esc(g.name)}</div>
        <div class="rank-meta">${metaChips(g)}${
          g.n === 1 ? '<span class="chip chip-warn">only 1 vote</span>' : ''}</div>
      </div>
      <div class="rank-score"><b>${fmt(g.raw, 1)}</b><span>${g.n} vote${g.n === 1 ? '' : 's'}</span></div>
    </li>`).join('') || '<p class="view-sub">Nothing rated in the backlog yet — go rate some games.</p>';

  $('#unviable-block').innerHTML = (hide || !blocked.length)
    ? (blocked.length ? `<h3>${blocked.length} more can't be played by ${need} of us</h3><p>Untick the box above to see them.</p>` : '')
    : `<h3>${need} of us can't play these</h3>
       <p>Verified player caps. They stay on the list so nobody re-suggests them.</p>
       ${blocked.map((g) => `
         <div class="unviable-row" data-id="${g.id}">
           <span><strong>${esc(g.name)}</strong> · ${fmt(g.raw, 1)}</span>
           <span class="why">${esc(g.viability.reason || `caps at ${g.max_players}`)}</span>
         </div>`).join('')}`;

  $$('#next-list .rank-row, #unviable-block .unviable-row')
    .forEach((r) => r.addEventListener('click', () => openDetail(Number(r.dataset.id))));
}

/* ══════════════════════════════ LIBRARY ═══════════════════════════════ */
/**
 * Column sort, layered over the sort dropdown rather than replacing it. Clicking
 * a header takes over; picking from the dropdown hands control back. Text columns
 * open A–Z, numeric ones open highest-first, because that is what you want on the
 * first click in each case.
 */
let libSort = null;   // { key, dir } — null means the dropdown is in charge

const LIB_COLUMNS = () => [
  { key: 'name',     label: 'Game',     cls: 'c-name', type: 'text', title: 'Game title' },
  { key: 'genre',    label: 'Genre',    cls: '',       type: 'text' },
  { key: 'status',   label: 'Status',   cls: '',       type: 'text' },
  { key: 'players',  label: 'Players',  cls: 'c-num',  type: 'num',
    title: 'Max simultaneous online co-op players' },
  ...state.members.map((m) => ({
    key: `p:${m.steam_id}`, label: m.short_name, cls: 'c-p', type: 'num',
    color: colorOf(m.steam_id), title: `${m.short_name}'s own score` })),
  { key: 'raw',      label: 'Avg',      cls: 'c-num',  type: 'num',
    title: 'The group\'s score: the plain mean of what people gave it. '
         + 'Read it next to Votes — a 9.0 from one person is not a 9.0 from four.' },
  { key: 'n',        label: 'Votes',    cls: 'c-num',  type: 'num',
    title: 'How many of you have scored this. A high average from one person is '
         + 'thin evidence; this is the column that tells you so.' },
  { key: 'hours',    label: 'Hrs',      cls: 'c-num',  type: 'num',
    title: 'Hours logged for this game, entered by hand' },
];

const libValue = (g, key) => {
  if (key === 'players') return g.max_players;
  if (key === 'status')  return STATUS_LABEL[g.status];
  if (key.startsWith('p:')) return g.votes[key.slice(2)];
  return g[key];
};

function renderLibHead() {
  $('#lib-head').innerHTML = LIB_COLUMNS().map((c) => {
    const active = libSort?.key === c.key;
    const arrow = active ? (libSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="${c.cls} th-sort${active ? ' is-sorted' : ''}" data-sort="${esc(c.key)}"
      ${c.color ? `style="color:${c.color}"` : ''}
      ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(c.label)}${arrow}</th>`;
  }).join('');

  $$('#lib-head .th-sort').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
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
  const total = state.games.length;
  if (!total) { box.hidden = true; return; }

  const rated = state.games.filter((g) => g.votes[state.me.steamId] != null).length;
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

function renderLibrary() {
  const q = $('#lib-search').value.trim().toLowerCase();
  const status = $('#lib-status').value;
  const sort = $('#lib-sort').value;
  const mine = $('#lib-mine').value;
  const minScore = Number($('#lib-score').value) || 0;
  const played = $('#lib-played').value;

  // Filters on the group average — the same number the table and Play next show.
  // Unclaimed seed identities count as voters — their imported ratings are real
  // scores, so a game they rated is not missing anyone's opinion.
  const voters = state.members.length;
  const rows = state.games.filter((g) => {
    if (status && g.status !== status) return false;
    if (q && !g.name.toLowerCase().includes(q) && !(g.genre || '').toLowerCase().includes(q)) return false;
    if (minScore && !(g.raw >= minScore)) return false;
    if (played === 'yes' && !(g.hours > 0)) return false;
    if (played === 'no' && g.hours > 0) return false;
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
      best:     (a, b) => (b.raw ?? -1) - (a.raw ?? -1),
      name:     (a, b) => a.name.localeCompare(b.name),
      spread:   (a, b) => (b.spread ?? -1) - (a.spread ?? -1),
      hours:    (a, b) => (b.hours ?? -1) - (a.hours ?? -1),
      votes:    (a, b) => a.n - b.n,
    }[sort]);
  }

  $('#lib-table tbody').innerHTML = rows.map((g) => `
    <tr data-id="${g.id}">
      <td class="c-name cell-strong">
        <span class="lib-game">${g.header_image
          ? `<img class="lib-art" src="${esc(g.header_image)}" alt="" loading="lazy" decoding="async">`
          : '<span class="lib-art lib-art-none"></span>'}<span>${esc(g.name)}</span>${
        g.viability.ok === false ? ' <span class="chip chip-bad">' + esc(g.viability.label) + '</span>' : ''}</span></td>
      <td>${esc(g.genre || '—')}</td>
      <td><span class="status-tag status-${esc(g.status)}">${STATUS_LABEL[g.status]}</span></td>
      <td class="c-num">${g.max_players ?? '?'}</td>
      ${state.members.map((m) => {
        const v = g.votes[m.steam_id];
        return v == null ? '<td class="c-p miss">·</td>' : `<td class="c-p">${fmt(v, 1)}</td>`;
      }).join('')}
      <td class="c-num cell-strong">${fmt(g.raw, 1)}</td>
      <td class="c-num">${g.n || '–'}</td>
      <td class="c-num">${g.hours ? fmt(g.hours, 0) : '–'}</td>
    </tr>`).join('');

  $$('#lib-table tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => openDetail(Number(tr.dataset.id))));
}

/* ══════════════════════════════ STATS ═════════════════════════════════ */
async function renderStats() {
  let s;
  try { s = await gapi('/stats'); } catch (e) { return toast(e.message); }

  $('#stat-tiles').innerHTML = `
    ${tile(s.totals.games, 'games tracked')}
    ${tile(s.totals.finished, 'finished together')}
    ${tile(s.totals.hours.toLocaleString(), 'hours logged', 'only where someone filled it in')}
    ${tile(s.totals.ratings, 'ratings given')}
    ${tile(fmt(s.totals.groupMean, 2), 'group average', 'across every score anyone has given')}
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

  $('#genre-chart').innerHTML = barChart(
    s.genres.map((g) => ({ label: `${g.genre} (${g.n})`, value: g.avg })),
    10, (v) => (v >= 8 ? 'good' : v < 6.5 ? 'bad' : ''));

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
    : '<p class="panel-sub">Nothing to argue about yet — you need three people to rate the same finished game.</p>';

  $('#top-chart').innerHTML = barChart(s.topRated.map((g) => ({ label: g.name, value: g.raw })), 10);
  $('#hours-chart').innerHTML = barChart(
    s.mostHours.map((g) => ({ label: g.name, value: g.hours })),
    Math.max(...s.mostHours.map((g) => g.hours), 1), () => '', 0);
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
      <span class="bar-val">${fmt(it.value, decimals)}</span>
    </div>`).join('');
}

/* ══════════════════════════════ GROUP ═════════════════════════════════ */
async function renderMembers() {
  let d;
  try { d = await gapi('/members'); } catch (e) { return toast(e.message); }
  const isOwner = d.group.role === 'owner';

  /* ── coverage leaderboard ──────────────────────────────────────────────── */
  const total = state.games.length;
  const ranked = d.members
    .map((m) => ({ ...m, pct: total ? Math.round((m.ratings / total) * 100) : 0 }))
    .sort((a, b) => b.pct - a.pct || a.short_name.localeCompare(b.short_name));

  $('#coverage-bars').innerHTML = ranked.map((m) => `
    <div class="bar-row">
      <div class="bar-label">${esc(m.short_name)} <span class="bar-sub">${m.ratings}/${total}</span></div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${m.pct}%;background:${colorOf(m.steam_id)}"></div>
      </div>
      <div class="c-num">${m.pct}%</div>
    </div>`).join('');

  // Name the gap rather than just drawing it — "Dave is 47 behind" is actionable
  // in a way that four bars of different lengths is not.
  const note = $('#coverage-note');
  if (ranked.length < 2 || !total) {
    note.textContent = '';
  } else {
    const lead = ranked[0];
    const last = ranked[ranked.length - 1];
    const gap = lead.ratings - last.ratings;
    note.textContent = gap
      ? `${last.short_name} is ${gap} rating${gap === 1 ? '' : 's'} behind ${lead.short_name}.`
      : 'Everyone is level. The ranking is as trustworthy as it gets.';
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
    const self = b.dataset.remove === state.me.steamId;
    if (!confirm(self ? 'Leave this group? Your ratings here are deleted.'
                      : 'Remove this member and all their ratings?')) return;
    try {
      await gapi('/members', { method: 'DELETE', body: { steamId: b.dataset.remove } });
      if (self) { state.groups = (await api('/api/me')).groups; state.group = null; location.hash = ''; return boot(); }
      await loadGroup(); setView('members'); toast('Removed');
    } catch (e) { toast(e.message); }
  }));

  $('#group-settings').innerHTML = `
    <div class="detail-field">
      <label for="s-myname">Your name in this group</label>
      <input id="s-myname" class="input" maxlength="16" value="${esc(
        d.members.find((m) => m.steam_id === state.me.steamId)?.short_name || '')}">
    </div>
    <div class="detail-field" style="margin-top:12px">
      <label for="s-name">Group name</label>
      <input id="s-name" class="input" maxlength="60" value="${esc(d.group.name)}" ${isOwner ? '' : 'disabled'}>
    </div>
    <div class="detail-field" style="margin-top:12px">
      <label for="s-size">How many of you play together</label>
      <input id="s-size" class="input" type="number" min="2" max="64" value="${d.group.maxPlayers}" ${isOwner ? '' : 'disabled'}>
    </div>
    <p class="field-help">Games that can't fit this many get flagged on Play next.</p>
    <button class="btn btn-primary" id="s-save" style="margin-top:12px">Save</button>

    ${isOwner ? `
    <hr class="settings-rule">
    <div class="danger">
      <strong>Delete this group</strong>
      <p class="field-help">Removes the group and everything in it — every game, every rating,
        every member. There is no undo and no export. Archiving a single game is on its row in
        the Library; this is for the whole group.</p>
      <label class="field">
        <span>Type <code>${esc(d.group.name)}</code> to confirm</span>
        <input class="input" id="s-del-name" autocomplete="off" placeholder="${esc(d.group.name)}">
      </label>
      <button class="btn btn-danger" id="s-delete">Delete group permanently</button>
      <p id="s-del-status" class="add-status"></p>
    </div>` : ''}

    <hr class="settings-rule">
    <label class="toggle" for="s-hide-others">
      <input type="checkbox" id="s-hide-others" ${prefs.hideOthers ? 'checked' : ''}>
      Hide everyone else's ratings while I rate
    </label>
    <p class="field-help">Only affects you, and applies immediately — nothing to save.
      Also stops the slider from opening on the group's current average, which
      anchors you just as much as seeing the numbers.</p>`;

  if (isOwner) $('#s-delete').addEventListener('click', async () => {
    const typed = $('#s-del-name').value.trim();
    if (typed !== d.group.name) {
      $('#s-del-status').textContent = 'Type the group name exactly to confirm.';
      return;
    }
    if (!confirm(`Delete "${d.group.name}" and every rating in it? This cannot be undone.`)) return;
    $('#s-delete').disabled = true;
    try {
      const r = await gapi('/group', { method: 'DELETE', body: { confirmName: typed } });
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

  $('#s-hide-others').addEventListener('change', (e) => {
    savePrefs({ hideOthers: e.target.checked });
    toast(e.target.checked ? "Others' ratings hidden while you rate" : "Others' ratings visible again");
    if (state.view === 'queue') renderQueue();
  });

  $('#s-save').addEventListener('click', async () => {
    const patch = { myName: $('#s-myname').value };
    if (isOwner) { patch.name = $('#s-name').value; patch.maxPlayers = Number($('#s-size').value); }
    try {
      await gapi('/members', { method: 'PATCH', body: patch });
      state.groups = (await api('/api/me')).groups;
      await loadGroup(); setView('members'); toast('Saved');
    } catch (e) { toast(e.message); }
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
    try { await gapi('/members', { method: 'PATCH', body: { invite: mode } }); await loadGroup(); setView('members'); }
    catch (e) { toast(e.message); }
  };
  $('#invite-rotate')?.addEventListener('click', () => setInvite('rotate'));
  $('#invite-off')?.addEventListener('click', () => setInvite('off'));
  $('#invite-on')?.addEventListener('click', () => setInvite('rotate'));
}

/* ══════════════════════════════ ADD GAME ══════════════════════════════ */
function openAdd() {
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
  if (!term || term.trim().length < 2) { $('#add-results').innerHTML = ''; return; }
  $('#add-status').textContent = 'Searching Steam…';
  try {
    const { results } = await api(`/api/steam/search?q=${encodeURIComponent(term.trim())}`);
    if (!results.length) { $('#add-status').textContent = 'No matches on Steam.'; $('#add-results').innerHTML = ''; return; }
    $('#add-status').textContent = '';
    // Whether it is already on the list is the first thing you want to know here;
    // finding out by getting a 409 after clicking Add is a poor substitute.
    const byAppid = new Map(state.games.filter((g) => g.steam_appid).map((g) => [g.steam_appid, g]));
    $('#add-results').innerHTML = results.map((r) => {
      const have = byAppid.get(r.appid);
      return `
      <button class="add-hit${have ? ' is-have' : ''}" data-appid="${r.appid}" ${have ? 'disabled' : ''}>
        <img src="${esc(r.image || '')}" alt="" loading="lazy">
        <span><b>${esc(r.name)}</b><br><span>${esc(r.price || '')} ${esc(r.release || '')}</span></span>
        ${have
          ? `<span class="chip chip-good">already in ${esc(STATUS_LABEL[have.status] || 'your library')}</span>`
          : '<span class="chip">Add</span>'}
      </button>`;
    }).join('');
    $$('#add-results .add-hit:not([disabled])').forEach((b) =>
      b.addEventListener('click', () => addGame(b.dataset.appid, b)));
  } catch (e) { $('#add-status').textContent = e.message; }
}

async function addGame(appid, btn) {
  btn.disabled = true;
  $('#add-status').textContent = 'Adding…';
  try {
    const r = await gapi('/games', { method: 'POST', body: { input: appid } });
    await loadGroup();
    $('#add-dialog').close();
    setView('queue');
    toast(`Added ${r.name}. Set its player count so we know if we can all play.`);
  } catch (e) { $('#add-status').textContent = e.message; btn.disabled = false; }
}

/** Add a game that has no Steam page at all. */
async function addManual() {
  const name = $('#man-name').value.trim();
  if (name.length < 2) { $('#man-status').textContent = 'Give the game a name.'; return; }
  const btn = $('#man-add');
  btn.disabled = true;
  $('#man-status').textContent = 'Adding…';
  try {
    const r = await gapi('/games', {
      method: 'POST',
      body: {
        manual: true,
        name,
        genre: $('#man-genre').value.trim() || null,
        maxPlayers: Number($('#man-players').value) || null,
      },
    });
    await loadGroup();
    $('#add-dialog').close();
    setView('queue');
    toast(`Added ${r.name} by hand. No trailer — set a player count from the Library if it needs one.`);
  } catch (e) {
    $('#man-status').textContent = e.message;
  } finally { btn.disabled = false; }
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
  if (reset) { browse.page = 0; browse.items = []; browse.hasMore = false; }

  const q = $('#browse-search').value.trim();
  const sort = $('#browse-sort').value;
  // "we can all play" can only mean games with a *verified* cap that covers the
  // group. Unknown caps are left out rather than optimistically included.
  const minPlayers = $('#browse-fits').checked ? (state.group.maxPlayers || 0) : 0;

  const params = new URLSearchParams({ page: String(browse.page), sort });
  if (q) params.set('q', q);
  if (minPlayers) params.set('minPlayers', String(minPlayers));

  const seq = ++browseSeq;
  $('#browse-status').textContent = browse.page ? 'Loading more…' : 'Loading catalogue…';
  let d;
  try { d = await api(`/api/coop?${params}`); }
  catch (e) {
    if (seq === browseSeq) $('#browse-status').textContent = e.message;
    return;
  }
  if (seq !== browseSeq) return;   // superseded by a later search; drop this answer

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
          ${g.short_description ? `<p>${esc(g.short_description)}</p>` : ''}
        </div>
        <div class="browse-act">
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
  const appid = Number(btn.dataset.add);
  const entry = browse.items.find((g) => g.appid === appid);
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    // Passing maxPlayers through means an added game arrives with a real cap
    // where one is known, so the viability check works without further input.
    const r = await gapi('/games', {
      method: 'POST',
      body: { input: String(appid), maxPlayers: entry?.max_players ?? null },
    });
    await loadGroup();
    btn.outerHTML = '<span class="chip chip-good">in your library</span>';
    toast(entry?.max_players
      ? `Added ${r.name} — it's in everyone's rating queue now.`
      : `Added ${r.name}. Set its player count so we know if we can all play.`);
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = '+ Add to library';
  }
}

/* ══════════════════════════════ DETAIL ════════════════════════════════ */
function openDetail(id) {
  const g = gameById(id);
  if (!g) return;
  $('#detail-title').textContent = g.name;

  $('#detail-body').innerHTML = `
    <div class="detail-grid">
      ${g.header_image ? `<img src="${esc(g.header_image)}" alt="" style="width:100%;border-radius:8px">` : ''}
      <div class="rank-meta">${metaChips(g)}</div>
      ${g.short_description ? `<p class="panel-sub" style="margin:0">${esc(g.short_description)}</p>` : ''}
      ${g.notes ? `<div class="callout">${esc(g.notes)}</div>` : ''}

      <div class="detail-votes">
        ${state.members.map((m) => {
          const score = g.votes[m.steam_id];
          return `<div class="detail-vote">
            <span style="color:${colorOf(m.steam_id)};font-weight:600">${esc(m.short_name)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${score ? (score / 10) * 100 : 0}%;background:${colorOf(m.steam_id)}"></div></div>
            <span class="bar-val">${score == null ? '–' : fmt(score, 1)}</span>
          </div>`;
        }).join('')}
      </div>

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
          <input id="d-hours" class="input" type="number" step="0.5" min="0" value="${g.hours ?? ''}">
        </div>
      </div>
      <div class="detail-field">
        <label for="d-notes">Notes</label>
        <input id="d-notes" class="input" value="${esc(g.notes || '')}" placeholder="anything the others should know">
      </div>
      ${g.steam_appid ? '' : `
        <div class="detail-field">
          <label for="d-link">Link to Steam (paste a store URL or appid)</label>
          <div class="invite-row">
            <input id="d-link" class="input" placeholder="https://store.steampowered.com/app/105600/">
            <button class="btn" id="d-linkbtn">Link</button>
          </div>
        </div>`}

      <div class="detail-actions">
        <button class="btn btn-primary" id="d-save">Save changes</button>
        ${g.steam_appid ? `<a class="btn btn-ghost" target="_blank" rel="noopener"
            href="https://store.steampowered.com/app/${g.steam_appid}">Steam page ↗</a>` : ''}
        <button class="btn btn-ghost" id="d-delete" style="margin-left:auto;color:var(--critical)">Delete</button>
      </div>
    </div>`;

  $('#d-save').addEventListener('click', async () => {
    try {
      await gapi(`/games/${id}`, { method: 'PATCH', body: {
        status: $('#d-status').value,
        max_players: $('#d-players').value === '' ? null : Number($('#d-players').value),
        genre: $('#d-genre').value.trim() || null,
        hours: $('#d-hours').value === '' ? null : Number($('#d-hours').value),
        notes: $('#d-notes').value.trim() || null,
      }});
      await loadGroup(); $('#detail-dialog').close(); setView(state.view); toast('Saved');
    } catch (e) { toast(e.message); }
  });

  $('#d-linkbtn')?.addEventListener('click', async () => {
    const raw = $('#d-link').value.trim();
    const appid = Number(raw.match(/app\/(\d+)/)?.[1] || raw);
    if (!Number.isInteger(appid) || !appid) return toast('paste a Steam store link or a numeric appid');
    try {
      await gapi(`/games/${id}`, { method: 'PUT', body: { appid } });
      await loadGroup(); $('#detail-dialog').close(); setView(state.view); toast('Linked to Steam');
    } catch (e) { toast(e.message); }
  });

  $('#d-delete').addEventListener('click', async () => {
    if (!confirm(`Delete ${g.name} and every rating for it?`)) return;
    try {
      await gapi(`/games/${id}`, { method: 'DELETE' });
      await loadGroup(); $('#detail-dialog').close(); setView(state.view); toast('Deleted');
    } catch (e) { toast(e.message); }
  });

  $('#detail-dialog').showModal();
}

boot();
