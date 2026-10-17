import { ConnectionManagerRequestService } from '../../shared.js';
import { cleanOutput, parseVocab, replaceVocab } from './src/rules.js';
import { LANGUAGES, LANGUAGE_CODES, detectLanguage } from './src/languages.js';
import { GROUPS, PATTERNS } from './src/patterns.js';
import { checkOutput, excerpt, groupHits, opening, patternName, sameOpening, scan } from './src/scan.js';
import { DEFAULT_PROMPT, LEGACY_PROMPTS, buildPrompt, selectRules } from './src/prompt.js';

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
    show_score: true,
    patterns: {},
    custom: emptyCustom(),
};

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
            notes: LANGUAGES[lang].notes,
            hits,
            previous,
        });
        const output = await request(config, system, current, lang);
        const problem = checkOutput(current, output);
        if (problem) {
            warning = `Rewrite discarded: ${problem}.`;
            break;
        }
        const next = findSlop(output, lang, previous, config);
        // Keep a round only if it helped: an edit must remove slop, a full rewrite must not add any.
        if (mode === 'edit' ? next.length >= hits.length : next.length > hits.length) break;
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

function showHits(hits, title) {
    const body = hits.length
        ? [...groupHits(hits)].map(([id, group]) => `<h4>${escapeHtml(patternName(id))}</h4><ul>${group.map(hit => `<li><b>${escapeHtml(hit.match)}</b><br><small>${escapeHtml(hit.excerpt)}</small></li>`).join('')}</ul>`).join('')
        : '<p>No slop found.</p>';
    ctx().callGenericPopup(`<div class="ifh-hits"><h3>${escapeHtml(title)}</h3>${body}</div>`, ctx().POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, leftAlign: true });
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
    const original = message.mes;
    try {
        const lang = config.language === 'auto' ? detectLanguage(original) : config.language;
        const result = await humanize(original, lang, previousOpening(id), config);
        // The chat may have been switched, or the message swiped or deleted, while waiting.
        if (ctx().chat[id] !== message || message.mes !== original) return;
        if (result.warning) toastr.warning(result.warning, TITLE);
        if (result.text !== original) {
            message.extra ??= {};
            // Keep the very first original across repeated runs on the same text.
            const first = message.extra.ifh?.result === original ? message.extra.ifh.original : original;
            message.extra.ifh = { original: first, result: result.text };
            await setMessageText(id, message, result.text);
        }
        if (config.show_score) {
            const summary = `${LANGUAGES[lang].name} · slop ${result.before.length} → ${result.after.length}`;
            const options = result.after.length ? { onclick: () => showHits(result.after, `Still flagged (${summary})`) } : {};
            toastr.info(result.after.length ? `${summary}. Click for details.` : summary, TITLE, options);
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
    showHits(hits, `${LANGUAGES[lang].name} · ${hits.length} flagged`);
}

/** Revert only while the message still shows the humanized text (not another swipe or a manual edit). */
const canRevert = message => typeof message?.extra?.ifh?.original === 'string' && message.mes === message.extra.ifh.result;

async function revertMessage(id) {
    const message = ctx().chat[id];
    if (!canRevert(message)) return;
    const { original } = message.extra.ifh;
    delete message.extra.ifh;
    await setMessageText(id, message, original);
}

function addButtons(id) {
    const element = $(`#chat .mes[mesid="${id}"]`);
    const box = element.find('.extraMesButtons');
    box.find('.ifh-button').remove();
    const message = ctx().chat[id];
    if (!box.length || !isTarget(message)) return;
    const running = busy.has(id);
    const humanize = $('<div class="mes_button ifh-button ifh-run fa-solid interactable" tabindex="0" role="button"></div>')
        .addClass(running ? 'fa-spinner fa-spin disabled' : 'fa-wand-magic-sparkles')
        .attr('title', running ? 'Humanizing…' : 'Humanize this message');
    const check = $('<div class="mes_button ifh-button ifh-scan fa-solid fa-magnifying-glass interactable" tabindex="0" role="button" title="Show AI-sounding phrases"></div>');
    box.prepend(humanize, check);
    if (canRevert(message) && !running) {
        check.after($('<div class="mes_button ifh-button ifh-revert fa-solid fa-rotate-left interactable" tabindex="0" role="button" title="Restore the text before humanizing"></div>'));
    }
}

function resetButtons() {
    document.querySelectorAll('#chat > .mes[mesid]').forEach(element => addButtons(Number(element.getAttribute('mesid'))));
}

function onCharacterRendered(id, type) {
    id = Number(id);
    addButtons(id);
    const message = ctx().chat[id];
    if (!settings().auto || type === 'first_message' || canRevert(message)) return;
    humanizeMessage(id, { quiet: true });
}

function patternToggles() {
    return Object.entries(GROUPS).map(([group, label]) => {
        const items = PATTERNS.filter(pattern => pattern.group === group)
            .map(pattern => `<label class="checkbox_label" title="${escapeHtml(pattern.rule)}"><input type="checkbox" class="ifh-pattern" data-id="${pattern.id}"><span>${escapeHtml(pattern.name)}</span></label>`)
            .join('');
        return `<div class="ifh-group"><b>${escapeHtml(label)}</b>${items}</div>`;
    }).join('') + '<div class="ifh-group"><b>Custom</b><label class="checkbox_label"><input type="checkbox" class="ifh-pattern" data-id="custom"><span>Custom phrases</span></label></div>';
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
                <label class="checkbox_label"><input id="ifh_auto" type="checkbox"><span>Humanize new character messages automatically</span></label>
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
        save();
    });
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
    $(document).on('click', '#chat .ifh-run:not(.disabled)', function () { humanizeMessage(Number($(this).closest('.mes').attr('mesid'))); });
    $(document).on('click', '#chat .ifh-scan', function () { scanMessage(Number($(this).closest('.mes').attr('mesid'))); });
    $(document).on('click', '#chat .ifh-revert', function () { revertMessage(Number($(this).closest('.mes').attr('mesid'))); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    eventSource.on(eventTypes.MESSAGE_SWIPED, id => addButtons(Number(id)));
    eventSource.on(eventTypes.MESSAGE_UPDATED, id => addButtons(Number(id)));
    eventSource.on(eventTypes.CHAT_CHANGED, resetButtons);
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, resetButtons);
    resetButtons();
});
