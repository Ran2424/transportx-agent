import { Type } from 'typebox';

const LegacyText = Type.String({ minLength: 1, maxLength: 16000 });

export const LegacyExperienceSearchSchema = Type.Object(
  {
    query: LegacyText,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    reference: Type.Optional(
      Type.Object({ release_id: LegacyText, entry_id: LegacyText }, { additionalProperties: false })
    ),
  },
  { additionalProperties: false }
);

export const ExperienceSearchSchema = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 500,
      description: 'A short business question or intent phrase.',
    }),
  },
  { additionalProperties: false }
);
