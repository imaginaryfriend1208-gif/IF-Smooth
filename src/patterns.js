// Slop patterns (pure data, no ST imports).
// Ideas follow blader/humanizer (A-F), its fiction adaptation (F1-F10) and roleplay rules; wording is our own.
//
// scope:  'narration' (outside quotes), 'dialogue' (inside quotes) or 'all'.
// rule:   instruction sent to the model when the pattern fires (edit mode) or always (rewrite mode).
// watch:  phrases per language. "..." = a short gap inside one sentence. A RegExp is used as is.
// detect: optional (text, lang) => [{ index, match }] for structural tells.

const short = paragraph => (paragraph.match(/[\p{L}\p{N}]+/gu) || []).length;

/** Narrative paragraphs of four words or fewer, after the first one. */
function shortParagraphs(text) {
    const hits = [];
    let seen = 0;
    for (const match of text.matchAll(/[^\n]+/g)) {
        const line = match[0].trim();
        // Skip speaker lines, dialogue, markup, and lines without sentence punctuation (names, chat logs).
        if (!/[.!?…]$/.test(line) || /^[\p{Lu}][\p{L}\s.'-]{0,30}:/u.test(line) || /["“”«»]|^[-—–]\s|[<{|`]/.test(line)) continue;
        if (short(line) <= 4 && ++seen > 1) hits.push({ index: match.index, match: line });
    }
    return hits;
}

/** Three or more sentences in a row opening with the same word ("Là... Là... Là..."). */
function repeatedOpenings(text) {
    const hits = [];
    const sentences = [...text.matchAll(/[^.!?…\n]+[.!?…]*/g)].map(m => ({ index: m.index, value: m[0].trim() })).filter(s => s.value);
    let run = 1;
    for (let i = 1; i < sentences.length; i++) {
        const first = s => (s.value.match(/^[\p{L}\p{N}]+/u)?.[0] || '').toLowerCase();
        run = first(sentences[i]) && first(sentences[i]) === first(sentences[i - 1]) ? run + 1 : 1;
        if (run === 3) hits.push({ index: sentences[i - 2].index, match: `${sentences[i - 2].value} ${sentences[i - 1].value} ${sentences[i].value}` });
    }
    return hits;
}

/** Three or more very short sentences in a row ("Hai mươi bảy ca. Không rõ tác nhân. Đừng có là..."). */
function fragmentRuns(text) {
    const hits = [];
    const sentences = [...text.matchAll(/[^.!?…\n]+[.!?…]+/g)].map(m => ({ index: m.index, value: m[0].trim() }));
    let run = [];
    for (const sentence of sentences) {
        if (short(sentence.value) <= 4) run.push(sentence);
        else run = [];
        if (run.length === 3) hits.push({ index: run[0].index, match: run.map(s => s.value).join(' ') });
    }
    return hits;
}

/** More than two mid-sentence dashes; a dash opening a line (Vietnamese dialogue) is ignored. */
function dashes(text) {
    const all = [...text.matchAll(/(?<!^[ \t]*)[—–]/gm)];
    return all.slice(2).map(m => ({ index: m.index, match: text.slice(Math.max(0, m.index - 20), m.index + 20).trim() }));
}

/** A sentence that echoes the end of the previous one ("Và cái giường. Cái giường anh bỏ bừa..."). */
function echoes(text) {
    const hits = [];
    const words = value => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const sentences = [...text.matchAll(/[^.!?…\n]+[.!?…]*/g)].map(m => ({ index: m.index, value: m[0].trim() })).filter(s => s.value);
    for (let i = 1; i < sentences.length; i++) {
        const tail = words(sentences[i - 1].value).slice(-2).join(' ');
        const head = words(sentences[i].value).slice(0, 2).join(' ');
        if (tail.includes(' ') && tail === head) hits.push({ index: sentences[i - 1].index, match: `${sentences[i - 1].value} ${sentences[i].value}` });
    }
    return hits;
}

/** "anh ấy / cô ấy / hắn ta" three or more times in one paragraph. */
function pronounRepeat(text) {
    const hits = [];
    for (const paragraph of text.matchAll(/[^\n]+/g)) {
        const found = [...paragraph[0].matchAll(/(?<![\p{L}])(anh ấy|cô ấy|hắn ta|anh ta|cô ta|nàng ta|gã ta)(?![\p{L}])/giu)];
        if (found.length >= 3) hits.push({ index: paragraph.index + found[2].index, match: found[2][0] });
    }
    return hits;
}

function headings(text) {
    return [...text.matchAll(/^#{1,6}\s.+$/gm)].map(m => ({ index: m.index, match: m[0] }));
}

export const GROUPS = {
    rp: 'Roleplay tells',
    staging: 'Staging instead of stating',
    rhythm: 'Rhythm by rule',
    inflation: 'Inflation',
    fiction: 'Fiction tells',
    vi: 'Vietnamese: translationese',
    fr: 'French: translationese',
    residue: 'Chatbot residue',
};

export const PATTERNS = [
    // --- Roleplay ---------------------------------------------------------------------------
    {
        id: 'rp.simile', group: 'rp', name: 'Similes and "as if" guesses', scope: 'all',
        rule: 'Remove similes and comparisons in any form ("like", "as if" guesses, "the way you\'d...", stock images). State what happens instead. If the sentence works without the comparison, cut the comparison.',
        watch: {
            en: ['as if', 'as though', "the way you'd", 'the way one', 'like a', 'like an', 'like the'],
            vi: ['như thể', 'cứ như', 'tựa như', 'tựa hồ', 'giống như một', 'giống như là', 'như một', 'như muốn', 'chẳng khác nào', 'y như'],
            fr: ['comme si', 'tel un', 'telle une', 'comme un', 'comme une', 'pareil à', 'semblable à'],
        },
    },
    {
        id: 'rp.notx', group: 'rp', name: '"Not X, just Z"', scope: 'all',
        rule: 'Rewrite "Not X (not Y), just Z" and "It wasn\'t X. It was Y." contrasts: state Z directly. Example: "Không phải hành lý đi chơi cuối tuần. Không phải hai tuần luôn." -> "Hành lý của người dọn hẳn sang ở."',
        watch: {
            en: ['not ... just', "it's not ... it's", "it wasn't ... it was", 'not because ... but because', 'not ... but ...', 'no, not ...'],
            vi: ['không phải ... mà là', 'không phải ... chỉ là', 'không phải ... không phải', 'chẳng phải ... mà là', 'không chỉ ... mà còn'],
            fr: ["ce n'est pas ... c'est", "ce n'était pas ... c'était", 'non pas ... mais', 'pas ... juste'],
        },
        detect: (text, lang) => lang === 'vi'
            ? [...text.matchAll(/(?<![\p{L}])Không phải[^.!?…\n]{1,60}[.!?…]\s+Không phải/gu)].map(m => ({ index: m.index, match: m[0] }))
            : [],
    },
    {
        id: 'rp.counting', group: 'rp', name: 'Counting for drama', scope: 'narration',
        rule: 'Drop dramatic counting ("one word", "three seconds", "ten years", "the tenth floor") unless the number matters to the plot. "He stood still for three seconds." -> show what he does in that pause, or cut it.',
        watch: {
            en: ['one word', 'a single word', 'one second', 'three seconds', 'one heartbeat', 'one breath', 'for a full'],
            vi: ['ba giây', 'hai giây', 'một giây', 'năm giây', 'một nhịp', 'một chữ', 'chỉ một từ',
                /(?<![\p{L}])(đúng|chỉ|tròn|suốt) (một|hai|ba|bốn|năm|mười)[\p{L} ]{0,12}?(giây|phút|tiếng|ngón tay|nhịp|chữ|từ|lần)(?![\p{L}])/giu],
            fr: ['un seul mot', 'une seconde', 'trois secondes', 'un battement'],
        },
    },
    {
        id: 'rp.landing', group: 'rp', name: 'Words that "land" inside someone', scope: 'narration',
        rule: 'Cut words or looks that "land", "hit" or "find" an unguarded place inside someone, and "filing away" a detail. Show the effect later through action.',
        watch: {
            en: ['lands somewhere', 'landed somewhere', 'hit somewhere', 'found its mark', 'filed away', 'files away', 'filed it away', 'struck a chord'],
            vi: ['chạm vào nơi', 'chạm đến nơi', 'đánh trúng', 'găm vào', 'cất vào một góc', 'ghi nhớ lại', 'cất giữ chi tiết'],
            fr: ['toucha un endroit', 'fit mouche', 'rangea ce détail', 'nota mentalement'],
        },
    },
    {
        id: 'rp.duration', group: 'rp', name: 'Measured-duration signals', scope: 'narration',
        rule: 'Remove measured-duration signals ("a beat too long", "longer than necessary"). If the pause matters, show what fills it.',
        watch: {
            en: ['a beat too long', 'a second too long', 'a moment too long', 'longer than necessary', 'a beat longer', 'one beat'],
            vi: ['lâu hơn cần thiết', 'lâu hơn bình thường', 'lâu hơn một nhịp', 'quá lâu một chút', 'thêm một nhịp'],
            fr: ['un peu trop longtemps', 'plus longtemps que nécessaire', 'une seconde de trop', 'un battement de trop'],
        },
    },
    {
        id: 'rp.voice', group: 'rp', name: 'Voice texture', scope: 'narration',
        rule: 'Remove voice-texture clichés (husky, hoarse, raspy, cracking, "khàn đặc", "vỡ ở âm cuối"). If delivery matters use plain words: fast, slow, loud, quiet, urgent, flat.',
        watch: {
            en: ['husky', 'hoarse', 'raspy', 'gravelly', 'voice cracked', 'voice cracking', 'voice dripping', 'barely above a whisper', 'low and rough'],
            vi: ['khàn đặc', 'khàn khàn', 'giọng khàn', 'khàn giọng', 'trầm thấp', 'trầm khàn', 'vỡ ở âm cuối', 'giọng vỡ', 'giọng lạc đi', 'gần như thì thầm', 'nhỏ như tiếng thì thầm'],
            fr: ['voix rauque', 'voix éraillée', 'voix brisée', 'à peine audible', 'murmure rauque', 'voix grave et'],
        },
    },
    {
        id: 'rp.reassure', group: 'rp', name: 'Stock reassurance', scope: 'dialogue',
        rule: 'Replace stock reassurance ("I\'m here", "I\'ve got you", "You\'re safe now", "Breathe", "Anh ở đây", "Có anh đây rồi", "Không sao rồi") with comfort in this character\'s own voice, or none.',
        watch: {
            en: ["i'm here", "i've got you", "you're safe now", "you're safe", 'just breathe', 'breathe', "i'm not going anywhere", "it's okay, i"],
            vi: [/(?<![\p{L}])(anh|em|chị|tôi) ở đây( rồi| mà| với em| với anh)?(?=\s*[.!,…”"])/giu, 'có anh đây', 'có em đây', 'không sao rồi', 'thở đi', 'hít thở', 'an toàn rồi', 'anh không đi đâu cả', 'anh sẽ không đi đâu'],
            fr: ['je suis là', 'je te tiens', 'tu es en sécurité', 'respire', 'ça va aller', 'je ne vais nulle part'],
        },
    },
    {
        id: 'rp.aftercare', group: 'rp', name: 'Blanket and cleanup reflex', scope: 'narration',
        rule: 'Do not end scenes on reflex blanket tucking, towel fetching, wiping, tidying, or falling asleep right after sex. Keep practical care only when it fits this character and moment, and sleep only from real exhaustion or a late hour.',
        watch: {
            en: ['pulled the blanket', 'pulled the covers', 'tucked ... in', 'fetched a towel', 'wiped ... clean', 'drifted off to sleep', 'drifted off', 'fell asleep in his arms', 'fell asleep in her arms'],
            vi: ['kéo chăn', 'đắp chăn', 'chăn lên', 'lau người', 'lấy khăn lau', 'dọn dẹp giường', 'chìm vào giấc ngủ', 'thiếp đi', 'ngủ thiếp đi', 'ôm ... vào lòng ngủ'],
            fr: ['remonta la couverture', 'borda', 'une serviette chaude', "s'endormit dans ses bras", 'sombra dans le sommeil'],
        },
    },
    {
        id: 'rp.hover', group: 'rp', name: 'Hovering hands', scope: 'narration',
        rule: 'No hovering hands. If a character touches, the touch happens; if not, the hand does something else.',
        watch: {
            en: ['hovered', 'hovering', 'hand paused in the air', 'hand stilled', 'fingers hovered', 'thumb hovered', 'thumb paused'],
            vi: ['lơ lửng', 'dừng lại giữa không trung', 'khựng lại giữa chừng', 'bàn tay dừng', 'tay dừng lại', 'ngón ... dừng trên', 'ngón ... khựng'],
            fr: ['suspendue', "resta en l'air", 'hésita au-dessus'],
        },
    },
    {
        id: 'rp.flashback', group: 'rp', name: 'Explanatory flashback', scope: 'narration',
        rule: 'Cut flashbacks that interpret the present ("He\'d seen that flinch before..."). Keep a memory only if it changes the action now, in one sentence.',
        watch: {
            en: ["he'd seen that", "she'd seen that", 'had seen that look', 'reminded him of', 'reminded her of', 'years ago'],
            vi: ['đã từng thấy', 'gợi nhớ', 'khiến anh nhớ', 'khiến cô nhớ', 'năm xưa'],
            fr: ['avait déjà vu', 'lui rappelait', 'des années plus tôt'],
        },
    },
    {
        id: 'rp.summary', group: 'rp', name: 'Summarizing ending', scope: 'narration',
        rule: 'Do not end by pulling back to sky or time or by declaring significance ("For the first time in twenty years...", "Lần đầu tiên sau bao năm..."). End mid-scene on an action or a line.',
        watch: {
            en: ['for the first time in', 'for the first time since', 'and in that moment', 'somehow, it was enough', 'outside, the', 'the night stretched'],
            vi: ['lần đầu tiên sau', 'lần đầu tiên trong', 'khoảnh khắc ấy', 'vào khoảnh khắc đó', 'từ giây phút đó', 'ngoài kia, ', 'màn đêm buông', 'bầu trời ngoài'],
            fr: ['pour la première fois depuis', 'à cet instant', 'dehors, la', 'la nuit tombait'],
        },
    },
    {
        id: 'rp.pronoun', group: 'rp', name: 'Romanticized pronouns', scope: 'narration',
        rule: 'Treat "anh/em" and other pronouns as ordinary address, never as a romantic or poetic moment. Do not comment on how a character says "em".',
        watch: {
            vi: [/(?<![\p{L}])(tiếng|chữ|từ|cách gọi|gọi)\s*[“"](anh|em|cưng)[”"]/giu],
        },
    },
    {
        id: 'rp.stress', group: 'rp', name: 'Stock stress tics', scope: 'narration',
        rule: 'Replace stock stress tics (white knuckles, clenched or ticking jaw, nails in palms, swallowing hard, Adam\'s apple bobbing, veins standing out, held breath, unblinking stare, cracking joints) with what this character specifically does or says.',
        watch: {
            en: ['white knuckles', 'knuckles whitened', 'knuckles white', 'jaw clenched', 'clenched jaw', 'jaw ticked', 'jaw tightened', 'swallowed hard', 'nails dug', "breath he didn't know", "breath she didn't know", 'breath hitched', 'heart hammered', 'heart pounded', 'eyes widened', 'adam\'s apple bobbed', 'without blinking'],
            vi: ['trắng bệch', 'nghiến chặt', 'quai hàm', 'nghiến răng', 'nuốt khan', 'nuốt nước bọt', 'móng tay bấm', 'bấm vào lòng bàn tay', 'nín thở', 'tim đập thình thịch', 'tim đập mạnh', 'khớp xương kêu', 'răng rắc', 'mắt mở to', 'yết hầu', 'gân xanh', 'không chớp'],
            fr: ['jointures blanchirent', 'mâchoire serrée', 'serra la mâchoire', 'déglutit', 'ongles enfoncés', 'retint son souffle', 'cœur battait', 'yeux écarquillés', 'pomme d\'Adam', 'sans ciller'],
        },
    },
    {
        id: 'rp.typed', group: 'rp', name: 'Typed, then deleted', scope: 'all',
        rule: 'Drop the "typed a message, deleted it, put the phone down" beat. Have the character send something, or do something else with their hands.',
        watch: {
            en: [/\btyped\b[^.!?\n]{0,80}?\b(deleted|erased)\b/gi, 'started to type'],
            vi: [/(?<![\p{L}])(gõ|soạn|nhắn)[^.!?…\n]{0,80}?(xóa|xoá)(?![\p{L}])/giu],
            fr: ['tapa ... effaça', 'écrivit ... effaça', 'commença à taper'],
        },
    },
    {
        id: 'rp.template', group: 'rp', name: 'Template rhythm', scope: 'all',
        rule: 'At most one one-line paragraph, one one-word sentence or one triplet ("Không... Không... Chỉ...", "Là... Là... Là...") per reply. No echo openings that repeat the end of the previous sentence ("Và cái giường. Cái giường anh..."). Merge the rest into the surrounding narration. Rhythm follows the scene: action short and hot, daily life ambles, dread stretches.',
        detect: (text) => [...shortParagraphs(text), ...repeatedOpenings(text), ...fragmentRuns(text), ...echoes(text)],
    },
    {
        id: 'rp.opening', group: 'rp', name: 'Same opening as the previous reply', scope: 'all',
        rule: 'Do not open the same way as the previous reply (same sentence shape, a weather line, a sound cue, "The [noun]..."). Enter mid-action, mid-line, on a physical detail, or with another character.',
    },

    // --- Staging (blader A) -------------------------------------------------------------------
    {
        id: 'st.saying', group: 'staging', name: 'Sayings that sound deep', scope: 'narration',
        rule: 'Cut narrator aphorisms and theme summaries ("At its core, this was never about the money."). Let the scene speak.',
        watch: {
            en: ['at its core', 'that was the thing about', 'some things', 'in the end, it', 'was never about'],
            vi: ['suy cho cùng', 'rốt cuộc thì', 'có những thứ', 'chưa bao giờ là về', 'đó mới là điều'],
            fr: ['au fond', 'après tout', 'il y a des choses', "n'avait jamais été question"],
        },
    },
    {
        id: 'st.runup', group: 'staging', name: 'Staged run-up', scope: 'narration',
        rule: 'Remove announcements before the point ("Here\'s the thing", "The truth was"). Enter the beat directly.',
        watch: {
            en: ["here's the thing", 'the truth was', 'the truth is', 'and then it happened'],
            vi: ['sự thật là', 'điều đáng nói là', 'vấn đề là'],
            fr: ["la vérité, c'est", "le truc, c'est", 'et puis, ce fut'],
        },
    },
    {
        id: 'st.shadowbox', group: 'staging', name: 'Arguing with no one', scope: 'narration',
        rule: 'Remove rebuttals of things nobody in the story thinks ("She wasn\'t naive — don\'t mistake her patience for weakness."). Show the trait instead.',
        watch: {
            en: ["don't mistake", 'make no mistake', "that didn't mean"],
            vi: ['đừng nhầm', 'không có nghĩa là', 'đừng hiểu lầm'],
            fr: ['ne vous y trompez pas', 'ne pas confondre'],
        },
    },

    // --- Rhythm (blader B) --------------------------------------------------------------------
    {
        id: 'rh.hedge', group: 'rhythm', name: 'Qualifiers and emotion blends', scope: 'narration',
        rule: 'Cut stacked qualifiers and emotion blends ("a hint of", "a mix of X and Y", "một tia ... lóe lên", "pha lẫn"). Commit to what the POV character perceives.',
        watch: {
            en: ['a hint of', 'a mix of', 'a mixture of', 'a flicker of', 'something like', 'seemed to almost'],
            vi: ['một tia', 'ánh lên một', 'pha lẫn', 'xen lẫn', 'hòa lẫn', 'mang theo một chút', 'một chút gì đó', 'có chút gì đó'],
            fr: ['une pointe de', 'une lueur de', 'un mélange de', 'un soupçon de', 'sembla presque'],
        },
    },
    {
        id: 'rh.dash', group: 'rhythm', name: 'Dashes everywhere', scope: 'narration',
        rule: 'Use at most two mid-sentence dashes per reply; replace the rest with commas, periods or restructured sentences. Dashes for interrupted speech and line-opening dialogue dashes stay.',
        detect: (text) => dashes(text),
    },

    // --- Inflation (blader C) -----------------------------------------------------------------
    {
        id: 'in.words', group: 'inflation', name: 'Overused AI words', scope: 'narration',
        rule: 'Replace overused AI words (testament, tapestry, delve, intricate, palpable, unwavering, "đầy ẩn ý", "sâu thẳm") with plain ones or cut them.',
        watch: {
            en: ['testament', 'tapestry', 'delve', 'intricate', 'vibrant', 'palpable', 'unwavering', 'myriad', 'realm', 'ministrations', 'padded'],
            vi: ['không thể phủ nhận', 'đầy ẩn ý', 'sâu thẳm', 'thăm thẳm', 'vô tận', 'mãnh liệt', 'nồng nàn'],
            fr: ['témoignage', 'tapisserie', 'palpable', 'indéfectible', 'myriade'],
        },
    },
    {
        id: 'in.fate', group: 'inflation', name: 'Fate-weighting', scope: 'narration',
        rule: 'Report actions plainly instead of weighting them with fate ("a decision that would change everything"). Let events earn their weight.',
        watch: {
            en: ['would change everything', 'the beginning of the end', 'would never forget', 'forever changed', 'nothing would ever be the same'],
            vi: ['thay đổi tất cả', 'thay đổi mọi thứ', 'sẽ không bao giờ quên', 'định mệnh', 'mãi mãi thay đổi', 'mọi thứ sẽ không bao giờ'],
            fr: ['changerait tout', 'le début de la fin', "n'oublierait jamais", 'rien ne serait plus jamais'],
        },
    },
    {
        id: 'in.purple', group: 'inflation', name: 'Purple atmosphere', scope: 'narration',
        rule: 'Replace stock atmosphere ("the air was thick with", "time stood still", "lingering in the air") with one concrete detail.',
        watch: {
            en: ['thick with tension', 'the air was thick', 'hung heavy', 'time stood still', 'time seemed to stop', 'lingered in the air', 'hung in the air'],
            vi: ['đặc quánh', 'ngưng đọng', 'ngừng trôi', 'đọng lại trong không khí', 'bao trùm', 'lan tỏa'],
            fr: ["l'air était chargé", 'le temps sembla', "flottait dans l'air", 'suspendu dans le temps'],
        },
    },
    {
        id: 'in.ing', group: 'inflation', name: 'Chained -ing participles', scope: 'narration',
        rule: 'Split chains of -ing participles and emotion tags into sequential finite verbs.',
        watch: { en: [/, \p{L}+ing\b[^.!?\n]{0,40}, \p{L}+ing\b/giu] },
    },

    // --- Fiction (F1-F10) ---------------------------------------------------------------------
    {
        id: 'fic.emotion', group: 'fiction', name: 'Stock emotion formulas', scope: 'narration',
        rule: 'Replace emotion formulas ("a wave of X washed over", "a chill ran down her spine", "something inside him broke") with this character\'s specific action, perception or thought.',
        watch: {
            en: ['a wave of', 'washed over', 'a pang of', 'a chill ran', 'shiver down', 'sent shivers', 'something inside', 'something shifted', 'came crashing down'],
            vi: ['một luồng', 'chạy dọc sống lưng', 'ớn lạnh', 'dâng trào', 'len lỏi', 'thắt lại', 'tim như ngừng', 'như có gì đó'],
            fr: ['une vague de', 'un frisson parcourut', 'le long de ... échine', 'quelque chose se brisa', 'son cœur manqua'],
        },
    },
    {
        id: 'fic.foreshadow', group: 'fiction', name: 'Announced foreshadowing', scope: 'narration',
        rule: 'Cut narrator foreshadowing ("Little did she know"). If needed, plant a concrete detail in the scene.',
        watch: {
            en: ['little did', 'if only ... had known', 'the last time ... would ever', 'looking back,'],
            vi: ['không hề biết rằng', 'nào ngờ', 'đâu biết rằng', 'giá như'],
            fr: ['il ne savait pas encore', 'elle ne savait pas encore', 'si seulement'],
        },
    },
    {
        id: 'fic.filter', group: 'fiction', name: 'Filter words', scope: 'narration',
        rule: 'Drop filter verbs ("she noticed", "he realized", "couldn\'t help but", "không khỏi", "bất giác") and render the perception directly, unless the act of noticing is the point.',
        watch: {
            en: ["couldn't help but", 'found herself', 'found himself', 'she realized', 'he realized', 'she noticed', 'he noticed'],
            vi: ['không khỏi', 'không thể không', 'không kìm được', 'chợt nhận ra', 'bất giác', 'nhận ra rằng'],
            fr: ["ne put s'empêcher", "ne pouvait s'empêcher", 'se rendit compte', 'se surprit à'],
        },
    },
    {
        id: 'fic.kindof', group: 'fiction', name: '"The kind of X that Y"', scope: 'narration',
        rule: 'Replace "the kind of X that Y" and "a smile that didn\'t reach his eyes" with the specific detail of this person or place.',
        watch: {
            en: ['the kind of', 'the sort of', 'one of those', "didn't reach ... eyes", 'in a way that only'],
            vi: ['cái kiểu', 'thuộc kiểu', 'loại người', 'không chạm tới', 'không chạm đến đáy mắt'],
            fr: ['le genre de', 'ce genre de', 'un de ces', "n'atteignait pas ... yeux"],
        },
    },
    {
        id: 'fic.unnameable', group: 'fiction', name: 'The unnameable feeling', scope: 'narration',
        rule: 'Replace "a feeling she couldn\'t name" and "something unspoken" with the specific sensation, or let action and silence carry it.',
        watch: {
            en: ["couldn't name", "couldn't quite name", 'without a name', 'something unspoken', 'left unsaid', "couldn't put into words"],
            vi: ['không thể gọi tên', 'không gọi được tên', 'khó gọi tên', 'không thành lời', 'điều gì đó', 'thứ gì đó'],
            fr: ['sans nom', 'impossible à nommer', 'savait nommer', 'non-dit'],
        },
    },
    {
        id: 'fic.expression', group: 'fiction', name: 'Stock expressions', scope: 'narration',
        rule: 'Replace stock smirks, glints, lip curls, blushes and lip biting ("nụ cười nửa miệng", "khóe môi cong lên", "đỏ tới mang tai", "mím môi") with an expression or gesture specific to this character.',
        watch: {
            en: ['smirk', 'mischievous glint', 'glint in ... eyes', 'eyes sparkled', 'ghost of a smile', 'corner of ... lips', 'lips curled', 'blushed', 'cheeks flushed', 'turned crimson', 'bit her lip', 'bit his lip'],
            vi: ['nụ cười nửa miệng', 'khóe môi cong', 'khóe môi nhếch', 'nhếch mép', 'nhếch môi', 'cong môi', 'ánh mắt tinh nghịch', 'lóe lên', 'ý cười', 'đỏ bừng', 'đỏ ... mang tai', 'đỏ ửng', 'mím môi', 'cắn môi'],
            fr: ['sourire en coin', 'lueur malicieuse', 'fantôme de sourire', 'coin des lèvres', 'esquissa un sourire', 'rougit', 'se mordit la lèvre'],
        },
    },

    // --- Vietnamese translationese ------------------------------------------------------------
    {
        id: 'vi.motcach', group: 'vi', name: '"một cách" + adjective', scope: 'all',
        rule: 'Drop "một cách" before adjectives ("nói một cách nhẹ nhàng" -> "nói nhẹ nhàng").',
        watch: { vi: [/(?<![\p{L}])một cách \p{L}+/giu] },
    },
    {
        id: 'vi.su', group: 'vi', name: 'Nominalizing "sự / việc"', scope: 'all',
        rule: 'Use a verb instead of nominalizing with "sự" or "việc" ("việc anh đến khiến cô vui" -> "anh đến, cô vui hẳn").',
        watch: { vi: ['sự ... của', 'việc ... khiến', 'việc ... làm cho'] },
    },
    {
        id: 'vi.passive', group: 'vi', name: 'Passive "được/bị ... bởi"', scope: 'all',
        rule: 'Turn "được/bị ... bởi" passives into active sentences.',
        watch: { vi: ['được ... bởi', 'bị ... bởi'] },
    },
    {
        id: 'vi.cua', group: 'vi', name: 'Redundant "của"', scope: 'all',
        rule: 'Drop redundant "của" with body parts and close possessions ("tay của anh ấy" -> "tay anh").',
        watch: { vi: [/(?<![\p{L}])(tay|mắt|môi|giọng|tóc|má|cổ|vai|ánh mắt|gương mặt|khuôn mặt|đôi mắt|bàn tay) của (anh ấy|cô ấy|hắn ta|anh|cô|hắn|nàng|gã)(?![\p{L}])/giu] },
    },
    {
        id: 'vi.pronoun', group: 'vi', name: 'Repeated "anh ấy / cô ấy"', scope: 'narration',
        rule: 'Do not repeat "anh ấy / cô ấy / hắn ta" every sentence; omit the subject or use the name or a fitting pronoun.',
        detect: (text, lang) => lang === 'vi' ? pronounRepeat(text) : [],
    },
    {
        id: 'vi.connector', group: 'vi', name: 'Essay connectors', scope: 'narration',
        rule: 'Replace essay connectors in narration (Tuy nhiên, Hơn nữa, Ngoài ra, Bên cạnh đó, Do đó) with "Nhưng", "Còn", or nothing.',
        watch: { vi: ['Tuy nhiên', 'Hơn nữa', 'Ngoài ra', 'Bên cạnh đó', 'Thêm vào đó', 'Do đó', 'Vì vậy'] },
    },
    {
        id: 'vi.intensifier', group: 'vi', name: 'Filler intensifiers', scope: 'narration',
        rule: 'Cut filler intensifiers (thật sự, hoàn toàn, vô cùng, cực kỳ) unless the character would stress it.',
        watch: { vi: ['thật sự', 'hoàn toàn', 'vô cùng', 'cực kỳ'] },
    },

    // --- French translationese ----------------------------------------------------------------
    {
        id: 'fr.connector', group: 'fr', name: 'Formal connectors', scope: 'narration',
        rule: 'Replace formal connectors in narration (néanmoins, de surcroît, par ailleurs, toutefois, en effet) with plain ones or nothing.',
        watch: { fr: ['néanmoins', 'de surcroît', 'par ailleurs', 'toutefois', 'en effet', 'force est de constater', 'il est important de noter'] },
    },

    // --- Chatbot residue (blader E) -----------------------------------------------------------
    {
        id: 'res.chatbot', group: 'residue', name: 'Chatbot residue', scope: 'narration',
        rule: 'Delete assistant chatter, notes to the user and offers to continue. The reply must read as story, not as an answer.',
        watch: {
            en: ['i hope you enjoy', 'let me know if', 'feel free to', 'as an ai', 'here is the next', 'shall i continue'],
            vi: ['hy vọng bạn', 'cho mình biết', 'bạn có muốn mình', 'dưới đây là', 'mình sẽ tiếp tục'],
            fr: ["j'espère que", "n'hésitez pas", 'voici la suite', 'voulez-vous que je'],
        },
        detect: (text) => headings(text),
    },
];

export const PATTERN_BY_ID = Object.fromEntries(PATTERNS.map(pattern => [pattern.id, pattern]));
