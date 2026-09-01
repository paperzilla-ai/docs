import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    assertDeployableArtifact,
    assertNonPromotableArtifact,
    nonPromotableMarkerBytes,
    nonPromotableMarkerName,
    writeNonPromotableMarker,
} from './artifact-guard.mjs';

test('deterministic review marker fails the deployable-artifact guard closed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-artifact-guard-'));
    try {
        await assertDeployableArtifact(root);
        await assert.rejects(assertNonPromotableArtifact(root), /missing/);

        await writeNonPromotableMarker(root);
        assert.equal(
            await readFile(path.join(root, nonPromotableMarkerName), 'utf8'),
            nonPromotableMarkerBytes,
        );
        await assertNonPromotableArtifact(root);
        await assert.rejects(assertDeployableArtifact(root), /must never be deployed/);

        await writeFile(path.join(root, nonPromotableMarkerName), '{}\n');
        await assert.rejects(assertNonPromotableArtifact(root), /malformed or non-deterministic/);
        await assert.rejects(assertDeployableArtifact(root), /must never be deployed/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
