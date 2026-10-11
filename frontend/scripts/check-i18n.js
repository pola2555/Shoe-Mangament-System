#!/usr/bin/env node
/**
 * Does every translation the code asks for actually exist?
 *
 * There was already a parity check comparing en.json against ar.json, and it passed
 * at 1759/1759 while `products.select_all_sizes` was printing its own key on screen.
 * Parity cannot catch that: a key missing from BOTH files is perfectly symmetrical.
 * Six more were found the same day — among them `sales.payment_method`, a form label
 * and a column heading on the dealer payments screen.
 *
 * `t()` returns the key itself when a lookup fails, so the failure is silent to every
 * test that does not read the pixels. This reads the other direction: every key the
 * code asks for must resolve in both languages.
 *
 * Checks:
 *   1. every t('literal') key resolves to a string in en.json
 *   2. ... and in ar.json
 *   3. the two files hold exactly the same set of keys
 *   4. a key's {placeholders} match between the two, so a translation cannot
 *      silently drop the number it was supposed to show
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const I18N = path.join(SRC, 'i18n');
const en = JSON.parse(fs.readFileSync(path.join(I18N, 'en.json'), 'utf8'));
const ar = JSON.parse(fs.readFileSync(path.join(I18N, 'ar.json'), 'utf8'));

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const pass = (msg) => console.log('  ok    ' + msg);

const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (
  v && typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]));

/** Every t('some.key') written as a literal. Dynamic keys cannot be checked here. */
function usedKeys() {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?)$/.test(f.name)) files.push(p);
    }
  })(SRC);

  const used = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // Strip block comments: the ConfirmDialog usage example contains a literal
    // t('...') that is documentation, not a lookup.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of code.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(rel);
    }
  }
  return used;
}

console.log('\ni18n');
console.log('='.repeat(60));

const used = usedKeys();
console.log(`  (${used.size} distinct keys used across the app)`);

for (const [lang, dict] of [['en', en], ['ar', ar]]) {
  const missing = [...used].filter(([k]) => typeof get(dict, k) !== 'string');
  if (missing.length) {
    fail(`${missing.length} key(s) the code asks for do not resolve in ${lang}.json:`);
    for (const [k, where] of missing) console.log(`          ${k}   <- ${[...where].join(', ')}`);
  } else {
    pass(`every key the code asks for resolves in ${lang}.json`);
  }
}

const E = new Map(flat(en));
const A = new Map(flat(ar));
const onlyEn = [...E.keys()].filter((k) => !A.has(k));
const onlyAr = [...A.keys()].filter((k) => !E.has(k));
if (onlyEn.length || onlyAr.length) {
  fail(`the two files disagree: ${onlyEn.length} only in en, ${onlyAr.length} only in ar`);
  for (const k of [...onlyEn.slice(0, 10), ...onlyAr.slice(0, 10)]) console.log('          ' + k);
} else {
  pass(`both files hold the same ${E.size} keys`);
}

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const drift = [...E].filter(([k, v]) => A.has(k) && ph(v) !== ph(A.get(k)));
if (drift.length) {
  fail(`${drift.length} key(s) whose {placeholders} differ between languages:`);
  for (const [k, v] of drift.slice(0, 10)) console.log(`          ${k}: en "${ph(v)}" vs ar "${ph(A.get(k))}"`);
} else {
  pass('placeholders match between the two languages');
}

console.log('='.repeat(60));
console.log(failures ? `${failures} FAILED\n` : 'all passed\n');
process.exit(failures ? 1 : 0);
