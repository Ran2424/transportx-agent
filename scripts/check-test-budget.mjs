import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const MAX_TESTS = 40;

export function checkTestBudget(root = process.cwd()) {
  const testRoot = path.join(root, 'test');
  const files = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'fixtures') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) files.push(file);
    }
  };
  collect(testRoot);
  let count = 0;
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const fail = (message) => { throw new Error(`${path.relative(root, file)}: ${message}`); };
    let importsTest = false;
    const allowedRequires = new Set();
    const contexts = new Set();
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const value = declaration.initializer && ts.isAsExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer;
          if (!value || !ts.isCallExpression(value) || value.expression.getText(source) !== 'require' || value.arguments[0]?.text !== 'node:test') continue;
          if (!ts.isObjectBindingPattern(declaration.name) || declaration.name.elements.length !== 1 || declaration.name.elements[0].name.getText(source) !== 'test' || declaration.name.elements[0].propertyName) fail('Only an unaliased test import can register tests.');
          allowedRequires.add(value);
          importsTest = true;
        }
      }
      if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'node:test' || statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      if (statement.importClause?.name || !bindings || !ts.isNamedImports(bindings)) fail('Use only the named node:test import; registration aliases are forbidden.');
      for (const entry of bindings.elements) {
        if (entry.isTypeOnly) continue;
        if (entry.name.text !== 'test' || entry.propertyName) fail('Only an unaliased test import can register tests.');
        importsTest = true;
      }
    }
    const visit = (node) => {
      if (ts.isParameter(node) && node.type && /\bTestContext\b/.test(node.type.getText(source))) contexts.add(node.name.getText(source));
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'node:test' && !allowedRequires.has(node)) fail('Dynamic node:test imports and require aliases are forbidden.');
      if (importsTest && ts.isIdentifier(node) && node.text === 'test') {
        if (ts.isImportSpecifier(node.parent)) return;
        if (ts.isBindingElement(node.parent)) return;
        if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
        const call = node.parent;
        if (!ts.isCallExpression(call) || call.expression !== node) fail('Test registration cannot be assigned or passed to another function.');
        if (!ts.isExpressionStatement(call.parent) || call.parent.parent !== source) fail('Nested, conditional and loop test registrations are forbidden; merge assertions into a scenario.');
        if (!file.endsWith('.test.ts') || path.dirname(file) !== path.join(testRoot, 'suites')) fail('All registrations must be in test/suites/*.test.ts.');
        const callback = call.arguments.at(-1);
        if (!ts.isStringLiteral(call.arguments[0]) || !callback || !ts.isArrowFunction(callback)) fail('Tests require a literal name and an inline callback.');
        if (callback.parameters[0]) contexts.add(callback.parameters[0].name.getText(source));
        count++;
      }
      const access = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null;
      if (access && ['test', 'only', 'skip', 'todo'].includes(access) && contexts.has(node.expression?.getText(source))) {
        if (access === 'test' || !ts.isCallExpression(node.parent)) fail('Context registration aliases and subtests are forbidden.');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (importsTest && !source.statements.some(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(source) === 'test')) fail('Test files must register a scenario.');
  }
  if (count === 0 || count > MAX_TESTS) throw new Error(`Test budget exceeded: ${count}/${MAX_TESTS} total tests (including skipped, todo and nested tests).`);
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(`Test budget: ${checkTestBudget()}/${MAX_TESTS} total tests; aliases, loops and subtests are forbidden.`);
}
