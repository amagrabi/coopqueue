import { bad, SECURITY_HEADERS } from '../../../../lib/http.js';

const TABLES = {
  games: {
    columns: [
      'id', 'group_id', 'name', 'steam_appid', 'genre', 'status', 'max_players',
      'min_session_minutes', 'coop_note', 'header_image', 'trailer_url',
      'short_description', 'price', 'release_date', 'metacritic', 'hours',
      'hours_estimated', 'hours_participants', 'started', 'finished',
      'finished_estimated', 'notes', 'added_by', 'enriched_at', 'archived_at', 'created_at',
    ],
    sql: 'SELECT * FROM games WHERE group_id = ? ORDER BY id',
  },
  history: {
    columns: ['group_id', 'game_id', 'field', 'source', 'set_by', 'updated_at'],
    sql: 'SELECT * FROM game_fact_sources WHERE group_id = ? ORDER BY game_id, field',
  },
  ratings: {
    columns: ['game_id', 'steam_id', 'score', 'comment', 'updated_at'],
    sql: `SELECT r.* FROM ratings r JOIN games g ON g.id = r.game_id
           WHERE g.group_id = ? ORDER BY r.game_id, r.steam_id`,
  },
  comments: {
    columns: ['id', 'group_id', 'game_id', 'steam_id', 'body', 'created_at'],
    sql: 'SELECT * FROM comments WHERE group_id = ? ORDER BY id',
  },
  members: {
    columns: [
      'steam_id', 'short_name', 'role', 'is_seed', 'joined_at',
      'display_name', 'avatar', 'account_created_at', 'last_seen_at',
    ],
    sql: `SELECT m.steam_id, m.short_name, m.role, m.is_seed, m.joined_at,
                 u.display_name, u.avatar, u.created_at AS account_created_at, u.last_seen_at
            FROM memberships m JOIN users u ON u.steam_id = m.steam_id
           WHERE m.group_id = ? ORDER BY m.short_name COLLATE NOCASE`,
  },
};

/** Owner-only portable export. JSON is the lossless backup; CSV is one relation
 * per download so it remains valid CSV instead of inventing a multi-table dialect. */
export async function onRequestGet({ request, env, data }) {
  if (data.group.role !== 'owner') return bad('only the group owner can export group data', 403);

  const params = new URL(request.url).searchParams;
  const format = (params.get('format') || 'json').toLowerCase();
  const gid = data.group.group_id;
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${data.group.slug}-${stamp}`.replace(/[^a-z0-9-]/gi, '-');

  if (format === 'csv') {
    const tableName = (params.get('table') || '').toLowerCase();
    const table = TABLES[tableName];
    if (!table) return bad(`table must be one of ${Object.keys(TABLES).join(', ')}`);
    const result = await env.DB.prepare(table.sql).bind(gid).all();
    return streamed(csvChunks(table.columns, result.results || []), 'text/csv; charset=utf-8',
      `${base}-${tableName}.csv`);
  }
  if (format !== 'json') return bad('format must be json or csv');

  const [group, ...results] = await Promise.all([
    env.DB.prepare(
      `SELECT g.id, g.slug, g.name, g.max_players, g.blind_rating, g.created_by, g.created_at,
              COALESCE(w.mode, 'coop') AS mode
         FROM groups g LEFT JOIN workspace_settings w ON w.group_id = g.id
        WHERE g.id = ?`
    ).bind(gid).first(),
    ...Object.values(TABLES).map((table) => env.DB.prepare(table.sql).bind(gid).all()),
  ]);
  const dataTables = Object.fromEntries(Object.keys(TABLES).map((name, i) => [name, results[i].results || []]));
  const exported = {
    version: 2,
    exportedAt: new Date().toISOString(),
    group,
    ...dataTables,
  };

  return streamed(jsonChunks(exported), 'application/json; charset=utf-8', `${base}.json`);
}

function streamed(iterator, contentType, filename) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    pull(controller) {
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
  }), {
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

function* jsonChunks(value) {
  // Stream each relation independently. D1 returns each result set as an array,
  // but this avoids constructing a second, group-sized JSON string in memory.
  yield '{';
  const scalar = { version: value.version, exportedAt: value.exportedAt, group: value.group };
  yield JSON.stringify(scalar).slice(1, -1);
  for (const name of Object.keys(TABLES)) {
    yield `,"${name}":[`;
    const rows = value[name];
    for (let i = 0; i < rows.length; i++) {
      if (i) yield ',';
      yield JSON.stringify(rows[i]);
    }
    yield ']';
  }
  yield '}\n';
}

function* csvChunks(columns, rows) {
  yield '\ufeff' + columns.map(csvCell).join(',') + '\r\n';
  for (const row of rows) {
    yield columns.map((column) => csvCell(row[column])).join(',') + '\r\n';
  }
}

function csvCell(value) {
  if (value == null) return '';
  let text = String(value);
  // Opening a CSV in a spreadsheet must not execute a member name or comment as
  // a formula. JSON remains the exact, lossless backup.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
