export interface ControlledHostContract {
  readonly schemaVersion: 1
  readonly host: {
    readonly platform: string
    readonly kernelRelease: string
    readonly architecture: string
    readonly processArchitecture: string
    readonly hardwareThreads: number
    readonly memoryGiB: number
  }
  readonly container: {
    readonly platform: string
    readonly architecture: string
    readonly processArchitecture: string
    readonly imagePlatform: string
    readonly imageArchitecture: string
  }
  readonly dockerDaemon: {
    readonly operatingSystem: string
    readonly name: string
  }
  readonly toolchain: {
    readonly node: string
    readonly pnpm: string
    readonly rustc: string
    readonly rustChannel: string
    readonly rustTarget: string
  }
}

export interface P5RunnerProvenance {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly sourceHost: ControlledHostContract['host'] & {
    readonly cpu: string | undefined
    readonly node: string
    readonly commit: string | undefined
    readonly dirty: boolean | undefined
    readonly sourceDiffFingerprintSha256: string | undefined
    readonly exactCommand: string
  }
  readonly host: ControlledHostContract['host']
  readonly container: ControlledHostContract['container'] & {
    readonly kernelRelease: string
    readonly hardwareThreads: number
    readonly memoryGiB: number
    readonly imageId: string
    readonly repoDigests: ReadonlyArray<string>
    readonly created: string
  }
  readonly toolchain: ControlledHostContract['toolchain']
  readonly docker: {
    readonly clientVersion: string
    readonly serverVersion: string
    readonly context: string
    readonly operatingSystem: string
    readonly name: string
  }
}

export interface ControlledHostMismatch {
  readonly field: string
  readonly expected: unknown
  readonly actual: unknown
}

export interface ControlledHostClassification {
  readonly authoritative: boolean
  readonly status: 'available' | 'blocked'
  readonly controlledLinux: boolean
  readonly reasons: ReadonlyArray<string>
  readonly mismatches: ReadonlyArray<ControlledHostMismatch>
}

export function createSourceDiffFingerprint(input: {
  readonly workingTreeDiff: string
  readonly cachedDiff: string
  readonly status: string
}): string

export function parseWrapperArguments(argv: ReadonlyArray<string>): {
  readonly outputDirectory: string
  readonly image: string
  readonly dryRun: boolean
  readonly help: boolean
  readonly benchmarkArgs: ReadonlyArray<string>
}

export function classifyControlledHost(
  contract: ControlledHostContract,
  provenance: P5RunnerProvenance,
  benchmarkArgs?: ReadonlyArray<string>
): ControlledHostClassification

export function buildAggregateContainerArgs(input: {
  readonly classification: ControlledHostClassification
  readonly outputPath: string
  readonly provenancePath: string
  readonly benchmarkArgs: ReadonlyArray<string>
}): ReadonlyArray<string>
