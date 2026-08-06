-- CoopQueue — pre-assigned identities for group 1 (g4m1ng).
--
--   npm run db:migrate -- --file=./migrations/007-friend-assignments.sql
--
-- Each of these SteamID64s was verified against Steam's API before being written
-- here: the persona name returned matched the name the owner gave, and the
-- profile URL matched the link they sent. That check mattered — the *persona*
-- "the_party" belongs to 76561197972536594, whose vanity URL is /id/theParty1,
-- while the *vanity URL* /id/the_party belongs to a different account entirely
-- ("Dan M", 76561198010314278). Resolving the wrong one would have handed Dave's
-- 25 ratings to a stranger and deleted the placeholder.
--
-- SteamID64s are public identifiers (they appear in profile URLs), but this file
-- names real people, so keep the repository private.
--
-- Ama (76561198049961191) is absent on purpose: that identity is already claimed,
-- so an assignment would be a permanent no-op.

INSERT INTO seed_assignments (group_id, steam_id, seed_steam_id, note) VALUES
  (1, '76561198119052954', 'seed:1:leo',  'Steam persona kalbshirn'),
  (1, '76561197978963402', 'seed:1:pat',  'Steam persona hrrarrlm'),
  (1, '76561197972536594', 'seed:1:dave', 'Steam persona the_party, /id/theParty1')
ON CONFLICT(group_id, steam_id) DO UPDATE SET
  seed_steam_id = excluded.seed_steam_id,
  note          = excluded.note;
