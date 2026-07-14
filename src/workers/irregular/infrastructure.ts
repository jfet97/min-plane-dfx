import { Layer } from 'effect'
import { CollisionGeometryBuilder } from './collisionGeometryBuilder.js'
import {
  FreeMaterialServiceUnimplemented,
  GeometryCacheInMemory,
  IrregularNestingPortfolioUnimplemented,
  NfpIfpServiceUnimplemented,
  PriorityOrderServiceUnimplemented,
  TransformGeneratorUnimplemented
} from './services.js'

export const IrregularNestingInfrastructureLive = Layer.mergeAll(
  CollisionGeometryBuilder.Live,
  TransformGeneratorUnimplemented,
  NfpIfpServiceUnimplemented,
  FreeMaterialServiceUnimplemented,
  PriorityOrderServiceUnimplemented,
  IrregularNestingPortfolioUnimplemented,
  GeometryCacheInMemory
)
