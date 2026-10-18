// Usage: node tools/test-scan.mjs — exits 1 on failure.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { scan, checkOutput, sameOpening, opening } from '../src/scan.js';
import { detectLanguage } from '../src/languages.js';
import { parseVocab, replaceVocab } from '../src/rules.js';
import { changes, touches } from '../src/diff.js';

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
        'rp.hover:Ngón cái anh dừng trên', 'rp.nowait:không đợi trả lời',
    ]) assert.ok(found.includes(expected), `missing ${expected}`);
    for (const id of ['rp.template', 'rp.notx', 'rp.typed', 'fic.expression']) assert.ok(found.some(hit => hit.startsWith(`${id}:`)), `missing ${id}`);
    assert.equal(found.length, 13, found.join('\n'));
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

test('not waiting for an answer', () => {
    for (const text of ['Anh không đợi trả lời, quay đầu nhìn vào trong.', 'Cô chẳng thèm chờ anh trả lời.', 'Hắn không đợi câu trả lời.']) assert.ok(ids(text, 'vi').includes('rp.nowait'), text);
    assert.ok(ids("He doesn't wait for an answer.", 'en').includes('rp.nowait'));
    assert.ok(ids('Without waiting for a reply, she left.', 'en').includes('rp.nowait'));
    assert.ok(ids('Il part sans attendre de réponse.', 'fr').includes('rp.nowait'));
    assert.ok(!ids('Anh đợi cô trả lời xong mới nói.', 'vi').includes('rp.nowait'));
});

test('tracker lines with <br> are not scanned', () => {
    assert.deepEqual(ids('ud: Tóc dài xõa, má đỏ tới mang tai<br/>Hoodie trùm váy lụa', 'vi'), []);
    assert.ok(ids('Má cô đỏ tới mang tai.', 'vi').includes('fic.expression'));
});

test('dialogue patterns (inside quotes only)', () => {
    const has = (text, id, lang = 'vi') => ids(text, lang).includes(id);
    assert.ok(has('"Ngài hãy ra ngoài chờ, việc này để tôi đảm nhận."', 'dl.bookish'));
    assert.ok(!has('Hắn hãy còn đứng đó, dường như chưa muốn đi.', 'dl.bookish'), 'narration is not dialogue');
    assert.ok(has('"Gã bên kia ngõ vừa tắt đèn. Ăn đi rồi kể. Tôi ngồi đây tới sáng."', 'dl.telegraphic'));
    assert.ok(!has('"Gã bên kia ngõ tắt đèn rồi đấy. Thôi em cứ ăn đi đã, ăn xong rồi kể, tôi ngồi đây với em tới sáng cũng được."', 'dl.telegraphic'));
    assert.ok(has('"Lão hỏi về cái sẹo, lão bỏ ca, lão đứng đầu chợ nhìn vào đây."', 'dl.recital'));
    assert.ok(has('"Thứ nhất, em không biết chữ."', 'dl.recital'));
    assert.ok(has('"Em đang né đấy."', 'dl.therapist'));
    assert.ok(has('"Tôi không suy diễn. Tôi chỉ nói cái tôi thấy."', 'rp.notx'));
    assert.ok(has('"Em ăn chưa? Ở đâu? Với ai? Mấy giờ về?"', 'dl.interview'));
    assert.ok(!has('"Em ăn chưa? Ở đâu?"', 'dl.interview'));
    assert.ok(has("\"You're deflecting again.\"", 'dl.therapist', 'en'));
});

test('dialogue notes only when the reply has speech', async () => {
    const { languageNotes } = await import('../src/languages.js');
    assert.ok(languageNotes('vi', 'Anh nói: "Thôi đi."').includes('tiểu từ'));
    assert.ok(!languageNotes('vi', 'Anh quay đi.').includes('tiểu từ'));
});

test('rhythm devices carried over from English', () => {
    const has = (text, id, lang = 'vi') => ids(text, lang).includes(id);
    // Vietnamese: a comma before "và" in a list is flagged every time.
    assert.ok(has('Một thứ mùi khác, dầu gội dừa, hơi ấm, và cái gì đó như lá thảo dược.', 'rh.tricolon'));
    assert.ok(!has('Cô mua táo, cam và chuối.', 'rh.tricolon'));
    // English: one triplet is a choice, two is a habit.
    assert.ok(!has('He was cold, wet, and tired.', 'rh.tricolon', 'en'));
    assert.ok(has('He was cold, wet, and tired. The room was dark, quiet, and empty.', 'rh.tricolon', 'en'));
    const chain = 'Anh mang nó trong ví, trong túi áo, trong túi quần.';
    assert.ok(!has(chain, 'rh.anaphora'));
    assert.ok(has(`${chain} Cô tìm ở bếp, ở phòng khách, ở ban công.`, 'rh.anaphora'));
    assert.ok(has('Mười bốn năm. Mười bốn năm anh mang nó. Cô ấy cười. Cô ấy cười, như thể không có gì.', 'rh.repeat'));
    assert.ok(!has('Mười bốn năm. Mười bốn năm anh mang nó.', 'rh.repeat'));
    assert.ok(has('Hơi nước phủ mờ gần hết vách kính. Gần hết. Anh nhìn vào ngăn tủ trống trơn lạnh lẽo. Trống trơn.', 'rh.echo'));
    assert.ok(has('Lẫn vào đó là một thứ mùi khác: dầu gội dừa. Trên bàn là đúng hai món đồ của cô: cái lược.', 'rh.colon'));
    assert.ok(!has('Dana (Marlowe): Jan 3, 8pm. Anh đọc lại tin nhắn trên màn hình rồi nói (Ý: không sao). Tin nhắn mới: đừng trễ nhé.', 'rh.colon'));
});

test('Chinese/Japanese/Korean leaks', () => {
    const hits = scan('Anh không cho ai隔着 màn hình lôi cô về Mississippi ngay lập tức.', 'vi').filter(hit => hit.id === 'res.cjk');
    assert.deepEqual(hits.map(hit => hit.match), ['隔着']);
    assert.ok(ids('She said 大丈夫 and left.', 'en').includes('res.cjk'));
    assert.ok(ids('Il a dit 사랑해.', 'fr').includes('res.cjk'));
    assert.deepEqual(scan('<span title="漢字">ok</span>\n```\n中文\n```\n{{char}}', 'en').filter(hit => hit.id === 'res.cjk'), [], 'markup and code are skipped');
    assert.equal(detectLanguage('Anh không cho ai隔着 màn hình lôi cô về.'), 'vi');
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
    assert.equal(checkOutput('a<br/>b', 'a<br>b'), null);
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

test('diff: changed spans and pattern overlap', () => {
    const before = 'Anh không đợi trả lời, quay đầu nhìn vào trong. Sebastian đứng yên ba giây. Rồi đi ra bếp.';
    const after = 'Anh quay đầu nhìn vào trong. Sebastian đứng yên, nhìn cái vali. Rồi đi ra bếp.';
    const list = changes(before, after);
    assert.equal(list.length, 2);
    assert.equal(list[0].removed.trim(), 'không đợi trả lời,');
    assert.equal(list[0].added, '');
    assert.ok(list[1].removed.includes('ba giây') && list[1].added.includes('nhìn cái vali'));
    const hits = scan(before, 'vi');
    assert.ok(hits.filter(hit => list.some(change => touches(hit, change))).map(hit => hit.id).includes('rp.counting'));
    assert.deepEqual(changes('same', 'same'), []);
    assert.deepEqual(changes('a  b', 'a b'), [], 'whitespace-only changes are ignored');
});

let failed = 0;
for (const [name, fn] of tests) {
    try { fn(); console.log(`ok   ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message}`); }
}
process.exit(failed ? 1 : 0);
