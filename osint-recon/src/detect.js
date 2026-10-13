'use strict';

/**
 * Input type detection.
 *
 * Patterns come from the project spec. Several of them overlap (e.g. "example.com"
 * also satisfies the username pattern, and "1234567890" satisfies both phone and
 * username), so `detectInputType` evaluates them in priority order and reports every
 * other type that also matches as a `candidates` alternative. The UI lets the user
 * force a type when the auto-detection guesses wrong.
 */

const PATTERNS = {
  email: /^[\w.-]+@[\w.-]+\.\w+$/,
  ip: /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  // Spec pattern extended to allow subdomains (sub.example.co.uk), each label 1-63 chars.
  domain: /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
  phone: /^(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}$/,
  username: /^[a-zA-Z0-9_.]{3,32}$/,
  // Two or more words made of letters, joined by spaces, apostrophes or hyphens.
  name: /^\p{L}[\p{L}'.-]*(?:\s+\p{L}[\p{L}'.-]*)+$/u,
};

// Evaluated in this order when more than one pattern matches.
const PRIORITY = ['email', 'ip', 'domain', 'phone', 'username', 'name'];

const TYPES = PRIORITY.slice();

function isValidIPv4(value) {
  const m = PATTERNS.ip.exec(value);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

function digitCount(value) {
  return (value.match(/\d/g) || []).length;
}

/** Returns true when `value` is plausibly a phone number for the given type. */
function matchesType(type, value) {
  switch (type) {
    case 'ip':
      return isValidIPv4(value);
    case 'phone': {
      const digits = digitCount(value);
      return PATTERNS.phone.test(value) && digits >= 7 && digits <= 15;
    }
    case 'name': {
      const words = value.split(/\s+/).length;
      return words >= 2 && words <= 6 && PATTERNS.name.test(value);
    }
    default:
      return PATTERNS[type].test(value);
  }
}

/**
 * Detect the type of an identifier.
 *
 * @param {string} rawQuery
 * @returns {{ query: string, type: string|null, candidates: string[] }}
 *   `query` is the normalised value used for lookups (trimmed; emails and domains lowercased).
 *   `type` is the primary type or null when nothing matches.
 *   `candidates` lists every type that matched, primary first.
 */
function detectInputType(rawQuery) {
  const trimmed = String(rawQuery ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { query: '', type: null, candidates: [] };

  const candidates = TYPES.filter((type) => matchesType(type, trimmed));
  const ordered = PRIORITY.filter((t) => candidates.includes(t));
  const type = ordered[0] ?? null;

  let query = trimmed;
  if (type === 'email' || type === 'domain') query = trimmed.toLowerCase();

  return { query, type, candidates: ordered };
}

/** Maps a user-forced type onto a normalised query, or null when it doesn't fit. */
function validateForcedType(type, rawQuery) {
  const trimmed = String(rawQuery ?? '').trim().replace(/\s+/g, ' ');
  if (!TYPES.includes(type)) return null;
  if (!matchesType(type, trimmed)) return null;
  return type === 'email' || type === 'domain' ? trimmed.toLowerCase() : trimmed;
}

module.exports = {
  detectInputType,
  validateForcedType,
  isValidIPv4,
  TYPES,
};
