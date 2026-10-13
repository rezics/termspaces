import { Type, type Static } from '@sinclair/typebox';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' });
const text = Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const object = { additionalProperties: false } as const;
const startup = Type.Union([
  Type.Object({ mode: Type.Literal('manual') }, object),
  Type.Object({ mode: Type.Literal('on-create'), argv: Type.Array(Type.String({ pattern: '^[^\\u0000]*$' }), { minItems: 1 }) }, object),
]);
export const WorkspaceSchema = Type.Object({
  version: Type.Literal(1),
  session: Type.Object({
    id, name: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[^.:\\u0000-\\u001f\\u007f]+$' })),
    cwd: text, autostart: Type.Optional(Type.Boolean()),
    profile: Type.Optional(Type.Union([Type.Literal('minimal'), Type.Literal('immersive')])),
  }, object),
  windows: Type.Array(Type.Object({
    id, name: Type.Optional(text), cwd: Type.Optional(text),
    startup: Type.Optional(startup),
    layout: Type.Optional(Type.Union([Type.Literal('even-horizontal'), Type.Literal('even-vertical'), Type.Literal('main-horizontal'), Type.Literal('main-vertical'), Type.Literal('tiled')])),
    panes: Type.Array(Type.Object({
      id, cwd: Type.Optional(text), sticky: Type.Optional(Type.Boolean()),
      shell: Type.Optional(text), startup: Type.Optional(startup),
    }, object), { minItems: 1 }),
  }, object), { minItems: 1 }),
}, { ...object, $id: 'https://rezics.github.io/termspaces/workspace.schema.json', title: 'Termspaces workspace' });
export type Workspace = Static<typeof WorkspaceSchema>;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync('schema', { recursive: true });
  writeFileSync('schema/workspace.schema.json', JSON.stringify(WorkspaceSchema, null, 2) + '\n');
}
