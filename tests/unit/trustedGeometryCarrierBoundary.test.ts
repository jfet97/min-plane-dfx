import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Schema } from 'effect'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  CollisionGeometry,
  CollisionGeometryDiagnostic,
  CollisionGeometryDiagnosticSchema,
  CollisionGeometrySchema,
  FlattenedGeometry,
  FlattenedGeometrySchema,
  FreeMaterialRegion,
  FreeMaterialRegionSchema,
  FreeMaterialSnapshot,
  FreeMaterialSnapshotSchema,
  IrregularBounds,
  IrregularBoundsSchema,
  IrregularGeometryCacheKey,
  IrregularGeometryCacheKeySchema,
  IrregularIfpBounds,
  IrregularIfpBoundsSchema,
  IrregularNfp,
  IrregularNfpSchema,
  IrregularPlacement,
  IrregularPlacementSchema,
  IrregularPoint,
  IrregularPointSchema,
  IrregularPolygon,
  IrregularPolygonSchema,
  IrregularPreparedPiece,
  IrregularPreparedPieceSchema,
  IrregularPriorityOrderKey,
  IrregularPriorityOrderKeySchema,
  IrregularTransform,
  IrregularTransformCandidate,
  IrregularTransformCandidateSchema,
  IrregularTransformSchema
} from '@shared/irregular/domain.js'

const domainPath = resolve('src/shared/irregular/domain.ts')
const workerRoots = [
  resolve('src/workers/algorithm/irregular'),
  resolve('src/workers/irregular')
]
const trustedCarrierNames = [
  'CollisionGeometry',
  'CollisionGeometryDiagnostic',
  'FlattenedGeometry',
  'FreeMaterialRegion',
  'FreeMaterialSnapshot',
  'IrregularBounds',
  'IrregularGeometryCacheKey',
  'IrregularIfpBounds',
  'IrregularNfp',
  'IrregularPlacement',
  'IrregularPoint',
  'IrregularPolygon',
  'IrregularPreparedPiece',
  'IrregularPriorityOrderKey',
  'IrregularTransform',
  'IrregularTransformCandidate'
] as const
const trustedCarrierSchemas = new Map<string, Schema.Top>([
  ['CollisionGeometry', CollisionGeometrySchema],
  ['CollisionGeometryDiagnostic', CollisionGeometryDiagnosticSchema],
  ['FlattenedGeometry', FlattenedGeometrySchema],
  ['FreeMaterialRegion', FreeMaterialRegionSchema],
  ['FreeMaterialSnapshot', FreeMaterialSnapshotSchema],
  ['IrregularBounds', IrregularBoundsSchema],
  ['IrregularGeometryCacheKey', IrregularGeometryCacheKeySchema],
  ['IrregularIfpBounds', IrregularIfpBoundsSchema],
  ['IrregularNfp', IrregularNfpSchema],
  ['IrregularPlacement', IrregularPlacementSchema],
  ['IrregularPoint', IrregularPointSchema],
  ['IrregularPolygon', IrregularPolygonSchema],
  ['IrregularPreparedPiece', IrregularPreparedPieceSchema],
  ['IrregularPriorityOrderKey', IrregularPriorityOrderKeySchema],
  ['IrregularTransform', IrregularTransformSchema],
  ['IrregularTransformCandidate', IrregularTransformCandidateSchema]
])
const trustedCarrierConstructors = new Map<string, unknown>([
  ['CollisionGeometry', CollisionGeometry],
  ['CollisionGeometryDiagnostic', CollisionGeometryDiagnostic],
  ['FlattenedGeometry', FlattenedGeometry],
  ['FreeMaterialRegion', FreeMaterialRegion],
  ['FreeMaterialSnapshot', FreeMaterialSnapshot],
  ['IrregularBounds', IrregularBounds],
  ['IrregularGeometryCacheKey', IrregularGeometryCacheKey],
  ['IrregularIfpBounds', IrregularIfpBounds],
  ['IrregularNfp', IrregularNfp],
  ['IrregularPlacement', IrregularPlacement],
  ['IrregularPoint', IrregularPoint],
  ['IrregularPolygon', IrregularPolygon],
  ['IrregularPreparedPiece', IrregularPreparedPiece],
  ['IrregularPriorityOrderKey', IrregularPriorityOrderKey],
  ['IrregularTransform', IrregularTransform],
  ['IrregularTransformCandidate', IrregularTransformCandidate]
])

describe('trusted geometry carrier boundary', () => {
  it('keeps every trusted carrier as a plain class beside a separate boundary schema', () => {
    const source = readFileSync(domainPath, 'utf8')
    const sourceFile = ts.createSourceFile(
      domainPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const declarations = new Map<string, ts.ClassDeclaration>()
    for (const statement of sourceFile.statements) {
      if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
        declarations.set(statement.name.text, statement)
      }
    }

    for (const carrierName of trustedCarrierNames) {
      const declaration = declarations.get(carrierName)
      expect(declaration, `${carrierName} must remain a declared runtime class`).toBeDefined()
      expect(
        declaration?.heritageClauses ?? [],
        `${carrierName} must not extend Schema.Class`
      ).toEqual([])
      expect(trustedCarrierSchemas.has(carrierName)).toBe(true)
      expect(trustedCarrierConstructors.has(carrierName)).toBe(true)
    }
  })

  it('keeps boundary schema symbols out of trusted algorithm imports', () => {
    const violations: string[] = []
    for (const workerRoot of workerRoots) {
      for (const filePath of TypeScriptFilesUnder(workerRoot)) {
        if (filePath.endsWith('/services.ts')) continue
        const sourceFile = ts.createSourceFile(
          filePath,
          readFileSync(filePath, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS
        )
        for (const statement of sourceFile.statements) {
          if (!ts.isImportDeclaration(statement)) continue
          const bindings = statement.importClause?.namedBindings
          if (bindings === undefined || !ts.isNamedImports(bindings)) continue
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text
            if (
              importedName.endsWith('Schema') &&
              trustedCarrierSchemas.has(importedName.replace(/Schema$/u, ''))
            ) {
              violations.push(`${filePath}:${importedName}`)
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('decodes boundary geometry into ordinary structural records', () => {
    const polygon = Schema.decodeUnknownSync(IrregularPolygonSchema)({
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 1 }
      ]
    })

    expect(Object.getPrototypeOf(polygon)).toBe(Object.prototype)
    expect(polygon.points.every((point) => Object.getPrototypeOf(point) === Object.prototype)).toBe(
      true
    )
    expect(() =>
      Schema.decodeUnknownSync(IrregularBoundsSchema)({
        minX: 2,
        minY: 0,
        maxX: 1,
        maxY: 1
      })
    ).toThrow()
  })
})

function TypeScriptFilesUnder(root: string): ReadonlyArray<string> {
  const files: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined) continue
    for (const name of readdirSync(path)) {
      const child = join(path, name)
      if (statSync(child).isDirectory()) {
        pending.push(child)
      } else if (child.endsWith('.ts')) {
        files.push(child)
      }
    }
  }
  return files
}
