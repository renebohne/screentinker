'use strict';

/*
 * The SCIM filter grammar we accept (RFC 7644 §3.4.2.2), and nothing else.
 *
 * ⚠️ A STRICT SUBSET ON PURPOSE. Identity providers only ever ask us a handful of questions — "is
 * there a user with this userName / externalId?", "is there a group called X?", "is user U in group
 * G?" — and a full SCIM filter engine (or, and, not, sw, co, gt, grouping, value paths) is a large
 * parser whose only job here would be to give an anonymous-looking bearer more ways to probe the
 * database. So:
 *
 *   filter := comparison ( SP "and" SP comparison ){0,3}
 *   comparison := attrPath SP "eq" SP compValue
 *   attrPath := [core-schema-urn ":"] ATTRNAME [ "." ATTRNAME ]
 *   compValue := JSON string | true | false
 *
 * The parse produces [{ attr, value }] with `attr` lowercased (SCIM attribute names are
 * case-insensitive). It never produces SQL: the caller maps each attribute through its own fixed
 * whitelist to a column and binds the value as a parameter. Anything outside the grammar — another
 * operator, "or", "not", brackets, a stray quote — is an invalidFilter error, never a best guess.
 */

const MAX_FILTER_LENGTH = 1000;
const MAX_TERMS = 4;
const ATTR_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)?$/;
const CORE_PREFIXES = [
  'urn:ietf:params:scim:schemas:core:2.0:user:',
  'urn:ietf:params:scim:schemas:core:2.0:group:',
];

class FilterError extends Error {
  constructor(message) { super(message); this.name = 'FilterError'; this.scimType = 'invalidFilter'; }
}

/** Read one JSON string literal starting at s[i] === '"'. Returns [value, nextIndex]. */
function readString(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '"') break;
    j++;
  }
  if (j >= s.length) throw new FilterError('unterminated string in filter');
  let value;
  try { value = JSON.parse(s.slice(i, j + 1)); } catch { throw new FilterError('malformed string in filter'); }
  return [value, j + 1];
}

function parseFilter(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new FilterError('filter must be a string');
  const s = raw.trim();
  if (!s) return null;
  if (s.length > MAX_FILTER_LENGTH) throw new FilterError('filter is too long');

  const terms = [];
  let i = 0;
  const skipSpaces = (required) => {
    const start = i;
    while (s[i] === ' ') i++;
    if (required && i === start) throw new FilterError('expected a space in filter');
  };
  const readWord = () => {
    const start = i;
    while (i < s.length && s[i] !== ' ' && s[i] !== '"') i++;
    return s.slice(start, i);
  };

  for (;;) {
    let attr = readWord();
    if (!attr) throw new FilterError('expected an attribute name');
    const lower = attr.toLowerCase();
    for (const p of CORE_PREFIXES) {
      if (lower.startsWith(p)) { attr = attr.slice(p.length); break; }
    }
    if (!ATTR_RE.test(attr)) throw new FilterError(`unsupported attribute "${attr.slice(0, 64)}"`);
    skipSpaces(true);
    const op = readWord().toLowerCase();
    if (op !== 'eq') throw new FilterError(`unsupported operator "${op.slice(0, 16)}" (only eq is supported)`);
    skipSpaces(true);
    let value;
    if (s[i] === '"') {
      [value, i] = readString(s, i);
    } else {
      const word = readWord().toLowerCase();
      if (word === 'true') value = true;
      else if (word === 'false') value = false;
      else throw new FilterError('comparison value must be a quoted string or a boolean');
    }
    terms.push({ attr: attr.toLowerCase(), value });
    if (terms.length > MAX_TERMS) throw new FilterError('too many comparisons in filter');
    if (i >= s.length) break;
    skipSpaces(true);
    const joiner = readWord().toLowerCase();
    if (joiner !== 'and') throw new FilterError(`unsupported logical operator "${joiner.slice(0, 16)}"`);
    skipSpaces(true);
  }
  return terms;
}

/*
 * A value-path selector inside a PATCH path, e.g. `members[value eq "abc"]` or
 * `emails[type eq "work"]`. Same strictness: one attribute, eq, one value.
 */
function parseValuePath(path) {
  const m = /^([A-Za-z][A-Za-z0-9_-]*)\[(.*)\](?:\.([A-Za-z][A-Za-z0-9_-]*))?$/.exec(String(path || '').trim());
  if (!m) return null;
  const terms = parseFilter(m[2]);
  if (!terms || terms.length !== 1) throw new FilterError('a value path must hold exactly one comparison');
  return { attr: m[1].toLowerCase(), filter: terms[0], sub: m[3] ? m[3].toLowerCase() : null };
}

module.exports = { parseFilter, parseValuePath, FilterError, MAX_FILTER_LENGTH };
