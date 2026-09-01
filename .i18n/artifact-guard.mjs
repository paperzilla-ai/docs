#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const nonPromotableMarkerName = '.paperzilla-non-promotable.json';
export const nonPromotableMarker = Object.freeze({
    schemaVersion: 1,
    artifactKind: 'paperzilla-docs-review',
    locale: 'es',
    promotable: false,
    reason: 'run7-review-only',
});
export const nonPromotableMarkerBytes = `${JSON.stringify(nonPromotableMarker, null, 2)}\n`;

function markerPath(root) {
    return path.join(path.resolve(root), nonPromotableMarkerName);
}

export async function writeNonPromotableMarker(root) {
    await writeFile(markerPath(root), nonPromotableMarkerBytes, 'utf8');
    return nonPromotableMarkerBytes;
}

async function readMarker(root) {
    try {
        return await readFile(markerPath(root), 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

export async function assertDeployableArtifact(root) {
    const rawMarker = await readMarker(root);
    if (rawMarker !== null) {
        throw new Error(
            `${nonPromotableMarkerName} is present; this review artifact must never be deployed or promoted.`,
        );
    }
}

export async function assertNonPromotableArtifact(root) {
    const rawMarker = await readMarker(root);
    if (rawMarker === null) {
        throw new Error(`Review artifact is missing ${nonPromotableMarkerName}.`);
    }
    if (rawMarker !== nonPromotableMarkerBytes) {
        throw new Error(`${nonPromotableMarkerName} is malformed or non-deterministic.`);
    }
}

function parseArguments(argv) {
    const [command, ...rest] = argv;
    let root = null;
    for (let index = 0; index < rest.length; index += 1) {
        if (rest[index] === '--root') {
            root = rest[++index];
        } else {
            throw new Error(`Unknown argument: ${rest[index]}`);
        }
    }
    if (!['assert-deployable', 'assert-non-promotable'].includes(command) || !root) {
        throw new Error(
            'Usage: artifact-guard.mjs assert-deployable|assert-non-promotable --root PATH',
        );
    }
    return { command, root };
}

async function main() {
    const { command, root } = parseArguments(process.argv.slice(2));
    if (command === 'assert-deployable') {
        await assertDeployableArtifact(root);
        console.log(`Deployable docs artifact guard passed: ${path.resolve(root)}`);
        return;
    }
    await assertNonPromotableArtifact(root);
    console.log(`Non-promotable review artifact marker verified: ${path.resolve(root)}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
    await main();
}
