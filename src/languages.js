// Per-language defaults (pure data + detection, no ST imports).
// notes: language-specific guidance added to the rewrite prompt.
// vocab: safe automatic replacements after the rewrite, `word = option1, option2`; nothing after "=" deletes the word.
//        Keep it to words whose replacement never changes meaning; everything else is left to the model.

export const LANGUAGES = {
    en: {
        name: 'English',
        notes: `- Prefer plain, concrete words over formal or ornate ones.
- Show emotion through action and dialogue instead of naming it.`,
        // Superset of the v1.0.0 list with the same options, so old configs migrate cleanly.
        vocab: `delve = dig
delves = digs
delved = dug
delving = digging
utilize = use
utilizes = uses
utilized = used
utilizing = using
facilitate = help
facilitates = helps
facilitated = helped
leverage = use
leveraging = using
furthermore = also, plus
moreover = also, besides
subsequently = then, after that
pivotal = key, crucial
paramount = vital, critical
intricate = complex, detailed
multifaceted = complex, varied
meticulous = careful, precise
meticulously = carefully, precisely
realm = world, field
tapestry = mix, web
testament = proof, sign
underscore = stress, highlight
underscores = stresses, highlights
encompass = cover, include
encompasses = covers, includes
commendable = impressive, admirable
unwavering = steady, firm
palpable = obvious, thick
myriad = countless, many`,
    },
    vi: {
        name: 'Vietnamese',
        notes: `- Write Vietnamese the way a native novelist does. Do NOT keep sentence structures translated from English ("văn dịch").
- Keep the pronoun pair (xưng hô) between characters exactly as in the original, and keep English words a character mixes into speech.
- Do not repeat "anh ấy / cô ấy / hắn ta" every sentence; omit the subject or use the name or a fitting pronoun.
- Vietnamese narration can run long sentences joined by commas; do not chop them into fragments.`,
        vocab: `trầm thấp = trầm`,
    },
    fr: {
        name: 'French',
        notes: `- Write French the way a native novelist does; avoid structures calqued from English.
- Keep the tu/vous register between characters exactly as in the original.
- Keep French typography if the original uses it: « » quotes, a space before ; : ! ?`,
        vocab: `de surcroît = en plus
néanmoins = pourtant
toutefois = pourtant
afin de = pour
lorsque = quand`,
    },
};

export const LANGUAGE_CODES = Object.keys(LANGUAGES);

const VI_CHARS = /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu;
const FR_CHARS = /[çéèëîïûùüÿœæ]/giu;
const FR_WORDS = /(?<![\p{L}])(le|la|les|des|une|est|et|pas|je|vous|il|elle|que|qui|dans|pour|avec|sur|mais|son|sa|ses|ne)(?![\p{L}])/giu;
const EN_WORDS = /(?<![\p{L}])(the|and|is|you|he|she|to|of|in|that|it|was|with|his|her|but|not|for|on|at)(?![\p{L}])/giu;

/** Guess en / vi / fr from the text itself. Falls back to English. */
export function detectLanguage(text) {
    const value = String(text || '').normalize('NFC');
    const letters = (value.match(/\p{L}/gu) || []).length || 1;
    if ((value.match(VI_CHARS) || []).length / letters > 0.02) return 'vi';
    const fr = (value.match(FR_WORDS) || []).length + (value.match(FR_CHARS) || []).length * 0.5;
    const en = (value.match(EN_WORDS) || []).length;
    return fr > en ? 'fr' : 'en';
}
