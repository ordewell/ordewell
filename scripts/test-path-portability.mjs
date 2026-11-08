// Only flag a comparison we can prove passes with POSIX paths and fails with
// Windows paths. POSIX fixtures and explicit path.posix tests remain valid.
import path from 'node:path';
import ts from 'typescript';

export function pathAssumptions(text, filename = 'test.ts') {
  const compilerFile = ts.sys.resolvePath(filename);
  const source = ts.createSourceFile(compilerFile, text, ts.ScriptTarget.Latest, true);
  const program = ts.createProgram([compilerFile], { noLib: true, noResolve: true, allowJs: true }, {
    ...ts.createCompilerHost({}),
    getSourceFile: (name) => name === compilerFile ? source : undefined,
  });
  const checker = program.getTypeChecker();
  const symbol = (node) => checker.getSymbolAtLocation(node);
  const imported = (node) => {
    const declaration = symbol(node)?.declarations?.[0];
    if (!declaration) return undefined;
    let owner = declaration;
    while (owner && !ts.isImportDeclaration(owner)) owner = owner.parent;
    if (!owner || !['path', 'node:path'].includes(owner.moduleSpecifier.text)) return undefined;
    return ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : '*';
  };
  const literal = (value) => ({ posix: value, windows: value, native: false });
  const evaluate = (node, seen = new Set()) => {
    if (!node || seen.has(node)) return undefined;
    seen = new Set([...seen, node]);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return literal(node.text);
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const declaration = symbol(node)?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration)
        && (declaration.parent.flags & ts.NodeFlags.Const)) return evaluate(declaration.initializer, seen);
      return undefined;
    }
    if (ts.isCallExpression(node)) {
      const args = node.arguments.map((arg) => evaluate(arg, seen));
      if (args.some((arg) => !arg)) return undefined;
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'encodeURIComponent' && !symbol(callee) && args.length === 1) {
        return { posix: encodeURIComponent(args[0].posix), windows: encodeURIComponent(args[0].windows), native: args[0].native };
      }
      const method = ts.isIdentifier(callee) ? imported(callee)
        : ts.isPropertyAccessExpression(callee) && imported(callee.expression) === '*' ? callee.name.text : undefined;
      if (!['resolve', 'join'].includes(method) || !args.length || !path.posix.isAbsolute(args[0].posix)) return undefined;
      return {
        posix: path.posix[method](...args.map((arg) => arg.posix)),
        // The drive is immaterial to the mismatch, but fixing it makes this
        // guard independent of the host's cwd and per-drive working folder.
        windows: path.win32[method](...(method === 'resolve' ? ['C:\\'] : []), ...args.map((arg) => arg.windows)),
        native: true,
      };
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, seen);
      const right = evaluate(node.right, seen);
      if (left && right) return { posix: left.posix + right.posix, windows: left.windows + right.windows, native: left.native || right.native };
    }
    return undefined;
  };
  const problems = [];
  const skippedOnWindows = (node) => {
    for (let owner = node.parent; owner; owner = owner.parent) {
      if (ts.isCallExpression(owner) && ts.isCallExpression(owner.expression)
        && /^(it|test|describe)\.skipIf\(process\.platform\s*===\s*['"]win32['"]\)$/.test(owner.expression.getText())) return true;
    }
    return false;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const assertion = node.expression;
      const expect = assertion.expression;
      if (['toBe', 'toEqual', 'toStrictEqual', 'toContain'].includes(assertion.name.text)
        && ts.isCallExpression(expect) && ts.isIdentifier(expect.expression) && expect.expression.text === 'expect') {
        const actual = evaluate(expect.arguments[0]);
        const expected = evaluate(node.arguments[0]);
        if (actual && expected && (actual.native || expected.native)) {
          const matches = (a, b) => assertion.name.text === 'toContain' ? a.includes(b) : a === b;
          if (matches(actual.posix, expected.posix) && !matches(actual.windows, expected.windows) && !skippedOnWindows(node)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            problems.push(`${filename}:${line + 1}: native path comparison fails on Windows; derive the expectation from the resolved path`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}
