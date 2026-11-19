export const TABLE_OPERATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export const TIME_ROLES = ['event_time', 'snapshot_time', 'source_updated_at'] as const;
export const FIELD_ROLES = ['dimension', 'measure', ...TIME_ROLES] as const;
export const REVIEW_TARGETS = ['data', 'knowledge', 'agent'] as const;

export type TableOperation = typeof TABLE_OPERATIONS[number];
export type TimeRole = typeof TIME_ROLES[number];
export type FieldRole = typeof FIELD_ROLES[number];
export type ReviewTarget = typeof REVIEW_TARGETS[number];
export type DefinitionRef = { scope: string; snapshot_id: string; revision: number; digest: string };
export type ReviewedDefinition = DefinitionRef & {
  definition: {
    row_grain: string;
    fields: { column: string; role: FieldRole; unit?: string; aliases?: { label: string; value: string }[] }[];
  };
};
export type CheckedPlan = {
  intentId: string; role: 'primary' | 'support' | 'time'; definition: DefinitionRef; planDigest: string;
  requiredTimes: { role: TimeRole; column: string }[]; timeRole?: TimeRole;
  operation: TableOperation; sampleBasis: 'rows' | 'non_null'; metric?: string; resultColumn?: string;
};
