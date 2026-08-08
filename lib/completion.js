/**
 * High-confidence story-ending achievements.
 *
 * This list is deliberately small. Achievement percentage and playtime are not
 * completion evidence, and generic names such as "Complete" are unsafe across
 * unrelated games. Add entries only after checking what the exact achievement
 * means for that app. The UI presents these as suggestions; it never changes a
 * status without the player's confirmation.
 */
const TERMINAL_ACHIEVEMENTS = new Map([
  [221910, [{ key: 'tsp_beatthegame', label: 'Beat the game' }]],
  [264710, [{ key: 'launchrocket', label: 'Go Among the Stars' }]],
  [367520, [
    { key: 'ending_a', label: 'The Hollow Knight' },
    { key: 'ending_c', label: 'Dream No More' },
  ]],
  [405640, [{ key: 'ach_progress_8', label: 'Escape' }]],
  [501300, [{ key: 'allstories', label: 'The End of Everything' }]],
  [606860, [{ key: 'ach_boss', label: 'Hardest Boss Ever!' }]],
  [814380, [{ key: 'ach09', label: 'Immortal Severance' }]],
  [1057090, [{ key: '14', label: 'Destiny' }]],
  [1091500, [{ key: 'theworld', label: 'The World' }]],
  [2358720, [
    { key: '81062', label: 'Meet the Match' },
    { key: '81072', label: 'A Duel of Destiny' },
  ]],
  [2592160, [
    { key: 'ach_mentor_success', label: 'final ending choice' },
    { key: 'ach_vengeance', label: 'final ending choice' },
  ]],
]);

export function completionEvidence(appid, unlocked) {
  const markers = TERMINAL_ACHIEVEMENTS.get(Number(appid));
  if (!markers?.length || !Array.isArray(unlocked)) return null;
  const keys = new Set(unlocked.map((achievement) => String(achievement?.key || '')));
  const marker = markers.find((candidate) => keys.has(candidate.key));
  return marker ? { key: marker.key, label: marker.label } : null;
}
