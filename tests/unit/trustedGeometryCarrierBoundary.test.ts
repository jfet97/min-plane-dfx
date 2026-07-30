import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Schema } from 'effect'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
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
    const program = projectProgram()
    const trustedWorkerFiles = program
      .getSourceFiles()
      .map((sourceFile) => resolve(sourceFile.fileName))
      .filter(
        (filePath) =>
          workerRoots.some((root) => filePath.startsWith(`${root}/`)) &&
          !filePath.endsWith('/services.ts') &&
          // `src/workers/irregular/native/` is a genuine untrusted external-process
          // boundary (the irregular-nesting-native N-API addon's JSON wire output),
          // the same conceptual boundary `services.ts` already carries a matching
          // exclusion for (decoding untrusted cache-serialized geometry) -- see
          // `docs/planning/rust-irregular-backend/backend-selection-rollback.md` and
          // `nativeIrregularBackend.ts`'s own module doc.
          !filePath.includes('/workers/irregular/native/')
      )
    expect(schemaReferenceViolations(program, trustedWorkerFiles)).toEqual([])
  })

  it('detects namespace and transitive re-export aliases while allowing runtime classes', () => {
    const program = projectProgram()
    const fixtureRoot = resolve('tests/fixtures/trusted-geometry-carrier-boundary')
    expect(
      schemaReferenceViolations(program, [
        resolve(fixtureRoot, 'namespace-import.ts'),
        resolve(fixtureRoot, 'transitive-alias.ts')
      ]).map(({ symbol }) => symbol)
    ).toEqual(['IrregularPointSchema', 'IrregularPointSchema'])
    expect(
      schemaReferenceViolations(program, [resolve(fixtureRoot, 'runtime-class.ts')])
    ).toEqual([])
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

  it('preserves omission versus explicit undefined on optional constructor fields', () => {
    const source = new ImportedPiece({
      id: PieceId.make('carrier-source'),
      sourceFileId: SourceFileId.make('carrier-file'),
      label: 'carrier source',
      realBounds: new Rect({ x: 0, y: 0, width: 2, height: 1 }),
      geometry: new DxfGeometrySummary({
        entityType: 'PRESET_SHAPE',
        closed: true,
        segments: []
      }),
      warnings: []
    })
    const points = [
      new IrregularPoint({ x: 0, y: 0 }),
      new IrregularPoint({ x: 2, y: 0 }),
      new IrregularPoint({ x: 0, y: 1 })
    ]
    const polygon = new IrregularPolygon({ points })
    const bounds = new IrregularBounds({ minX: 0, minY: 0, maxX: 2, maxY: 1 })
    const collisionGeometry = new CollisionGeometry({
      sourcePieceId: source.id,
      sourceBounds: bounds,
      sampledPoints: points,
      convexHull: polygon,
      collisionPolygon: polygon,
      placementReference: points[0] ?? new IrregularPoint({ x: 0, y: 0 }),
      diagnostics: []
    })
    const transform = new IrregularTransform({
      translateX: 0,
      translateY: 0,
      rotationDeg: 0,
      mirrored: false
    })
    const omittedDiagnostic = new CollisionGeometryDiagnostic({ code: 'omitted', message: 'ok' })
    const explicitDiagnostic = new CollisionGeometryDiagnostic({
      code: 'explicit',
      message: 'ok',
      pieceId: undefined
    })
    const omittedPrepared = new IrregularPreparedPiece({
      source,
      allowMirror: false,
      collisionGeometry,
      transforms: []
    })
    const explicitPrepared = new IrregularPreparedPiece({
      pieceId: undefined,
      interchangeabilityKey: undefined,
      source,
      allowMirror: false,
      collisionGeometry,
      transforms: [],
      priorityOrderKey: undefined
    })
    const omittedPlacement = new IrregularPlacement({
      sourcePieceId: source.id,
      transform
    })
    const explicitPlacement = new IrregularPlacement({
      pieceId: undefined,
      sourcePieceId: source.id,
      placementReference: undefined,
      transform
    })

    expect(Object.hasOwn(omittedDiagnostic, 'pieceId')).toBe(false)
    expect(Object.keys(omittedDiagnostic)).not.toContain('pieceId')
    expect(Object.hasOwn(explicitDiagnostic, 'pieceId')).toBe(true)
    expect(Object.keys(explicitDiagnostic)).toContain('pieceId')
    expect(Object.keys(omittedPrepared)).not.toEqual(
      expect.arrayContaining(['pieceId', 'interchangeabilityKey', 'priorityOrderKey'])
    )
    expect(Object.keys(explicitPrepared)).toEqual(
      expect.arrayContaining(['pieceId', 'interchangeabilityKey', 'priorityOrderKey'])
    )
    expect(Object.keys(omittedPlacement)).not.toEqual(
      expect.arrayContaining(['pieceId', 'placementReference'])
    )
    expect(Object.keys(explicitPlacement)).toEqual(
      expect.arrayContaining(['pieceId', 'placementReference'])
    )
  })
})

interface SchemaReferenceViolation {
  readonly filePath: string
  readonly symbol: string
}

function projectProgram(): ts.Program {
  const configPath = resolve('tsconfig.node.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('.'), {}, configPath)
  return ts.createProgram(parsed.fileNames, parsed.options)
}

function schemaReferenceViolations(
  program: ts.Program,
  filePaths: ReadonlyArray<string>
): ReadonlyArray<SchemaReferenceViolation> {
  const checker = program.getTypeChecker()
  const targetSchemaNames = new Set(
    [...trustedCarrierSchemas.keys()].map((carrierName) => `${carrierName}Schema`)
  )
  const normalizedDomainPath = resolve(domainPath)
  const violations = new Map<string, SchemaReferenceViolation>()

  for (const filePath of filePaths) {
    const sourceFile = program.getSourceFile(filePath)
    if (sourceFile === undefined) throw new Error(`missing TypeScript source file ${filePath}`)
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = resolveAliasedSymbol(checker, checker.getSymbolAtLocation(node))
        if (
          symbol !== undefined &&
          targetSchemaNames.has(symbol.getName()) &&
          symbol.declarations?.some(
            (declaration) => resolve(declaration.getSourceFile().fileName) === normalizedDomainPath
          ) === true
        ) {
          const key = `${filePath}:${symbol.getName()}`
          violations.set(key, { filePath, symbol: symbol.getName() })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return [...violations.values()].toSorted((first, second) =>
    first.filePath === second.filePath
      ? first.symbol.localeCompare(second.symbol)
      : first.filePath.localeCompare(second.filePath)
  )
}

function resolveAliasedSymbol(
  checker: ts.TypeChecker,
  initial: ts.Symbol | undefined
): ts.Symbol | undefined {
  let symbol = initial
  const visited = new Set<ts.Symbol>()
  while (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    if (visited.has(symbol)) return symbol
    visited.add(symbol)
    symbol = checker.getAliasedSymbol(symbol)
  }
  return symbol
}
