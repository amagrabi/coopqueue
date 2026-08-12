-- CoopQueue migration 029 — which workspace opens when you sign in.
--
--   npm run db:migrate -- --file=./migrations/029-default-workspace.sql
--
-- Signing in with no hash landed you in `state.groups[0]`, which is the first
-- workspace in NAME order — an arbitrary answer that changes when somebody renames
-- a group. This makes it a choice.
--
-- Stored on `member_preferences` rather than in a new per-account table for two
-- properties that come free with the existing shape:
--
--   * the composite foreign key cascades from `memberships`, so leaving a group
--     clears the default instead of leaving a dangling id the boot path has to
--     defend against;
--   * the partial unique index below makes "at most one default per account" a
--     database constraint rather than something every write path has to remember.
--
-- The index is the reason `PATCH /api/me` clears the old row BEFORE setting the new
-- one — the other order trips the constraint mid-batch.
--
-- Default 0 keeps existing behaviour: no default, first workspace by name.

ALTER TABLE member_preferences
  ADD COLUMN default_workspace INTEGER NOT NULL DEFAULT 0 CHECK (default_workspace IN (0,1));

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_default_workspace
  ON member_preferences(steam_id) WHERE default_workspace = 1;
