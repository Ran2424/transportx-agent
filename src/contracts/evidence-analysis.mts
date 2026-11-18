import { Type } from 'typebox';

const Column = Type.String({ minLength: 1, maxLength: 160 });
const Direction = Type.Union([Type.Literal('asc'), Type.Literal('desc')]);

export const WorkspaceTableSchema = Type.Object(
  {
    file: Type.String({
      minLength: 1,
      maxLength: 1024,
      description: 'Relative path to a UTF-8 CSV in the current task workspace.',
    }),
    deliver: Type.Optional(Type.Boolean({ description: 'Set true to submit this successful exact aggregate as the final answer in the same call; omit or false to continue analysis.' })),
    select: Type.Optional(Type.Array(Column, { minItems: 1, maxItems: 24, description: 'Read mode: columns to return; omit to read all columns. In aggregate mode omit select and use groupBy for dimensions.' })),
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

export const CompleteEvidenceAnalysisSchema = Type.Object(
  {
    status: Type.Optional(
      Type.String({
        maxLength: 32,
        description: "Omit for an answer. Use 'missing' to report a checked source gap.",
      })
    ),
    answer: Type.String({
      minLength: 1,
      maxLength: 12000,
      description: 'Complete answer, or a concrete description of what evidence is missing.',
    }),
    evidence: Type.Array(Type.String({ pattern: '^ev_[0-9a-f]{16}$' }), {
      maxItems: 16,
      uniqueItems: true,
    }),
    relatedToolCallIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 8,
      uniqueItems: true,
      description: 'Optional receipt IDs issued by other successful tools in this turn. They are references and do not count as source evidence.',
    })),
  },
  { additionalProperties: false }
);

export const EVIDENCE_ANALYSIS_ENTRY = 'transportx.evidence-analysis.v1';
