// Slop scanner and output checks (pure, no ST imports).
import { PATTERNS, PATTERN_BY_ID } from './patterns.js';

const PROTECTED = /```[\s\S]*?```|<[^>\n]+>|\{\{[\s\S]*?\}\}|https?:\/\/\S+/g;
// Status / tracker blocks are copied as is by the prompt, so flagging them would only block the rescan.
const BLOCKS = /<(details|pre|table|code|style|script)\b[\s\S]*?<\/\1>|^.*<br\s*\/?>.*$/gim;
const DIALOGUE =/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g;
const GAP = '[^.!?…\\n]{0,40}?';
const cache = new Map();

/** Compile a watch entry: a RegExp is used as is; "..." in a string is a short gap inside one sentence. */
export function compile(entry) {
    if (entry instanceof RegExp) return new RegExp(entry.source, entry.flags.includes('g') ? entry.flags : entry.flags + 'g');
    const key = String(entry).normalize('NFC');
    if (!cache.has(key)) {
        const body = key.split('...').map(part => part.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(GAP);
        cache.set(key, new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu'));
    }
    return new RegExp(cache.get(key));
}

/** Replace ranges with newlines (same length, so indices stay valid and gaps cannot cross them). */
function mask(text, pattern) {
    return text.replace(pattern, match => match.replace(/[^\n]/g, '\n'));
}

function views(text) {
    const full = mask(mask(text, BLOCKS), PROTECTED);
    const narration = mask(full, DIALOGUE);
    let dialogue = '';
    let last = 0;
    for (const match of full.matchAll(DIALOGUE)) {
        dialogue += full.slice(last, match.index).replace(/[^\n]/g, '\n') + match[0];
        last = match.index + match[0].length;
    }
    dialogue += full.slice(last).replace(/[^\n]/g, '\n');
    return { all: full, narration, dialogue };
}

/** The sentence around `index`, trimmed to about 160 characters. */
export function excerpt(text, index, length = 0) {
    let start = index;
    while (start > 0 && !/[.!?…\n]/.test(text[start - 1])) start--;
    let end = index + length;
    while (end < text.length && !/[.!?…\n]/.test(text[end])) end++;
    if (end < text.length && text[end] !== '\n') end++;
    let value = text.slice(start, end).trim().replace(/^["”»)\]]+\s*/, '');
    if (value.length > 160) value = `${value.slice(0, 157)}…`;
    return value;
}

/**
 * Find slop in `text`.
 * @param {string} text
 * @param {string} lang en | vi | fr
 * @param {{ disabled?: Record<string, boolean>, extra?: string[] }} [options] disabled pattern ids; extra user phrases
 * @returns {{ id: string, match: string, index: number, excerpt: string }[]} sorted by position, one hit per id+position
 */
export function scan(text, lang, { disabled = {}, extra = [] } = {}) {
    const source = String(text || '').normalize('NFC');
    const view = views(source);
    const hits = new Map();
    const add = (id, index, match) => {
        const key = `${id}:${index}`;
        if (!hits.has(key)) hits.set(key, { id, match, index, excerpt: excerpt(source, index, match.length) });
    };
    for (const pattern of PATTERNS) {
        if (disabled[pattern.id]) continue;
        const target = view[pattern.scope] ?? view.all;
        for (const entry of pattern.watch?.[lang] || []) {
            for (const match of target.matchAll(compile(entry))) add(pattern.id, match.index, match[0]);
        }
        for (const hit of pattern.detect?.(target, lang) || []) add(pattern.id, hit.index, hit.match);
    }
    if (!disabled.custom) {
        for (const entry of extra) {
            if (String(entry).trim()) for (const match of view.all.matchAll(compile(entry))) add('custom', match.index, match[0]);
        }
    }
    return [...hits.values()].sort((a, b) => a.index - b.index);
}

/** Group hits by pattern id, keeping order of first appearance. */
export function groupHits(hits) {
    const groups = new Map();
    for (const hit of hits) {
        if (!groups.has(hit.id)) groups.set(hit.id, []);
        groups.get(hit.id).push(hit);
    }
    return groups;
}

export const patternName = id => id === 'custom' ? 'Custom phrase' : PATTERN_BY_ID[id]?.name || id;

/** First sentence of a reply, for the "do not open the same way" check. */
export function opening(text) {
    const clean = mask(String(text || ''), PROTECTED).replace(/\s+/g, ' ').trim();
    return (clean.match(/^[^.!?…]{1,100}[.!?…]?/)?.[0] || '').trim();
}

/** True when two replies open with the same first three words. */
export function sameOpening(a, b) {
    const words = value => (String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 3).join(' ');
    return Boolean(words(a)) && words(a) === words(b);
}

function multiset(text, pattern, normalize = item => item.replace(/\s+/g, ' ')) {
    return (String(text).match(pattern) || []).map(normalize).sort().join('\u0001');
}

// <br>, <br/> and <BR /> are the same tag: compare lower-case name and attributes only.
const tagKey = tag => tag.toLowerCase().replace(/\s*\/?>$/, '>').replace(/\s+/g, ' ');

/**
 * Compare a rewrite with the source. Returns a reason string when the rewrite must be rejected, else null.
 * Checks HTML tags, macros, code fences, asterisk balance and length.
 */
export function checkOutput(source, output, { minRatio = 0.6, maxRatio = 1.4 } = {}) {
    if (multiset(source, /<\/?[a-zA-Z][^>]*>/g, tagKey) !== multiset(output, /<\/?[a-zA-Z][^>]*>/g, tagKey)) return 'HTML tags changed';
    if (multiset(source, /\{\{[\s\S]*?\}\}/g) !== multiset(output, /\{\{[\s\S]*?\}\}/g)) return 'macros changed';
    if ((source.match(/```/g) || []).length !== (output.match(/```/g) || []).length) return 'code blocks changed';
    if ((source.match(/\*/g) || []).length % 2 === 0 && (output.match(/\*/g) || []).length % 2 === 1) return 'unbalanced *asterisks*';
    if (source.length > 200) {
        const ratio = output.length / source.length;
        if (ratio < minRatio || ratio > maxRatio) return `length changed too much (${Math.round(ratio * 100)}%)`;
    }
    return null;
}
