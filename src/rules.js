// Pure text helpers (no ST imports) so they can be checked with plain node.

/** Words that read as machine-written in prose. Keys are matched as whole words, case-insensitive. */
export const DEFAULT_VOCAB = {
    'delve': ['dig'], 'delves': ['digs'], 'delved': ['dug'], 'delving': ['digging'],
    'utilize': ['use'], 'utilizes': ['uses'], 'utilized': ['used'], 'utilizing': ['using'],
    'facilitate': ['help'], 'facilitates': ['helps'], 'facilitated': ['helped'],
    'leverage': ['use'], 'leveraging': ['using'],
    'furthermore': ['also', 'plus'], 'moreover': ['also', 'besides'], 'subsequently': ['then', 'after that'],
    'pivotal': ['key', 'crucial'], 'paramount': ['vital', 'critical'],
    'intricate': ['complex', 'detailed'], 'multifaceted': ['complex', 'varied'],
    'meticulous': ['careful', 'precise'], 'meticulously': ['carefully', 'precisely'],
    'realm': ['world', 'field'], 'tapestry': ['mix', 'web'], 'testament': ['proof', 'sign'],
    'underscore': ['stress', 'highlight'], 'underscores': ['stresses', 'highlights'],
    'encompass': ['cover', 'include'], 'encompasses': ['covers', 'includes'],
    'commendable': ['impressive', 'admirable'], 'unwavering': ['steady', 'firm'],
    'palpable': ['obvious', 'thick'], 'myriad': ['countless', 'many'],
};

const PROTECTED = /```[\s\S]*?```|<[^>\n]+>|\{\{[\s\S]*?\}\}|https?:\/\/\S+/g;

/** Replace protected spans (code, HTML tags, macros, URLs) with placeholders; returns [masked, restore]. */
export function protect(text) {
    const kept = [];
    const masked = text.replace(PROTECTED, match => `\u0000${kept.push(match) - 1}\u0000`);
    return [masked, value => value.replace(/\u0000(\d+)\u0000/g, (_, index) => kept[Number(index)] ?? '')];
}

function matchCase(source, replacement) {
    if (source === source.toUpperCase() && source.length > 1) return replacement.toUpperCase();
    if (source[0] === source[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
    return replacement;
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word replacement of every vocabulary entry, keeping the original capitalization. */
export function replaceVocab(text, vocab = DEFAULT_VOCAB, random = Math.random) {
    const [masked, restore] = protect(text);
    let result = masked;
    for (const [word, options] of Object.entries(vocab)) {
        if (!word || !options?.length) continue;
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}_'-])${escape(word)}(?![\\p{L}\\p{N}_'-])`, 'giu');
        result = result.replace(pattern, match => matchCase(match, options[Math.floor(random() * options.length)]));
    }
    return restore(result);
}

/** Parse the settings textarea: one `word = option1, option2` per line. */
export function parseVocab(source) {
    const vocab = {};
    for (const line of String(source || '').split('\n')) {
        const [word, rest] = line.split('=');
        const options = (rest || '').split(',').map(item => item.trim()).filter(Boolean);
        if (word?.trim() && options.length) vocab[word.trim().toLowerCase()] = options;
    }
    return vocab;
}

export const formatVocab = vocab => Object.entries(vocab).map(([word, options]) => `${word} = ${options.join(', ')}`).join('\n');

/**
 * Statistical "AI-likeness" score in 0..1 (higher = more uniform / repetitive).
 * Combines type-token ratio, sentence-length variation and the share of words used once.
 * Returns null when the text is too short to judge.
 */
export function aiScore(text) {
    const clean = String(text || '').replace(PROTECTED, ' ');
    const sentences = clean.split(/(?<=[.!?…])\s+|\n+/).map(item => item.trim()).filter(Boolean);
    const words = clean.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    if (sentences.length < 3 || words.length < 30) return null;
    const ttr = new Set(words).size / words.length;
    const lengths = sentences.map(item => (item.match(/[\p{L}\p{N}']+/gu) || []).length);
    const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
    const cv = mean ? Math.sqrt(lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length) / mean : 0;
    const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    const hapax = [...counts.values()].filter(count => count === 1).length / counts.size;
    const clamp = value => Math.max(0, Math.min(1, value));
    return (clamp((0.7 - ttr) / 0.3) + clamp((0.5 - cv) / 0.3) + clamp((0.6 - hapax) / 0.3)) / 3;
}

/** Strip reasoning blocks and wrapping quotes/fences a model may add around the rewritten text. */
export function cleanOutput(text) {
    return String(text || '')
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i, '$1')
        .trim();
}
