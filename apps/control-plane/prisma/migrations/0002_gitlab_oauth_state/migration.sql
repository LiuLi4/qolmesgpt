CREATE TABLE "GitLabOAuthState" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "instanceUrl" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifierCiphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitLabOAuthState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitLabOAuthState_stateHash_key" ON "GitLabOAuthState"("stateHash");
CREATE INDEX "GitLabOAuthState_userId_expiresAt_idx" ON "GitLabOAuthState"("userId", "expiresAt");
ALTER TABLE "GitLabOAuthState" ADD CONSTRAINT "GitLabOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
