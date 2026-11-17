import { Type } from 'typebox';

const Column = Type.String({ minLength: 1, maxLength: 160 });
const Columns = Type.Array(Column, { minItems: 1, maxItems: 24 });
const Direction = Type.Union([Type.Literal('asc'), Type.Literal('desc')]);
const Operation = Type.Union([
  Type.Literal('count'),
  Type.Literal('sum'),
  Type.Literal('min'),
  Type.Literal('max'),
]);

export const WorkspaceTableSchema = Type.Object(
  {
    file: Type.String({
      minLength: 1,
      maxLength: 256,
      description:
        'Relative path to a UTF-8 CSV in the current task workspace.',
    }),
    select: Type.Optional(Columns),
    filters: Type.Optional(
      Type.Array(
        Type.Object(
          {
            column: Column,
            value: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
          },
          { additionalProperties: false }
        ),
        { maxItems: 16 }
      )
    ),
    groupBy: Type.Optional(Columns),
    aggregates: Type.Optional(
      Type.Array(
        Type.Object(
          {
            op: Operation,
            column: Type.Optional(Column),
            as: Column,
            numeric: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false }
        ),
        { maxItems: 16 }
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
  { additionalProperties: false }
);

export const CompleteEvidenceAnalysisSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('answered'), Type.Literal('missing')]),
    answer: Type.String({
      minLength: 1,
      maxLength: 12000,
      description:
        'Complete answer, or a concrete description of what evidence is missing.',
    }),
    evidence: Type.Array(Type.String({ pattern: '^ev_[0-9a-f]{16}$' }), {
      maxItems: 16,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export const EVIDENCE_ANALYSIS_ENTRY = 'transportx.evidence-analysis.v1';
