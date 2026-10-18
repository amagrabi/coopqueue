-- Individual acknowledgements complement the existing mark-all watermark.
-- Keep this definition in schema.sql too. No existing read state is changed.
CREATE TABLE IF NOT EXISTS activity_item_reads (
  group_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES group_activity(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, steam_id, event_id),
  FOREIGN KEY (group_id, steam_id) REFERENCES memberships(group_id, steam_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_activity_item_reads_event ON activity_item_reads(event_id);
