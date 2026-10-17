// Rewrite prompt template and its assembly (pure, no ST imports).
import { PATTERNS, PATTERN_BY_ID } from './patterns.js';
import { groupHits, patternName } from './scan.js';

export const DEFAULT_PROMPT = `You are a fiction line editor for roleplay. Remove phrasing that sounds machine-written from the reply you are given, so it reads as if a skilled human novelist wrote it in {{language}}.

Keep:
- The language ({{language}}), point of view, tense, names, events, and the meaning of every line of dialogue. Do not invent new events or new dialogue.
- The formatting exactly: *asterisk actions*, quoted dialogue, speaker labels, paragraph breaks, HTML tags, code blocks, chat logs, status or tracker blocks, and macros in double curly braces.
- Anything that is not slop. Concrete, specific details are the human part; keep them.

{{task}}

Rules:
{{rules}}
- Show emotion through action, dialogue, pauses and concrete detail. If a sentence works without the comparison or explanation, cut it. Never replace one cliché with another.

Language notes:
{{notes}}

{{flagged}}

{{previous}}

Output only the edited reply. No preface, notes, lists of changes, or quotes around it.`;

export const TASKS = {
    edit: 'Task: edit only the flagged passages below, plus whatever must change with them so the text still flows. Copy every other sentence exactly as it is.',
    rewrite: 'Task: rewrite the whole reply in one pass, keeping its events and length roughly the same. Fix the flagged passages below and anything else that breaks the rules.',
};

/** Prompts shipped by earlier versions, so untouched configs can be upgraded to the new default. */
export const LEGACY_PROMPTS = [`You are a fiction copy editor. Rewrite the text you are given so it reads as if a skilled human author wrote it.

Rules:
- Keep the original language, point of view, tense, names, events and the meaning of every line of dialogue. Do not add or remove plot content.
- Keep the formatting exactly: *asterisk actions*, "quoted dialogue", paragraph breaks, HTML tags and anything inside {{ }}.
- Vary sentence length: mix short, blunt sentences with longer ones. Avoid three sentences in a row of similar length.
- Replace stock phrases and clichés (e.g. "a testament to", "sent shivers down", "barely above a whisper", "a mix of X and Y", "couldn't help but") with concrete, plain wording.
- Prefer everyday vocabulary over formal or ornate words.
- Output only the rewritten text. No preface, notes, or quotes around it.`];

const SECTIONS = {
    task: value => value,
    rules: value => `Rules:\n${value}`,
    notes: value => `Language notes:\n${value}`,
    flagged: value => value,
    previous: value => value,
};

/** Rules to send: the patterns that fired (edit), or every enabled pattern for the language (rewrite). */
export function selectRules(hits, { mode, lang, disabled = {} }) {
    const ids = mode === 'rewrite'
        ? PATTERNS.filter(p => !disabled[p.id] && (!['vi', 'fr'].includes(p.group) || p.group === lang)).map(p => p.id)
        : [...groupHits(hits).keys()];
    return ids.map(id => id === 'custom' ? '- Rewrite the custom flagged phrases in plain words.' : `- ${PATTERN_BY_ID[id]?.rule}`).filter(rule => rule !== '- undefined');
}

/** "Flagged passages" block, one line per hit, grouped by pattern. */
export function formatFlagged(hits) {
    if (!hits.length) return '';
    const lines = [];
    for (const [id, group] of groupHits(hits)) {
        for (const hit of group) {
            const context = hit.excerpt.startsWith(hit.match.slice(0, 150)) && hit.match.length >= hit.excerpt.length - 2 ? '' : ` in: ${hit.excerpt}`;
            lines.push(`- [${patternName(id)}] "${hit.match}"${context}`);
        }
    }
    return `Flagged passages:\n${lines.join('\n')}`;
}

/**
 * Fill the template. A custom template without some placeholder still gets that section appended,
 * so editing the prompt never silently drops the rules or the flagged list.
 */
export function buildPrompt(template, { language, mode = 'edit', rules = [], notes = '', hits = [], previous = '' }) {
    const values = {
        task: TASKS[mode] || TASKS.edit,
        rules: rules.join('\n'),
        notes: String(notes || '').trim(),
        flagged: formatFlagged(hits),
        previous: previous ? `The previous reply opened with: "${previous}". Do not open this one the same way.` : '',
    };
    let result = String(template || DEFAULT_PROMPT);
    const extra = [];
    for (const [key, value] of Object.entries(values)) {
        const tag = `{{${key}}}`;
        if (result.includes(tag)) result = result.split(tag).join(value);
        else if (value) extra.push(SECTIONS[key](value));
    }
    result = result.split('{{language}}').join(language);
    if (extra.length) result += `\n\n${extra.join('\n\n')}`;
    return result.replace(/\n{3,}/g, '\n\n').trim();
}
