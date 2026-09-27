// SQL parsing helpers for the write guard.
//
// Kept separate from main.js so the parser can be unit tested on its own: this
// is the part that decides which columns a statement touches, and "we could not
// parse it" must never be mistaken for "there is nothing to restrict".

function topLevelKeyword(s, kw, from = 0) {
  let depth = 0, quote = null;
  const needle = kw.toLowerCase();
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { if (s[i + 1] === quote) i++; else quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === ']') { depth--; continue; }
    if (depth !== 0) continue;
    if (!s.slice(i, i + kw.length).toLowerCase().startsWith(needle)) continue;
    const before = i === 0 ? ' ' : s[i - 1];
    const after = s[i + kw.length];
    if (/\s/.test(before) && (after === undefined || /\s/.test(after))) return i;
  }
  return -1;
}

function splitTopLevel(body) {
  const out = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote) { if (body[i + 1] === quote) cur += body[++i]; else quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Columns assigned by an UPDATE. Returns null when the SET list cannot be read
// with certainty, which callers must treat as "refuse", never as "no limit".
function updateSetColumns(sql) {
  const s = String(sql).replace(/;+\s*$/, '');
  const setAt = topLevelKeyword(s, 'set');
  if (setAt < 0) return null;
  let end = s.length;
  for (const kw of ['where', 'order', 'limit', 'returning']) {
    const i = topLevelKeyword(s, kw, setAt);
    if (i >= 0) { end = i; break; }
  }
  const cols = [];
  for (const part of splitTopLevel(s.slice(setAt + 3, end))) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const col = part.slice(0, eq).trim().replace(/["'`\[\]]/g, '');
    if (!/^[A-Za-z_]\w*$/.test(col)) return null;
    cols.push(col.toLowerCase());
  }
  return cols.length ? cols : null;
}

function writeRequirement(sql) {
  const s = sql.trim().replace(/;+\s*$/, '');
  let m = s.match(/^\s*insert\s+(?:or\s+\w+\s+)?into\s+["'`[]?([\w]+)/i);
  if (m) return { verb: 'i', table: m[1].toLowerCase() };
  m = s.match(/^\s*replace\s+into\s+["'`[]?([\w]+)/i);
  if (m) return { verb: 'i', table: m[1].toLowerCase() };
  m = s.match(/^\s*update\s+(?:or\s+\w+\s+)?["'`[]?([\w]+)/i);
  if (m) return { verb: 'u', table: m[1].toLowerCase() };
  m = s.match(/^\s*delete\s+from\s+["'`[]?([\w]+)/i);
  if (m) return { verb: 'd', table: m[1].toLowerCase() };
  return null;
}

module.exports = { topLevelKeyword, splitTopLevel, updateSetColumns, writeRequirement };
