export type IrregularMatrixBackend = 'rust' | 'typescript'

export function parseIrregularMatrixBackend(value: string | undefined): IrregularMatrixBackend {
  if (value === undefined || value === 'rust') return 'rust'
  if (value === 'typescript') return value
  throw new Error('--backend must be rust or typescript')
}
