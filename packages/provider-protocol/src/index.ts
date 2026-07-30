import type {
  CallSite,
  ChangedFile,
  CommunityRecord,
  FlowRecord,
  IndexStats,
  ProviderCapabilities,
  ProviderHealth,
  RepositoryOverview,
  Snapshot,
  SymbolRecord,
} from "@veriflow/contracts";

export interface ProgressSink {
  (message: string): void;
}

/**
 * The only contract any code intelligence engine has to satisfy. Exactly one package is allowed to
 * know which engine is behind it.
 */
export interface CodeIntelligenceProvider {
  readonly id: string;

  version(): Promise<string>;
  isAvailable(): Promise<ProviderHealth>;
  capabilities(): Promise<ProviderCapabilities>;

  index(snapshot: SnapshotLike, sink: ProgressSink): Promise<IndexStats>;
  update(snapshot: SnapshotLike, sink: ProgressSink): Promise<IndexStats>;

  overview(snapshot: SnapshotLike): Promise<RepositoryOverview>;
  symbols(snapshot: SnapshotLike): Promise<SymbolRecord[]>;
  callSites(snapshot: SnapshotLike): Promise<CallSite[]>;
  flows(snapshot: SnapshotLike): Promise<FlowRecord[]>;
  communities(snapshot: SnapshotLike): Promise<CommunityRecord[]>;
  changedFiles(snapshot: SnapshotLike): Promise<ChangedFile[]>;
}

/** Providers only need the root and the identity, not the whole stored row. */
export type SnapshotLike = Pick<Snapshot, "path"> & Partial<Pick<Snapshot, "id" | "commitSha">>;

export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    readonly installHint?: string,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * A deterministic provider for tests, so every downstream feature can be built and verified without
 * an external process, a network, or a real repository.
 */
export class FakeProvider implements CodeIntelligenceProvider {
  readonly id = "fake";

  constructor(
    private readonly data: {
      symbols: SymbolRecord[];
      callSites: CallSite[];
      capabilities?: Partial<ProviderCapabilities>;
      flows?: FlowRecord[];
      communities?: CommunityRecord[];
    },
  ) {}

  async version(): Promise<string> {
    return "0.0.0-fake";
  }

  async isAvailable(): Promise<ProviderHealth> {
    return { available: true, version: "0.0.0-fake" };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      languages: ["typescript"],
      imports: true,
      calls: true,
      callSiteLines: true,
      flows: false,
      communities: false,
      coChange: false,
      incremental: true,
      ...this.data.capabilities,
    };
  }

  async index(): Promise<IndexStats> {
    return {
      files: new Set(this.data.symbols.map((s) => s.path)).size,
      nodes: this.data.symbols.length,
      edges: this.data.callSites.length,
      durationMs: 0,
      incremental: false,
    };
  }

  async update(): Promise<IndexStats> {
    return { ...(await this.index()), incremental: true };
  }

  async overview(): Promise<RepositoryOverview> {
    return {
      files: new Set(this.data.symbols.map((s) => s.path)).size,
      symbols: this.data.symbols.length,
      languages: ["typescript"],
      communities: this.data.communities?.length ?? 0,
    };
  }

  async symbols(): Promise<SymbolRecord[]> {
    return this.data.symbols;
  }

  async callSites(): Promise<CallSite[]> {
    return this.data.callSites;
  }

  async flows(): Promise<FlowRecord[]> {
    return this.data.flows ?? [];
  }

  async communities(): Promise<CommunityRecord[]> {
    return this.data.communities ?? [];
  }

  async changedFiles(): Promise<ChangedFile[]> {
    return [];
  }
}
