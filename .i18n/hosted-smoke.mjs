#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nonPromotableMarkerName } from './artifact-guard.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);

function normalizeUrl(value) {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
}

function absoluteUrl(baseUrl, route) {
    const directoryBase = `${baseUrl.replace(/\/+$/, '')}/`;
    return normalizeUrl(new URL(route.replace(/^\/+/, ''), directoryBase).href);
}

function decodeHtml(value) {
    return value
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>');
}

function attributes(tag) {
    const output = {};
    for (const match of tag.matchAll(/([^\s=<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        output[match[1].toLocaleLowerCase('en-US')] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
    }
    return output;
}

export function pageMetadata(html) {
    const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
    const htmlAttributes = attributes(htmlTag);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]));
    const canonical = links.find((entry) => entry.rel?.toLocaleLowerCase('en-US') === 'canonical')?.href ?? null;
    const alternates = Object.fromEntries(links.filter((entry) => (
        entry.rel?.toLocaleLowerCase('en-US') === 'alternate' && entry.hreflang
    )).map((entry) => [entry.hreflang.toLocaleLowerCase('en-US'), entry.href]));
    return { lang: htmlAttributes.lang ?? null, canonical, alternates };
}

export function assertHostedSmokeLiveStage(registry) {
    const spanish = registry?.locales?.find((locale) => locale?.tag === 'es');
    if (spanish?.stage !== 'live' || spanish?.indexable !== true) {
        throw new Error('Hosted Spanish smoke is live-only; the local generated registry is not live/indexable.');
    }
}

async function responseText(response, label, { expectedStatus = null } = {}) {
    if (expectedStatus !== null ? response.status !== expectedStatus : !response.ok) {
        throw new Error(`${label} returned HTTP ${response.status}.`);
    }
    const text = await response.text();
    if (text.length > 12_000_000) {
        throw new Error(`${label} exceeded the 12 MB smoke-audit limit.`);
    }
    return text;
}

async function fetchText(fetchImpl, url, label, options = {}) {
    const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        ...options,
    });
    return {
        response,
        text: await responseText(response, label, options),
    };
}

function assertPageMetadata({ html, expectedLang, canonicalUrl, englishUrl, spanishUrl, label }) {
    const metadata = pageMetadata(html);
    if (metadata.lang !== expectedLang) {
        throw new Error(`${label} html lang must be ${expectedLang}; found ${metadata.lang ?? 'none'}.`);
    }
    if (!metadata.canonical || normalizeUrl(metadata.canonical) !== canonicalUrl) {
        throw new Error(`${label} canonical must be ${canonicalUrl}; found ${metadata.canonical ?? 'none'}.`);
    }
    const expectedAlternates = { en: englishUrl, es: spanishUrl, 'x-default': englishUrl };
    for (const [language, expected] of Object.entries(expectedAlternates)) {
        const actual = metadata.alternates[language];
        if (!actual || normalizeUrl(actual) !== expected) {
            throw new Error(`${label} hreflang ${language} must be ${expected}; found ${actual ?? 'none'}.`);
        }
    }
}

function parseMcpPayload(text, label) {
    if (text.trim() === '') {
        return null;
    }
    const dataLines = text.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== '' && line !== '[DONE]');
    const raw = dataLines.at(-1) ?? text;
    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`${label} returned invalid JSON/SSE: ${error.message}`);
    }
}

async function auditMcpSearch(fetchImpl, mcpUrl, query, expectedPath, expectedToken, timeoutMs) {
    let sessionId = null;
    let id = 1;
    async function request(method, params, { notification = false } = {}) {
        const body = {
            jsonrpc: '2.0',
            ...(notification ? {} : { id: id++ }),
            method,
            ...(params === undefined ? {} : { params }),
        };
        const response = await fetchImpl(mcpUrl, {
            method: 'POST',
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`MCP ${method} returned HTTP ${response.status}.`);
        }
        sessionId = response.headers.get('mcp-session-id') ?? sessionId;
        const payload = parseMcpPayload(await response.text(), `MCP ${method}`);
        if (payload?.error) {
            throw new Error(`MCP ${method} failed: ${JSON.stringify(payload.error)}`);
        }
        return payload;
    }

    await request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'paperzilla-docs-live-smoke', version: '1' },
    });
    await request('notifications/initialized', undefined, { notification: true });
    const listed = await request('tools/list', {});
    const tools = listed?.result?.tools;
    const search = Array.isArray(tools)
        ? tools.find((tool) => tool?.name?.toLocaleLowerCase('en-US').includes('search'))
        : null;
    if (!search) {
        throw new Error('Hosted MCP surface exposes no search tool.');
    }
    const properties = search.inputSchema?.properties ?? {};
    const queryKey = ['query', 'searchQuery', 'text'].find((key) => properties[key])
        ?? Object.entries(properties).find(([, schema]) => schema?.type === 'string')?.[0];
    if (!queryKey) {
        throw new Error(`MCP search tool ${search.name} has no string query input.`);
    }
    const result = await request('tools/call', {
        name: search.name,
        arguments: { [queryKey]: query },
    });
    const serialized = JSON.stringify(result?.result ?? {});
    if (!serialized.includes(expectedPath) || !serialized.includes(expectedToken)) {
        throw new Error('MCP search did not return the expected indexed Spanish page and token.');
    }
}

export async function auditHostedDocs({
    baseUrl,
    englishPath = '/',
    spanishPath = '/es',
    spanishToken = 'Portal de documentación de Paperzilla',
    searchQuery = 'Portal de documentación de Paperzilla',
    fetchImpl = globalThis.fetch,
    timeoutMs = 20_000,
}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('A Fetch-compatible implementation is required.');
    }
    const parsedBase = new URL(baseUrl);
    if (parsedBase.protocol !== 'https:' || parsedBase.username || parsedBase.password
        || parsedBase.search || parsedBase.hash) {
        throw new Error('Hosted docs base URL must be a credential-free HTTPS origin/path.');
    }
    const canonicalBase = normalizeUrl(parsedBase.href);
    const englishUrl = absoluteUrl(canonicalBase, englishPath);
    const spanishUrl = absoluteUrl(canonicalBase, spanishPath);

    const english = await fetchText(fetchImpl, englishUrl, 'English page', { timeoutMs });
    const spanish = await fetchText(fetchImpl, spanishUrl, 'Spanish page', { timeoutMs });
    assertPageMetadata({
        html: english.text,
        expectedLang: 'en',
        canonicalUrl: englishUrl,
        englishUrl,
        spanishUrl,
        label: 'English page',
    });
    assertPageMetadata({
        html: spanish.text,
        expectedLang: 'es',
        canonicalUrl: spanishUrl,
        englishUrl,
        spanishUrl,
        label: 'Spanish page',
    });
    if (!spanish.text.includes(spanishToken)) {
        throw new Error('Spanish page does not contain the expected reviewed token.');
    }

    const sitemapUrl = absoluteUrl(canonicalBase, '/sitemap.xml');
    const sitemap = await fetchText(fetchImpl, sitemapUrl, 'sitemap.xml', { timeoutMs });
    for (const expected of [englishUrl, spanishUrl]) {
        if (!sitemap.text.split(/<loc>|<\/loc>/).some((value) => {
            try {
                return normalizeUrl(decodeHtml(value.trim())) === expected;
            } catch {
                return false;
            }
        })) {
            throw new Error(`sitemap.xml is missing ${expected}.`);
        }
    }

    for (const route of ['/llms.txt', '/llms-full.txt']) {
        const surface = await fetchText(fetchImpl, absoluteUrl(canonicalBase, route), route, { timeoutMs });
        if (!surface.text.includes(spanishUrl) || !surface.text.includes(spanishToken)) {
            throw new Error(`${route} is missing the reviewed Spanish page or token.`);
        }
    }
    const skill = await fetchText(fetchImpl, absoluteUrl(canonicalBase, '/skill.md'), 'skill.md', { timeoutMs });
    if (skill.text.trim().length === 0) {
        throw new Error('skill.md is empty.');
    }

    const markdown = await fetchText(fetchImpl, spanishUrl, 'Spanish Markdown negotiation', {
        timeoutMs,
        headers: { accept: 'text/markdown' },
    });
    const contentType = markdown.response.headers.get('content-type') ?? '';
    if (!/(?:text\/markdown|text\/plain)/i.test(contentType) || !markdown.text.includes(spanishToken)) {
        throw new Error('Spanish AI content negotiation did not return reviewed Markdown/plain text.');
    }

    const markerResponse = await fetchImpl(
        absoluteUrl(canonicalBase, `/${nonPromotableMarkerName}`),
        { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) },
    );
    if (markerResponse.status !== 404) {
        throw new Error(`Hosted live docs expose the non-promotable marker with HTTP ${markerResponse.status}.`);
    }

    await auditMcpSearch(
        fetchImpl,
        absoluteUrl(canonicalBase, '/mcp'),
        searchQuery,
        new URL(spanishUrl).pathname,
        spanishToken,
        timeoutMs,
    );
    return {
        baseUrl: canonicalBase,
        englishUrl,
        spanishUrl,
        checks: ['canonical', 'hreflang', 'html-lang', 'sitemap', 'search', 'llms', 'ai-markdown', 'mcp'],
    };
}

function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const key = {
            '--base-url': 'baseUrl',
            '--english-path': 'englishPath',
            '--spanish-path': 'spanishPath',
            '--spanish-token': 'spanishToken',
            '--search-query': 'searchQuery',
            '--timeout-ms': 'timeoutMs',
        }[argument];
        if (!key) {
            throw new Error(`Unknown argument: ${argument}`);
        }
        options[key] = argv[++index];
    }
    if (!options.baseUrl) {
        throw new Error('Usage: hosted-smoke.mjs --base-url https://docs.example.com [options]');
    }
    if (options.timeoutMs !== undefined) {
        options.timeoutMs = Number(options.timeoutMs);
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
            throw new Error('--timeout-ms must be an integer of at least 1000.');
        }
    }
    return options;
}

async function main() {
    const rawRegistry = await readFile(path.join(internalDirectory, 'locales.generated.json'), 'utf8');
    const registry = JSON.parse(rawRegistry);
    assertHostedSmokeLiveStage(registry);
    const result = await auditHostedDocs(parseArguments(process.argv.slice(2)));
    console.log(`Hosted Spanish docs smoke passed: ${result.spanishUrl}`);
    console.log(`Checks: ${result.checks.join(', ')}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
    await main();
}
