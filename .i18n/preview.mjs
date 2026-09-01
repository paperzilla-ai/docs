#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAuthoredContent } from './content.mjs';

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
        throw new Error('Run 6 has an isolated preview projection for es only.');
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
    if (destination === repositoryRoot || destination.startsWith(`${repositoryRoot}${path.sep}`)) {
        throw new Error('Spanish preview output must be outside the docs repository.');
    }
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
        const temporaryRoots = new Set([
            path.resolve(os.tmpdir()),
            path.resolve('/tmp'),
            path.resolve('/private/tmp'),
        ]);
        if (![...temporaryRoots].some((root) => destination.startsWith(`${root}${path.sep}`))) {
            throw new Error('--replace is restricted to an explicit directory under the system temporary directory.');
        }
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const staging = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.stage-`));
    try {
        await cp(path.join(repositoryRoot, 'es'), path.join(staging, 'es'), { recursive: true });
        for (const asset of ['images', 'logo', 'favicon.ico', 'favicon.png']) {
            await copyIfPresent(path.join(repositoryRoot, asset), path.join(staging, asset));
        }

        const docsConfig = JSON.parse(await readFile(path.join(repositoryRoot, 'docs.json'), 'utf8'));
        const translated = JSON.parse(await readFile(path.join(internalDirectory, 'navigation.es.json'), 'utf8'));
        docsConfig.name = 'Documentación de Paperzilla (vista previa aislada)';
        docsConfig.navigation = translated.navigation;
        docsConfig.navbar = translated.navbar;
        await writeFile(path.join(staging, 'docs.json'), `${JSON.stringify(docsConfig, null, 2)}\n`, 'utf8');
        await writeFile(
            path.join(staging, 'PREVIEW_ONLY.txt'),
            'Isolated local Spanish projection for Run 6. Never deploy this directory.\n',
            'utf8',
        );

        let backup = null;
        if (destinationExists) {
            backup = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.backup-`));
            await rm(backup, { recursive: true, force: true });
            await rename(destination, backup);
        }
        try {
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
    console.log(`Spanish preview projection: ${destination}`);
    console.log(`Run locally: mint dev --root ${destination}`);
}
