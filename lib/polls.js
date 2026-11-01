/**
 * Reschedule polls: "I can't make Tuesday — would any of these work instead?"
 *
 * Shared by the schedule GET (which ships polls beside the sessions they belong
 * to) and the poll route. Every query is group-scoped even though poll and option
 * ids are global, because both are sequential and guessable (invariant 2).
 */
import { findSession, sessionOn, addDays, attendanceOn } from './schedule.js';

export const MAX_CREATE_SLOTS = 5;
export const MAX_SLOTS = 6;           // after other members have added theirs
export const POLL_KEEP_DAYS = 14;     // a decided poll stays visible this long after its session

/**
 * The option worth suggesting: most yes, then fewest no, then most maybe, then the
 * earliest. Null until somebody other than the starter has said yes to something:
 * the starter's own yes votes on their own suggestions are not news, and a fresh
 * poll should not pretend to have a favourite. A slot that has already started is out.
 */
export function bestOption(options, now, createdBy) {
  const live = options.filter((o) => (o.kind !== 'slot' || o.startsAt > now)
    && Object.entries(o.votes).some(([id, v]) => v.answer === 'yes' && id !== createdBy));
  live.sort((a, b) => b.yes - a.yes || a.no - b.no || b.maybe - a.maybe
    || (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity));
  return live[0]?.id ?? null;
}

/**
 * Polls for sessions from the last POLL_KEEP_DAYS onward, newest first.
 *
 * Each poll carries `out`: everyone not coming to the session it is about, read
 * from the same attendance the schedule shows (answers, then away ranges). The
 * starter is usually one of them but rarely the only one, and a poll that only
 * knew about its starter offered "keep Tuesday without Ama" to somebody who could
 * not make Tuesday either. Answers from people who are out do not count on the
 * "as planned" option: they cannot play at that time whatever they voted.
 */
export async function loadPolls(db, gid, rule, overrides, now, today, members, aways) {
  if (!rule) return [];
  const since = addDays(today, -POLL_KEEP_DAYS);
  const [pollRes, optionRes, voteRes, rsvpRes] = await Promise.all([
    db.prepare(
      `SELECT id, session_key, replaces_date, replaces_time, created_by, status,
              decided_option, decided_by, decided_at, created_at
         FROM session_polls WHERE group_id = ? AND session_key >= ? ORDER BY id DESC LIMIT 20`
    ).bind(gid, since).all(),
    db.prepare(
      `SELECT o.id, o.poll_id, o.kind, o.slot_date, o.slot_time, o.added_by
         FROM poll_options o JOIN session_polls p ON p.id = o.poll_id
        WHERE p.group_id = ? AND p.session_key >= ? ORDER BY o.id`
    ).bind(gid, since).all(),
    db.prepare(
      `SELECT v.option_id, v.steam_id, v.answer, v.set_by
         FROM poll_votes v
         JOIN poll_options o ON o.id = v.option_id
         JOIN session_polls p ON p.id = o.poll_id AND p.group_id = v.group_id
        WHERE p.group_id = ? AND p.session_key >= ?`
    ).bind(gid, since).all(),
    db.prepare(
      'SELECT steam_id, session_date, answer, set_by FROM session_rsvps WHERE group_id = ? AND session_date >= ?'
    ).bind(gid, since).all(),
  ]);
  const votes = new Map();
  for (const v of voteRes.results || []) {
    if (!votes.has(v.option_id)) votes.set(v.option_id, {});
    votes.get(v.option_id)[v.steam_id] = { answer: v.answer, setBy: v.set_by || null };
  }
  const optionsByPoll = new Map();
  for (const o of optionRes.results || []) {
    if (!optionsByPoll.has(o.poll_id)) optionsByPoll.set(o.poll_id, []);
    optionsByPoll.get(o.poll_id).push(o);
  }
  const rsvps = rsvpRes.results || [];

  return (pollRes.results || []).map((p) => {
    const session = findSession(rule, overrides, p.session_key);
    // A session no longer on the rule still has a day; its attendance is moot,
    // but the poll stays readable.
    const attendance = attendanceOn(members, rsvps, aways, session || { key: p.session_key, date: p.session_key });
    const out = members.map((m) => m.steam_id).filter((id) => attendance[id]?.state === 'out');
    const options = (optionsByPoll.get(p.id) || []).map((o) => {
      const all = votes.get(o.id) || {};
      const cast = o.kind === 'asplanned'
        ? Object.fromEntries(Object.entries(all).filter(([id]) => !out.includes(id)))
        : all;
      const count = (answer) => Object.values(cast).filter((v) => v.answer === answer).length;
      return {
        id: o.id, kind: o.kind, date: o.slot_date, time: o.slot_time, addedBy: o.added_by,
        startsAt: o.kind === 'slot' ? sessionOn(rule, o.slot_date, o.slot_time).startsAt : null,
        votes: cast, yes: count('yes'), maybe: count('maybe'), no: count('no'),
      };
    });
    // An open poll whose session is over, or no longer on the rule, can only be
    // read: the moment it was about has passed.
    const status = p.status === 'open' && (!session || session.endsAt <= now) ? 'expired' : p.status;
    return {
      id: p.id, key: p.session_key, status, out,
      replacesStartsAt: sessionOn(rule, p.replaces_date, p.replaces_time).startsAt,
      createdBy: p.created_by, createdAt: p.created_at,
      decidedOption: p.decided_option, decidedBy: p.decided_by, decidedAt: p.decided_at,
      options,
      best: status === 'open' ? bestOption(options, now, p.created_by) : null,
    };
  });
}
