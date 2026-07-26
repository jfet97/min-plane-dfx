import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

      expect(source, filePath).not.toMatch(/from\s+['"]effect['"]/u)
      expect(source, filePath).not.toMatch(/from\s+['"]@shared\//u)
      expect(source, filePath).not.toMatch(/import\s+\{[^}]*\bSchema\b[^}]*\}\s+from/u)

      for (const specifier of relativeImportSpecifiers(source)) {
        const dependencyPath = resolveTypeScriptDependency(filePath, specifier)
        expect(dependencyPath, `${filePath} imports ${specifier}`).toBeDefined()
        if (dependencyPath !== undefined) pending.push(dependencyPath)
      }
    }

    expect(visited.size).toBeGreaterThan(readdirSync(coreRoot).length)
  })
})

function relativeImportSpecifiers(source: string): ReadonlyArray<string> {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier?.startsWith('.') === true)
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
