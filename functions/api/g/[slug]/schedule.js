import { json, bad, body } from '../../../../lib/http.js';
import {
  SESSION_COUNT, RSVP_HORIZON_DAYS, AWAY_SPAN_DAYS, AWAY_LIMIT, PRUNE_AFTER_DAYS,
  parseRule, ruleFromRow, upcomingSessions, attendanceOn, findSession, sessionClash,
  validTime, localDate, addDays, daysBetween, parseDate, awayCovers,
} from '../../../../lib/schedule.js';
import { loadPolls } from '../../../../lib/polls.js';

/**
 * The group's regular session: the standing rule, the next few sessions it
 * produces, and who is expected at each.
 *
 * Attendance is opt-out. Any member may answer for any member, because the
 * realistic flow is "Dave said in Discord he can't make it" and somebody else
 * updating the site — and an unclaimed placeholder cannot answer at all.
 * `set_by` keeps that visible. Changing the standing rule is owner-only, like
 * every other group rule — and so is moving or cancelling one session, which is
 * the owner recording what the group already agreed, without asking again.
 *
 * Personal workspaces have nobody to schedule with: GET reports it disabled and
 * every write is refused.
 */
const scheduleRow = (db, gid) =>
  db.prepare('SELECT * FROM session_schedules WHERE group_id = ?').bind(gid).first();
// Bounded without a query limit: one row per rule session at most, within the
// answer horizon, and pruned 30 days after it has passed.
const overrideRows = async (db, gid) => (await db.prepare(
  'SELECT original_date, new_date, new_time, cancelled, set_by FROM session_overrides WHERE group_id = ?'
).bind(gid).all()).results || [];

export async function onRequestGet({ env, data }) {
  if (data.group.workspace_mode === 'personal') return json({ enabled: false });
  const gid = data.group.group_id;
  const rule = ruleFromRow(await scheduleRow(env.DB, gid));
  const canEdit = data.group.role === 'owner';
  const now = Date.now();
  const today = localDate(rule?.timezone || 'UTC', now);

  const [membersRes, awayRes] = await Promise.all([
    env.DB.prepare('SELECT steam_id FROM memberships WHERE group_id = ?').bind(gid).all(),
    env.DB.prepare(
      `SELECT id, steam_id, from_date, to_date, set_by FROM member_away
        WHERE group_id = ? AND to_date >= ? ORDER BY from_date, id`
    ).bind(gid, today).all(),
  ]);
  const members = membersRes.results || [];
  const aways = awayRes.results || [];
  const away = aways.map((a) => ({
    id: a.id, steamId: a.steam_id, from: a.from_date, to: a.to_date, setBy: a.set_by,
  }));

  if (!rule) return json({ enabled: true, canEdit, schedule: null, sessions: [], away, today });

  const overrides = await overrideRows(env.DB, gid);
  const changedBy = new Map(overrides.map((o) => [o.original_date, o.set_by]));
  const sessions = upcomingSessions(rule, now, SESSION_COUNT, overrides);
  const pollsPromise = loadPolls(env.DB, gid, rule, overrides, now, today);
  let rsvps = [];
  if (sessions.length) {
    // By key, not by a date range: a moved session's key can sit far from its neighbours.
    const res = await env.DB.prepare(
      `SELECT steam_id, session_date, answer, set_by FROM session_rsvps
        WHERE group_id = ? AND session_date IN (${sessions.map(() => '?').join(',')})`
    ).bind(gid, ...sessions.map((s) => s.key)).all();
    rsvps = res.results || [];
  }

  return json({
    enabled: true,
    canEdit,
    schedule: rule,
    today,
    away,
    polls: await pollsPromise,
    sessions: sessions.map((s) => ({
      ...s,
      changedBy: s.moved || s.cancelled ? changedBy.get(s.key) || null : null,
      attendance: s.cancelled ? {} : attendanceOn(members, rsvps, aways, s),
    })),
  });
}

export async function onRequestPut({ request, env, data }) {
  if (data.group.workspace_mode === 'personal') return bad('personal workspaces have no group schedule', 409);
  if (data.group.role !== 'owner') return bad('only the group owner can change the regular session', 403);
  const parsed = parseRule(await body(request));
  if (parsed.error) return bad(parsed.error);
  const r = parsed.rule;
  await env.DB.prepare(
    `INSERT INTO session_schedules
       (group_id, weekdays, start_time, timezone, every_weeks, anchor_date, duration_min, updated_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,unixepoch())
     ON CONFLICT(group_id) DO UPDATE SET
       weekdays=excluded.weekdays, start_time=excluded.start_time, timezone=excluded.timezone,
       every_weeks=excluded.every_weeks, anchor_date=excluded.anchor_date,
       duration_min=excluded.duration_min, updated_by=excluded.updated_by, updated_at=unixepoch()`
  ).bind(data.group.group_id, JSON.stringify(r.weekdays), r.time, r.timezone, r.everyWeeks,
         r.anchorDate, r.durationMin, data.user.steam_id).run();
  return json({ ok: true, schedule: r });
}

/** Removes the rule only. Answers keyed to dates stay, so restoring it restores them. */
export async function onRequestDelete({ env, data }) {
  if (data.group.workspace_mode === 'personal') return bad('personal workspaces have no group schedule', 409);
  if (data.group.role !== 'owner') return bad('only the group owner can change the regular session', 403);
  await env.DB.prepare('DELETE FROM session_schedules WHERE group_id = ?').bind(data.group.group_id).run();
  return json({ ok: true });
}

export async function onRequestPost({ request, env, data }) {
  if (data.group.workspace_mode === 'personal') return bad('personal workspaces have no group schedule', 409);
  const input = await body(request);
  const gid = data.group.group_id;
  const action = String(input.action || '');
  const rule = ruleFromRow(await scheduleRow(env.DB, gid));
  const now = Date.now();
  const today = localDate(rule?.timezone || 'UTC', now);
  const pruneBefore = addDays(today, -PRUNE_AFTER_DAYS);
  // Housekeeping rides along with every write, so neither table grows without bound
  // and no cron is needed.
  const prune = [
    env.DB.prepare('DELETE FROM session_rsvps WHERE group_id = ? AND session_date < ?').bind(gid, pruneBefore),
    env.DB.prepare('DELETE FROM member_away WHERE group_id = ? AND to_date < ?').bind(gid, pruneBefore),
    // A session moved forward from an old key must survive until it is played too.
    env.DB.prepare(
      `DELETE FROM session_overrides WHERE group_id = ?1 AND original_date < ?2
          AND COALESCE(new_date, original_date) < ?2`
    ).bind(gid, pruneBefore),
  ];
  const overrides = rule ? await overrideRows(env.DB, gid) : [];

  if (['move', 'cancel', 'restore'].includes(action)) {
    return changeSession({ env, data, input, action, rule, overrides, now, today, prune });
  }

  if (action === 'unaway') {
    const id = Number(input.id);
    if (!Number.isInteger(id) || id < 1) return bad('bad away id');
    // group_id in the predicate: away ids are global and sequential (invariant 2).
    const res = await env.DB.prepare('DELETE FROM member_away WHERE id = ? AND group_id = ?').bind(id, gid).run();
    if (!res.meta?.changes) return bad('no such away range', 404);
    return json({ ok: true });
  }

  // Answering for somebody else is allowed, but only for a member of THIS group.
  const target = input.steamId == null ? data.user.steam_id : String(input.steamId);
  const member = await env.DB.prepare('SELECT 1 AS x FROM memberships WHERE group_id = ? AND steam_id = ?')
    .bind(gid, target).first();
  if (!member) return bad('that person is not in this group');

  if (action === 'rsvp') {
    if (!rule) return bad('this group has no regular session yet', 409);
    // `date` is the session's key: the day the rule gives it, even after a move.
    const date = String(input.date || '');
    const session = findSession(rule, overrides, date);
    if (!session) return bad('there is no session on that date');
    if (session.cancelled) return bad('that session is cancelled', 409);
    if (session.endsAt <= now) return bad('that session is already over');
    if (daysBetween(today, session.date) > RSVP_HORIZON_DAYS) return bad('that session is too far ahead');
    const answer = input.answer == null ? null : String(input.answer);
    if (answer != null && !['in', 'maybe', 'out'].includes(answer)) return bad('answer must be in, maybe or out');

    /* "Coming" is the default, so it is stored only where it changes something:
       overriding an away range. Storing it everywhere would make a later away
       range silently fail to cover a session somebody once clicked "Coming" on. */
    const aways = (await env.DB.prepare(
      'SELECT steam_id, from_date, to_date FROM member_away WHERE group_id = ? AND steam_id = ?'
    ).bind(gid, target).all()).results || [];
    const store = answer === 'in' ? awayCovers(aways, target, session.date) : answer != null;
    await env.DB.batch([
      store
        ? env.DB.prepare(
          `INSERT INTO session_rsvps (group_id, steam_id, session_date, answer, set_by, updated_at)
           VALUES (?,?,?,?,?,unixepoch())
           ON CONFLICT(group_id, steam_id, session_date) DO UPDATE SET
             answer=excluded.answer, set_by=excluded.set_by, updated_at=unixepoch()`
        ).bind(gid, target, date, answer, data.user.steam_id)
        : env.DB.prepare('DELETE FROM session_rsvps WHERE group_id = ? AND steam_id = ? AND session_date = ?')
          .bind(gid, target, date),
      ...prune,
    ]);
    return json({ ok: true });
  }

  if (action === 'away') {
    const from = String(input.from || '');
    const to = String(input.to || '');
    if (parseDate(from) == null || parseDate(to) == null) return bad('dates must be YYYY-MM-DD');
    if (to < from) return bad('the last day cannot be before the first');
    if (to < today) return bad('that range is already over');
    if (daysBetween(from, to) > AWAY_SPAN_DAYS) return bad('an away range can cover at most a year');
    if (daysBetween(today, from) > RSVP_HORIZON_DAYS) return bad('that range starts too far ahead');
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM member_away WHERE group_id = ? AND steam_id = ? AND to_date >= ?'
    ).bind(gid, target, today).first();
    if ((count?.n ?? 0) >= AWAY_LIMIT) return bad(`at most ${AWAY_LIMIT} away ranges per person`, 409);
    // The newest statement wins: an earlier "coming after all" inside the new range
    // was an override of some older range, not of this one.
    const res = await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM session_rsvps WHERE group_id = ? AND steam_id = ? AND answer = 'in'
            AND session_date BETWEEN ? AND ?`
      ).bind(gid, target, from, to),
      env.DB.prepare(
        'INSERT INTO member_away (group_id, steam_id, from_date, to_date, set_by) VALUES (?,?,?,?,?)'
      ).bind(gid, target, from, to, data.user.steam_id),
      ...prune,
    ]);
    return json({ ok: true, id: res[1]?.meta?.last_row_id ?? Number(res[1]?.lastInsertRowid) });
  }

  return bad('unknown schedule action');
}

/**
 * Owner-only one-off changes: move a single session, cancel it, or put it back on
 * the rule. None of them touches the rule, so the regular slot resumes by itself.
 *
 * Moving clears the answers given for that session, because they were answers to
 * a different time: "can't make Tuesday" says nothing about Monday. Cancelling
 * keeps them, since restoring a cancelled session brings back the same time.
 */
async function changeSession({ env, data, input, action, rule, overrides, now, today, prune }) {
  if (data.group.role !== 'owner') return bad('only the group owner can change a single session', 403);
  if (!rule) return bad('this group has no regular session yet', 409);
  const gid = data.group.group_id;
  const key = String(input.key || '');
  const session = findSession(rule, overrides, key);
  if (!session) return bad('there is no session on that date');
  if (session.endsAt <= now) return bad('that session is already over');
  const existing = overrides.find((o) => o.original_date === key);
  const clearAnswers = env.DB.prepare('DELETE FROM session_rsvps WHERE group_id = ? AND session_date = ?')
    .bind(gid, key);
  const removeOverride = env.DB.prepare('DELETE FROM session_overrides WHERE group_id = ? AND original_date = ?')
    .bind(gid, key);
  const upsert = (newDate, newTime, cancelled) => env.DB.prepare(
    `INSERT INTO session_overrides (group_id, original_date, new_date, new_time, cancelled, set_by, updated_at)
     VALUES (?,?,?,?,?,?,unixepoch())
     ON CONFLICT(group_id, original_date) DO UPDATE SET
       new_date=excluded.new_date, new_time=excluded.new_time, cancelled=excluded.cancelled,
       set_by=excluded.set_by, updated_at=unixepoch()`
  ).bind(gid, key, newDate, newTime, cancelled, data.user.steam_id);

  if (action === 'restore') {
    if (!existing) return bad('that session already follows the regular schedule', 409);
    const regular = findSession(rule, [], key);
    if (regular.endsAt <= now) return bad('its regular time has already passed');
    if (sessionClash(rule, overrides, key, key)) return bad('another session has been moved onto that day', 409);
    await env.DB.batch([...(existing.cancelled ? [] : [clearAnswers]), removeOverride, ...prune]);
    return json({ ok: true });
  }

  if (action === 'cancel') {
    if (session.cancelled) return bad('that session is already cancelled', 409);
    await env.DB.batch([upsert(null, null, 1), ...prune]);
    return json({ ok: true });
  }

  const date = String(input.date || '');
  const time = String(input.time || '');
  if (parseDate(date) == null) return bad('date must be YYYY-MM-DD');
  if (!validTime(time)) return bad('time must be HH:MM');
  if (daysBetween(today, date) > RSVP_HORIZON_DAYS) return bad('that date is too far ahead');
  const moved = findSession(rule, [{ original_date: key, new_date: date, new_time: time, cancelled: 0 }], key);
  if (moved.startsAt <= now) return bad('pick a time that has not started yet');
  if (sessionClash(rule, overrides, date, key)) return bad('there is already a session on that day', 409);
  if (!session.cancelled && session.date === date && session.time === time) {
    return bad('that is already when this session is', 409);
  }
  // Back onto its own slot is a restore, so the session reads as regular again.
  const toRegular = date === key && time === rule.time;
  await env.DB.batch([clearAnswers, toRegular ? removeOverride : upsert(date, time, 0), ...prune]);
  return json({ ok: true });
}

