export type CountBatch = { id: string; label: string; startDate: string; endDateExclusive: string; rowCount: number; sha256: string; sourceUrl: string };
export type CountBucket = { average: number | null; valid: number; total: number; sum: number | null };
export type CountComparisonRequest = { batchA: string; batchB: string; startHour: number; endHour: number };
export type CountComparisonResult = { runId: string; engineVersion: string; methodVersion: string; batches: [CountBatch, CountBatch]; startHour: number; endHour: number; rows: Array<{ hour: number; values: [CountBucket, CountBucket] }> };
