#!/usr/bin/env node
import { localizeMdxPaths } from './path-map.mjs';

import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNonPromotableMarker } from './artifact-guard.mjs';
import {
    englishMdxInventory,
    validateAuthoredContent,
} from './content.mjs';
import {
    assertPathOutsideRoot,
    buildDeployConfig,
    canonicalJson,
    registryWithFutureLiveLocale,
} from './deploy-config.mjs';

const internalDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(internalDirectory);

function parseArguments(argv) {
    const options = { locale: 'es', output: null, replace: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--locale') {
            options.locale = argv[++index];
        } else if (argument === '--output') {
            options.output = path.resolve(argv[++index]);
        } else if (argument === '--replace') {
            options.replace = true;
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (options.locale !== 'es') {
        throw new Error('Run 7 has an isolated review projection for es only.');
    }
    return options;
}

async function copyIfPresent(source, destination) {
    try {
        await cp(source, destination, { recursive: true, errorOnExist: false });
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}

export async function buildPreviewProjection({ output, replace = false } = {}) {
    const destination = path.resolve(output ?? path.join(os.tmpdir(), `paperzilla-docs-es-${randomUUID()}`));
    let canonicalDestination = await assertPathOutsideRoot(destination, repositoryRoot);
    const errors = await validateAuthoredContent(repositoryRoot);
    if (errors.length > 0) {
        throw new Error(`Cannot build a stale or invalid Spanish projection:\n- ${errors.join('\n- ')}`);
    }
    let destinationExists = false;
    try {
        await stat(destination);
        destinationExists = true;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    if (destinationExists && !replace) {
        throw new Error('Preview output already exists; pass --replace for an atomic replacement.');
    }
    if (destinationExists && replace) {
        const temporaryRoots = new Set(await Promise.all([
            os.tmpdir(),
            '/tmp',
            '/private/tmp',
        ].map(async (root) => {
            try {
                return await realpath(root);
            } catch {
                return path.resolve(root);
            }
        })));
        if (![...temporaryRoots].some((root) => canonicalDestination.startsWith(`${root}${path.sep}`))) {
            throw new Error('--replace is restricted to an explicit directory under the system temporary directory.');
        }
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await assertPathOutsideRoot(destination, repositoryRoot);
    const staging = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.stage-`));
    try {
        await assertPathOutsideRoot(staging, repositoryRoot);
        const englishFiles = await englishMdxInventory(repositoryRoot);
        for (const relativePath of englishFiles) {
            const destinationPath = path.join(staging, relativePath);
            await mkdir(path.dirname(destinationPath), { recursive: true });
            await cp(path.join(repositoryRoot, relativePath), destinationPath);
        }
        await copyIfPresent(path.join(repositoryRoot, 'es'), path.join(staging, 'es'));
        for (const relativePath of englishFiles) {
            const file = path.join(staging, 'es', relativePath);
            const text = await readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
            if (text !== null) await writeFile(file, localizeMdxPaths(text, 'es', staging));
        }

        for (const asset of ['images', 'logo', 'favicon.ico', 'favicon.png']) {
            await copyIfPresent(path.join(repositoryRoot, asset), path.join(staging, asset));
        }

        const docsConfig = JSON.parse(await readFile(path.join(repositoryRoot, 'docs.json'), 'utf8'));
        const registry = JSON.parse(await readFile(path.join(internalDirectory, 'locales.generated.json'), 'utf8'));
        const translated = JSON.parse(await readFile(path.join(internalDirectory, 'navigation.es.json'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return 'null'; throw error; }));
        const reviewConfigValue = buildDeployConfig(
            docsConfig,
            registryWithFutureLiveLocale(registry, 'es'),
            { es: translated },
            staging,
        );
        reviewConfigValue.seo = {
            ...(reviewConfigValue.seo ?? {}),
            metatags: {
                ...(reviewConfigValue.seo?.metatags ?? {}),
                robots: 'noindex, nofollow, noarchive',
            },
        };
        const reviewConfig = canonicalJson(reviewConfigValue);
        await writeFile(path.join(staging, 'docs.json'), reviewConfig, 'utf8');
        await writeFile(
            path.join(staging, 'PREVIEW_ONLY.txt'),
            'Isolated bilingual Spanish review projection for Run 7. Never deploy this directory.\n',
            'utf8',
        );
        await writeNonPromotableMarker(staging);

        let backup = null;
        await assertPathOutsideRoot(destination, repositoryRoot);
        if (destinationExists) {
            backup = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.backup-`));
            await rm(backup, { recursive: true, force: true });
            await rename(destination, backup);
        }
        try {
            await assertPathOutsideRoot(destination, repositoryRoot);
            await rename(staging, destination);
        } catch (error) {
            if (backup !== null) {
                await rename(backup, destination);
            }
            throw error;
        }
        if (backup !== null) {
            await rm(backup, { recursive: true, force: true });
        }
    } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
    }
    return destination;
}

const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const destination = await buildPreviewProjection(parseArguments(process.argv.slice(2)));
    console.log(`Spanish review projection: ${destination}`);
    console.log(`Run locally: mint dev --root ${destination}`);
}
