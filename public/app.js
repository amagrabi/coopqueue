/* ============================================================================
   g4m1ng — client. No framework, no build step: edit, push, done.
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
  view: 'queue',
};

/* Fixed categorical slots, assigned by position in the member list. Colour
   follows the person, never their rank, so filtering never repaints anyone. */
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
                'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
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

/**
 * Can a bare <video> actually play this URL? Steam serves most trailers as an
 * HLS manifest now, which only Safari handles without a streaming library, so
 * ask the browser rather than assuming. Progressive files always pass.
 */
const playable = (url) => {
  if (!/\.m3u8(\?|$)/i.test(url)) return true;
  const v = document.createElement('video');
  return !!(v.canPlayType('application/vnd.apple.mpegurl') ||
            v.canPlayType('application/x-mpegURL'));
};

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
const VIEWS = ['queue', 'next', 'library', 'stats', 'members'];

function setView(view) {
  if (!VIEWS.includes(view)) view = 'queue';
  state.view = view;
  const want = `#/g/${state.group.slug}/${view}`;
  if (location.hash !== want) history.replaceState(null, '', want);
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  ({ queue: renderQueue, next: renderNext, library: renderLibrary,
     stats: renderStats, members: renderMembers }[view])();
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
  $('#btn-skip').addEventListener('click', skipGame);

  $('#lib-search').addEventListener('input', renderLibrary);
  $('#lib-status').addEventListener('change', renderLibrary);
  $('#lib-sort').addEventListener('change', renderLibrary);
  $('#hide-unviable').addEventListener('change', renderNext);

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
function renderQueue() {
  const empty = !state.queue.length;
  $('#queue-empty').hidden = !empty;
  $('#queue-card').hidden = empty;
  if (empty) return;

  if (state.qIndex >= state.queue.length) state.qIndex = 0;
  const g = gameById(state.queue[state.qIndex]);
  if (!g) { state.queue.splice(state.qIndex, 1); return renderQueue(); }

  $('#rate-title').textContent = g.name;
  $('#rate-pos').textContent = `${state.qIndex + 1} of ${state.queue.length} left`;
  $('#rate-desc').textContent = g.short_description || '';
  $('#score-hint').textContent = g.status === 'backlog'
    ? 'how much do you want to play this?'
    : 'how good was it?';

  const video = $('#rate-video');
  const image = $('#rate-image');
  const media = $('.rate-media');
  const note  = $('#rate-notrailer');
  video.pause();
  if (g.trailer_url && playable(g.trailer_url)) {
    video.src = g.trailer_url;
    video.poster = g.header_image || '';
    video.hidden = false; image.hidden = true; note.hidden = true;
    media.classList.remove('is-blank');
  } else if (g.trailer_url && g.header_image) {
    // Steam now serves most trailers only as an HLS stream, which Safari plays
    // natively and Chrome/Firefox do not. Showing the art beats showing a video
    // element that silently never starts.
    video.removeAttribute('src'); video.hidden = true;
    image.src = g.header_image; image.hidden = false;
    note.hidden = false; note.textContent = 'Trailer needs Safari — Steam streams it as HLS';
    media.classList.remove('is-blank');
  } else if (g.header_image) {
    video.removeAttribute('src'); video.hidden = true;
    image.src = g.header_image; image.hidden = false;
    note.hidden = false; note.textContent = 'No trailer on Steam';
    media.classList.remove('is-blank');
  } else {
    // Not linked to Steam yet — a slim prompt beats a viewport-sized black box.
    video.removeAttribute('src'); video.hidden = true; image.hidden = true;
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
  $('#rate-others').innerHTML = others.length
    ? others.map(([id, s]) =>
        `<span class="other-vote"><i class="dot" style="background:${colorOf(id)}"></i>${esc(nameOf(id))} <b>${fmt(s, 1)}</b></span>`
      ).join('')
    : '<span class="other-vote" style="color:var(--text-muted)">Nobody else has rated this yet</span>';

  const start = others.length ? Math.round(g.raw * 2) / 2 : 7.5;
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
  if (g.metacritic)   chips.push(`<span class="chip">MC ${g.metacritic}</span>`);
  if (g.status !== 'backlog') chips.push(`<span class="chip">${STATUS_LABEL[g.status]}</span>`);
  return chips.join('');
}

async function saveRating() {
  const g = gameById(state.queue[state.qIndex]);
  if (!g) return;
  const score = Number($('#score-range').value);
  $('#btn-save').disabled = true;
  try {
    await gapi('/rate', { method: 'POST', body: { gameId: g.id, score } });
    state.queue.splice(state.qIndex, 1);
    $('#queue-count').textContent = state.queue.length || '';
    g.votes[state.me.steamId] = score;
    toast(`${g.name}: ${fmt(score, 1)}`);
    renderQueue();
    gapi('/games').then((lib) => { state.games = lib.games; state.model = lib.model; });
  } catch (e) { toast(e.message); }
  finally { $('#btn-save').disabled = false; }
}

async function skipGame() {
  const g = gameById(state.queue[state.qIndex]);
  if (!g) return;
  try {
    await gapi('/skip', { method: 'POST', body: { gameId: g.id } });
    state.queue.splice(state.qIndex, 1);
    $('#queue-count').textContent = state.queue.length || '';
    renderQueue();
  } catch (e) { toast(e.message); }
}

/* ══════════════════════════════ PLAY NEXT ═════════════════════════════ */
function renderNext() {
  const need = state.group.maxPlayers;
  $('#next-sub').textContent =
    `Backlog games ranked by weighted score — calibrated for how each of you uses the scale, and pulled ` +
    `toward the middle when only one person has voted. Anything that can't fit ${need} players is flagged.`;

  const backlog = state.games.filter((g) => g.status === 'backlog' && g.n > 0);
  const hide = $('#hide-unviable').checked;
  const playable = backlog.filter((g) => g.viability.ok !== false).sort((a, b) => b.weighted - a.weighted);
  const blocked  = backlog.filter((g) => g.viability.ok === false).sort((a, b) => b.weighted - a.weighted);

  $('#next-list').innerHTML = playable.map((g, i) => `
    <li class="rank-row" data-id="${g.id}">
      <div class="rank-num">${i + 1}</div>
      <div class="rank-main">
        <div class="rank-name">${esc(g.name)}</div>
        <div class="rank-meta">${metaChips(g)}${
          g.n === 1 ? '<span class="chip chip-warn">only 1 vote</span>' : ''}</div>
      </div>
      <div class="rank-score"><b>${fmt(g.weighted)}</b><span>${g.n} vote${g.n === 1 ? '' : 's'} · avg ${fmt(g.raw, 1)}</span></div>
    </li>`).join('') || '<p class="view-sub">Nothing rated in the backlog yet — go rate some games.</p>';

  $('#unviable-block').innerHTML = (hide || !blocked.length)
    ? (blocked.length ? `<h3>${blocked.length} more can't be played by ${need} of us</h3><p>Untick the box above to see them.</p>` : '')
    : `<h3>${need} of us can't play these</h3>
       <p>Verified player caps. They stay on the list so nobody re-suggests them.</p>
       ${blocked.map((g) => `
         <div class="unviable-row" data-id="${g.id}">
           <span><strong>${esc(g.name)}</strong> · ${fmt(g.weighted)}</span>
           <span class="why">${esc(g.viability.reason || `caps at ${g.max_players}`)}</span>
         </div>`).join('')}`;

  $$('#next-list .rank-row, #unviable-block .unviable-row')
    .forEach((r) => r.addEventListener('click', () => openDetail(Number(r.dataset.id))));
}

/* ══════════════════════════════ LIBRARY ═══════════════════════════════ */
function renderLibHead() {
  $('#lib-head').innerHTML =
    `<th class="c-name">Game</th><th>Genre</th><th>Status</th><th class="c-num">Players</th>` +
    state.members.map((m) =>
      `<th class="c-p" style="color:${colorOf(m.steam_id)}">${esc(m.short_name)}</th>`).join('') +
    `<th class="c-num">Avg</th><th class="c-num">Weighted</th><th class="c-num">Hrs</th>`;
}

function renderLibrary() {
  const q = $('#lib-search').value.trim().toLowerCase();
  const status = $('#lib-status').value;
  const sort = $('#lib-sort').value;

  const rows = state.games.filter((g) =>
    (!status || g.status === status) &&
    (!q || g.name.toLowerCase().includes(q) || (g.genre || '').toLowerCase().includes(q))
  );

  rows.sort({
    weighted: (a, b) => (b.weighted ?? -1) - (a.weighted ?? -1),
    name:     (a, b) => a.name.localeCompare(b.name),
    spread:   (a, b) => (b.spread ?? -1) - (a.spread ?? -1),
    hours:    (a, b) => (b.hours ?? -1) - (a.hours ?? -1),
    votes:    (a, b) => a.n - b.n,
  }[sort]);

  $('#lib-table tbody').innerHTML = rows.map((g) => `
    <tr data-id="${g.id}">
      <td class="c-name cell-strong">${esc(g.name)}${
        g.viability.ok === false ? ' <span class="chip chip-bad">' + esc(g.viability.label) + '</span>' : ''}</td>
      <td>${esc(g.genre || '—')}</td>
      <td><span class="status-tag">${STATUS_LABEL[g.status]}</span></td>
      <td class="c-num">${g.max_players ?? '?'}</td>
      ${state.members.map((m) => {
        const v = g.votes[m.steam_id];
        return v == null ? '<td class="c-p miss">·</td>' : `<td class="c-p">${fmt(v, 1)}</td>`;
      }).join('')}
      <td class="c-num">${fmt(g.raw, 1)}</td>
      <td class="c-num cell-strong">${fmt(g.weighted)}</td>
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
    ${tile(fmt(s.totals.groupMean, 2), 'group baseline', 'the weighted score pulls toward this')}
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

  $('#top-chart').innerHTML = barChart(s.topRated.map((g) => ({ label: g.name, value: g.weighted })), 10);
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
    <button class="btn btn-primary" id="s-save" style="margin-top:12px">Save</button>`;

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
    $('#add-results').innerHTML = results.map((r) => `
      <button class="add-hit" data-appid="${r.appid}">
        <img src="${esc(r.image || '')}" alt="" loading="lazy">
        <span><b>${esc(r.name)}</b><br><span>${esc(r.price || '')} ${esc(r.release || '')}</span></span>
        <span class="chip">Add</span>
      </button>`).join('');
    $$('#add-results .add-hit').forEach((b) => b.addEventListener('click', () => addGame(b.dataset.appid, b)));
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
