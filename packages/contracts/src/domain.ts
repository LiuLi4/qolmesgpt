export const taskStatuses = [
  "INVESTIGATION_PENDING",
  "INVESTIGATING",
  "AWAITING_APPROVAL",
  "REPAIRING",
  "VERIFIED",
  "FAILED",
  "CLOSED",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type TaskPriority = "HIGH";

const transitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  INVESTIGATION_PENDING: ["INVESTIGATING", "CLOSED"],
  INVESTIGATING: ["AWAITING_APPROVAL", "FAILED", "CLOSED"],
  AWAITING_APPROVAL: ["REPAIRING", "CLOSED"],
  REPAIRING: ["VERIFIED", "FAILED", "CLOSED"],
  VERIFIED: ["CLOSED"],
  FAILED: ["CLOSED", "INVESTIGATING"],
  CLOSED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
  return to;
}

export function taskPriority(): TaskPriority {
  return "HIGH";
}
