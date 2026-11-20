export type DataSourceTestStatus = "passed" | "no_data" | "failed";

export interface BoundedRange {
  readonly from: Date;
  readonly to: Date;
}

export interface DataSourceConnectionTestResult {
  readonly status: Exclude<DataSourceTestStatus, "no_data">;
  readonly safeSummary: Record<string, string | number | boolean | null>;
  readonly errorCode?: string;
}

export interface DataSourceReadTestResult<TRecord = unknown> {
  readonly status: DataSourceTestStatus;
  readonly records: readonly TRecord[];
  readonly safeSummary: Record<string, string | number | boolean | null>;
  readonly errorCode?: string;
}

export interface DataSourceAdapter<TConfig, TRecord = unknown> {
  validate(config: TConfig): Promise<DataSourceConnectionTestResult>;
  readSample(config: TConfig, range: BoundedRange, limit: number): Promise<DataSourceReadTestResult<TRecord>>;
  search(config: TConfig, query: string, range: BoundedRange, limit: number): Promise<DataSourceReadTestResult<TRecord>>;
}
