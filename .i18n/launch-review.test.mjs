import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from './deploy-config.mjs';
import {
    aggregateSha256,
    artifactReviewState,
    documentationReviewState,
    reviewSetSha256,
    validateLaunchReviewMatrix,
} from './launch-review.mjs';

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

async function committedInputs() {
    const [rawMatrix, rawRegistry] = await Promise.all([
        readFile(new URL('./launch-review-matrix.generated.json', import.meta.url), 'utf8'),
        readFile(new URL('./locales.generated.json', import.meta.url), 'utf8'),
    ]);
    return {
        rawMatrix,
        matrix: JSON.parse(rawMatrix),
        rawRegistry,
        registry: JSON.parse(rawRegistry),
    };
}

function stageInputs(inputs, stage) {
    const registry = structuredClone(inputs.registry);
    const spanish = registry.locales.find((locale) => locale.tag === 'es');
    spanish.stage = stage;
    spanish.indexable = stage === 'live';
    const rawRegistry = canonicalJson(registry);
    const matrix = structuredClone(inputs.matrix);
    matrix.localeRegistrySha256 = sha256(rawRegistry);
    return { matrix, registry, rawRegistry };
}

function previewInputs(inputs) {
    return stageInputs(inputs, 'preview');
}

function reviewerAuthorityForRole(role) {
    return ['linguistic', 'editorial'].includes(role)
        ? 'trusted-spanish-reviewer'
        : 'mark';
}

async function addCurrentDocsReviews(inputs) {
    const docsArtifacts = inputs.matrix.artifacts.filter((artifact) => artifact.repository === 'docs');
    for (const [artifactIndex, artifact] of docsArtifacts.entries()) {
        const state = await artifactReviewState(inputs.matrix, artifact.id);
        for (const [roleIndex, role] of artifact.requiredRoles.entries()) {
            inputs.matrix.reviews.push({
                locale: artifact.locale,
                artifactId: artifact.id,
                surface: artifact.surface,
                role,
                reviewerAuthority: reviewerAuthorityForRole(role),
                sourceSha256: state.sourceSha256,
                artifactSha256: state.artifactSha256,
                reviewerLabel: 'Named reviewer',
                timestamp: `2026-09-01T20:0${artifactIndex}:${String(roleIndex).padStart(2, '0')}Z`,
                decision: 'approved',
                exceptions: [],
            });
        }
    }
}

function addPromotionApproval(inputs, targetStage) {
    inputs.matrix.promotionApprovals.push({
        locale: 'es',
        targetStage,
        approverRole: targetStage === 'preview' ? 'trusted-spanish-reviewer' : 'mark',
        reviewerLabel: targetStage === 'preview' ? 'Trusted Spanish reviewer' : 'Mark',
        timestamp: targetStage === 'preview' ? '2026-09-01T21:00:00Z' : '2026-09-01T22:00:00Z',
        decision: 'approved',
        reviewSetSha256: reviewSetSha256(inputs.matrix, 'es'),
        exceptions: [],
    });
}

function refreshPromotionApprovalHashes(matrix) {
    for (const approval of matrix.promotionApprovals) {
        approval.reviewSetSha256 = reviewSetSha256(matrix, approval.locale);
    }
}

test('committed generated launch-review mirror is canonical and valid while Spanish is planned', async () => {
    const inputs = await committedInputs();
    assert.deepEqual(await validateLaunchReviewMatrix(inputs), []);
});

test('aggregate hash framing matches the backend portable contract vector', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-review-hash-'));
    try {
        await mkdir(path.join(root, 'nested'));
        await writeFile(path.join(root, 'a.txt'), Buffer.from([0x41, 0x0a]));
        await writeFile(path.join(root, 'nested/b.txt'), Buffer.from([0x00, 0x42]));
        assert.equal(
            await aggregateSha256(root, ['**/*.txt', 'a.txt']),
            '0a4c24209a257ba3bce55e150c993e49c7aa853740f68f3cbad2531a1731e58c',
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('aggregate hashing rejects artifact symlinks that escape the repository', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-review-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-review-outside-'));
    try {
        const outsideFile = path.join(outside, 'outside.txt');
        await writeFile(outsideFile, 'outside review bytes\n');
        await symlink(outsideFile, path.join(root, 'linked.txt'));
        await assert.rejects(
            aggregateSha256(root, ['linked.txt']),
            /resolves outside the repository/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test('aggregate hashing permits contained symlinks using their canonical repository path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'paperzilla-docs-review-contained-'));
    try {
        await writeFile(path.join(root, 'target.txt'), 'contained review bytes\n');
        await symlink('target.txt', path.join(root, 'alias.txt'));
        assert.equal(
            await aggregateSha256(root, ['alias.txt']),
            await aggregateSha256(root, ['target.txt']),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('documentation state derives current hashes and pending specialist roles', async () => {
    const { matrix } = await committedInputs();
    const state = await documentationReviewState(matrix);
    assert.match(state.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(state.artifactSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(state.currentApprovedRoles, []);
    assert.deepEqual(state.pendingRoles, ['linguistic', 'editorial', 'product-technical', 'seo']);
});

test('generated mirror pins both docs artifact contracts', async () => {
    const committed = await committedInputs();
    const missingRuntime = structuredClone(committed.matrix);
    missingRuntime.artifacts = missingRuntime.artifacts.filter((artifact) => (
        artifact.id !== 'documentation-runtime-and-deployment'
    ));
    let rawMatrix = canonicalJson(missingRuntime);
    let errors = await validateLaunchReviewMatrix({ ...committed, matrix: missingRuntime, rawMatrix });
    assert(errors.some((error) => error.includes('docs artifact set changed')));
    assert(errors.some((error) => error.includes('exactly one documentation-runtime-and-deployment')));

    const weakenedRuntime = structuredClone(committed.matrix);
    const runtime = weakenedRuntime.artifacts.find((artifact) => (
        artifact.id === 'documentation-runtime-and-deployment'
    ));
    runtime.artifactPaths = runtime.artifactPaths.filter((artifactPath) => artifactPath !== '.mintignore');
    rawMatrix = canonicalJson(weakenedRuntime);
    errors = await validateLaunchReviewMatrix({ ...committed, matrix: weakenedRuntime, rawMatrix });
    assert(errors.some((error) => error.includes('artifact contract changed unexpectedly')));
});

test('preview is blocked until current specialist reviews and explicit approval are present', async () => {
    const committed = await committedInputs();
    const inputs = previewInputs(committed);
    let rawMatrix = canonicalJson(inputs.matrix);
    let errors = await validateLaunchReviewMatrix({ ...inputs, rawMatrix });
    assert(errors.some((error) => error.includes('documentation: missing editorial review')));
    assert(errors.some((error) => error.includes('documentation-runtime-and-deployment: missing product-technical review')));
    assert(errors.some((error) => error.includes('missing explicit preview promotion approval')));

    await addCurrentDocsReviews(inputs);
    addPromotionApproval(inputs, 'preview');
    rawMatrix = canonicalJson(inputs.matrix);
    assert.deepEqual(await validateLaunchReviewMatrix({ ...inputs, rawMatrix }), []);

    const editorialReview = inputs.matrix.reviews.find((review) => (
        review.artifactId === 'documentation' && review.role === 'editorial'
    ));
    editorialReview.artifactSha256 = '0'.repeat(64);
    rawMatrix = canonicalJson(inputs.matrix);
    errors = await validateLaunchReviewMatrix({ ...inputs, rawMatrix });
    assert(errors.some((error) => error.includes('documentation: editorial review hashes are stale')));
});

test('preview and live reject missing or stale approval for either docs artifact', async () => {
    const committed = await committedInputs();
    for (const targetStage of ['preview', 'live']) {
        const approved = stageInputs(committed, targetStage);
        await addCurrentDocsReviews(approved);
        addPromotionApproval(approved, 'preview');
        if (targetStage === 'live') {
            addPromotionApproval(approved, 'live');
        }
        let rawMatrix = canonicalJson(approved.matrix);
        assert.deepEqual(await validateLaunchReviewMatrix({ ...approved, rawMatrix }), []);

        for (const artifact of approved.matrix.artifacts.filter((entry) => entry.repository === 'docs')) {
            for (const role of artifact.requiredRoles) {
                const missing = structuredClone(approved);
                missing.matrix.reviews = missing.matrix.reviews.filter((review) => !(
                    review.artifactId === artifact.id && review.role === role
                ));
                refreshPromotionApprovalHashes(missing.matrix);
                rawMatrix = canonicalJson(missing.matrix);
                let errors = await validateLaunchReviewMatrix({ ...missing, rawMatrix });
                assert(
                    errors.some((error) => error.includes(`${artifact.id}: missing ${role} review`)),
                    `${targetStage} must reject a missing ${artifact.id} ${role} review`,
                );

                const stale = structuredClone(approved);
                const staleReview = stale.matrix.reviews.find((review) => (
                    review.artifactId === artifact.id && review.role === role
                ));
                staleReview.artifactSha256 = '0'.repeat(64);
                refreshPromotionApprovalHashes(stale.matrix);
                rawMatrix = canonicalJson(stale.matrix);
                errors = await validateLaunchReviewMatrix({ ...stale, rawMatrix });
                assert(
                    errors.some((error) => error.includes(`${artifact.id}: ${role} review hashes are stale`)),
                    `${targetStage} must reject a stale ${artifact.id} ${role} review`,
                );
            }
        }
    }
});

test('reviewer labels reject contact details in the generated mirror', async () => {
    const committed = await committedInputs();
    for (const reviewerLabel of [
        'reviewer@example.com',
        'https://example.com/reviewer',
        '+1 (555) 123-4567',
        'Spanish reviewer phone 555 123 4567',
    ]) {
        const inputs = previewInputs(committed);
        const state = await documentationReviewState(inputs.matrix);
        inputs.matrix.reviews.push({
            locale: 'es',
            artifactId: 'documentation',
            surface: 'documentation',
            role: 'editorial',
            reviewerAuthority: 'trusted-spanish-reviewer',
            sourceSha256: state.sourceSha256,
            artifactSha256: state.artifactSha256,
            reviewerLabel,
            timestamp: '2026-09-01T20:00:00Z',
            decision: 'approved',
            exceptions: [],
        });
        const rawMatrix = canonicalJson(inputs.matrix);
        const errors = await validateLaunchReviewMatrix({ ...inputs, rawMatrix });
        assert(errors.some((error) => error.includes('stable non-contact label')));
    }
});

test('review roles require their assigned reviewer authority', async () => {
    const committed = await committedInputs();
    const inputs = previewInputs(committed);
    const state = await documentationReviewState(inputs.matrix);
    inputs.matrix.reviews.push({
        locale: 'es',
        artifactId: 'documentation',
        surface: 'documentation',
        role: 'editorial',
        reviewerAuthority: 'mark',
        sourceSha256: state.sourceSha256,
        artifactSha256: state.artifactSha256,
        reviewerLabel: 'Mark',
        timestamp: '2026-09-01T20:00:00Z',
        decision: 'approved',
        exceptions: [],
    });
    const rawMatrix = canonicalJson(inputs.matrix);
    const errors = await validateLaunchReviewMatrix({ ...inputs, rawMatrix });
    assert(errors.some((error) => error.includes('reviewerAuthority does not own editorial')));
});

test('duplicate review and promotion identities at one timestamp are rejected', async () => {
    const committed = await committedInputs();
    const inputs = previewInputs(committed);
    await addCurrentDocsReviews(inputs);
    addPromotionApproval(inputs, 'preview');
    inputs.matrix.reviews.push({
        ...inputs.matrix.reviews[0],
        timestamp: '2026-09-01T23:00:00+03:00',
        decision: 'rejected',
    });
    inputs.matrix.promotionApprovals.push({
        ...inputs.matrix.promotionApprovals[0],
        timestamp: '2026-09-02T00:00:00+03:00',
        decision: 'rejected',
    });
    const rawMatrix = canonicalJson(inputs.matrix);
    const errors = await validateLaunchReviewMatrix({ ...inputs, rawMatrix });
    assert(errors.some((error) => error.includes('duplicates a review identity and timestamp')));
    assert(errors.some((error) => error.includes('duplicates a promotion-approval identity and timestamp')));
});

test('retired gate freezes reviewed Spanish artifacts but ignores moving source hashes', async () => {
    const committed = await committedInputs();
    const inputs = stageInputs(committed, 'retired');
    await addCurrentDocsReviews(inputs);
    for (const review of inputs.matrix.reviews.filter((entry) => entry.artifactId === 'documentation')) {
        review.sourceSha256 = '0'.repeat(64);
    }
    let rawMatrix = canonicalJson(inputs.matrix);
    assert.deepEqual(await validateLaunchReviewMatrix({ ...inputs, rawMatrix }), []);

    const changedArtifact = structuredClone(inputs);
    changedArtifact.matrix.reviews.find((review) => (
        review.artifactId === 'documentation' && review.role === 'linguistic'
    )).artifactSha256 = '0'.repeat(64);
    rawMatrix = canonicalJson(changedArtifact.matrix);
    const errors = await validateLaunchReviewMatrix({ ...changedArtifact, rawMatrix });
    assert(errors.some((error) => error.includes('retired artifact changed after its linguistic approval')));
});
