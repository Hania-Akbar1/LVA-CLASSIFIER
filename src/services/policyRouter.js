/**
 * Parses retention period strings into numeric year equivalents.
 * Handles Years, Months, Days, and Permanent/Indefinite keywords.
 */
function parseRetentionYears(retentionPeriod) {
  if (!retentionPeriod || typeof retentionPeriod !== 'string') return -Infinity;

  const lower = retentionPeriod.toLowerCase();

  // "Permanent" or "Indefinite" outranks any numeric duration
  if (/permanent|indefinite/i.test(lower)) return Infinity;

  // Match Years (e.g., "3 years", "5 yrs", "1.5 year")
  const yearMatch = lower.match(/(\d+(\.\d+)?)\s*(year|yr)/i);
  if (yearMatch) return parseFloat(yearMatch[1]);

  // Match Months (e.g., "6 months", "18 mo") -> convert to year fraction
  const monthMatch = lower.match(/(\d+(\.\d+)?)\s*(month|mo)/i);
  if (monthMatch) return parseFloat(monthMatch[1]) / 12;

  // Match Days (e.g., "90 days") -> convert to year fraction
  const dayMatch = lower.match(/(\d+(\.\d+)?)\s*(day)/i);
  if (dayMatch) return parseFloat(dayMatch[1]) / 365;

  // Unparseable or purely event-driven strings without explicit numbers
  return -Infinity;
}

/**
 * Checks whether a disposition method requires confidential handling.
 */
function isConfidentialDisposition(dispositionMethod) {
  const method = (dispositionMethod || '').toString();
  return /confidential/i.test(method) && !/non-confidential/i.test(method);
}

/**
 * Evaluates multiple retention schedule categories and applies the maximum retention
 * policy, ensuring the longest retention duration and strictest disposition govern.
 */
function applyMaxRetentionRule(categories) {
  if (!categories || !Array.isArray(categories) || categories.length === 0) {
    return null;
  }

  if (categories.length === 1) {
    return { ...categories[0] };
  }

  let winner = categories[0];

  for (const candidate of categories.slice(1)) {
    const winnerPeriod = winner.retentionPeriod || winner.effectiveRetentionPeriod;
    const candidatePeriod = candidate.retentionPeriod || candidate.effectiveRetentionPeriod;

    const currentYears = parseRetentionYears(winnerPeriod);
    const candidateYears = parseRetentionYears(candidatePeriod);

    if (candidateYears > currentYears) {
      winner = candidate;
    }
  }

  // Check if any category requires confidential disposal
  const anyConfidential = categories.some((c) => {
    const method = c.dispositionMethod || c.effectiveDispositionMethod;
    return isConfidentialDisposition(method);
  });

  const winningDisposition = winner.dispositionMethod || winner.effectiveDispositionMethod || 'Non-confidential Destruction';
  const effectiveDisposition = anyConfidential ? 'Confidential Destruction' : winningDisposition;

  return {
    ...winner,
    retentionPeriod: winner.retentionPeriod || winner.effectiveRetentionPeriod || 'Unknown',
    dispositionMethod: effectiveDisposition,
  };
}

module.exports = {
  applyMaxRetentionRule,
  parseRetentionYears,
  isConfidentialDisposition,
};