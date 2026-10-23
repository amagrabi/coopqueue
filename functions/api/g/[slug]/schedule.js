import { json, bad, body } from '../../../../lib/http.js';
import {
  SESSION_COUNT, RSVP_HORIZON_DAYS, AWAY_SPAN_DAYS, AWAY_LIMIT, PRUNE_AFTER_DAYS,
  parseRule, ruleFromRow, upcomingSessions, attendanceOn, isSessionDate, sessionOn,
  localDate, addDays, daysBetween, parseDate, awayCovers,
} from '../../../../lib/schedule.js';

/**
 * The group's regular session: the standing rule, the next few sessions it
 * produces, and who is expected at each.
 *
 * Attendance is opt-out. Any member may answer for any member, because the
 * realistic flow is "Dave said in Discord he can't make it" and somebody else
 * updating the site — and an unclaimed placeholder cannot answer at all.
 * `set_by` keeps that visible. Changing the standing rule is owner-only, like
 * every other group rule.
 *
 * Personal workspaces have nobody to schedule with: GET reports it disabled and
 * every write is refused.
 */
const scheduleRow = (db, gid) =>
  db.prepare('SELECT * FROM session_schedules WHERE group_id = ?').bind(gid).first();

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

  const sessions = upcomingSessions(rule, now, SESSION_COUNT);
  let rsvps = [];
  if (sessions.length) {
    const res = await env.DB.prepare(
      `SELECT steam_id, session_date, answer, set_by FROM session_rsvps
        WHERE group_id = ? AND session_date BETWEEN ? AND ?`
    ).bind(gid, sessions[0].date, sessions[sessions.length - 1].date).all();
    rsvps = res.results || [];
  }

  return json({
    enabled: true,
    canEdit,
    schedule: rule,
    today,
    away,
    sessions: sessions.map((s) => ({ ...s, attendance: attendanceOn(members, rsvps, aways, s.date) })),
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
  ];

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
    const date = String(input.date || '');
    if (!isSessionDate(rule, date)) return bad('there is no session on that date');
    if (sessionOn(rule, date).endsAt <= now) return bad('that session is already over');
    if (daysBetween(today, date) > RSVP_HORIZON_DAYS) return bad('that session is too far ahead');
    const answer = input.answer == null ? null : String(input.answer);
    if (answer != null && !['in', 'maybe', 'out'].includes(answer)) return bad('answer must be in, maybe or out');

    /* "Coming" is the default, so it is stored only where it changes something:
       overriding an away range. Storing it everywhere would make a later away
       range silently fail to cover a session somebody once clicked "Coming" on. */
    const aways = (await env.DB.prepare(
      'SELECT steam_id, from_date, to_date FROM member_away WHERE group_id = ? AND steam_id = ?'
    ).bind(gid, target).all()).results || [];
    const store = answer === 'in' ? awayCovers(aways, target, date) : answer != null;
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
