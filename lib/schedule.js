/**
 * Regular play sessions: turning a standing rule ("Tuesdays 20:30, Berlin") into
 * concrete upcoming sessions, and resolving who is expected at each one.
 *
 * Pure, and shared by the route and the harness so the local schedule is the
 * shipped schedule. Sessions are never stored: they are recomputed from the rule,
 * so changing the rule cannot leave stale session rows behind.
 *
 * Dates are local calendar dates in the schedule's own timezone ('YYYY-MM-DD').
 * Calendar arithmetic is done on those strings through UTC midnight, which has no
 * daylight-saving transitions; only the final wall-clock → instant step consults
 * the timezone.
 */

export const SESSION_COUNT = 8;      // shown on Play next; the strip uses the first
export const RSVP_HORIZON_DAYS = 366; // how far ahead an answer or away range may reach
export const AWAY_SPAN_DAYS = 366;
export const AWAY_LIMIT = 20;         // active ranges per member
export const PRUNE_AFTER_DAYS = 30;   // answers and ranges this far in the past are deleted on write

const DAY = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseDate(value) {
  const m = DATE_RE.exec(String(value ?? ''));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  // Round-trip rejects 2026-02-30, which Date.UTC would silently roll into March.
  return new Date(ms).toISOString().slice(0, 10) === m[0] ? ms : null;
}

const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date, n) => fromMs(parseDate(date) + n * DAY);
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / DAY);

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export const isoWeekday = (date) => ((new Date(parseDate(date)).getUTCDay() + 6) % 7) + 1;

/** Monday-based week number since the epoch (1970-01-01 was a Thursday). */
const weekIndex = (date) => Math.floor((parseDate(date) / DAY + 3) / 7);

const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

export function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { formatter(tz); return true; } catch { return false; }
}

function wallClock(tz, ms) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(ms).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}

/** The local calendar date in `tz` at instant `ms`. */
export const localDate = (tz, ms) => fromMs(wallClock(tz, ms));

/**
 * The instant at which `date time` happens on the wall clock in `tz`. Two passes
 * because the offset at the naive guess can differ from the offset at the answer
 * when a daylight-saving change falls between them.
 */
export function zonedInstant(date, time, tz) {
  const [, hh, mm] = TIME_RE.exec(time);
  const wall = parseDate(date) + (+hh * 60 + +mm) * 60000;
  const second = (ms) => Math.floor(ms / 1000) * 1000;
  let utc = wall - (wallClock(tz, wall) - second(wall));
  const offset = wallClock(tz, utc) - second(utc);
  if (wall - utc !== offset) utc = wall - offset;
  return utc;
}

/** Validate a rule from a request body. Returns { rule } or { error }. */
export function parseRule(input) {
  const raw = Array.isArray(input?.weekdays) ? input.weekdays : [];
  const weekdays = [...new Set(raw.map(Number))].sort((a, b) => a - b);
  if (!weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
      || weekdays.length !== raw.length) {
    return { error: 'pick at least one weekday' };
  }
  const time = String(input.time ?? '');
  if (!TIME_RE.test(time)) return { error: 'start time must be HH:MM' };
  const timezone = String(input.timezone ?? '');
  if (!validTimezone(timezone)) return { error: 'unknown timezone' };
  const everyWeeks = input.everyWeeks == null ? 1 : Number(input.everyWeeks);
  if (!Number.isInteger(everyWeeks) || everyWeeks < 1 || everyWeeks > 4) {
    return { error: 'repeat every 1–4 weeks' };
  }
  const anchorDate = String(input.startDate ?? '');
  if (parseDate(anchorDate) == null) return { error: 'start date must be YYYY-MM-DD' };
  const durationMin = input.durationMin == null ? 180 : Number(input.durationMin);
  if (!Number.isInteger(durationMin) || durationMin < 30 || durationMin > 720) {
    return { error: 'session length must be 30–720 minutes' };
  }
  return { rule: { weekdays, time, timezone, everyWeeks, anchorDate, durationMin } };
}

export function ruleFromRow(row) {
  if (!row) return null;
  return {
    weekdays: JSON.parse(row.weekdays),
    time: row.start_time,
    timezone: row.timezone,
    everyWeeks: row.every_weeks,
    anchorDate: row.anchor_date,
    durationMin: row.duration_min,
  };
}

/** Does the rule put a session on this local date? */
export function isSessionDate(rule, date) {
  if (parseDate(date) == null || date < rule.anchorDate) return false;
  if (!rule.weekdays.includes(isoWeekday(date))) return false;
  return (weekIndex(date) - weekIndex(rule.anchorDate)) % rule.everyWeeks === 0;
}

export function sessionOn(rule, date) {
  const startsAt = zonedInstant(date, rule.time, rule.timezone);
  return { date, startsAt, endsAt: startsAt + rule.durationMin * 60000 };
}

/**
 * The next `count` sessions that have not ended yet, so a session in progress is
 * still "the next session" until it is over. Starts from yesterday because a
 * late session can run past local midnight.
 */
export function upcomingSessions(rule, now, count = SESSION_COUNT) {
  const out = [];
  let date = addDays(localDate(rule.timezone, now), -1);
  if (date < rule.anchorDate) date = rule.anchorDate;
  // Every-4-weeks with one weekday needs 4 weeks per session; bound the scan.
  const limit = count * rule.everyWeeks * 7 + 14;
  for (let i = 0; i < limit && out.length < count; i++, date = addDays(date, 1)) {
    if (!isSessionDate(rule, date)) continue;
    const session = sessionOn(rule, date);
    if (session.endsAt > now) out.push(session);
  }
  return out;
}

/**
 * Who is expected at the session on `date`. Opt-out: nobody RSVPs "yes" to a
 * weekly game every week, so no answer means coming. An explicit answer beats an
 * away range, which is the only reason an explicit 'in' is ever stored.
 */
export function attendanceOn(members, rsvps, aways, date) {
  return Object.fromEntries(members.map((m) => {
    const answer = rsvps.find((r) => r.steam_id === m.steam_id && r.session_date === date);
    if (answer) {
      return [m.steam_id, { state: answer.answer, source: 'answer', setBy: answer.set_by || null }];
    }
    const away = aways.find((a) => a.steam_id === m.steam_id && a.from_date <= date && date <= a.to_date);
    if (away) return [m.steam_id, { state: 'out', source: 'away', setBy: away.set_by || null, awayId: away.id }];
    return [m.steam_id, { state: 'in', source: 'default', setBy: null }];
  }));
}

export const awayCovers = (aways, steamId, date) =>
  aways.some((a) => a.steam_id === steamId && a.from_date <= date && date <= a.to_date);
