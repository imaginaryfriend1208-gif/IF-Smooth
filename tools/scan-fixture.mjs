// Usage: node tools/scan-fixture.mjs <file> [en|vi|fr]
import { readFileSync } from 'node:fs';
import { scan, patternName } from '../src/scan.js';
import { detectLanguage } from '../src/languages.js';

const file = process.argv[2];
const text = readFileSync(file, 'utf8');
const lang = process.argv[3] || detectLanguage(text);
const hits = scan(text, lang);
console.log(`${file}: ${lang}, ${hits.length} hits`);
for (const hit of hits) console.log(`- [${hit.id}] ${patternName(hit.id)}: "${hit.match}"  ←  ${hit.excerpt}`);
