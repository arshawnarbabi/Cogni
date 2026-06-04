// Turn an uploaded filename into a clean, human-readable title for display and for
// assignment names — so the app shows "Problem Set Derivatives", never the raw
// "Problem_Set_Derivatives.md". Conservative on purpose: it fixes separators and
// capitalization but does not aggressively rewrite words (no risky abbreviation
// expansion that could mangle real titles or acronyms).
export function prettifyTitle(filename: string): string {
  const noExt = filename.replace(/\.[a-z0-9]{1,8}$/i, '')
  const cleaned = noExt
    .replace(/[_-]+/g, ' ')          // underscores / dashes → spaces
    .replace(/\s*\(\d+\)\s*$/, '')   // trailing copy markers like "(1)"
    .replace(/\b\d{12,}\b/g, '')     // long unix-ms id tokens
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim()
  if (!cleaned) return filename
  // Capitalize the first letter of all-lowercase words; leave already-capitalized
  // words and ALLCAPS acronyms (FRQ, AP, MIT) untouched.
  return cleaned
    .split(' ')
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
}
