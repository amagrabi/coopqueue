import { json, bad, body } from '../../../../lib/http.js';
import {
  RSVP_HORIZON_DAYS, PRUNE_AFTER_DAYS, ruleFromRow, findSession, sessionClash, sessionOn,
  validTime, localDate, addDays, daysBetween, parseDate,
} from '../../../../lib/schedule.js';
import { MAX_CREATE_SLOTS, MAX_SLOTS, POLL_KEEP_DAYS } from '../../../../lib/polls.js';

/**
 * Reschedule polls. Any member can start one for a session they can't make,
 * suggest times, add a time to somebody else's poll, and answer — for themselves
 * or, as with attendance, for a member who said it in chat. Confirming the result
 * is limited to whoever started the poll and the owner: confirming moves or
 * cancels a session, and anyone being able to do that would route around the
 * owner-only direct move.
 *
 * Reads come with the schedule (GET /schedule) so the strip and the poll stay in
 * one snapshot. Personal workspaces have no schedule and refuse every write.
 */
export async function onRequestPost({ request, env, data }) {
  if (data.group.workspace_mode === 'personal') return bad('personal workspaces have no group schedule', 409);
  const input = await body(request);
  const gid = data.group.group_id;
  const me = data.user.steam_id;
  const action = String(input.action || '');

  const row = await env.DB.prepare('SELECT * FROM session_schedules WHERE group_id = ?').bind(gid).first();
  const rule = ruleFromRow(row);
  if (!rule) return bad('this group has no regular session yet', 409);
  const overrides = (await env.DB.prepare(
    'SELECT original_date, new_date, new_time, cancelled FROM session_overrides WHERE group_id = ?'
  ).bind(gid).all()).results || [];
  const now = Date.now();
  const today = localDate(rule.timezone, now);
  // Housekeeping rides along with every write, as on the schedule route.
  const prune = env.DB.prepare('DELETE FROM session_polls WHERE group_id = ? AND session_key < ?')
    .bind(gid, addDays(today, -Math.max(PRUNE_AFTER_DAYS, POLL_KEEP_DAYS)));

  /** A replacement time: real, upcoming, in reach, and not on another session's day. */
  const checkSlot = (key, slot, { allowCurrent = false } = {}) => {
    const date = String(slot?.date || '');
    const time = String(slot?.time || '');
    if (parseDate(date) == null) return { error: bad('dates must be YYYY-MM-DD') };
    if (!validTime(time)) return { error: bad('times must be HH:MM') };
    if (daysBetween(today, date) > RSVP_HORIZON_DAYS) return { error: bad('that date is too far ahead') };
    if (sessionOn(rule, date, time).startsAt <= now) return { error: bad('pick times that have not started yet') };
    if (sessionClash(rule, overrides, date, key)) return { error: bad('there is already a session on that day', 409) };
    const current = findSession(rule, overrides, key);
    const already = !!current && !current.cancelled && current.date === date && current.time === time;
    if (already && !allowCurrent) return { error: bad('that is already when this session is', 409) };
    return { date, time, already };
  };

  /** A poll of this group, or null. Poll ids are global (invariant 2). */
  const pollOf = async (id) => {
    const pollId = Number(id);
    if (!Number.isSafeInteger(pollId) || pollId < 1) return null;
    const poll = await env.DB.prepare('SELECT * FROM session_polls WHERE id = ? AND group_id = ?')
      .bind(pollId, gid).first();
    if (!poll) return null;
    const session = findSession(rule, overrides, poll.session_key);
    const live = poll.status === 'open' && session && session.endsAt > now;
    return { ...poll, session, live };
  };

  if (action === 'create') {
    const key = String(input.key || '');
    const session = findSession(rule, overrides, key);
    if (!session) return bad('there is no session on that date');
    if (session.endsAt <= now) return bad('that session is already over');
    if (session.cancelled) return bad('that session is already cancelled', 409);
    const raw = Array.isArray(input.slots) ? input.slots : [];
    if (raw.length < 1 || raw.length > MAX_CREATE_SLOTS) return bad(`suggest 1–${MAX_CREATE_SLOTS} times`);
    const slots = [];
    for (const slot of raw) {
      const checked = checkSlot(key, slot);
      if (checked.error) return checked.error;
      if (slots.some((s) => s.date === checked.date && s.time === checked.time)) return bad('each time can only be suggested once');
      slots.push(checked);
    }
    const open = await env.DB.prepare(
      "SELECT id FROM session_polls WHERE group_id = ? AND session_key = ? AND status = 'open'"
    ).bind(gid, key).first();
    if (open) return json({ error: 'there is already a poll for that session', pollId: open.id }, 409);

    /* One batch, so a half-made poll never exists. Later statements find the new
       poll through the one-open-poll-per-session index rather than a returned id,
       which a D1 batch cannot pass between statements. */
    const thisPoll = "SELECT id FROM session_polls WHERE group_id = ?1 AND session_key = ?2 AND status = 'open'";
    const option = (kind, date, time) => env.DB.prepare(
      `INSERT INTO poll_options (poll_id, kind, slot_date, slot_time, added_by)
       SELECT id, ?3, ?4, ?5, ?6 FROM session_polls WHERE group_id = ?1 AND session_key = ?2 AND status = 'open'`
    ).bind(gid, key, kind, date, time, me);
    const cantMake = input.cantMake !== false;
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO session_polls (group_id, session_key, replaces_date, replaces_time, created_by) VALUES (?,?,?,?,?)'
      ).bind(gid, key, session.date, session.time, me),
      ...slots.map((s) => option('slot', s.date, s.time)),
      option('asplanned', null, null),
      option('skip', null, null),
      // The suggester can make every time they suggested.
      env.DB.prepare(
        `INSERT INTO poll_votes (option_id, group_id, steam_id, answer, set_by)
         SELECT o.id, ?1, ?3, 'yes', ?3 FROM poll_options o
          WHERE o.kind = 'slot' AND o.poll_id = (${thisPoll})`
      ).bind(gid, key, me),
      // Starting a poll because you can't make it says so in the attendance too.
      ...(cantMake ? [env.DB.prepare(
        `INSERT INTO session_rsvps (group_id, steam_id, session_date, answer, set_by, updated_at)
         VALUES (?,?,?,'out',?,unixepoch())
         ON CONFLICT(group_id, steam_id, session_date) DO UPDATE SET
           answer='out', set_by=excluded.set_by, updated_at=unixepoch()`
      ).bind(gid, me, key, me)] : []),
      prune,
    ]);
    const created = await env.DB.prepare(thisPoll).bind(gid, key).first();
    return json({ ok: true, pollId: created?.id ?? null });
  }

  if (action === 'add') {
    const poll = await pollOf(input.pollId);
    if (!poll) return bad('no such poll', 404);
    if (!poll.live) return bad('that poll is closed', 409);
    const checked = checkSlot(poll.session_key, input);
    if (checked.error) return checked.error;
    const slots = (await env.DB.prepare(
      "SELECT slot_date, slot_time FROM poll_options WHERE poll_id = ? AND kind = 'slot'"
    ).bind(poll.id).all()).results || [];
    if (slots.length >= MAX_SLOTS) return bad(`a poll can hold at most ${MAX_SLOTS} times`, 409);
    if (slots.some((s) => s.slot_date === checked.date && s.slot_time === checked.time)) {
      return bad('that time is already in the poll', 409);
    }
    const res = await env.DB.prepare(
      "INSERT INTO poll_options (poll_id, kind, slot_date, slot_time, added_by) VALUES (?, 'slot', ?, ?, ?)"
    ).bind(poll.id, checked.date, checked.time, me).run();
    const optionId = res.meta?.last_row_id;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO poll_votes (option_id, group_id, steam_id, answer, set_by) VALUES (?,?,?,'yes',?)"
      ).bind(optionId, gid, me, me),
      prune,
    ]);
    return json({ ok: true, optionId });
  }

  if (action === 'vote') {
    const optionId = Number(input.optionId);
    if (!Number.isSafeInteger(optionId) || optionId < 1) return bad('no such option', 404);
    const option = await env.DB.prepare(
      `SELECT o.id, o.poll_id FROM poll_options o JOIN session_polls p ON p.id = o.poll_id
        WHERE o.id = ? AND p.group_id = ?`
    ).bind(optionId, gid).first();
    if (!option) return bad('no such option', 404);
    const poll = await pollOf(option.poll_id);
    if (!poll?.live) return bad('that poll is closed', 409);
    const target = input.steamId == null ? me : String(input.steamId);
    const member = await env.DB.prepare('SELECT 1 AS x FROM memberships WHERE group_id = ? AND steam_id = ?')
      .bind(gid, target).first();
    if (!member) return bad('that person is not in this group');
    const answer = input.answer == null ? null : String(input.answer);
    if (answer != null && !['yes', 'maybe', 'no'].includes(answer)) return bad('answer must be yes, maybe or no');
    await env.DB.batch([
      answer == null
        ? env.DB.prepare('DELETE FROM poll_votes WHERE option_id = ? AND steam_id = ? AND group_id = ?')
          .bind(optionId, target, gid)
        : env.DB.prepare(
          `INSERT INTO poll_votes (option_id, group_id, steam_id, answer, set_by, updated_at)
           VALUES (?,?,?,?,?,unixepoch())
           ON CONFLICT(option_id, steam_id) DO UPDATE SET
             answer=excluded.answer, set_by=excluded.set_by, updated_at=unixepoch()`
        ).bind(optionId, gid, target, answer, me),
      prune,
    ]);
    return json({ ok: true });
  }

  if (action === 'decide' || action === 'withdraw') {
    const poll = await pollOf(input.pollId);
    if (!poll) return bad('no such poll', 404);
    if (poll.created_by !== me && data.group.role !== 'owner') {
      return bad('only whoever started the poll or the group owner can close it', 403);
    }
    if (!poll.live) return bad('that poll is closed', 409);
    const close = (optionId) => env.DB.prepare(
      `UPDATE session_polls SET status = ?, decided_option = ?, decided_by = ?, decided_at = unixepoch()
        WHERE id = ? AND group_id = ? AND status = 'open'`
    ).bind(action === 'decide' ? 'decided' : 'withdrawn', optionId, me, poll.id, gid);
    if (action === 'withdraw') {
      await env.DB.batch([close(null), prune]);
      return json({ ok: true });
    }

    const optionId = Number(input.optionId);
    const option = Number.isSafeInteger(optionId) ? await env.DB.prepare(
      'SELECT * FROM poll_options WHERE id = ? AND poll_id = ?'
    ).bind(optionId, poll.id).first() : null;
    if (!option) return bad('no such option', 404);
    const key = poll.session_key;
    const override = (newDate, newTime, cancelled) => env.DB.prepare(
      `INSERT INTO session_overrides (group_id, original_date, new_date, new_time, cancelled, set_by, updated_at)
       VALUES (?,?,?,?,?,?,unixepoch())
       ON CONFLICT(group_id, original_date) DO UPDATE SET
         new_date=excluded.new_date, new_time=excluded.new_time, cancelled=excluded.cancelled,
         set_by=excluded.set_by, updated_at=unixepoch()`
    ).bind(gid, key, newDate, newTime, cancelled, me);

    if (option.kind === 'asplanned') {
      // Whoever can't make it stays out; the session itself is unchanged.
      await env.DB.batch([close(option.id), prune]);
      return json({ ok: true });
    }
    if (option.kind === 'skip') {
      // Same row a direct cancel writes, and like it, answers are kept for a restore.
      await env.DB.batch([override(null, null, 1), close(option.id), prune]);
      return json({ ok: true });
    }

    // The owner may have moved the session there directly while the poll ran.
    const checked = checkSlot(key, { date: option.slot_date, time: option.slot_time }, { allowCurrent: true });
    if (checked.error) return checked.error;
    if (checked.already) {
      await env.DB.batch([close(option.id), prune]);
      return json({ ok: true });
    }
    const toRegular = checked.date === key && checked.time === rule.time;
    /* Exactly what a direct move does — clear the answers given for the old time —
       and then carry the poll over: whoever said no to this time is out of it, a
       maybe stays a maybe. Yes and silence are the opt-out default. */
    await env.DB.batch([
      env.DB.prepare('DELETE FROM session_rsvps WHERE group_id = ? AND session_date = ?').bind(gid, key),
      toRegular
        ? env.DB.prepare('DELETE FROM session_overrides WHERE group_id = ? AND original_date = ?').bind(gid, key)
        : override(checked.date, checked.time, 0),
      env.DB.prepare(
        `INSERT INTO session_rsvps (group_id, steam_id, session_date, answer, set_by)
         SELECT v.group_id, v.steam_id, ?2, CASE v.answer WHEN 'no' THEN 'out' ELSE 'maybe' END, ?3
           FROM poll_votes v
           JOIN memberships m ON m.group_id = v.group_id AND m.steam_id = v.steam_id
          WHERE v.option_id = ?4 AND v.group_id = ?1 AND v.answer IN ('no','maybe')`
      ).bind(gid, key, me, option.id),
      close(option.id),
      prune,
    ]);
    return json({ ok: true });
  }

  return bad('unknown poll action');
}
