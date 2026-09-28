// The Jev questions schema from project/plans/2026-09-25-advanced-schema-for-jev.md ("The schema").
// Mirrors `Questions` from @typesafe-ai/sdk 0.6.0: a map of tagged-oneOf questions with a rubric array.
export const jevQuestionsSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Jev questions',
  description: "A set of named Jev questions in TypeSafe's request shape.",
  type: 'object',
  required: ['questions'],
  additionalProperties: false,
  properties: {
    questions: {
      type: 'object',
      minProperties: 1,
      propertyNames: {pattern: '^[a-zA-Z][a-zA-Z0-9_]*$'},
      additionalProperties: {
        oneOf: [
          {
            title: 'Yes / No',
            type: 'object',
            required: ['type'],
            additionalProperties: false,
            properties: {
              type: {const: 'noul'},
              instructions: {type: 'string', title: 'Question'},
              criteria: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  true: {type: 'string', title: 'Means yes'},
                  false: {type: 'string', title: 'Means no'},
                },
              },
            },
          },
          {
            title: 'Score',
            type: 'object',
            required: ['type', 'criteria'],
            additionalProperties: false,
            properties: {
              type: {const: 'score'},
              instructions: {type: 'string', title: 'Question'},
              criteria: {
                title: 'Rubric, lowest first',
                description: 'Jev returns the position counted from 0: first line = 0.',
                type: 'array',
                minItems: 2,
                items: {type: 'string'},
              },
            },
          },
          {
            title: 'Choice',
            type: 'object',
            required: ['type', 'criteria'],
            additionalProperties: false,
            properties: {
              type: {const: 'choice'},
              instructions: {type: 'string', title: 'Question'},
              criteria: {
                title: 'Labels',
                type: 'object',
                minProperties: 2,
                maxProperties: 255,
                additionalProperties: {type: 'string'},
              },
            },
          },
        ],
      },
    },
  },
}
