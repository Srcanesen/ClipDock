// Preview-only adapter: transpiled from source for the local server, never written to dist/.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export function transpilePreviewAdapter(root) {
  const source = readFileSync(path.join(root, 'src', 'preview.ts'), 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
    reportDiagnostics: true,
  });
  const diagnostics = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (diagnostics.length > 0) {
    throw new Error(`Could not transpile src/preview.ts: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`);
  }
  return result.outputText;
}
