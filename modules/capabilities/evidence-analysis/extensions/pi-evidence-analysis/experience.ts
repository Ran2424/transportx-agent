import { asRecord } from '../../../../../src/contracts/common.ts';

type Release = { releaseId: string; entryId: string; revision: number; digest: string };
export type ExperienceLookup = {
  toolCallId: string;
  status: 'matched' | 'empty' | 'unavailable';
  releases: Release[];
};
export type ExperienceSelection = Release & { disposition: 'used' | 'skipped'; reason?: string };

export function captureExperience(toolCallId: string, value: unknown, isError: boolean): ExperienceLookup {
  const details = asRecord(value);
  if (isError || details?.kind !== 'experience-search' || !Array.isArray(details.experiences)) {
    return { toolCallId, status: 'unavailable', releases: [] };
  }
  const releases = details.experiences.slice(0, 8).flatMap((item) => {
    const entry = asRecord(item);
    if (
      typeof entry?.release_id !== 'string' ||
      typeof entry.entry_id !== 'string' ||
      typeof entry.revision !== 'number' ||
      typeof entry.digest !== 'string'
    )
      return [];
    return [
      { releaseId: entry.release_id, entryId: entry.entry_id, revision: entry.revision, digest: entry.digest },
    ];
  });
  return { toolCallId, status: releases.length ? 'matched' : 'empty', releases };
}

export function selectExperience(
  lookups: ExperienceLookup[],
  input: {
    experienceReleaseId?: string;
    experienceDisposition?: string;
    experienceReason?: string;
  }
): ExperienceSelection | undefined {
  const disposition = input.experienceDisposition;
  if (!input.experienceReleaseId || (disposition !== 'used' && disposition !== 'skipped')) return;
  const release = lookups
    .flatMap((lookup) => lookup.releases)
    .find((item) => item.releaseId === input.experienceReleaseId);
  if (!release) return;
  const reason = input.experienceReason?.trim();
  return { ...release, disposition, ...(reason ? { reason } : {}) };
}
