export interface InvestigationJob {
  readonly outboxId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly workspaceId?: string | null;
  readonly repositories?: readonly { id: string; projectPath: string; workspacePath: string | null }[];
  readonly codeEvidence?: readonly string[];
  readonly errorEventId: string;
  readonly errorEvidence: unknown;
  readonly projectPath: string;
  readonly workspacePath: string | null;
  readonly attempts: number;
}

export interface InvestigationResult {
  readonly summary: string;
  readonly rootCause: string;
  readonly codeContext: string[];
  readonly proposedFix: string;
  readonly confidence: "low" | "medium" | "high";
  readonly affectedProjectIds?: string[];
}

const resultSchema = {
  type: "json_schema",
  json_schema: {
    name: "InvestigationResult",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        rootCause: { type: "string" },
        codeContext: { type: "array", items: { type: "string" } },
        proposedFix: { type: "string" },
        affectedProjectIds: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["summary", "rootCause", "codeContext", "proposedFix", "confidence"],
    },
  },
} as const;

export interface HolmesClient {
  investigate(job: InvestigationJob): Promise<InvestigationResult>;
}

function bounded(value: string, max: number): string { return value.length > max ? `${value.slice(0, max)}…` : value; }

function parseResult(value: unknown): InvestigationResult {
  const response = value as { analysis?: unknown };
  const analysis = typeof response?.analysis === "string" ? response.analysis : "";
  let parsed: unknown = response?.analysis;
  try { parsed = JSON.parse(analysis) as unknown; } catch { /* Holmes may return a non-JSON answer. */ }
  if (!parsed || typeof parsed !== "object") throw new Error("HOLMES_INCOMPLETE_RESULT");
  const result = parsed as Record<string, unknown>;
  if (!["low", "medium", "high"].includes(String(result.confidence)) || typeof result.summary !== "string" || typeof result.rootCause !== "string" || typeof result.proposedFix !== "string" || !Array.isArray(result.codeContext) || result.codeContext.some((item) => typeof item !== "string")) throw new Error("HOLMES_INCOMPLETE_RESULT");
  if (result.affectedProjectIds !== undefined && (!Array.isArray(result.affectedProjectIds) || result.affectedProjectIds.length > 100 || result.affectedProjectIds.some((id) => typeof id !== "string"))) throw new Error("HOLMES_INCOMPLETE_RESULT");
  return {
    affectedProjectIds: result.affectedProjectIds as string[] | undefined,
    summary: bounded(result.summary, 4_000), rootCause: bounded(result.rootCause, 4_000), proposedFix: bounded(result.proposedFix, 4_000),
    codeContext: result.codeContext.slice(0, 20).map((item) => bounded(item as string, 500)), confidence: result.confidence as "low" | "medium" | "high",
  };
}

export class HttpHolmesClient implements HolmesClient {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string, private readonly fetcher: typeof fetch = fetch) {}

  async investigate(job: InvestigationJob): Promise<InvestigationResult> {
    const url = new URL("/api/chat", this.baseUrl);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    const ask = [
      `Investigate the error in GitLab ${job.workspaceId ? "Group Workspace" : "project"} ${job.projectPath}.`,
      "Use the attached log evidence and repository context. Identify the likely root cause, relevant code locations, and a proposed fix. Do not modify files or create a merge request.",
      `Log evidence: ${JSON.stringify(job.errorEvidence)}`,
      `Workspace reference: ${job.workspacePath ?? "not provisioned"}`,
      `Repository inventory: ${bounded(JSON.stringify(job.repositories ?? [{ id: job.projectId, projectPath: job.projectPath, workspacePath: job.workspacePath }]), 60_000)}`,
      `Read-only code evidence: ${bounded(JSON.stringify(job.codeEvidence ?? []), 40_000)}`,
      "Use affectedProjectIds only from this inventory and cite evidence for each. Return an empty list when attribution is uncertain. Never assume the first repository owns the error.",
    ].join("\n");
    const response = await this.fetcher(url, { method: "POST", headers, body: JSON.stringify({ ask, stream: false, response_format: resultSchema }) });
    if (!response.ok) throw new Error(`HOLMES_HTTP_${response.status}`);
    return parseResult(await response.json());
  }
}
