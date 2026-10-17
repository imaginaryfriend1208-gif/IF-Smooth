// Word-level diff between the original and the humanized text (pure, no ST imports).

const WORDS = /[\p{L}\p{M}\p{N}_]+(?:['’-][\p{L}\p{M}\p{N}_]+)*|\s+|[^\s]/gu;
const SENTENCES = /[^.!?…\n]+[.!?…]*["”»)]*[ \t]*|\n+/gu;
// Above this many table cells, diff whole sentences instead of words.
const MAX_CELLS = 2_500_000;

const units = (text, pattern) => [...text.matchAll(pattern)].map(match => ({ value: match[0], index: match.index }));

/** Longest-common-subsequence edit script: ['=' | '-' | '+', i, j] per step. */
function lcs(a, b) {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * width + j] = a[i].value === b[j].value
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i].value === b[j].value) ops.push(['=', i++, j++]);
        else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push(['-', i++, j]);
        else ops.push(['+', i, j++]);
    }
    while (i < a.length) ops.push(['-', i++, j]);
    while (j < b.length) ops.push(['+', i, j++]);
    return ops;
}

function script(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start].value === b[start].value) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end].value === b[b.length - 1 - end].value) end++;
    const ops = [];
    for (let k = 0; k < start; k++) ops.push(['=', k, k]);
    for (const [type, i, j] of lcs(a.slice(start, a.length - end), b.slice(start, b.length - end))) ops.push([type, i + start, j + start]);
    for (let k = end; k > 0; k--) ops.push(['=', a.length - k, b.length - k]);
    return ops;
}

/**
 * Changed spans between `before` and `after`, in character offsets of each text.
 * Changes separated by two units or fewer are merged; whitespace-only changes are dropped.
 * @returns {{ start: number, end: number, afterStart: number, afterEnd: number, removed: string, added: string }[]}
 */
export function changes(before, after) {
    const a0 = String(before || '');
    const b0 = String(after || '');
    let a = units(a0, WORDS);
    let b = units(b0, WORDS);
    if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
        a = units(a0, SENTENCES);
        b = units(b0, SENTENCES);
    }
    const ops = script(a, b);
    const position = (list, text, k) => k < list.length ? list[k].index : text.length;
    const spans = [];
    let current = null;
    let gap = 0;
    for (const [type, i, j] of ops) {
        if (type === '=') {
            if (current) gap++;
            continue;
        }
        if (current && gap <= 2) {
            current.aEnd = type === '-' ? i + 1 : Math.max(current.aEnd, i);
            current.bEnd = type === '+' ? j + 1 : Math.max(current.bEnd, j);
        } else {
            current = { aStart: i, aEnd: type === '-' ? i + 1 : i, bStart: j, bEnd: type === '+' ? j + 1 : j };
            spans.push(current);
        }
        gap = 0;
    }
    return spans.map(span => {
        const start = position(a, a0, span.aStart);
        const end = position(a, a0, span.aEnd);
        const afterStart = position(b, b0, span.bStart);
        const afterEnd = position(b, b0, span.bEnd);
        return { start, end, afterStart, afterEnd, removed: a0.slice(start, end), added: b0.slice(afterStart, afterEnd) };
    }).filter(change => change.removed.trim() || change.added.trim());
}

/** Text around [start, end) on the same line, at most `size` characters each side. */
export function around(text, start, end, size = 40) {
    let left = Math.max(0, start - size);
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (lineStart > left) left = lineStart;
    let right = Math.min(text.length, end + size);
    const lineEnd = text.indexOf('\n', end);
    if (lineEnd >= 0 && lineEnd < right) right = lineEnd;
    return {
        before: (left > 0 && left !== lineStart ? '…' : '') + text.slice(left, start),
        middle: text.slice(start, end),
        after: text.slice(end, right) + (right < text.length && right !== lineEnd ? '…' : ''),
    };
}

/** True when a scan hit overlaps the removed span of a change (or sits at an insertion point). */
export function touches(hit, change) {
    const hitEnd = hit.index + hit.match.length;
    if (change.start === change.end) return hit.index <= change.start && change.start <= hitEnd;
    return hit.index < change.end && hitEnd > change.start;
}
