import { ConnectionManagerRequestService } from '../../shared.js';
import { DEFAULT_VOCAB, aiScore, cleanOutput, formatVocab, parseVocab, replaceVocab } from './src/rules.js';

const MODULE = 'if_humanize';
const TITLE = 'IF Humanize';

const DEFAULT_PROMPT = `You are a fiction copy editor. Rewrite the text you are given so it reads as if a skilled human author wrote it.

Rules:
- Keep the original language, point of view, tense, names, events and the meaning of every line of dialogue. Do not add or remove plot content.
- Keep the formatting exactly: *asterisk actions*, "quoted dialogue", paragraph breaks, HTML tags and anything inside {{ }}.
- Vary sentence length: mix short, blunt sentences with longer ones. Avoid three sentences in a row of similar length.
- Replace stock phrases and clichés (e.g. "a testament to", "sent shivers down", "barely above a whisper", "a mix of X and Y", "couldn't help but") with concrete, plain wording.
- Prefer everyday vocabulary over formal or ornate words.
- Output only the rewritten text. No preface, notes, or quotes around it.`;

const DEFAULTS = {
    profile: null,
    rounds: 1,
    prompt: DEFAULT_PROMPT,
    max_tokens: 0,
    vocab_enabled: true,
    vocab: formatVocab(DEFAULT_VOCAB),
    auto: false,
    show_score: true,
};

const busy = new Set();
const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] = { ...DEFAULTS, ...(all[MODULE] || {}) };
    return all[MODULE];
}

const save = () => ctx().saveSettingsDebounced();
const percent = value => value == null ? 'n/a' : `${Math.round(value * 100)}%`;

function isTarget(message) {
    return Boolean(message) && !message.is_user && !message.is_system && typeof message.mes === 'string' && message.mes.trim().length > 0;
}

async function rewrite(text) {
    const config = settings();
    if (!config.profile) throw new Error('Select a connection profile in the IF Humanize settings.');
    const maxTokens = Number(config.max_tokens) || Math.min(8192, Math.max(512, Math.ceil(text.length / 2)));
    let current = text;
    for (let round = 0; round < Number(config.rounds); round++) {
        const messages = [
            { role: 'system', content: config.prompt || DEFAULT_PROMPT },
            { role: 'user', content: current },
        ];
        let response;
        try {
            response = await ConnectionManagerRequestService.sendRequest(config.profile, messages, maxTokens, { stream: false, extractData: true, includePreset: true, includeInstruct: true });
        } catch (error) {
            throw new Error(error?.cause?.message || error?.message || String(error));
        }
        const output = cleanOutput(typeof response === 'string' ? response : response?.content);
        if (!output) throw new Error('The profile returned an empty response.');
        current = output;
    }
    return current;
}

async function setMessageText(id, message, text) {
    message.mes = text;
    if (Array.isArray(message.swipes)) message.swipes[message.swipe_id ?? 0] = text;
    ctx().updateMessageBlock(id, message);
    await ctx().saveChat();
    addButtons(id);
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
        let text = original;
        if (Number(config.rounds) > 0) text = await rewrite(text);
        if (config.vocab_enabled) text = replaceVocab(text, parseVocab(config.vocab));
        // The chat may have been switched, or the message swiped or deleted, while waiting.
        if (ctx().chat[id] !== message || message.mes !== original) return;
        message.extra ??= {};
        // Keep the very first original across repeated runs on the same text.
        const first = message.extra.ifh?.result === original ? message.extra.ifh.original : original;
        message.extra.ifh = { original: first, result: text };
        await setMessageText(id, message, text);
        if (config.show_score) toastr.info(`AI-likeness: ${percent(aiScore(original))} → ${percent(aiScore(text))}`, TITLE);
    } catch (error) {
        console.error(`[${TITLE}]`, error);
        toastr.error(error.message, TITLE);
    } finally {
        busy.delete(id);
        addButtons(id);
    }
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
    box.prepend(humanize);
    if (canRevert(message) && !running) {
        humanize.after($('<div class="mes_button ifh-button ifh-revert fa-solid fa-rotate-left interactable" tabindex="0" role="button" title="Restore the text before humanizing"></div>'));
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

function renderSettings() {
    const config = settings();
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
                    <label for="ifh_rounds"><small>Rewrite rounds (0 = word replacement only)</small></label>
                    <input id="ifh_rounds" class="text_pole" type="number" min="0" max="3" step="1">
                </div>
                <div class="ifh-row">
                    <label for="ifh_max_tokens"><small>Max response tokens (0 = auto)</small></label>
                    <input id="ifh_max_tokens" class="text_pole" type="number" min="0" step="64">
                </div>
                <label class="checkbox_label"><input id="ifh_auto" type="checkbox"><span>Humanize new character messages automatically</span></label>
                <label class="checkbox_label"><input id="ifh_show_score" type="checkbox"><span>Show AI-likeness score after each run</span></label>
                <label for="ifh_prompt"><small>Rewrite prompt</small></label>
                <textarea id="ifh_prompt" class="text_pole textarea_compact" rows="8"></textarea>
                <div class="menu_button ifh-reset-prompt">Reset prompt</div>
                <hr>
                <label class="checkbox_label"><input id="ifh_vocab_enabled" type="checkbox"><span>Replace AI-sounding words (whole words, after the rewrite)</span></label>
                <label for="ifh_vocab"><small>One per line: <code>word = option1, option2</code></small></label>
                <textarea id="ifh_vocab" class="text_pole textarea_compact" rows="8"></textarea>
                <div class="menu_button ifh-reset-vocab">Reset word list</div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#ifh_rounds').val(config.rounds).on('input', function () { config.rounds = Math.max(0, Math.min(3, Number(this.value) || 0)); save(); });
    $('#ifh_max_tokens').val(config.max_tokens).on('input', function () { config.max_tokens = Math.max(0, Number(this.value) || 0); save(); });
    $('#ifh_prompt').val(config.prompt).on('input', function () { config.prompt = this.value; save(); });
    $('#ifh_vocab').val(config.vocab).on('input', function () { config.vocab = this.value; save(); });
    for (const key of ['auto', 'show_score', 'vocab_enabled']) {
        $(`#ifh_${key}`).prop('checked', config[key]).on('change', function () { config[key] = this.checked; save(); });
    }
    $('.ifh-reset-prompt').on('click', () => { config.prompt = DEFAULT_PROMPT; $('#ifh_prompt').val(DEFAULT_PROMPT); save(); });
    $('.ifh-reset-vocab').on('click', () => { config.vocab = DEFAULTS.vocab; $('#ifh_vocab').val(DEFAULTS.vocab); save(); });

    try {
        ConnectionManagerRequestService.handleDropdown('#ifh_profile', config.profile || '', profile => { config.profile = profile?.id ?? null; save(); });
    } catch (error) {
        $('#ifh_profile').replaceWith('<div class="ifh-warning">Enable the Connection Manager extension to choose a profile.</div>');
        console.warn(`[${TITLE}]`, error);
    }
}

jQuery(() => {
    const { eventSource, eventTypes } = ctx();
    renderSettings();
    $(document).on('click', '#chat .ifh-run:not(.disabled)', function () { humanizeMessage(Number($(this).closest('.mes').attr('mesid'))); });
    $(document).on('click', '#chat .ifh-revert', function () { revertMessage(Number($(this).closest('.mes').attr('mesid'))); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    eventSource.on(eventTypes.MESSAGE_SWIPED, id => addButtons(Number(id)));
    eventSource.on(eventTypes.MESSAGE_UPDATED, id => addButtons(Number(id)));
    eventSource.on(eventTypes.CHAT_CHANGED, resetButtons);
    eventSource.on(eventTypes.MORE_MESSAGES_LOADED, resetButtons);
    resetButtons();
});
