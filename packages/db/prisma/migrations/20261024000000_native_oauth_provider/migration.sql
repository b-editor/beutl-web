-- Existing Cockroach tables may be schema-locked by changefeeds.
ALTER TABLE "User" SET (schema_locked = false);
ALTER TABLE "Session" SET (schema_locked = false);
ALTER TABLE "Verification" SET (schema_locked = false);

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "passkeyVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Jwks" (
    "id" STRING NOT NULL,
    "publicKey" STRING NOT NULL,
    "privateKey" STRING NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "alg" STRING,
    "crv" STRING,

    CONSTRAINT "Jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthClient" (
    "id" STRING NOT NULL,
    "clientId" STRING NOT NULL,
    "clientSecret" STRING,
    "clientDiscoveryId" STRING,
    "disabled" BOOL DEFAULT false,
    "skipConsent" BOOL,
    "enableEndSession" BOOL,
    "subjectType" STRING,
    "scopes" STRING[] DEFAULT ARRAY[]::STRING[],
    "clientCredentialsScopes" STRING[] DEFAULT ARRAY[]::STRING[],
    "userId" STRING,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "name" STRING,
    "uri" STRING,
    "icon" STRING,
    "contacts" STRING[] DEFAULT ARRAY[]::STRING[],
    "tos" STRING,
    "policy" STRING,
    "softwareId" STRING,
    "softwareVersion" STRING,
    "softwareStatement" STRING,
    "redirectUris" STRING[] DEFAULT ARRAY[]::STRING[],
    "postLogoutRedirectUris" STRING[] DEFAULT ARRAY[]::STRING[],
    "backchannelLogoutUri" STRING,
    "backchannelLogoutSessionRequired" BOOL,
    "tokenEndpointAuthMethod" STRING,
    "applicationType" STRING,
    "jwks" STRING,
    "jwksUri" STRING,
    "grantTypes" STRING[] DEFAULT ARRAY[]::STRING[],
    "responseTypes" STRING[] DEFAULT ARRAY[]::STRING[],
    "requirePKCE" BOOL,
    "dpopBoundAccessTokens" BOOL DEFAULT false,
    "referenceId" STRING,
    "metadata" STRING,

    CONSTRAINT "OauthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthResource" (
    "id" STRING NOT NULL,
    "identifier" STRING NOT NULL,
    "name" STRING NOT NULL,
    "accessTokenTtl" INT4,
    "refreshTokenTtl" INT4,
    "signingAlgorithm" STRING,
    "signingKeyId" STRING,
    "allowedScopes" STRING[] DEFAULT ARRAY[]::STRING[],
    "customClaims" STRING,
    "dpopBoundAccessTokensRequired" BOOL DEFAULT false,
    "disabled" BOOL DEFAULT false,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "policyVersion" INT4 DEFAULT 1,
    "metadata" STRING,

    CONSTRAINT "OauthResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthClientResource" (
    "id" STRING NOT NULL,
    "clientId" STRING NOT NULL,
    "resourceId" STRING NOT NULL,
    "metadata" STRING,
    "createdAt" TIMESTAMP(3),

    CONSTRAINT "OauthClientResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthRefreshToken" (
    "id" STRING NOT NULL,
    "token" STRING NOT NULL,
    "clientId" STRING NOT NULL,
    "sessionId" STRING,
    "userId" STRING NOT NULL,
    "referenceId" STRING,
    "authorizationCodeId" STRING,
    "resources" STRING[] DEFAULT ARRAY[]::STRING[],
    "requestedUserInfoClaims" STRING[] DEFAULT ARRAY[]::STRING[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "revoked" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "rotationReplayResponse" STRING,
    "rotationReplayExpiresAt" TIMESTAMP(3),
    "authTime" TIMESTAMP(3),
    "confirmation" STRING,
    "scopes" STRING[] DEFAULT ARRAY[]::STRING[],

    CONSTRAINT "OauthRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthAccessToken" (
    "id" STRING NOT NULL,
    "token" STRING NOT NULL,
    "clientId" STRING NOT NULL,
    "sessionId" STRING,
    "userId" STRING,
    "referenceId" STRING,
    "authorizationCodeId" STRING,
    "resources" STRING[] DEFAULT ARRAY[]::STRING[],
    "requestedUserInfoClaims" STRING[] DEFAULT ARRAY[]::STRING[],
    "refreshId" STRING,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "revoked" TIMESTAMP(3),
    "confirmation" STRING,
    "scopes" STRING[] DEFAULT ARRAY[]::STRING[],

    CONSTRAINT "OauthAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthConsent" (
    "id" STRING NOT NULL,
    "clientId" STRING NOT NULL,
    "userId" STRING,
    "referenceId" STRING,
    "resources" STRING[] DEFAULT ARRAY[]::STRING[],
    "requestedUserInfoClaims" STRING[] DEFAULT ARRAY[]::STRING[],
    "scopes" STRING[] DEFAULT ARRAY[]::STRING[],
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OauthClientAssertion" (
    "id" STRING NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthClientAssertion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeDevice" (
    "id" STRING NOT NULL,
    "userId" STRING NOT NULL,
    "clientId" STRING NOT NULL,
    "keyThumbprint" STRING NOT NULL,
    "name" STRING NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeDevice_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Jwks" SET (schema_locked = false);
ALTER TABLE "OauthClient" SET (schema_locked = false);
ALTER TABLE "OauthResource" SET (schema_locked = false);
ALTER TABLE "OauthClientResource" SET (schema_locked = false);
ALTER TABLE "OauthRefreshToken" SET (schema_locked = false);
ALTER TABLE "OauthAccessToken" SET (schema_locked = false);
ALTER TABLE "OauthConsent" SET (schema_locked = false);
ALTER TABLE "OauthClientAssertion" SET (schema_locked = false);
ALTER TABLE "NativeDevice" SET (schema_locked = false);

-- CreateIndex
CREATE UNIQUE INDEX "OauthClient_clientId_key" ON "OauthClient"("clientId");

-- CreateIndex
CREATE INDEX "OauthClient_userId_idx" ON "OauthClient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OauthResource_identifier_key" ON "OauthResource"("identifier");

-- CreateIndex
CREATE INDEX "OauthClientResource_clientId_idx" ON "OauthClientResource"("clientId");

-- CreateIndex
CREATE INDEX "OauthClientResource_resourceId_idx" ON "OauthClientResource"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "OauthClientResource_clientId_resourceId_key" ON "OauthClientResource"("clientId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "OauthRefreshToken_token_key" ON "OauthRefreshToken"("token");

-- CreateIndex
CREATE INDEX "OauthRefreshToken_clientId_idx" ON "OauthRefreshToken"("clientId");

-- CreateIndex
CREATE INDEX "OauthRefreshToken_sessionId_idx" ON "OauthRefreshToken"("sessionId");

-- CreateIndex
CREATE INDEX "OauthRefreshToken_userId_idx" ON "OauthRefreshToken"("userId");

-- CreateIndex
CREATE INDEX "OauthRefreshToken_authorizationCodeId_idx" ON "OauthRefreshToken"("authorizationCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "OauthAccessToken_token_key" ON "OauthAccessToken"("token");

-- CreateIndex
CREATE INDEX "OauthAccessToken_clientId_idx" ON "OauthAccessToken"("clientId");

-- CreateIndex
CREATE INDEX "OauthAccessToken_sessionId_idx" ON "OauthAccessToken"("sessionId");

-- CreateIndex
CREATE INDEX "OauthAccessToken_userId_idx" ON "OauthAccessToken"("userId");

-- CreateIndex
CREATE INDEX "OauthAccessToken_authorizationCodeId_idx" ON "OauthAccessToken"("authorizationCodeId");

-- CreateIndex
CREATE INDEX "OauthAccessToken_refreshId_idx" ON "OauthAccessToken"("refreshId");

-- CreateIndex
CREATE INDEX "OauthConsent_clientId_idx" ON "OauthConsent"("clientId");

-- CreateIndex
CREATE INDEX "OauthConsent_userId_idx" ON "OauthConsent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NativeDevice_userId_clientId_keyThumbprint_key" ON "NativeDevice"("userId", "clientId", "keyThumbprint");

-- CreateIndex
CREATE INDEX "Verification_expiresAt_idx" ON "Verification"("expiresAt");

-- AddForeignKey
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthClientResource" ADD CONSTRAINT "OauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthClientResource" ADD CONSTRAINT "OauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "OauthResource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "OauthRefreshToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeDevice" ADD CONSTRAINT "NativeDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- First-party public native client. Loopback ports are validated by Better Auth.
INSERT INTO "OauthClient" (
  "id", "clientId", "name", "tokenEndpointAuthMethod", "applicationType",
  "redirectUris", "scopes", "grantTypes", "responseTypes", "requirePKCE",
  "dpopBoundAccessTokens", "skipConsent", "disabled", "createdAt", "updatedAt"
) VALUES (
  'beutl-desktop', 'beutl-desktop', 'Beutl Desktop', 'none', 'native',
  ARRAY['http://127.0.0.1/__/auth/handler/', 'http://[::1]/__/auth/handler/'],
  ARRAY['beutl:desktop', 'offline_access'], ARRAY['authorization_code', 'refresh_token'],
  ARRAY['code'], true, true, false, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

ALTER TABLE "User" SET (schema_locked = true);
ALTER TABLE "Session" SET (schema_locked = true);
ALTER TABLE "Verification" SET (schema_locked = true);

ALTER TABLE "Jwks" SET (schema_locked = true);
ALTER TABLE "OauthClient" SET (schema_locked = true);
ALTER TABLE "OauthResource" SET (schema_locked = true);
ALTER TABLE "OauthClientResource" SET (schema_locked = true);
ALTER TABLE "OauthRefreshToken" SET (schema_locked = true);
ALTER TABLE "OauthAccessToken" SET (schema_locked = true);
ALTER TABLE "OauthConsent" SET (schema_locked = true);
ALTER TABLE "OauthClientAssertion" SET (schema_locked = true);
ALTER TABLE "NativeDevice" SET (schema_locked = true);
