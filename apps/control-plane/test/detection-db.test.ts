import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { decryptSecret, encryptSecret } from "@qolmesgpt/security";
import { isolatedDatabase } from "./database-fixture.ts";
import { PrismaSlsDetectionStore } from "../dist/detection/prisma.js";
import { PrismaSlsDataSourceWriter, PrismaSlsVerificationStore } from "../dist/integrations/sls/prisma.js";
import { parseEncryptedSecret } from "../dist/integrations/gitlab/types.js";

test("SLS detection persists deduplicated evidence and grouped tasks and rolls back failures", { skip: !process.env.DATABASE_URL }, async () => {
  const database = await isolatedDatabase(process.env.DATABASE_URL!);
  const { prisma } = database;
  const key = randomBytes(32);
  const store = new PrismaSlsDetectionStore(prisma, { getKey: () => key });
  const user = await prisma.user.create({ data: { authSubject: `test-${randomUUID()}` } });
  try {
    const gitlab = await prisma.gitLabConnection.create({
      data: { userId: user.id, instanceUrl: "https://gitlab.example.test", authType: "PAT", accessTokenCiphertext: "fixture", credentialKeyVersion: "v1" },
    });
    const group = await prisma.gitLabGroup.create({ data: { connectionId: gitlab.id, externalGroupId: "1", fullPath: "test" } });
    const project = await prisma.project.create({
      data: { connectionId: gitlab.id, groupId: group.id, externalProjectId: "1", pathWithNamespace: "test/project", defaultBranch: "main", createdByUserId: user.id },
    });
    const connection = await prisma.dataSourceConnection.create({
      data: {
        projectId: project.id, type: "ALIYUN_SLS", status: "ENABLED",
        configJson: { endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "telemetry", logstore: "staging" },
        credentialsCiphertext: JSON.stringify(encryptSecret(JSON.stringify({ accessKeyId: "id", accessKeySecret: "secret" }), "v1", { getKey: () => key })),
        credentialKeyVersion: "v1",
      },
    });
    const verification = new PrismaSlsVerificationStore(prisma, {
      encrypt: (value) => encryptSecret(value, "v1", { getKey: () => key }),
      decrypt: (value) => decryptSecret(parseEncryptedSecret(value), { getKey: () => key }),
    });
    const savedConfig = {
      endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "telemetry", logstore: "staging",
      accessKeyId: "id", accessKeySecret: "secret",
    };

    const workspace = await prisma.groupWorkspace.create({ data: { groupId: group.id, relativePath: "groups/test", status: "READY" } });
    const writer = new PrismaSlsDataSourceWriter(prisma, {
      encrypt: (value) => encryptSecret(value, "v1", { getKey: () => key }),
      decrypt: (value) => decryptSecret(parseEncryptedSecret(value), { getKey: () => key }),
    }, "v1");
    const firstSource = await writer.createForWorkspace(workspace.id, user.id, savedConfig);
    const secondSource = await writer.createForWorkspace(workspace.id, user.id, { ...savedConfig, logstore: "other" });
    assert.notEqual(firstSource.id, secondSource.id);
    await writer.createForWorkspace(workspace.id, user.id, { ...savedConfig, logstore: "updated" }, secondSource.id);
    const workspaceSources = await prisma.dataSourceConnection.findMany({ where: { workspaceId: workspace.id } });
    assert.equal(workspaceSources.length, 2);
    assert.equal((workspaceSources.find((item) => item.id === firstSource.id)?.configJson as any).logstore, "staging");
    assert.equal((workspaceSources.find((item) => item.id === secondSource.id)?.configJson as any).logstore, "updated");
    await assert.rejects(writer.createForWorkspace(workspace.id, user.id, savedConfig, randomUUID()), /not found/);

    assert.equal(await verification.matchesConfig(connection.id, savedConfig), true);
    assert.equal(await verification.matchesConfig(connection.id, { ...savedConfig, endpoint: "https://cn-beijing.log.aliyuncs.com" }), false);
    assert.equal(await verification.matchesConfig(connection.id, { ...savedConfig, project: "other-project" }), false);
    assert.equal(await verification.matchesConfig(connection.id, { ...savedConfig, accessKeySecret: "other-secret" }), false);
    assert.equal(await verification.matchesConfig(randomUUID(), savedConfig), false);
    assert.equal(await verification.canEnable(connection.id), false);
    await verification.recordConnection(connection.id, { status: "passed", safeSummary: {} });
    await verification.recordRead(connection.id, { status: "passed", records: [], safeSummary: {} });
    assert.equal(await verification.canEnable(connection.id), true);
    await verification.recordRead(connection.id, { status: "failed", records: [], safeSummary: {} });
    assert.equal(await verification.canEnable(connection.id), false);
    await verification.recordRead(connection.id, { status: "passed", records: [], safeSummary: {} });
    await prisma.dataSourceConnection.update({ where: { id: connection.id }, data: { configJson: { endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "telemetry", logstore: "new-staging" } } });
    assert.equal(await verification.canEnable(connection.id), false);
    await assert.rejects(verification.enable(connection.id), /must both pass/);
    await verification.recordConnection(connection.id, { status: "passed", safeSummary: {} });
    await verification.recordRead(connection.id, { status: "passed", records: [], safeSummary: {} });
    assert.deepEqual(await verification.enable(connection.id), { status: "ENABLED" });
    assert.equal(await store.claim(connection.id, "qolmesgpt-test", "worker-a"), true);
    assert.equal(await store.claim(connection.id, "qolmesgpt-test", "worker-b"), false);
    assert.equal(await store.renew(connection.id, "worker-a"), true);
    assert.equal(await store.renew(connection.id, "worker-b"), false);
    await store.setState(connection.id, "qolmesgpt-test", "worker-a", "RUNNING", [0], { lagging: false });
    await store.release(connection.id, "worker-b");
    assert.equal((await prisma.sLSConsumerState.findUnique({ where: { connectionId: connection.id } }))?.status, "RUNNING");
    await store.release(connection.id, "worker-a");
    assert.equal(await store.claim(connection.id, "qolmesgpt-test", "worker-b"), true);
    await store.release(connection.id, "worker-b");
    const source = (await store.listEnabled()).find((item) => item.id === connection.id);
    assert.ok(source);
    assert.equal(source.accessKeySecret, "secret");
    assert.equal(await store.claim(connection.id, "qolmesgpt-test", "metrics-worker"), true);
    await store.recordBatch(source, [{ sourcePositionKey: "normal-preview", record: { __time__: 1794818108, level: 30, msg: "request completed password=customer-secret", content: '{"token":"preview-token"}' } }], 0, "metrics-worker");
    await store.setState(connection.id, "qolmesgpt-test", "metrics-worker", "RUNNING", [0], { lagging: false });
    const telemetry = (await prisma.sLSConsumerState.findUniqueOrThrow({ where: { connectionId: connection.id } })).checkpointSummary as Record<string, unknown>;
    assert.equal(telemetry.logsConsumed, 1);
    assert.equal(telemetry.tasksCreated, 0);
    assert.equal(telemetry.lastLogAt, new Date(1794818108000).toISOString());
    assert.doesNotMatch(JSON.stringify(telemetry), /customer-secret|preview-token/);
    await assert.rejects(store.recordBatch(source, [{ sourcePositionKey: "x", record: { __time__: 1 } }], 0, "other-worker"), /lease/);
    await store.release(connection.id, "metrics-worker");

    const invalidProject = await prisma.project.create({
      data: { connectionId: gitlab.id, groupId: group.id, externalProjectId: "2", pathWithNamespace: "test/invalid", defaultBranch: "main", createdByUserId: user.id },
    });
    const invalid = await prisma.dataSourceConnection.create({
      data: {
        projectId: invalidProject.id, type: "ALIYUN_SLS", status: "ENABLED",
        configJson: { endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "telemetry", logstore: "staging" },
        credentialsCiphertext: "corrupt", credentialKeyVersion: "v1",
      },
    });
    assert.deepEqual((await store.listEnabled()).map((item) => item.id), [connection.id]);
    assert.equal((await prisma.sLSConsumerState.findUnique({ where: { connectionId: invalid.id } }))?.status, "FAILED");
    const record = {
      __time__: 1794818108,
      level: 50,
      service: "ec-saas",
      msg: "database timeout",
      content: '{"token":"must-not-persist","detail":"timeout"}',
    };
    const a = { sourcePositionKey: "shard:0:cursor:a:ordinal:0", record };
    const b = { sourcePositionKey: "shard:0:cursor:a:ordinal:1", record };
    assert.equal(await store.persist(source, [a, b, { sourcePositionKey: "normal", record: { __time__: 1794818108, level: 30, msg: "request completed" } }]), 1);
    assert.equal(await store.persist(source, [a, b]), 0);
    assert.equal(await prisma.errorEvent.count({ where: { dataSourceConnectionId: connection.id } }), 2);
    const events = await prisma.errorEvent.findMany({ where: { dataSourceConnectionId: connection.id }, orderBy: { sourcePositionKey: "asc" } });
    assert.equal(events[0]?.fingerprint, events[1]?.fingerprint);
    assert.doesNotMatch(JSON.stringify(events), /must-not-persist/);
    assert.equal(await prisma.investigationTask.count({ where: { projectId: project.id, status: "INVESTIGATION_PENDING", priority: "HIGH" } }), 1);
    assert.equal(await prisma.outboxMessage.count({ where: { eventType: "InvestigationRequested", task: { projectId: project.id } } }), 1);

    await store.persist(source, [{
      sourcePositionKey: "long-content",
      record: { __time__: 1794818108, level: 50, content: JSON.stringify({ token: "must-not-persist-long", message: "x".repeat(5_000) }) },
    }]);
    const longEvidence = await prisma.errorEvent.findUniqueOrThrow({
      where: { dataSourceConnectionId_sourcePositionKey: { dataSourceConnectionId: connection.id, sourcePositionKey: "long-content" } },
    });
    assert.doesNotMatch(JSON.stringify(longEvidence.logEvidenceJson), /must-not-persist-long/);
    await store.persist(source, [{
      sourcePositionKey: "embedded-secret",
      record: { __time__: 1794818108, level: 50, msg: 'request failed Authorization: Bearer opaque-token accessKeySecret=secret password="customer-secret" token: "another-secret"' },
    }]);
    const embedded = await prisma.errorEvent.findUniqueOrThrow({
      where: { dataSourceConnectionId_sourcePositionKey: { dataSourceConnectionId: connection.id, sourcePositionKey: "embedded-secret" } },
    });
    assert.doesNotMatch(JSON.stringify(embedded.logEvidenceJson), /opaque-token|accessKeySecret=secret|customer-secret|another-secret/);

    const many = Array.from({ length: 101 }, (_, index) => ({
      sourcePositionKey: `bulk-${index}`,
      record: { __time__: index === 100 ? "invalid" : 1794818108, level: 50, msg: "bulk error" },
    }));
    await assert.rejects(store.persist(source, many));
    assert.equal(await prisma.errorEvent.count({ where: { dataSourceConnectionId: connection.id } }), 104);
    const corrected = many.map((log) => ({ ...log, record: { ...log.record, __time__: 1794818108 } }));
    assert.equal(await store.persist(source, corrected), 0);
    assert.equal(await store.persist(source, corrected), 0);
    assert.equal(await prisma.investigationTask.count({ where: { projectId: project.id } }), 4);
    assert.equal(await prisma.outboxMessage.count({ where: { task: { projectId: project.id } } }), 4);

    await assert.rejects(store.persist({ id: connection.id, projectId: randomUUID() }, [{ sourcePositionKey: "rollback", record }]));
    assert.equal(await prisma.errorEvent.count({ where: { dataSourceConnectionId: connection.id } }), 105);
  } finally {
    await prisma.project.deleteMany({ where: { createdByUserId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await database.close();
  }
});
