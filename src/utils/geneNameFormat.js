export function formatGeneNameForDisplay(geneName, genome) {
  const name = (geneName != null && String(geneName).trim()) ? String(geneName).trim() : '';
  if (!name) return name;
  if (/^chr\w+:\d+-\d+$/i.test(name)) return name;
  const g = (genome != null && String(genome).trim()) ? String(genome).trim().toLowerCase() : '';
  const isMouse = g.startsWith('mm') || g.includes('mouse');
  const isHuman = g.startsWith('hg') || g.includes('human') || g.includes('grch');
  if (isHuman) return name.toUpperCase();
  if (isMouse) return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return name;
}
