import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// A docs-only release decision. Never write this projection to the shared
// registry: product selection, Auth, email and app routes retain their stages.
export const publicationKeys = [
    'schemaVersion', 'surface', 'locale', 'stage', 'approvedBy', 'approvedAt',
    'verification', 'provenance', 'contentManifestSha256', 'registrySha256',
    'decisionRecord',
];

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function registryForDocsPublication(registry, approval, hashes) {
    if (approval === null) return structuredClone(registry);
    if (!approval || JSON.stringify(Object.keys(approval)) !== JSON.stringify(publicationKeys)
        || approval.schemaVersion !== 1 || approval.surface !== 'documentation'
        || approval.locale !== 'es' || approval.stage !== 'live'
        || approval.approvedBy !== 'Mark Pors'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(approval.approvedAt)
        || Number.isNaN(Date.parse(approval.approvedAt))
        || approval.verification !== 'live-after-deploy'
        || !['preserve-machine-status', 'preserve-recorded-status'].includes(approval.provenance)
        || approval.decisionRecord !== 'docs/multilingual/spanish-docs-live-2026-09-07.md') {
        throw new Error('Invalid docs-only publication approval.');
    }
    for (const key of ['contentManifestSha256', 'registrySha256']) {
        if (!/^[a-f0-9]{64}$/.test(approval[key]) || approval[key] !== hashes[key]) {
            throw new Error(`Docs publication approval has stale ${key}; review the change before renewing approval.`);
        }
    }
    const result = structuredClone(registry);
    const locale = result.locales?.find((entry) => entry.tag === approval.locale);
    if (!locale || !['planned', 'preview', 'live'].includes(locale.stage)
        || locale.pathPrefix !== 'es' || locale.fallback !== 'en') {
        throw new Error('Docs publication cannot expose an unknown, retired or incompatible locale.');
    }
    locale.stage = 'live';
    locale.indexable = true;
    return result;
}

export async function loadDocsPublication(root, registry) {
    let rawApproval;
    try {
        rawApproval = await readFile(path.join(root, '.i18n/publication.json'), 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return structuredClone(registry);
        throw error;
    }
    const approval = JSON.parse(rawApproval);
    if (rawApproval !== `${JSON.stringify(approval, null, 2)}\n`) {
        throw new Error('Docs publication approval must use canonical JSON.');
    }
    const [manifest, rawRegistry] = await Promise.all([
        readFile(path.join(root, '.i18n/content.manifest.json')),
        readFile(path.join(root, '.i18n/locales.generated.json')),
    ]);
    if (JSON.stringify(JSON.parse(rawRegistry)) !== JSON.stringify(registry)) {
        throw new Error('Docs publication must use the unchanged generated product registry.');
    }
    return registryForDocsPublication(registry, approval, {
        contentManifestSha256: sha256(manifest),
        registrySha256: sha256(rawRegistry),
    });
}
