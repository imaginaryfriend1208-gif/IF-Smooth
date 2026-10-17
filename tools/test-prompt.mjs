// Usage: node tools/test-prompt.mjs — exits 1 on failure.
import assert from 'node:assert/strict';
import { DEFAULT_PROMPT, LEGACY_PROMPTS, TASKS, buildPrompt, selectRules } from '../src/prompt.js';
import { PATTERNS } from '../src/patterns.js';
import { scan } from '../src/scan.js';

const hits = scan('Sebastian đứng yên ba giây. Anh nhắm mắt, gân xanh nổi dọc cẳng tay.', 'vi');
assert.ok(hits.length >= 2);

const editRules = selectRules(hits, { mode: 'edit', lang: 'vi' });
assert.equal(editRules.length, new Set(hits.map(hit => hit.id)).size);

const all = selectRules([], { mode: 'rewrite', lang: 'vi' });
assert.ok(all.length < PATTERNS.length, 'French rules must not be sent for Vietnamese');
assert.ok(!selectRules([], { mode: 'rewrite', lang: 'vi', disabled: { 'rp.simile': true } }).some(rule => rule.includes(PATTERNS.find(p => p.id === 'rp.simile').rule)));

const prompt = buildPrompt(DEFAULT_PROMPT, { language: 'Vietnamese', rules: editRules, notes: 'NOTE', hits, previous: 'Anh quay đầu.' });
for (const part of ['Vietnamese', TASKS.edit, editRules[0], 'NOTE', 'Flagged passages', 'ba giây', 'Anh quay đầu.']) assert.ok(prompt.includes(part), `missing ${part}`);
assert.ok(!/\{\{(language|task|rules|notes|flagged|previous)\}\}/.test(prompt));

// A custom template without placeholders still gets the rules and the flagged list.
const custom = buildPrompt('Fix the text.', { language: 'Vietnamese', rules: editRules, hits });
assert.ok(custom.startsWith('Fix the text.') && custom.includes('Rules:') && custom.includes('ba giây'));

assert.ok(LEGACY_PROMPTS[0].startsWith('You are a fiction copy editor.'));
console.log('ok   prompt tests');
