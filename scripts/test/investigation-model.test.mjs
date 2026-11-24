import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkCompanyKey } from "../check-investigation-model.mjs";

const resolver = fileURLToPath(new URL("../investigation-model.sh", import.meta.url));
function resolve(env) {
  return spawnSync("bash", ["-c", 'set -eu; source "$1"; resolve_investigation_model; printf "%s\\n" "$MODEL" "$API_BASE" "$API_KEY"', "model-test", resolver], {
    env: { PATH: process.env.PATH, API_BASE: "", ...env }, encoding: "utf8",
  });
}

test("company gateway keeps the exact wire model ID and overrides inherited provider settings", () => {
  const result = resolve({ YUANXI_BASE_URL: "https://yuanxi.xrtan.cn/yuanxi/v1/", YUANXI_API_KEY: "company-test-key", YUANXI_MODEL: "anthropic/claude-sonnet-4-5-20250929", OPENROUTER_API_KEY: "router-test-key", API_KEY: "old-key", API_BASE: "https://openrouter.ai/api/v1", MODEL: "old-model" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["openai/anthropic/claude-sonnet-4-5-20250929", "https://yuanxi.xrtan.cn/yuanxi/v1", "company-test-key"]);
});

test("incomplete company configuration fails without leaking secrets or falling back", () => {
  const result = resolve({ YUANXI_API_KEY: "private-company-key", OPENROUTER_API_KEY: "router-test-key", MODEL: "openai/test-model" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /YUANXI_MODEL/);
  assert.doesNotMatch(result.stderr + result.stdout, /private-company-key|router-test-key/);
});

test("company URL must be a complete HTTPS base without duplicate v1 inference", () => {
  for (const base of ["http://yuanxi.xrtan.cn/yuanxi/v1", "https://yuanxi.xrtan.cn", "https://key@yuanxi.xrtan.cn/yuanxi/v1", "https://yuanxi.xrtan.cn/yuanxi/v1?key=hidden", "https://yuanxi.xrtan.cn/yuanxi/v1#fragment"]) {
    const result = resolve({ YUANXI_BASE_URL: base, YUANXI_API_KEY: "company-test-key", YUANXI_MODEL: "model" });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /hidden|company-test-key/);
  }
});

test("an explicit compatible API key is not overwritten by OpenRouter", () => {
  const result = resolve({ MODEL: "openai/company-model", API_BASE: "https://company.test/v1", API_KEY: "explicit-test-key", OPENROUTER_API_KEY: "router-test-key" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["openai/company-model", "https://company.test/v1", "explicit-test-key"]);
});

test("unrelated OpenRouter credentials cannot authenticate a custom endpoint", () => {
  for (const model of ["openai/company-model", "openrouter/test-model"]) {
    const result = resolve({ MODEL: model, API_BASE: "https://company.test/v1", OPENROUTER_API_KEY: "router-test-key" });
    assert.equal(result.status, 1);
  }
});

test("provider specific keys and legacy OpenRouter setup still work", () => {
  const examples = [
    [{ MODEL: "openrouter/test-model", OPENROUTER_API_KEY: "router-key" }, ["openrouter/test-model", "https://openrouter.ai/api/v1", "router-key"]],
    [{ MODEL: "openai/test-model", OPENROUTER_API_KEY: "router-key" }, ["openai/test-model", "https://openrouter.ai/api/v1", "router-key"]],
    [{ MODEL: "openai/test-model", OPENAI_API_KEY: "openai-key", OPENROUTER_API_KEY: "router-key" }, ["openai/test-model", "", "openai-key"]],
    [{ MODEL: "anthropic/test-model", ANTHROPIC_API_KEY: "anthropic-key", OPENROUTER_API_KEY: "router-key" }, ["anthropic/test-model", "", "anthropic-key"]],
  ];
  for (const [env, expected] of examples) {
    const result = resolve(env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), expected);
  }
});

test("company preflight uses the documented key-check path and bearer auth without redirects", async () => {
  let calls = 0;
  await checkCompanyKey("https://yuanxi.xrtan.cn/yuanxi/v1/", "company-test-key", async (url, init) => {
    calls++;
    assert.equal(url, "https://yuanxi.xrtan.cn/yuanxi/v1/key-check");
    assert.equal(init.headers.Authorization, "Bearer company-test-key");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return new Response(JSON.stringify({ valid: true }));
  });
  assert.equal(calls, 1);
});

test("company preflight rejects failed or unconfirmed authentication without returning gateway bodies", async () => {
  await assert.rejects(checkCompanyKey("https://company.test/v1", "test-key", async () => new Response("private-upstream-detail", { status: 401 })), /HTTP 401/);
  await assert.rejects(checkCompanyKey("https://company.test/v1", "test-key", async () => new Response(JSON.stringify({ valid: false }))), /did not confirm/);
});
