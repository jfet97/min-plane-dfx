import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve('src/workers/irregular')
const coreRoot = join(sourceRoot, 'core')

describe('pure irregular core boundary', () => {
  it('keeps the complete relative-import closure free of Effect and shared domain models', () => {
    const visited = new Set<string>()
    const pending = readdirSync(coreRoot)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(coreRoot, name))

    while (pending.length > 0) {
      const filePath = pending.pop()
      if (filePath === undefined || visited.has(filePath)) continue
      visited.add(filePath)
      const source = readFileSync(filePath, 'utf8')

      const specifiers = moduleSpecifiers(source, filePath)
      expect(
        specifiers.filter(isProhibitedSpecifier),
        `${filePath} imports prohibited modules`
      ).toEqual([])

      for (const specifier of specifiers.filter((value) => value.startsWith('.'))) {
        const dependencyPath = resolveTypeScriptDependency(filePath, specifier)
        expect(dependencyPath, `${filePath} imports ${specifier}`).toBeDefined()
        if (dependencyPath !== undefined) pending.push(dependencyPath)
      }
    }

    expect(visited.size).toBeGreaterThan(readdirSync(coreRoot).length)
  })

  it('recognizes every prohibited static, side-effect, export, dynamic, and require form', () => {
    const source = [
      "import { Effect } from 'effect'",
      "import * as Schema from 'effect/Schema'",
      "import 'effect'",
      "import legacy = require('effect/Schema')",
      "export { value } from '@shared/domain/value.js'",
      "const lazy = import('effect/Schema')",
      "const lazyTemplate = import(`effect/Schema`)",
      "const required = require('@shared/irregular/domain.js')",
      "const requiredTemplate = require(`@shared/irregular/domain.js`)"
    ].join('\n')

    expect(moduleSpecifiers(source, 'negative-fixture.ts').filter(isProhibitedSpecifier)).toEqual([
      'effect',
      'effect/Schema',
      'effect',
      'effect/Schema',
      '@shared/domain/value.js',
      'effect/Schema',
      'effect/Schema',
      '@shared/irregular/domain.js',
      '@shared/irregular/domain.js'
    ])
  })
})

function moduleSpecifiers(source: string, filePath: string): ReadonlyArray<string> {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node)) {
      const argument = node.arguments[0]
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (
        (isDynamicImport || isRequire) &&
        argument !== undefined &&
        ts.isStringLiteralLike(argument)
      ) {
        specifiers.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

function isProhibitedSpecifier(specifier: string): boolean {
  return (
    specifier === 'effect' ||
    specifier.startsWith('effect/') ||
    specifier.startsWith('@shared/')
  )
}

function resolveTypeScriptDependency(
  importerPath: string,
  specifier: string
): string | undefined {
  const resolvedPath = resolve(dirname(importerPath), specifier)
  const candidates = [
    resolvedPath.replace(/\.js$/u, '.ts'),
    `${resolvedPath}.ts`,
    join(resolvedPath, 'index.ts')
  ]
  return candidates.find((candidate) => existsSync(candidate))
}
