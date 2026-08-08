-- Opt-in history prompts and explicit invitations to registered accounts.
-- Both are side tables so this migration is additive and safely replayable.

CREATE TABLE IF NOT EXISTS member_preferences (
  group_id        INTEGER NOT NULL,
  steam_id        TEXT    NOT NULL,
  history_prompts INTEGER NOT NULL DEFAULT 0 CHECK (history_prompts IN (0,1)),
  PRIMARY KEY (group_id, steam_id),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_invites (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  invited_steam_id TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  invited_by       TEXT    NOT NULL REFERENCES users(steam_id) ON DELETE CASCADE,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  responded_at     INTEGER,
  UNIQUE (group_id, invited_steam_id)
);

CREATE INDEX IF NOT EXISTS idx_group_invites_recipient
  ON group_invites(invited_steam_id, status, created_at DESC);
