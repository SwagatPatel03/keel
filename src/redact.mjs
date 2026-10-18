// Masks common secret shapes and shortens text before Keel stores or shows it.

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,}|sk_(live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b([A-Za-z0-9_]*(api[_-]?key|token|secret|passw(or)?d|pwd|auth)[A-Za-z0-9_]*)\s*([=:])\s*("[^"]*"|'[^']*'|\S+)/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Long random-looking tokens: letters and digits mixed, no path separators.
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}={0,2}/g,
];

/** @param {string} text */
export function maskSecrets(text) {
  let out = String(text ?? '');
  out = out.replace(SECRET_PATTERNS[0], '[secret]');
  out = out.replace(SECRET_PATTERNS[1], (_m, kind) => `${kind} [secret]`);
  out = out.replace(SECRET_PATTERNS[2], (_m, name, _k, _o, sep) => `${name}${sep}[secret]`);
  out = out.replace(SECRET_PATTERNS[3], '[private key]');
  out = out.replace(SECRET_PATTERNS[4], '[secret]');
  return out;
}

/**
 * Redacts and shortens text for storage. Keeps the start, where commands and
 * error messages carry their meaning.
 * @param {string|null|undefined} text
 * @param {number} [max]
 */
export function excerpt(text, max = 200) {
  if (text == null) return null;
  const clean = maskSecrets(String(text)).replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

/**
 * Like excerpt, but keeps the end of the text, where test runners print their
 * summary.
 * @param {string|null|undefined} text
 * @param {number} [max]
 */
export function tailExcerpt(text, max = 200) {
  if (text == null) return null;
  const clean = maskSecrets(String(text)).replace(/\s+/g, ' ').trim();
  return clean.length > max ? '…' + clean.slice(clean.length - max + 1) : clean;
}
