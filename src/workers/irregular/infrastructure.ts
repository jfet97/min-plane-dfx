import { Layer } from 'effect'
import { GeometryKernel } from './geometryKernel.js'
import {
  CollisionGeometryBuilderUnimplemented,
  FreeMaterialServiceUnimplemented,
  GeometryCacheInMemory,
  IrregularNestingPortfolioUnimplemented,
  NfpIfpServiceUnimplemented,
  PriorityOrderServiceUnimplemented,
  TransformGeneratorUnimplemented
} from './services.js'

export const IrregularNestingInfrastructureLive = Layer.mergeAll(
  GeometryKernel.Live,
  CollisionGeometryBuilderUnimplemented,
  TransformGeneratorUnimplemented,
  NfpIfpServiceUnimplemented,
  FreeMaterialServiceUnimplemented,
  PriorityOrderServiceUnimplemented,
  IrregularNestingPortfolioUnimplemented,
  GeometryCacheInMemory
)
