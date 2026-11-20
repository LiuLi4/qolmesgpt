export function controlPlaneStatus(): { adapter: string } {
  return { adapter: "aliyun-sls" };
}

export { PrismaSlsDetectionStore } from "./detection/prisma.js";
export type { EnabledSlsSource, DetectionLog } from "./detection/prisma.js";
export { classifySlsError } from "./integrations/sls/classifier.js";
export { createSlsDetectionRuntime } from "./detection/runtime.js";
export { PrismaInvestigationStore } from "./investigation/prisma.js";
export type { InvestigationJob, InvestigationResult } from "./investigation/prisma.js";
export { createInvestigationRuntime } from "./investigation/runtime.js";
