// Usage: node tools/test-scan.mjs — exits 1 on failure.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { scan, checkOutput, sameOpening, opening } from '../src/scan.js';
import { detectLanguage } from '../src/languages.js';
import { parseVocab, replaceVocab } from '../src/rules.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ids = (text, lang) => scan(text, lang).map(hit => hit.id);

test('vi fixture: expected hits', () => {
    const text = readFileSync(new URL('./fixtures/vi/sebastian.txt', import.meta.url), 'utf8');
    assert.equal(detectLanguage(text), 'vi');
    const found = scan(text, 'vi').map(hit => `${hit.id}:${hit.match}`);
    for (const expected of [
        'in.purple:đọng lại trong không khí', 'rp.counting:ba giây', 'rp.counting:đúng hai ngón tay',
        'fic.expression:mím môi', 'rp.stress:yết hầu', 'rp.stress:gân xanh', 'rp.stress:không chớp',
        'rp.hover:Ngón cái anh dừng trên',
    ]) assert.ok(found.includes(expected), `missing ${expected}`);
    for (const id of ['rp.template', 'rp.notx', 'rp.typed', 'fic.expression']) assert.ok(found.some(hit => hit.startsWith(`${id}:`)), `missing ${id}`);
    assert.equal(found.length, 12, found.join('\n'));
});

test('vi: no false positives on plain sentences', () => {
    for (const text of [
        'Như thường lệ, anh dậy lúc sáu giờ.',
        'Sebastian: "Em ở đây từ mấy giờ vậy?"',
        'Hồi đó anh còn học lớp hai.',
        'Mười hai phút sau anh ra ngoài.',
        'Priya Raman\nanyone else read that memo',
    ]) assert.deepEqual(ids(text, 'vi'), [], text);
});

test('vi: reassurance only as a standalone line in dialogue', () => {
    assert.ok(ids('"Anh ở đây rồi."', 'vi').includes('rp.reassure'));
    assert.ok(!ids('Anh ở đây rồi, cô nghĩ.', 'vi').includes('rp.reassure'));
});

test('language detection', () => {
    assert.equal(detectLanguage('He picks up his glass and drinks from it anyway.'), 'en');
    assert.equal(detectLanguage('Il prend son verre, voit qu’il est vide, et boit quand même.'), 'fr');
    assert.equal(detectLanguage('Anh cầm ly lên, thấy nó rỗng, vẫn uống.'), 'vi');
});

test('checkOutput rejects broken format', () => {
    assert.equal(checkOutput('*a* {{user}}', '*a* {{user}}'), null);
    assert.match(checkOutput('{{user}} hi', 'hi'), /macros/);
    assert.match(checkOutput('<b>x</b>', 'x'), /HTML/);
    assert.match(checkOutput('*a* b', '*a b'), /asterisks/);
    assert.match(checkOutput('x'.repeat(300), 'x'.repeat(100)), /length/);
});

test('same opening', () => {
    assert.ok(sameOpening(opening('The rain fell. He sat.'), 'The rain fell again.'));
    assert.ok(!sameOpening('The rain fell.', 'He sat down.'));
});

test('vocab: whole words, case, deletion', () => {
    const vocab = parseVocab('utilize = use\nnéanmoins =');
    assert.deepEqual(vocab['néanmoins'], ['']);
    assert.equal(replaceVocab('Utilize it, utilized stays.', vocab), 'Use it, utilized stays.');
    assert.equal(replaceVocab('Il vient néanmoins demain.', vocab), 'Il vient demain.');
    assert.equal(replaceVocab('`utilize` {{utilize}}', vocab), '`use` {{utilize}}');
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok   ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message}`); }
}
process.exit(failed ? 1 : 0);
