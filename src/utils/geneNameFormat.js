/**
 * Format a gene symbol for display based on genome convention:
 * Peak IDs (chrN:start-end): return as-is
 * Human (hg38, hg19, etc.): all uppercase (e.g. MS4A1)
 * Mouse (mm10, mm39, etc.): first letter capital, rest lowercase (e.g. Ms4a1)
 * Unknown: return as-is
 * @param {string} geneName: Raw gene symbol or peak ID (e.g. from user input)
 * @param {string} [genome]: Reference genome (e.g. 'hg38', 'mm10')
 * @returns {string} Formatted gene symbol for display
 */
export function formatGeneNameForDisplay(geneName, genome) {
  const name = (geneName != null && String(geneName).trim()) ? String(geneName).trim() : '';
  if (!name) return name;
  // Peak IDs (chrN:start-end): display as-is
  if (/^chr\w+:\d+-\d+$/i.test(name)) return name;
  const g = (genome != null && String(genome).trim()) ? String(genome).trim().toLowerCase() : '';
  const isMouse = g.startsWith('mm') || g.includes('mouse');
  const isHuman = g.startsWith('hg') || g.includes('human') || g.includes('grch');
  if (isHuman) return name.toUpperCase();
  if (isMouse) return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return name;
}
