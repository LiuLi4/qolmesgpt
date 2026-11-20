import assert from "node:assert/strict";
import test from "node:test";
import { canTransition, taskPriority, transitionTask } from "../src/domain.ts";

test("accepts the approved task path", () => {
  assert.equal(canTransition("INVESTIGATION_PENDING", "INVESTIGATING"), true);
  assert.equal(transitionTask("AWAITING_APPROVAL", "REPAIRING"), "REPAIRING");
  assert.equal(taskPriority(), "HIGH");
});

test("rejects repair without approval", () => {
  assert.equal(canTransition("INVESTIGATING", "REPAIRING"), false);
  assert.throws(() => transitionTask("INVESTIGATING", "REPAIRING"), /Invalid task transition/);
});
