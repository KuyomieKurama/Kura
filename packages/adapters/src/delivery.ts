import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterError, type AdapterErrorCode } from './errors.js';
import { stageByteStream } from './staging.js';
import type {
  AssetManifest,
  DownloadLimits,
  QualityPolicy,
  SourceAdapter,
  SourcePost,
  StagedFile
} from './types.js';
import type { RunWorkspace } from './workspace.js';

export type AssetOutcome =
  | { readonly status: 'staged'; readonly assetIndex: number; readonly sourceAssetId: string; readonly staged: StagedFile }
  | { readonly status: 'failed'; readonly assetIndex: number; readonly sourceAssetId: string; readonly errorCode: AdapterErrorCode | 'UNEXPECTED'; readonly message: string };

/** `partially_completed` is the plan 04 state for "some assets stored, some not". */
export type PostCompletion = 'complete' | 'partially_completed' | 'failed';

export interface DeliveryRequest {
  readonly adapter: SourceAdapter;
  readonly post: SourcePost;
  readonly manifest: AssetManifest;
  readonly policy: QualityPolicy;
  readonly workspace: RunWorkspace;
  readonly jobId: string;
  readonly leaseGeneration: number;
  readonly limits: DownloadLimits;
  readonly signal?: AbortSignal;
}

export interface DeliveryResult {
  readonly completion: PostCompletion;
  readonly outcomes: readonly AssetOutcome[];
  /** Absolute path of the bounded result.json next to media/. */
  readonly resultFile: string;
}

/**
 * Stages every asset of a manifest, one by one. One failing asset never
 * stops the others and never discards files that were staged successfully
 * (plan 04, section 4: completion is tracked per asset). The outcome list is
 * the truth; `completion` is derived from it and from the manifest.
 *
 * Adapters with `stage()` hand over checked files; others stream through
 * `download()` into the staging area. A caller abort stops the whole run.
 */
export async function deliverAssets(request: DeliveryRequest): Promise<DeliveryResult> {
  const { adapter, manifest, workspace } = request;
  const outcomes: AssetOutcome[] = [];

  for (const asset of manifest.assets) {
    if (request.signal?.aborted) throw new AdapterError('PROCESS_ABORTED', 'Delivery was aborted');
    const context = {
      jobId: request.jobId,
      leaseGeneration: request.leaseGeneration,
      signal: request.signal,
      post: request.post,
      policy: request.policy,
      limits: request.limits
    };
    try {
      const staged = adapter.stage
        ? await adapter.stage(asset, { ...context, workspace })
        : await stageByteStream(adapter.download(asset, context), workspace, asset.assetIndex, asset.mediaType, request.limits.maxBytes);
      outcomes.push({ status: 'staged', assetIndex: asset.assetIndex, sourceAssetId: asset.sourceAssetId, staged });
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'PROCESS_ABORTED') throw error;
      outcomes.push({
        status: 'failed',
        assetIndex: asset.assetIndex,
        sourceAssetId: asset.sourceAssetId,
        errorCode: error instanceof AdapterError ? error.code : 'UNEXPECTED',
        message: error instanceof AdapterError ? error.message : 'Unexpected error while staging the asset'
      });
    }
  }

  const stagedCount = outcomes.filter((outcome) => outcome.status === 'staged').length;
  const everythingKnownAndStaged = stagedCount === manifest.assets.length && manifest.discoveryComplete && manifest.errors.length === 0;
  const completion: PostCompletion = stagedCount === 0 ? 'failed' : everythingKnownAndStaged ? 'complete' : 'partially_completed';
  const resultFile = await writeResultFile(request, outcomes);
  return { completion, outcomes, resultFile };
}

/** The bounded manifest of docs/planning/04, section 7. It is a hint for the importer, which re-checks every file. */
async function writeResultFile(request: DeliveryRequest, outcomes: readonly AssetOutcome[]): Promise<string> {
  const { manifest } = request;
  const document = {
    schemaVersion: 1,
    jobId: request.jobId,
    leaseGeneration: request.leaseGeneration,
    adapterId: manifest.adapterId,
    adapterVersion: manifest.adapterVersion,
    discoveryComplete: manifest.discoveryComplete,
    items: outcomes.flatMap((outcome) => {
      if (outcome.status !== 'staged') return [];
      const asset = manifest.assets.find((candidate) => candidate.assetIndex === outcome.assetIndex)!;
      return [{
        sourcePostId: manifest.platformPostId,
        sourceAssetId: outcome.sourceAssetId,
        revisionKey: manifest.revisionKey,
        relativePath: outcome.staged.relativePath,
        role: asset.role,
        declaredBytes: outcome.staged.byteLength,
        sha256: outcome.staged.sha256,
        metadata: { creatorId: manifest.creatorId, index: outcome.assetIndex }
      }];
    }),
    errors: [
      ...manifest.errors.map((error) => ({ code: error.code, message: error.message })),
      ...outcomes.flatMap((outcome) => outcome.status === 'failed'
        ? [{ sourceAssetId: outcome.sourceAssetId, code: outcome.errorCode, message: outcome.message }]
        : [])
    ]
  };
  const resultFile = join(request.workspace.rootDir, 'result.json');
  await writeFile(resultFile, JSON.stringify(document, null, 2), { mode: 0o600 });
  return resultFile;
}
