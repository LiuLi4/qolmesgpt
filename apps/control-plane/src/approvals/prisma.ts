import type { PrismaClient } from "../generated/prisma/client.js";
import type { ApprovalRecord, ApprovalStore, ApprovalTask } from "../routes/approvals.js";

export class PrismaApprovalStore implements ApprovalStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findTask(taskId: string): Promise<ApprovalTask | null> {
    const task = await this.prisma.investigationTask.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, status: true, project: { select: { groupId: true, connectionId: true } } },
    });
    if (!task || !task.project || !task.projectId) return null;
    return { taskId: task.id, projectId: task.projectId, groupId: task.project.groupId, gitLabConnectionId: task.project.connectionId, status: task.status as ApprovalTask["status"] };
  }

  async findDecision(taskId: string): Promise<ApprovalRecord | null> {
    const approval = await this.prisma.approval.findUnique({ where: { taskId } });
    if (!approval) return null;
    return {
      id: approval.id,
      taskId: approval.taskId,
      approverUserId: approval.approverUserId,
      role: approval.groupRoleAtApproval as ApprovalRecord["role"],
      decision: approval.decision,
      approvedAt: approval.approvedAt.toISOString(),
      roleCheckedAt: approval.roleCheckedAt.toISOString(),
    };
  }

  async createApproval(input: Omit<ApprovalRecord, "id" | "approvedAt">): Promise<ApprovalRecord> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.investigationTask.updateMany({
          where: { id: input.taskId, status: "AWAITING_APPROVAL" },
          data: { updatedAt: new Date() },
        });
        if (claimed.count !== 1) throw new Error("Task is not awaiting approval");
        const task = await tx.investigationTask.findUnique({ where: { id: input.taskId }, select: { id: true, projectId: true, status: true } });
        if (!task || task.status !== "AWAITING_APPROVAL") throw new Error("Task is not awaiting approval");
        const approval = await tx.approval.create({
          data: {
            taskId: input.taskId,
            approverUserId: input.approverUserId,
            groupRoleAtApproval: input.role,
            decision: input.decision,
            roleCheckedAt: new Date(input.roleCheckedAt),
          },
        });
        if (input.decision === "APPROVED") {
          await tx.outboxMessage.create({
            data: { aggregateType: "InvestigationTask", aggregateId: input.taskId, eventType: "RepairRequested", payload: { taskId: input.taskId, approvalId: approval.id, projectId: task.projectId } },
          });
        } else {
          await tx.investigationTask.update({ where: { id: input.taskId }, data: { status: "CLOSED" } });
        }
        return {
          id: approval.id,
          taskId: approval.taskId,
          approverUserId: approval.approverUserId,
          role: approval.groupRoleAtApproval as ApprovalRecord["role"],
          decision: approval.decision,
          approvedAt: approval.approvedAt.toISOString(),
          roleCheckedAt: approval.roleCheckedAt.toISOString(),
        };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") throw new Error("Task already has a decision");
      throw error;
    }
  }
}
