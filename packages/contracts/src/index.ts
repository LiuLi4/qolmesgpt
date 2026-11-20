export type HealthStatus = "unknown" | "healthy" | "degraded" | "failed";

export type DataSourceKind = "aliyun-sls";

export interface DataSourceAdapterDescriptor {
  readonly kind: DataSourceKind;
  readonly displayName: string;
  readonly capabilities: readonly string[];
}

export const aliyunSlsAdapter: DataSourceAdapterDescriptor = {
  kind: "aliyun-sls",
  displayName: "Alibaba Cloud SLS",
  capabilities: ["bounded-read", "error-classification"],
};

export * from "./domain.js";
export * from "./dto.js";
export * from "./errors.js";
