-- New activity only: no history is backfilled and no existing game is changed.
-- Keep this definition in schema.sql too. Apply before deploying the activity API.
CREATE TABLE IF NOT EXISTS group_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(steam_id) ON DELETE SET NULL,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('game_added','rating','status_changed','comment')),
  from_status TEXT,
  to_status TEXT,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_activity_group_id ON group_activity(group_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_group_time ON group_activity(group_id, created_at);

-- AUTOINCREMENT event ids are watermarks: an acknowledged id must never be reused.
-- A member leaving loses their read state; another member's cursor is independent.
CREATE TABLE IF NOT EXISTS activity_reads (
  group_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, steam_id),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id) ON DELETE CASCADE
);

-- Capture writes atomically, including bulk imports, without copying rating values
-- or comment bodies. Seed claims and metadata enrichment must not manufacture news.
CREATE TRIGGER IF NOT EXISTS activity_game_added AFTER INSERT ON games
WHEN EXISTS (SELECT 1 FROM memberships WHERE group_id=NEW.group_id AND steam_id=NEW.added_by AND is_seed=0)
 AND NOT EXISTS (SELECT 1 FROM workspace_settings WHERE group_id=NEW.group_id AND mode='personal')
BEGIN
  INSERT INTO group_activity (group_id,actor_id,game_id,kind)
  VALUES (NEW.group_id,NEW.added_by,NEW.id,'game_added');
END;

CREATE TRIGGER IF NOT EXISTS activity_rating_added AFTER INSERT ON ratings
BEGIN
  INSERT INTO group_activity (group_id,actor_id,game_id,kind)
  SELECT g.group_id,NEW.steam_id,g.id,'rating' FROM games g
  JOIN memberships m ON m.group_id=g.group_id AND m.steam_id=NEW.steam_id AND m.is_seed=0
  WHERE g.id=NEW.game_id
    AND NOT EXISTS (SELECT 1 FROM workspace_settings w WHERE w.group_id=g.group_id AND w.mode='personal');
END;

CREATE TRIGGER IF NOT EXISTS activity_rating_changed AFTER UPDATE OF score ON ratings
WHEN NEW.score IS NOT OLD.score
BEGIN
  INSERT INTO group_activity (group_id,actor_id,game_id,kind)
  SELECT g.group_id,NEW.steam_id,g.id,'rating' FROM games g
  JOIN memberships m ON m.group_id=g.group_id AND m.steam_id=NEW.steam_id AND m.is_seed=0
  WHERE g.id=NEW.game_id
    AND NOT EXISTS (SELECT 1 FROM workspace_settings w WHERE w.group_id=g.group_id AND w.mode='personal');
END;

CREATE TRIGGER IF NOT EXISTS activity_comment_added AFTER INSERT ON comments
BEGIN
  INSERT INTO group_activity (group_id,actor_id,game_id,kind,comment_id)
  SELECT NEW.group_id,NEW.steam_id,NEW.game_id,'comment',NEW.id FROM games g
  JOIN memberships m ON m.group_id=g.group_id AND m.steam_id=NEW.steam_id AND m.is_seed=0
  WHERE g.id=NEW.game_id AND g.group_id=NEW.group_id
    AND NOT EXISTS (SELECT 1 FROM workspace_settings w WHERE w.group_id=g.group_id AND w.mode='personal');
END;

-- Index-bounded housekeeping on the group receiving a write; no scheduled job.
CREATE TRIGGER IF NOT EXISTS activity_retention AFTER INSERT ON group_activity
BEGIN
  DELETE FROM group_activity WHERE group_id=NEW.group_id AND created_at < unixepoch()-7776000;
END;
