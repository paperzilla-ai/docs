import { sha256 } from './content-structure.mjs';

const frontmatterKeys = new Set(['title', 'sidebarTitle', 'name', 'description', 'keywords']);
const jsxAttributes = new Set(['alt', 'caption', 'description', 'label', 'placeholder', 'summary', 'title']);
const brands = [
    'Paperzilla', 'arXiv', 'bioRxiv', 'medRxiv', 'ChemRxiv', 'ChinaXiv',
    'PubMed', 'Google Scholar', 'Hugging Face', 'OpenClaw', 'Codex', 'Claude',
    'Microsoft Teams', 'Telegram', 'Slack', 'GitHub', 'MCP', 'RSS', 'Atom',
    'CLI', 'API', 'Intercom', 'Feedly', 'Miniflux', 'Reeder', 'JSON',
];

function frontmatterBoundary(text) {
    if (!text.startsWith('---\n')) {
        return 0;
    }
    const end = text.indexOf('\n---', 4);
    if (end < 0) {
        throw new Error('Unclosed frontmatter.');
    }
    return end + 4;
}

function frontmatterSpans(text, bodyStart) {
    if (!bodyStart) {
        return [];
    }
    const spans = [];
    const frontmatter = text.slice(4, bodyStart - 4);
    for (const match of frontmatter.matchAll(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/gm)) {
        const key = match[1];
        if (!frontmatterKeys.has(key)) {
            continue;
        }
        const rawValue = match[2];
        const leading = rawValue.length - rawValue.trimStart().length;
        let start = 4 + match.index + match[0].length - rawValue.length + leading;
        let end = 4 + match.index + match[0].length;
        const raw = text.slice(start, end);
        if (raw.length >= 2 && raw[0] === raw.at(-1) && ['"', "'"].includes(raw[0])) {
            start += 1;
            end -= 1;
        }
        if (start === end) {
            throw new Error(`Empty translatable frontmatter ${key}.`);
        }
        spans.push({ kind: `frontmatter-${key}`, start, end });
    }
    return spans;
}

function subtractRanges(start, end, ranges) {
    const output = [];
    let cursor = start;
    for (const [blockedStart, blockedEnd] of ranges) {
        if (blockedEnd <= cursor || blockedStart >= end) {
            continue;
        }
        if (blockedStart > cursor) {
            output.push([cursor, Math.min(blockedStart, end)]);
        }
        cursor = Math.max(cursor, blockedEnd);
        if (cursor >= end) {
            break;
        }
    }
    if (cursor < end) {
        output.push([cursor, end]);
    }
    return output;
}

function bodySpans(text, bodyStart) {
    let bodyOffset = bodyStart;
    while (bodyOffset < text.length && text[bodyOffset] === '\n') {
        bodyOffset += 1;
    }
    const body = text.slice(bodyOffset);
    const blocked = [];
    const attributes = [];
    const blockers = [
        /^```.*?^```[ \t]*$|^~~~.*?^~~~[ \t]*$/gms,
        /^\s*(?:import|export)\b.*$/gm,
        /`[^`\n]+`/g,
        /\{[^{}]*\}/g,
        /<\/?[A-Za-z][^>]*>/g,
    ];
    for (const pattern of blockers) {
        for (const match of body.matchAll(pattern)) {
            const start = bodyOffset + match.index;
            const end = start + match[0].length;
            blocked.push([start, end]);
            if (pattern === blockers.at(-1) && !match[0].startsWith('</')) {
                for (const attribute of match[0].matchAll(/\b([A-Za-z][\w-]*)\s*=\s*(["'])(.*?)\2/gs)) {
                    if (!jsxAttributes.has(attribute[1])) {
                        continue;
                    }
                    const valueOffset = attribute.index + attribute[0].indexOf(attribute[3]);
                    const valueStart = start + valueOffset;
                    const valueEnd = valueStart + attribute[3].length;
                    if (valueStart === valueEnd) {
                        throw new Error(`Empty translatable JSX attribute ${attribute[1]}.`);
                    }
                    attributes.push({ kind: `jsx-${attribute[1]}`, start: valueStart, end: valueEnd });
                }
            }
        }
    }
    blocked.sort((left, right) => left[0] - right[0]);
    const spans = [...attributes];
    for (const paragraph of body.matchAll(/(?:^|\n{2,})(.*?)(?=\n{2,}|$)/gs)) {
        const prefixLength = paragraph[0].length - paragraph[1].length;
        const start = bodyOffset + paragraph.index + prefixLength;
        const end = start + paragraph[1].length;
        for (let [visibleStart, visibleEnd] of subtractRanges(start, end, blocked)) {
            while (visibleStart < visibleEnd && /\s/u.test(text[visibleStart])) {
                visibleStart += 1;
            }
            while (visibleEnd > visibleStart && /\s/u.test(text[visibleEnd - 1])) {
                visibleEnd -= 1;
            }
            if (visibleStart < visibleEnd) {
                spans.push({ kind: 'body', start: visibleStart, end: visibleEnd });
            }
        }
    }
    return spans.sort((left, right) => left.start - right.start);
}

export function protectedTokens(value) {
    const tokens = [];
    for (const line of value.split('\n')) {
        const marker = line.match(/^(\s*)(#{1,6}\s+|-!\s+|[-*+]\s+|\d+[.)]\s+|>\s*|---\s*$)/);
        if (marker) {
            tokens.push(marker[1] + marker[2]);
        }
        const directive = line.match(/^\s*(?:::[:\w-]*|!!!\s+\w+)/);
        if (directive) {
            tokens.push(directive[0]);
        }
        const stripped = line.trim();
        const pipeCount = [...stripped].filter((character) => character === '|').length;
        if (pipeCount >= 2 || (pipeCount > 0 && stripped.startsWith('|') && stripped.endsWith('|'))) {
            tokens.push(`TABLE:${pipeCount}:${Number(stripped.startsWith('|'))}:${Number(stripped.endsWith('|'))}`);
        }
    }
    const pattern = /```.*?```|~~~.*?~~~|`[^`\n]+`|\{[%{].*?[}%]\}|<\/?[A-Za-z][^>]*>|!?(?:\[[^\]]*\])\(([^)]+)\)|https?:\/\/[^\s)>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gs;
    for (const match of value.matchAll(pattern)) {
        tokens.push(match[1] ?? match[0]);
    }
    for (const match of value.matchAll(/\*\*|__|(?<!\*)\*(?!\*)|(?<!_)_(?!_)/g)) {
        tokens.push(match[0]);
    }
    for (const brand of brands) {
        const count = value.split(brand).length - 1;
        tokens.push(...Array(count).fill(brand));
    }
    return tokens;
}

export function extractSegments(text) {
    const bodyStart = frontmatterBoundary(text);
    const spans = [...frontmatterSpans(text, bodyStart), ...bodySpans(text, bodyStart)];
    const occurrences = new Map();
    return spans.map((span) => {
        const source = text.slice(span.start, span.end);
        const sourceSha256 = sha256(source);
        const key = `${span.kind}:${sourceSha256}`;
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        const tokens = protectedTokens(source);
        return {
            kind: span.kind,
            protectedStructureSha256: sha256(tokens.join('\n')),
            stableId: `${span.kind}:${sourceSha256.slice(0, 20)}:${occurrence}`,
            text: source,
        };
    });
}

export function documentProtectedStructureSha256(segments) {
    return sha256(segments.map((segment) => segment.protectedStructureSha256).join('\n'));
}
