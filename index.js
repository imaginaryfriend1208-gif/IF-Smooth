import { ConnectionManagerRequestService } from '../../shared.js';
import { cleanOutput, parseVocab, replaceVocab } from './src/rules.js';
import { LANGUAGES, LANGUAGE_CODES, detectLanguage, languageNotes } from './src/languages.js';
import { GROUPS, PATTERNS } from './src/patterns.js';
import { checkOutput, excerpt, groupHits, opening, patternName, sameOpening, scan } from './src/scan.js';
import { DEFAULT_PROMPT, LEGACY_PROMPTS, buildPrompt, selectRules } from './src/prompt.js';
import { around, changes, touches } from './src/diff.js';

const MODULE = 'if_humanize';
const TITLE = 'IF Humanize';
const emptyCustom = () => Object.fromEntries(LANGUAGE_CODES.map(code => [code, { slop: '', vocab: '' }]));

const DEFAULTS = {
    profile: null,
    language: 'auto',
    mode: 'edit',
    rounds: 2,
    prompt: DEFAULT_PROMPT,
    max_tokens: 0,
    vocab_enabled: true,
    auto: false,
    threshold: 3,
    show_score: true,
    patterns: {},
    custom: emptyCustom(),
};

// Inline SVG icons (24×24, stroke = currentColor) so the toolbar does not depend on the icon font.
const ICONS = {
    humanize: '<path d="M4 20 15 9"/><path d="m13 7 4 4"/><path d="M18 3v4M16 5h4M6 4v3M4.5 5.5h3M20 13v3M18.5 14.5h3"/>',
    again: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 21v-5h-5"/>',
    scan: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    changes: '<path d="M7 4v16"/><path d="m4 7 3-3 3 3"/><path d="M17 20V4"/><path d="m14 17 3 3 3-3"/>',
    original: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    result: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    busy: '<path d="M12 3a9 9 0 1 0 9 9"/>',
};
const svg = name => `<svg class="ifh-icon${name === 'busy' ? ' ifh-spin' : ''}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const busy = new Set();
const ctx = () => SillyTavern.getContext();
let migrated = false;

/** v1.0 kept one English word list in `vocab`; move the user's own entries to `custom.en.vocab`. */
function migrate(config) {
    if (typeof config.vocab === 'string') {
        const builtIn = parseVocab(LANGUAGES.en.vocab);
        const own = Object.entries(parseVocab(config.vocab))
            .filter(([word, options]) => builtIn[word]?.join(',') !== options.join(','))
            .map(([word, options]) => `${word} = ${options.join(', ')}`);
        if (own.length && !config.custom.en.vocab) config.custom.en.vocab = own.join('\n');
        delete config.vocab;
    }
    if (LEGACY_PROMPTS.includes(config.prompt)) config.prompt = DEFAULT_PROMPT;
}

function settings() {
    const all = ctx().extensionSettings;
    // Fill in place: the settings panel keeps a reference to this object.
    const config = all[MODULE] ??= {};
    if (migrated) return config;
    for (const [key, value] of Object.entries(DEFAULTS)) config[key] ??= structuredClone(value);
    for (const code of LANGUAGE_CODES) config.custom[code] = { slop: '', vocab: '', ...config.custom[code] };
    migrate(config);
    migrated = true;
    return config;
}

const save = () => ctx().saveSettingsDebounced();
const lines = value => String(value || '').split('\n').map(line => line.trim()).filter(Boolean);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

function isTarget(message) {
    return Boolean(message) && !message.is_user && !message.is_system && typeof message.mes === 'string' && message.mes.trim().length > 0;
}

/** First sentence of the closest earlier character reply, for the "same opening" check. */
function previousOpening(id) {
    const { chat } = ctx();
    for (let index = id - 1; index >= 0; index--) {
        if (isTarget(chat[index])) return opening(chat[index].mes);
    }
    return '';
}

function findSlop(text, lang, previous, config) {
    const hits = scan(text, lang, { disabled: config.patterns, extra: lines(config.custom[lang]?.slop) });
    const first = opening(text);
    if (previous && !config.patterns['rp.opening'] && sameOpening(previous, first)) {
        hits.unshift({ id: 'rp.opening', match: first, index: 0, excerpt: excerpt(text, 0, first.length) });
    }
    return hits;
}

async function request(config, system, text, lang) {
    const perChar = lang === 'en' ? 0.5 : 1;
    const maxTokens = Number(config.max_tokens) || Math.min(8192, Math.max(512, Math.ceil(text.length * perChar)));
    const messages = [{ role: 'system', content: system }, { role: 'user', content: text }];
    let response;
    try {
        response = await ConnectionManagerRequestService.sendRequest(config.profile, messages, maxTokens, { stream: false, extractData: true, includePreset: true, includeInstruct: true });
    } catch (error) {
        throw new Error(error?.cause?.message || error?.message || String(error));
    }
    const output = cleanOutput(typeof response === 'string' ? response : response?.content);
    if (!output) throw new Error('The profile returned an empty response.');
    return output;
}

/**
 * Scan → edit (or rewrite) → rescan, up to `rounds` requests. Stops when nothing is left, when a round
 * does not reduce the count, or when a rewrite breaks the formatting (that output is discarded).
 */
async function humanize(text, lang, previous, config) {
    const before = findSlop(text, lang, previous, config);
    let current = text;
    let hits = before;
    let warning = '';
    const rounds = Number(config.rounds);
    if (rounds > 0 && !config.profile) throw new Error('Select a connection profile in the IF Humanize settings.');
    for (let round = 0; round < rounds; round++) {
        // A full rewrite runs once; later rounds only fix what is still flagged.
        const mode = round === 0 && config.mode === 'rewrite' ? 'rewrite' : 'edit';
        if (mode === 'edit' && !hits.length) break;
        const system = buildPrompt(config.prompt, {
            language: LANGUAGES[lang].name,
            mode,
            rules: selectRules(hits, { mode, lang, disabled: config.patterns }),
            notes: languageNotes(lang, current),
            hits,
            previous,
        });
        const output = await request(config, system, current, lang);
        console.debug(`[${TITLE}] round ${round + 1} (${mode})`, { system, output });
        const problem = checkOutput(current, output);
        if (problem) {
            warning = `Round ${round + 1}: the model's text was discarded (${problem}).`;
            break;
        }
        if (output === current) {
            warning = `Round ${round + 1}: the model returned the text unchanged. Try another profile or the "Rewrite" mode.`;
            break;
        }
        const next = findSlop(output, lang, previous, config);
        // Keep a round only if it helped: an edit must remove slop, a full rewrite must not add any.
        if (mode === 'edit' ? next.length >= hits.length : next.length > hits.length) {
            warning = `Round ${round + 1}: the edit did not reduce slop (${hits.length} → ${next.length}), so it was not kept.`;
            break;
        }
        current = output;
        hits = next;
    }
    if (config.vocab_enabled) {
        const vocab = { ...parseVocab(LANGUAGES[lang].vocab), ...parseVocab(config.custom[lang]?.vocab) };
        current = replaceVocab(current, vocab);
        hits = findSlop(current, lang, previous, config);
    }
    return { text: current, before, after: hits, warning };
}

async function setMessageText(id, message, text) {
    message.mes = text;
    if (Array.isArray(message.swipes)) message.swipes[message.swipe_id ?? 0] = text;
    ctx().updateMessageBlock(id, message);
    await ctx().saveChat();
    addButtons(id);
}

function popup(html) {
    ctx().callGenericPopup(`<div class="ifh-hits">${html}</div>`, ctx().POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, leftAlign: true });
}

function hitList(hits) {
    return [...groupHits(hits)].map(([id, group]) => `<h4>${escapeHtml(patternName(id))}</h4><ul>${group.map(hit => {
        const context = hit.excerpt.startsWith(hit.match.slice(0, 150)) && hit.match.length >= hit.excerpt.length - 2 ? '' : `<br><small>${escapeHtml(hit.excerpt)}</small>`;
        return `<li><b>${escapeHtml(hit.match)}</b>${context}</li>`;
    }).join('')}</ul>`).join('');
}

export async function humanizeMessage(id, { quiet = false } = {}) {
    const message = ctx().chat[id];
    if (!isTarget(message) || busy.has(id)) return;
    const config = settings();
    if (Number(config.rounds) < 1 && !config.vocab_enabled) {
        if (!quiet) toastr.warning('Both LLM rewrite and word replacement are off.', TITLE);
        return;
    }
    busy.add(id);
    addButtons(id);
    const source = message.mes;
    try {
        const lang = config.language === 'auto' ? detectLanguage(source) : config.language;
        const result = await humanize(source, lang, previousOpening(id), config);
        // The chat may have been switched, or the message swiped or deleted, while waiting.
        if (ctx().chat[id] !== message || message.mes !== source) return;
        if (result.warning) toastr.warning(result.warning, TITLE);
        const changed = result.text !== source;
        if (changed) {
            message.extra ??= {};
            // Running again on the humanized text keeps the very first original.
            const original = message.extra.ifh?.result === source ? message.extra.ifh.original : source;
            message.extra.ifh = { original, result: result.text, lang, note: result.warning };
            await setMessageText(id, message, result.text);
        }
        if (config.show_score) {
            const summary = `${LANGUAGES[lang].name} · slop ${result.before.length} → ${result.after.length}`;
            toastr.info(changed ? `${summary}. Click to see what changed.` : `${summary}. Text unchanged.`, TITLE, changed ? { onclick: () => showChanges(id) } : {});
        }
    } catch (error) {
        console.error(`[${TITLE}]`, error);
        toastr.error(error.message, TITLE);
    } finally {
        busy.delete(id);
        addButtons(id);
    }
}

function scanMessage(id) {
    const message = ctx().chat[id];
    if (!isTarget(message)) return;
    const config = settings();
    const lang = config.language === 'auto' ? detectLanguage(message.mes) : config.language;
    const hits = findSlop(message.mes, lang, previousOpening(id), config);
    popup(`<h3>Scan only, nothing changed (${LANGUAGES[lang].name} · ${hits.length} flagged)</h3>${hits.length ? hitList(hits) : '<p>No slop found.</p>'}`);
}

/** Which stored version the message shows now: 'original', 'result', or null (another swipe or a manual edit). */
function shownVersion(message) {
    const data = message?.extra?.ifh;
    if (typeof data?.original !== 'string' || typeof data?.result !== 'string') return null;
    if (message.mes === data.result) return 'result';
    if (message.mes === data.original) return 'original';
    return null;
}

/** Switch between the original and the humanized text without a new request. */
async function showVersion(id, which) {
    const message = ctx().chat[id];
    if (!shownVersion(message) || busy.has(id)) return;
    await setMessageText(id, message, message.extra.ifh[which]);
}

/** Every change as "context <del>removed</del><ins>added</ins> context", tagged with the pattern that flagged it. */
function showChanges(id) {
    const message = ctx().chat[id];
    if (!shownVersion(message)) return;
    const data = message.extra.ifh;
    const config = settings();
    const lang = data.lang || detectLanguage(data.original);
    const previous = previousOpening(id);
    const before = findSlop(data.original, lang, previous, config);
    const after = findSlop(data.result, lang, previous, config);
    const list = changes(data.original, data.result);
    const rows = list.map(change => {
        const names = [...new Set(before.filter(hit => touches(hit, change)).map(hit => patternName(hit.id)))];
        const tag = names.length ? `<span class="ifh-tag">${escapeHtml(names.join(', '))}</span>` : '<span class="ifh-tag ifh-tag-extra">Extra edit</span>';
        const part = around(data.original, change.start, change.end);
        const removed = part.middle ? `<del>${escapeHtml(part.middle)}</del>` : '';
        const added = change.added ? `<ins>${escapeHtml(change.added)}</ins>` : '';
        return `<li>${tag}<div>${escapeHtml(part.before)}${removed}${added}${escapeHtml(part.after)}</div></li>`;
    }).join('');
    const missed = before.filter(hit => !list.some(change => touches(hit, change)));
    const fresh = after.filter(hit => list.some(change => hit.index < change.afterEnd && hit.index + hit.match.length > change.afterStart));
    popup(`<h3>${LANGUAGES[lang].name} · slop ${before.length} → ${after.length} · ${list.length} changes</h3>
        ${data.note ? `<p class="ifh-note">${escapeHtml(data.note)}</p>` : ''}
        ${rows ? `<ol class="ifh-changes">${rows}</ol>` : '<p>No differences.</p>'}
        ${missed.length ? `<h3>Flagged but left as is (${missed.length})</h3>${hitList(missed)}` : ''}
        ${fresh.length ? `<h3>New slop in the edited text (${fresh.length})</h3>${hitList(fresh)}` : ''}`);
}

/** Icon toolbar under the message text: Humanize/again, Scan, and (once humanized) Changes + Original/Humanized. */
function addButtons(id) {
    const element = $(`#chat .mes[mesid="${id}"]`);
    element.find('.ifh-bar').remove();
    const message = ctx().chat[id];
    if (!element.length || !isTarget(message)) return;
    const running = busy.has(id);
    const shown = shownVersion(message);
    const button = (action, icon, title, extra = '') => `<div class="ifh-btn ifh-${action} interactable${extra}" tabindex="0" role="button" title="${title}" aria-label="${title}">${svg(icon)}</div>`;
    let html = running
        ? button('run', 'busy', 'Humanizing…', ' disabled')
        : shown === 'result'
            ? button('run', 'again', 'Humanize again (sends a request)')
            : button('run', 'humanize', 'Humanize (sends a request)');
    html += button('scan', 'scan', 'Scan for AI-sounding phrases (no request)');
    if (shown && !running) {
        html += button('changes', 'changes', 'What changed: before / after (no request)');
        html += shown === 'result'
            ? button('original', 'original', 'Show the original text (no request)')
            : button('result', 'result', 'Show the humanized text (no request)');
    }
    element.find('.mes_text').after(`<div class="ifh-bar">${html}</div>`);
}

function resetButtons() {
    document.querySelectorAll('#chat > .mes[mesid]').forEach(element => addButtons(Number(element.getAttribute('mesid'))));
}

/** Auto mode: runs in the background (not awaited), only when the reply has at least `threshold` hits. */
function onCharacterRendered(id, type) {
    id = Number(id);
    addButtons(id);
    const message = ctx().chat[id];
    const config = settings();
    if (!config.auto || type === 'first_message' || !isTarget(message) || shownVersion(message)) return;
    const lang = config.language === 'auto' ? detectLanguage(message.mes) : config.language;
    if (findSlop(message.mes, lang, previousOpening(id), config).length < Math.max(1, Number(config.threshold) || 1)) return;
    humanizeMessage(id, { quiet: true });
}

/** One collapsed <details> per group; the summary shows "on/total" and a box that turns the whole group on or off. */
function patternToggles() {
    const groups = Object.entries(GROUPS).map(([group, label]) => [group, label, PATTERNS.filter(pattern => pattern.group === group)]);
    groups.push(['custom', 'Custom', [{ id: 'custom', name: 'Custom phrases', rule: 'Phrases from "Your lists"' }]]);
    return groups.map(([group, label, items]) => `
        <details class="ifh-group" data-group="${group}">
            <summary><input type="checkbox" class="ifh-group-toggle" title="Turn the whole group on or off"><span>${escapeHtml(label)}</span><small class="ifh-count"></small></summary>
            ${items.map(pattern => `<label class="checkbox_label" title="${escapeHtml(pattern.rule)}"><input type="checkbox" class="ifh-pattern" data-id="${pattern.id}"><span>${escapeHtml(pattern.name)}</span></label>`).join('')}
        </details>`).join('');
}

function refreshGroups() {
    $('.ifh-group').each(function () {
        const boxes = $(this).find('.ifh-pattern');
        const on = boxes.filter(':checked').length;
        $(this).find('.ifh-count').text(`${on}/${boxes.length}`);
        $(this).find('.ifh-group-toggle').prop({ checked: on === boxes.length, indeterminate: on > 0 && on < boxes.length });
    });
}

function renderSettings() {
    const config = settings();
    const languageOptions = LANGUAGE_CODES.map(code => `<option value="${code}">${LANGUAGES[code].name}</option>`).join('');
    const html = `
    <div class="ifh-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${TITLE}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="ifh_profile"><small>Connection profile (used for the rewrite)</small></label>
                <select id="ifh_profile" class="text_pole"></select>
                <div class="ifh-row">
                    <label for="ifh_language"><small>Language</small></label>
                    <select id="ifh_language" class="text_pole"><option value="auto">Detect from the message</option>${languageOptions}</select>
                </div>
                <div class="ifh-row">
                    <label for="ifh_mode"><small>Mode</small></label>
                    <select id="ifh_mode" class="text_pole">
                        <option value="edit">Edit flagged passages only</option>
                        <option value="rewrite">Rewrite the whole reply</option>
                    </select>
                </div>
                <div class="ifh-row">
                    <label for="ifh_rounds"><small>Max requests per message (0 = word replacement only)</small></label>
                    <input id="ifh_rounds" class="text_pole" type="number" min="0" max="3" step="1">
                </div>
                <div class="ifh-row">
                    <label for="ifh_max_tokens"><small>Max response tokens (0 = auto)</small></label>
                    <input id="ifh_max_tokens" class="text_pole" type="number" min="0" step="64">
                </div>
                <label class="checkbox_label"><input id="ifh_auto" type="checkbox"><span>Humanize new character messages automatically (in the background)</span></label>
                <div class="ifh-row">
                    <label for="ifh_threshold"><small>Auto: only when the reply has at least this many flagged phrases</small></label>
                    <input id="ifh_threshold" class="text_pole" type="number" min="1" step="1">
                </div>
                <label class="checkbox_label"><input id="ifh_show_score" type="checkbox"><span>Show slop count after each run</span></label>
                <label class="checkbox_label"><input id="ifh_vocab_enabled" type="checkbox"><span>Replace formal words after the rewrite (built-in list + your list)</span></label>
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header"><span>Patterns</span><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
                    <div class="inline-drawer-content ifh-patterns">${patternToggles()}</div>
                </div>
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header"><span>Your lists</span><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
                    <div class="inline-drawer-content">
                        <select id="ifh_list_language" class="text_pole">${languageOptions}</select>
                        <label for="ifh_custom_slop"><small>Phrases to flag, one per line (<code>...</code> = a few words in between)</small></label>
                        <textarea id="ifh_custom_slop" class="text_pole textarea_compact" rows="5"></textarea>
                        <label for="ifh_custom_vocab"><small>Word list, one per line: <code>word = option1, option2</code>; <code>word =</code> deletes it</small></label>
                        <textarea id="ifh_custom_vocab" class="text_pole textarea_compact" rows="5"></textarea>
                    </div>
                </div>
                <label for="ifh_prompt"><small>Rewrite prompt (placeholders: {{language}} {{task}} {{rules}} {{notes}} {{flagged}} {{previous}})</small></label>
                <textarea id="ifh_prompt" class="text_pole textarea_compact" rows="8"></textarea>
                <div class="menu_button ifh-reset-prompt">Reset prompt</div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#ifh_language').val(config.language).on('change', function () { config.language = this.value; save(); });
    $('#ifh_mode').val(config.mode).on('change', function () { config.mode = this.value; save(); });
    $('#ifh_rounds').val(config.rounds).on('input', function () { config.rounds = Math.max(0, Math.min(3, Number(this.value) || 0)); save(); });
    $('#ifh_threshold').val(config.threshold).on('input', function () { config.threshold = Math.max(1, Number(this.value) || 1); save(); });
    $('#ifh_max_tokens').val(config.max_tokens).on('input', function () { config.max_tokens = Math.max(0, Number(this.value) || 0); save(); });
    $('#ifh_prompt').val(config.prompt).on('input', function () { config.prompt = this.value; save(); });
    for (const key of ['auto', 'show_score', 'vocab_enabled']) {
        $(`#ifh_${key}`).prop('checked', config[key]).on('change', function () { config[key] = this.checked; save(); });
    }
    $('.ifh-pattern').each(function () {
        $(this).prop('checked', !config.patterns[this.dataset.id]);
    }).on('change', function () {
        if (this.checked) delete config.patterns[this.dataset.id];
        else config.patterns[this.dataset.id] = true;
        refreshGroups();
        save();
    });
    // The group box sits inside <summary>: stop the click from also folding the section.
    $('.ifh-group-toggle').on('click', event => event.stopPropagation()).on('change', function () {
        $(this).closest('.ifh-group').find('.ifh-pattern').prop('checked', this.checked).trigger('change');
    });
    refreshGroups();
    const listLanguage = () => $('#ifh_list_language').val();
    const showLists = () => {
        $('#ifh_custom_slop').val(config.custom[listLanguage()].slop);
        $('#ifh_custom_vocab').val(config.custom[listLanguage()].vocab);
    };
    $('#ifh_list_language').val(config.language === 'auto' ? 'en' : config.language).on('change', showLists);
    $('#ifh_custom_slop').on('input', function () { config.custom[listLanguage()].slop = this.value; save(); });
    $('#ifh_custom_vocab').on('input', function () { config.custom[listLanguage()].vocab = this.value; save(); });
    showLists();
    $('.ifh-reset-prompt').on('click', () => { config.prompt = DEFAULT_PROMPT; $('#ifh_prompt').val(DEFAULT_PROMPT); save(); });

    try {
        ConnectionManagerRequestService.handleDropdown('#ifh_profile', config.profile || '', profile => { config.profile = profile?.id ?? null; save(); });
    } catch (error) {
        $('#ifh_profile').replaceWith('<div class="ifh-warning">Enable the Connection Manager extension to choose a profile.</div>');
        console.warn(`[${TITLE}]`, error);
    }
}

jQuery(() => {
    const { eventSource, eventTypes } = ctx();
    settings();
    save();
    renderSettings();
    const actions = {
        run: humanizeMessage,
        scan: scanMessage,
        changes: showChanges,
        original: id => showVersion(id, 'original'),
        result: id => showVersion(id, 'result'),
    };
    for (const [action, handler] of Object.entries(actions)) {
        $(document).on('click', `#chat .ifh-${action}:not(.disabled)`, function () { handler(Number($(this).closest('.mes').attr('mesid'))); });
    }
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    eventSource.on(eventTypes.MESSAGE_SWIPED, id => addButtons(Number(id)));
    eventSource.on(eventTypes.MESSAGE_UPDATED, id => addButtons(Number(id)));
    eventSource.on(eventTypes.CHAT_CHANGED, resetButtons);
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, resetButtons);
    resetButtons();
});
