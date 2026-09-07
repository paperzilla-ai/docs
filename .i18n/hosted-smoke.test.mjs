import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHostedSmokeLiveStage, auditHostedDocs, pageMetadata } from './hosted-smoke.mjs';

const baseUrl = 'https://docs.example.com';
const englishUrl = `${baseUrl}/`;
const spanishUrl = `${baseUrl}/es`;
const spanishToken = 'Portal de documentación de Paperzilla';

function page(lang, canonical, body = '') {
    return `<html lang="${lang}"><head>
<link href="${canonical}" rel="canonical">
<link hreflang="en" href="${englishUrl}" rel="alternate">
<link rel="alternate" href="${spanishUrl}" hreflang="es">
<link rel="alternate" hreflang="x-default" href="${englishUrl}">
</head><body>${body}</body></html>`;
}

function fakeFetch({ spanishLang = 'es', languageFilter = false, emptyLlms = false, missingAlternates = false } = {}) {
    let mcpSession = false;
    return async (input, options = {}) => {
        const url = new URL(input);
        const accept = new Headers(options.headers).get('accept') ?? '';
        if (url.pathname === '/mcp' && options.method === 'POST') {
            const request = JSON.parse(options.body);
            const headers = { 'content-type': 'application/json', 'mcp-session-id': 'test-session' };
            if (request.method === 'initialize') {
                mcpSession = true;
                return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }), { status: 200, headers });
            }
            assert(mcpSession);
            if (request.method === 'notifications/initialized') {
                return new Response('', { status: 202, headers });
            }
            if (request.method === 'tools/list') {
                return new Response(JSON.stringify({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: { tools: [{ name: 'search', inputSchema: { properties: {
                        query: { type: 'string' },
                        ...(languageFilter ? { language: { type: 'string' } } : {}),
                    } } }] },
                }), { status: 200, headers });
            }
            assert.equal(request.params.arguments.language, languageFilter ? 'es' : undefined);
            return new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: { content: [{ type: 'text', text: `${spanishToken} ${spanishUrl}` }] },
            }), { status: 200, headers });
        }
        if (url.pathname === '/.paperzilla-non-promotable.json') {
            return new Response('not found', { status: 404 });
        }
        if (url.pathname === '/sitemap.xml') {
            return new Response(`<urlset><url><loc>${englishUrl}</loc></url><url><loc>${spanishUrl}</loc></url></urlset>`);
        }
        if (['/llms.txt', '/llms-full.txt'].includes(url.pathname)) {
            return new Response(emptyLlms ? '' : `# Docs\n[English](${englishUrl})\n`);
        }
        if (url.pathname === '/skill.md') {
            return new Response('# Paperzilla docs skill\n');
        }
        if (url.pathname === '/es' && accept === 'text/markdown') {
            return new Response(`# ${spanishToken}\n`, { headers: { 'content-type': 'text/markdown' } });
        }
        if (url.pathname === '/es') {
            return new Response(page(spanishLang, spanishUrl, spanishToken), { headers: { 'content-type': 'text/html' } });
        }
        if (url.pathname === '/') {
            let html = page('en', englishUrl, 'Paperzilla docs portal');
            if (missingAlternates) html = html.replace(/<link[^>]*hreflang[^>]*>/g, '');
            return new Response(html, { headers: { 'content-type': 'text/html' } });
        }
        return new Response('not found', { status: 404 });
    };
}

test('metadata parser handles attribute order and reciprocal language links', () => {
    assert.deepEqual(pageMetadata(page('es', spanishUrl)), {
        lang: 'es',
        canonical: spanishUrl,
        alternates: { en: englishUrl, es: spanishUrl, 'x-default': englishUrl },
    });
});

test('hosted network audit is gated to a live and indexable local registry', () => {
    assert.throws(
        () => assertHostedSmokeLiveStage({ locales: [{ tag: 'es', stage: 'planned', indexable: false }] }),
        /live-only/,
    );
    assert.doesNotThrow(() => assertHostedSmokeLiveStage({
        locales: [{ tag: 'es', stage: 'live', indexable: true }],
    }));
});

test('manual hosted audit covers human, search, sitemap, llms, AI, and MCP surfaces', async () => {
    const result = await auditHostedDocs({ baseUrl, spanishToken, fetchImpl: fakeFetch() });
    assert.equal(result.spanishUrl, spanishUrl);
    assert.deepEqual(result.checks, [
        'canonical', 'hreflang', 'html-lang', 'sitemap', 'search', 'llms-default-language', 'ai-markdown', 'mcp',
    ]);
});

test('multilingual MCP search explicitly requests Spanish when the server advertises it', async () => {
    await auditHostedDocs({ baseUrl, spanishToken, fetchImpl: fakeFetch({ languageFilter: true }) });
});

test('documented default-language LLM files must still be present and nonempty', async () => {
    await assert.rejects(
        auditHostedDocs({ baseUrl, spanishToken, fetchImpl: fakeFetch({ emptyLlms: true }) }),
        /default-language documentation/,
    );
});

test('the provider hreflang limitation remains a strict audit failure', async () => {
    await assert.rejects(
        auditHostedDocs({ baseUrl, spanishToken, fetchImpl: fakeFetch({ missingAlternates: true }) }),
        /hreflang en/,
    );
});

test('manual hosted audit fails closed on wrong Spanish html language', async () => {
    await assert.rejects(
        auditHostedDocs({ baseUrl, spanishToken, fetchImpl: fakeFetch({ spanishLang: 'en' }) }),
        /Spanish page html lang must be es/,
    );
});
