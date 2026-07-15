import { Layer } from 'effect'
import { CollisionGeometryBuilder } from './collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from './freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from './geometryKernel.js'
import { NfpIfpServiceLive } from './nfpIfpService.js'
import { TransformGeneratorLive } from './transformGenerator.js'
import { GeometryCacheInMemory } from './services.js'
import { IrregularNestingPortfolioLive } from '../algorithm/irregular/portfolioSearch.js'
import { PriorityOrderServiceLive } from '../algorithm/irregular/priorityOrderService.js'
import { IrregularPlacementScorer } from '../algorithm/irregular/irregularPlacementScorer.js'
import { IrregularLayoutScorer } from '../algorithm/irregular/irregularLayoutScorer.js'

export const IrregularNestingInfrastructureLive = Layer.mergeAll(
  CollisionGeometryBuilder.Live,
  TransformGeneratorLive,
  NfpIfpServiceLive,
  FreeMaterialServiceLive,
  PriorityOrderServiceLive,
  IrregularPlacementScorer.Live,
  IrregularLayoutScorer.Live,
  IrregularNestingPortfolioLive.pipe(
    Layer.provideMerge(GeometryKernel.Live),
    Layer.provideMerge(NfpIfpServiceLive),
    Layer.provideMerge(IrregularPlacementScorer.Live),
    Layer.provideMerge(IrregularLayoutScorer.Live),
    Layer.provideMerge(PriorityOrderServiceLive)
  ),
  GeometryCacheInMemory
).pipe(Layer.provideMerge(GeometrySettings.Live))
