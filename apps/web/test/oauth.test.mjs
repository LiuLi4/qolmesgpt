import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";

// Exercise the unconfigured deployment without requiring a database or GitLab.
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
delete process.env.GITLAB_OAUTH_CLIENT_ID;
delete process.env.GITLAB_OAUTH_CLIENT_SECRET;
delete process.env.GITLAB_OAUTH_REDIRECT_URI;
delete process.env.DATABASE_URL;
const { server } = await import("../dist/index.js");
if (!server.listening) await once(server, "listening");
after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("unconfigured OAuth stays on QolmesGPT and explains GitLab application setup", async () => {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/gitlab/oauth/start?instanceUrl=http%3A%2F%2Fgit.quantgroup.cn`, { redirect: "manual" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  const body = await response.json();
  assert.equal(body.code, "GITLAB_OAUTH_NOT_CONFIGURED");
  assert.equal(body.redirectUri, "http://127.0.0.1:5050/api/gitlab/oauth/callback");
  assert.match(body.message, /GITLAB_OAUTH_CLIENT_ID/);
  assert.equal(body.authorizationUrl, undefined);
});
