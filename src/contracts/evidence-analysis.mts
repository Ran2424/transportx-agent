import { Type, type Static } from 'typebox';

const Column = Type.String({ minLength: 1, maxLength: 160 });
const Direction = Type.Union([Type.Literal('asc'), Type.Literal('desc')]);
const ExactFilter = Type.Object({
  column: Column,
  value: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
}, { additionalProperties: false });

export const WorkspaceTableSchema = Type.Object(
  {
    file: Type.String({
      minLength: 1,
      maxLength: 1024,
      description: 'Relative path to a UTF-8 CSV in the current task workspace.',
    }),
    deliver: Type.Optional(Type.Boolean({ description: 'Set true to submit this successful exact aggregate as the final answer in the same call; omit or false to continue analysis.' })),
    select: Type.Optional(Type.Array(Column, { minItems: 1, maxItems: 24, description: 'Read mode: columns to return; omit to read all columns. In aggregate mode omit select and use groupBy for dimensions.' })),
    filters: Type.Optional(Type.Array(ExactFilter, { maxItems: 16 })),
    groupBy: Type.Optional(Type.Array(Column, { minItems: 1, maxItems: 24, description: 'Aggregate mode: grouping columns. Requires aggregates; omit select.' })),
    aggregates: Type.Optional(
      Type.Array(
        Type.Object(
          {
            op: Type.Union([Type.Literal('count'), Type.Literal('sum'), Type.Literal('avg'), Type.Literal('min'), Type.Literal('max')], { description: 'count counts rows when column is omitted, otherwise non-empty cells. sum and avg are numeric; avg returns floating-point text. min/max compare text unless numeric is true. Numeric columns must contain decimal values or empty cells throughout the CSV.' }),
            column: Type.Optional(Type.Union([Column, Type.Null()], { description: 'Exact CSV column name. Only count permits omission or JSON null, meaning count all rows.' })),
            as: Type.String({ minLength: 1, maxLength: 160, description: 'Unique output column name.' }),
            numeric: Type.Optional(Type.Boolean({ description: 'For min/max, true compares decimal numbers; omitted or false compares text.' })),
          },
          { additionalProperties: false }
        ),
        { maxItems: 16, description: 'Aggregate mode: omit select. Example: [{\"op\":\"avg\",\"column\":\"value\",\"as\":\"mean\"}]. Empty CSV cells are null and excluded from numeric aggregates.' }
      )
    ),
    orderBy: Type.Optional(
      Type.Array(
        Type.Object(
          {
            column: Column,
            direction: Type.Optional(Direction),
            numeric: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false }
        ),
        { maxItems: 16 }
      )
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false, description: 'Read example: {\"file\":\"data.csv\",\"select\":[\"name\",\"value\"]}. Aggregate example: {\"file\":\"data.csv\",\"groupBy\":[\"name\"],\"aggregates\":[{\"op\":\"sum\",\"column\":\"value\",\"as\":\"total\"}]}. CSV empty cells are null; the text \"null\" is an ordinary value or column name.' }
);

const EvidenceId = Type.String({ pattern: '^ev_[0-9a-f]{16}$' });
const TableClaim = Type.Object({
  kind: Type.Union([Type.Literal('scope'), Type.Literal('sample'), Type.Literal('time'), Type.Literal('value')]),
  label: Type.String({ minLength: 1, maxLength: 120, description: 'Short name of the fact, without its value.' }),
  evidenceId: EvidenceId,
  expectedFilters: Type.Optional(Type.Array(ExactFilter, {
    maxItems: 16,
    description: 'Scope only, required: express every condition intended by the user in actual source column names and values. Verify that the cited query implemented them. Use [] only when you intend the whole table.',
  })),
  column: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: 'For value or time only: the exact output column.' })),
  row: Type.Optional(Type.Integer({ minimum: 0, maximum: 19, description: 'For value only: zero-based output row (default 0).' })),
}, { additionalProperties: false });
export type TableClaimInput = Static<typeof TableClaim>;

export const CompleteEvidenceAnalysisSchema = Type.Object(
  {
    status: Type.Optional(
      Type.String({
        maxLength: 32,
        description: "Omit for an answer. Use 'missing' to report a checked source gap.",
      })
    ),
    answer: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 12000,
      description: 'For table claims, optional qualitative interpretation for review; leave factual values to claims. Otherwise the answer or checked source gap.',
    })),
    evidence: Type.Optional(Type.Array(EvidenceId, {
      maxItems: 16,
      uniqueItems: true,
      description: 'Supporting evidence IDs. IDs cited by claims are included automatically.',
    })),
    claims: Type.Optional(Type.Array(TableClaim, {
      minItems: 1, maxItems: 16,
      description: 'Required for a table answer. Bind scope and sample to the same query. Bind values to result cells and time to a complete single-column grouping with COUNT(*) per observed time. The workbench renders actual values; the model never supplies them.',
    })),
    relatedToolCallIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 8,
      uniqueItems: true,
      description: 'Optional receipt IDs issued by other successful tools in this turn. They are references and do not count as source evidence.',
    })),
  },
  { additionalProperties: false }
);

export const EVIDENCE_ANALYSIS_ENTRY = 'transportx.evidence-analysis.v1';
