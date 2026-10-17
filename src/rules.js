// Pure text helpers (no ST imports) so they can be checked with plain node.

const PROTECTED = /```[\s\S]*?```|<[^>\n]+>|\{\{[\s\S]*?\}\}|https?:\/\/\S+/g;

/** Replace protected spans (code, HTML tags, macros, URLs) with placeholders; returns [masked, restore]. */
export function protect(text) {
    const kept = [];
    const masked = text.replace(PROTECTED, match => `\u0000${kept.push(match) - 1}\u0000`);
    return [masked, value => value.replace(/\u0000(\d+)\u0000/g, (_, index) => kept[Number(index)] ?? '')];
}

function matchCase(source, replacement) {
    if (!replacement) return replacement;
    if (source === source.toUpperCase() && source.length > 1) return replacement.toUpperCase();
    if (source[0] === source[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
    return replacement;
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word replacement of every vocabulary entry, keeping the original capitalization.
 * An empty option deletes the word together with one neighbouring space.
 */
export function replaceVocab(text, vocab, random = Math.random) {
    const [masked, restore] = protect(String(text || '').normalize('NFC'));
    let result = masked;
    for (const [word, options] of Object.entries(vocab || {})) {
        if (!word || !options?.length) continue;
        const pattern = new RegExp(`( ?)(?<![\\p{L}\\p{N}_'-])${escape(word.normalize('NFC'))}(?![\\p{L}\\p{N}_'-])`, 'giu');
        result = result.replace(pattern, (match, space) => {
            const choice = options[Math.floor(random() * options.length)];
            return choice ? space + matchCase(match.slice(space.length), choice) : '';
        });
    }
    return restore(result);
}

/** Parse a word list: one `word = option1, option2` per line; `word =` deletes the word. */
export function parseVocab(source) {
    const vocab = {};
    for (const line of String(source || '').split('\n')) {
        const separator = line.indexOf('=');
        if (separator < 0) continue;
        const word = line.slice(0, separator).trim().toLowerCase();
        const options = line.slice(separator + 1).split(',').map(item => item.trim()).filter(Boolean);
        if (word) vocab[word] = options.length ? options : [''];
    }
    return vocab;
}

export const formatVocab = vocab => Object.entries(vocab).map(([word, options]) => `${word} = ${options.join(', ')}`).join('\n');

/** Strip reasoning blocks and wrapping fences a model may add around the edited text. */
export function cleanOutput(text) {
    return String(text || '')
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i, '$1')
        .trim();
}
