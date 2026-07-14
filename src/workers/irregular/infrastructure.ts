import { Layer } from 'effect'
import { CollisionGeometryBuilder } from './collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from './freeMaterialService.js'
import { NfpIfpServiceLive } from './nfpIfpService.js'
import { TransformGeneratorLive } from './transformGenerator.js'
import {
  GeometryCacheInMemory,
  IrregularNestingPortfolioUnimplemented,
  PriorityOrderServiceUnimplemented
} from './services.js'

export const IrregularNestingInfrastructureLive = Layer.mergeAll(
  CollisionGeometryBuilder.Live,
  TransformGeneratorLive,
  NfpIfpServiceLive,
  FreeMaterialServiceLive,
  PriorityOrderServiceUnimplemented,
  IrregularNestingPortfolioUnimplemented,
  GeometryCacheInMemory
)
