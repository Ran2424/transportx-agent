import { Type, type Static } from 'typebox';
const name = Type.String({ minLength: 1, maxLength: 160 });
const operation = Type.Union([Type.Literal('count'), Type.Literal('sum'), Type.Literal('avg'), Type.Literal('min'), Type.Literal('max')]);
const timeRole = Type.Union([Type.Literal('event_time'), Type.Literal('snapshot_time'), Type.Literal('source_updated_at')]);
const target = Type.Union([Type.Literal('data'), Type.Literal('knowledge'), Type.Literal('agent')], {
  description: 'The Studio identified by the reviewer. If omitted for a rejected plan, use Agent Studio.',
});
const filter = Type.Object({
  column: name,
  value: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
}, { additionalProperties: false });

export const WorkspaceHandoffSchema = Type.Object({
  action: Type.Union([
    Type.Literal('inspect'), Type.Literal('prepare'), Type.Literal('review'), Type.Literal('resolve'),
    Type.Literal('retry_resolution'), Type.Literal('inspect_review'),
  ], { description: 'Inspect or prepare a reviewed snapshot, route or resolve a review, retry a verified Data Studio closure, or look up review state.' }),
  file: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  operation: Type.Optional(operation),
  metric: Type.Optional(name),
  sampleBasis: Type.Optional(Type.Union([Type.Literal('rows'), Type.Literal('non_null')], {
    description: 'The requested denominator. non_null uses the metric column. COUNT(*) counts rows.',
  })),
  filters: Type.Optional(Type.Array(filter, {
    maxItems: 16,
    description: 'Exact filters for resolved user choices. Confirmed aliases appearing in the original request are independently added.',
  })),
  groupBy: Type.Optional(Type.Array(name, { maxItems: 12, uniqueItems: true })),
  timeRoles: Type.Optional(Type.Array(timeRole, { maxItems: 3, uniqueItems: true })),
  candidateReleaseIds: Type.Optional(Type.Array(name, { maxItems: 3, uniqueItems: true })),
  target: Type.Optional(target),
  intentId: Type.Optional(name),
  reviewId: Type.Optional(name),
  releaseId: Type.Optional(name),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1500 })),
}, { additionalProperties: false });

export type HandoffInput = Static<typeof WorkspaceHandoffSchema>;
