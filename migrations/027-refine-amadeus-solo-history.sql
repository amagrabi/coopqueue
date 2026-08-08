-- Refine the first Amadeus Solo Games import without overwriting later edits.
-- Steam lifetime minutes are rounded to one decimal hour. A game is promoted
-- from sampled to finished only when the imported achievement snapshot contains
-- an explicit story-ending or game-completion achievement; completion percentage
-- and playtime alone are deliberately not evidence of finishing a game.

UPDATE games
   SET hours = round(hours, 1)
 WHERE group_id = (SELECT id FROM groups WHERE slug = 'amadeus-solo-games')
   AND hours IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM game_fact_sources f
      WHERE f.group_id = games.group_id AND f.game_id = games.id
        AND f.field = 'hours' AND f.source = 'steam-hours'
   )
   AND abs(hours - round(hours, 1)) > 0.000001;

-- Dune is intentionally added only to the personal workspace. The existing
-- g4m1ng row stays in Backlog. Its live-service structure and achievements do
-- not establish a story ending, so its conservative outcome is Sampled.
INSERT OR IGNORE INTO games
  (group_id,name,steam_appid,genre,status,header_image,trailer_url,short_description,
   price,release_date,metacritic,hours,started,finished,added_by,enriched_at)
SELECT gr.id,s.name,s.appid,s.genre,'sampled',s.header_image,s.trailer_url,
       s.short_description,s.price,s.release_date,s.metacritic,
       round(p.minutes / 60.0, 1),'2025-07-06',date(p.last_played,'unixepoch'),
       '76561198049961191',unixepoch()
  FROM groups gr
  JOIN workspace_settings w ON w.group_id=gr.id AND w.mode='personal'
  JOIN steam_apps s ON s.appid=1172710
  JOIN playtime p ON p.steam_id='76561198049961191' AND p.appid=s.appid
 WHERE gr.slug='amadeus-solo-games'
   AND NOT EXISTS (
     SELECT 1 FROM games existing
      WHERE existing.group_id=gr.id AND existing.steam_appid=s.appid
   );

-- Two previously transient achievement lookups now give us missing play dates.
-- Only fill NULL fields so a date entered since migration 026 always wins.
UPDATE games
   SET started = '2018-03-17'
 WHERE group_id = (SELECT id FROM groups WHERE slug='amadeus-solo-games')
   AND steam_appid=578080 AND started IS NULL;
UPDATE games
   SET finished = '2019-01-17'
 WHERE group_id = (SELECT id FROM groups WHERE slug='amadeus-solo-games')
   AND steam_appid=578080 AND finished IS NULL;
UPDATE games
   SET started = '2018-01-13'
 WHERE group_id = (SELECT id FROM groups WHERE slug='amadeus-solo-games')
   AND steam_appid=501300 AND started IS NULL;
UPDATE games
   SET finished = '2018-01-13'
 WHERE group_id = (SELECT id FROM groups WHERE slug='amadeus-solo-games')
   AND steam_appid=501300 AND finished IS NULL;

-- These are the high-confidence completions in the imported achievement set.
-- The exact achievement evidence and repeatable review process are recorded in
-- docs/PERSONAL_STEAM_HISTORY.md.
UPDATE games
   SET status = 'finished'
 WHERE group_id = (SELECT id FROM groups WHERE slug='amadeus-solo-games')
   AND status = 'sampled'
   AND steam_appid IN (
     221910, 264710, 367520, 405640, 501300, 606860,
     814380, 1057090, 1091500, 2358720, 2592160
   );

INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
SELECT g.group_id,g.id,'hours','steam-hours','76561198049961191'
  FROM games g JOIN groups gr ON gr.id=g.group_id
 WHERE gr.slug='amadeus-solo-games' AND g.steam_appid=1172710;

INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
SELECT g.group_id,g.id,'started','achievement','76561198049961191'
  FROM games g JOIN groups gr ON gr.id=g.group_id
 WHERE gr.slug='amadeus-solo-games'
   AND ((g.steam_appid=1172710 AND g.started='2025-07-06')
     OR (g.steam_appid=501300 AND g.started='2018-01-13'));

-- PUBG's first achievement date differs from Edith Finch's; keep it explicit.
INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
SELECT g.group_id,g.id,'started','achievement','76561198049961191'
  FROM games g JOIN groups gr ON gr.id=g.group_id
 WHERE gr.slug='amadeus-solo-games'
   AND g.steam_appid=578080 AND g.started='2018-03-17';

INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
SELECT g.group_id,g.id,'finished','achievement','76561198049961191'
  FROM games g JOIN groups gr ON gr.id=g.group_id
 WHERE gr.slug='amadeus-solo-games'
   AND ((g.steam_appid=578080 AND g.finished='2019-01-17')
     OR (g.steam_appid=501300 AND g.finished='2018-01-13'));

INSERT OR IGNORE INTO game_fact_sources (group_id,game_id,field,source,set_by)
SELECT g.group_id,g.id,'finished','steam-last-played','76561198049961191'
  FROM games g JOIN groups gr ON gr.id=g.group_id
 WHERE gr.slug='amadeus-solo-games'
   AND g.steam_appid=1172710 AND g.finished='2025-08-02';

-- These snapshots were the only missing achievement responses in migration 026.
-- INSERT OR IGNORE preserves a newer sync if one has already happened.
INSERT OR IGNORE INTO achievement_progress
  (steam_id,appid,achieved,total,unlocked,fetched_at)
VALUES
  ('76561198049961191',1172710,32,72,'[{"key":"sb-ach-progression1","name":"Welcome to Arrakis","unlocktime":1751795626},{"key":"sb-ach-progression2","name":"Echoes of the Past","unlocktime":1752190204},{"key":"sb-ach-progression4","name":"In Their Footsteps","unlocktime":1752241692},{"key":"sb-ach-progression5","name":"Job’s Done!","unlocktime":1751795626},{"key":"sb-ach-progression7","name":"Kirab Instigator","unlocktime":1753011979},{"key":"sb-ach-progression8","name":"Infiltrate and Neutralize","unlocktime":1752925385},{"key":"sb-ach-progression9","name":"Silver or Steel?","unlocktime":1752445948},{"key":"sb-ach-progression10","name":"Survivor’s Guilt","unlocktime":1752925385},{"key":"sb-ach-progression11","name":"The Scorpion’s Sting","unlocktime":1752927355},{"key":"sb-ach-progression12","name":"Intelligence and Counter-Intelligence","unlocktime":1752927851},{"key":"sb-ach-progression14","name":"Imperial Testing Station Investigator","unlocktime":1752445948},{"key":"sb-ach-exploration1","name":"Among the Hawks","unlocktime":1752445948},{"key":"sb-ach-exploration2","name":"Among the Griffins","unlocktime":1751882975},{"key":"sb-ach-exploration3","name":"Harko Village","unlocktime":1751813167},{"key":"sb-ach-exploration4","name":"Arrakeen","unlocktime":1751795626},{"key":"sb-ach-exploration5","name":"Sea of Sand","unlocktime":1753130708},{"key":"sb-ach-exploration6","name":"Desert''s Grasp","unlocktime":1751882975},{"key":"sb-ach-exploration7","name":"On Top of the World","unlocktime":1751989285},{"key":"sb-ach-exploration8","name":"Dentist","unlocktime":1751991620},{"key":"sb-ach-exploration10","name":"Merchant","unlocktime":1752190617},{"key":"sb-ach-industry1","name":"Across the Sands","unlocktime":1751795626},{"key":"sb-ach-industry2","name":"Above the Sands","unlocktime":1752246727},{"key":"sb-ach-industry4","name":"Basic Machinery","unlocktime":1751795626},{"key":"sb-ach-industry5","name":"Advanced Machinery","unlocktime":1752322490},{"key":"sb-ach-industry8","name":"Stake Your Claim","unlocktime":1751795626},{"key":"sb-ach-industry12","name":"Eco-Friendly","unlocktime":1752336990},{"key":"sb-ach-social2","name":"Hawks and Griffins","unlocktime":1751931682},{"key":"sb-ach-social5","name":"House Operator","unlocktime":1752682741},{"key":"sb-ach-misc2","name":"Staring Contest","unlocktime":1751795626},{"key":"sb-ach-misc6","name":"Time to Relax","unlocktime":1751796214},{"key":"sb-ach-misc10","name":"Vampire","unlocktime":1751795626},{"key":"sb-ach-combat3","name":"Own Medicine","unlocktime":1752927336}]',unixepoch()),
  ('76561198049961191',578080,19,37,'[{"key":"achive002","name":"Dynamic Duo","unlocktime":1521585961},{"key":"achive003","name":"Fantastic Four","unlocktime":1521388018},{"key":"achive004","name":"Top 10","unlocktime":1521668040},{"key":"achive005","name":"Pacifist","unlocktime":1521390835},{"key":"achive007","name":"CQB Expert","unlocktime":1521903323},{"key":"achive008","name":"CQB Novice","unlocktime":1521374579},{"key":"achive009","name":"Marksman Master","unlocktime":1547757171},{"key":"achive010","name":"Marksman Expert","unlocktime":1521841213},{"key":"achive011","name":"Marksman Novice","unlocktime":1521385600},{"key":"achive016","name":"Collateral Damage","unlocktime":1521662626},{"key":"achive017","name":"Devil Inside Me","unlocktime":1521304566},{"key":"achive018","name":"Blood on My Hands","unlocktime":1521303276},{"key":"achive020","name":"Killing Spree","unlocktime":1521417567},{"key":"achive023","name":"First Blood","unlocktime":1521664206},{"key":"achive027","name":"Now You See Me, Now You Don''t","unlocktime":1521417607},{"key":"achive028","name":"Airborne","unlocktime":1522187689},{"key":"achive030","name":"Guardian Angel","unlocktime":1521304843},{"key":"achive034","name":"You Complete Me","unlocktime":1521417596},{"key":"achive036","name":"Health Junkie","unlocktime":1521390691}]',unixepoch()),
  ('76561198049961191',501300,3,9,'[{"key":"allstories","name":"The End of Everything","unlocktime":1515847140},{"key":"allpeepholes","name":"A Closer Look","unlocktime":1515845797},{"key":"johann","name":"Thanks, Johann!","unlocktime":1515847201}]',unixepoch());
