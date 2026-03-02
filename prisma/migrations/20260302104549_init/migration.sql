create type "ConfirmationTokenPurpose" as enum ('EMAIL_UPDATE', 'ACCOUNT_DELETE');

create type "FileVisibility" as enum ('PUBLIC', 'PRIVATE', 'DEDICATED');

create type "PaymentInterval" as enum ('ONCE', 'MONTHLY', 'YEARLY');

create table "AppReleaseAsset"
(
    id           text    not null
        primary key,
    version      text    not null,
    "minVersion" text,
    os           text    not null,
    arch         text    not null,
    type         text    not null,
    standalone   boolean not null,
    url          text    not null
);

create table "SocialProfileProvider"
(
    id            text not null
        primary key,
    provider      text not null,
    name          text not null,
    "urlTemplate" text not null
);

create table "User"
(
    id              text                                     not null
        primary key,
    name            text,
    email           text                                     not null
        unique,
    image           text,
    "createdAt"     timestamp(3) default current_timestamp() not null,
    "updatedAt"     timestamp(3)                             not null,
    "emailVerified" boolean      default false
);

create table "AuditLog"
(
    id          text                                     not null
        primary key,
    "userId"    text
                                                         references "User"
                                                             on update cascade on delete set null,
    action      text                                     not null,
    details     text,
    "ipAddress" text,
    "userAgent" text,
    "createdAt" timestamp(3) default current_timestamp() not null,
    port        text
);

create table "ConfirmationToken"
(
    "userId"   text                     not null
        references "User"
            on update cascade on delete cascade,
    identifier text                     not null,
    token      text                     not null,
    expires    timestamp(3)             not null,
    purpose    "ConfirmationTokenPurpose" not null,
    primary key (identifier, token)
);

create table "Customer"
(
    "userId"    text                                     not null
        primary key
        references "User"
            on update cascade on delete cascade,
    "stripeId"  text                                     not null,
    "createdAt" timestamp(3) default current_timestamp() not null,
    "updatedAt" timestamp(3)                             not null
);

create table "File"
(
    id          text                                     not null
        primary key,
    name        text                                     not null,
    size        bigint                                   not null,
    "mimeType"  text                                     not null,
    "objectKey" text                                     not null,
    "userId"    text                                     not null
        references "User"
            on update cascade on delete cascade,
    sha256      text,
    visibility  "FileVisibility"                           not null,
    "createdAt" timestamp(3) default current_timestamp() not null,
    "updatedAt" timestamp(3)                             not null
);

create table "NativeAppAuth"
(
    id            text not null
        primary key,
    "continueUrl" text not null,
    "sessionId"   text not null,
    "userId"      text
        references "User"
            on update cascade on delete cascade,
    code          text,
    "codeExpires" timestamp(3)
);

create table "Package"
(
    id                 text                                     not null
        primary key,
    name               text                                     not null
        unique,
    "displayName"      text,
    description        text                                     not null,
    "shortDescription" text                                     not null,
    published          boolean                                  not null,
    "webSite"          text                                     not null,
    tags               text[],
    "iconFileId"       text
                                                                references "File"
                                                                    on update cascade on delete set null,
    "userId"           text                                     not null
        references "User"
            on update cascade on delete cascade,
    "createdAt"        timestamp(3) default current_timestamp() not null,
    "updatedAt"        timestamp(3)                             not null,
    interval           "PaymentInterval"
);

create table "PackagePricing"
(
    id          text                                     not null
        primary key,
    "packageId" text                                     not null
        references "Package"
            on update cascade on delete cascade,
    price       bigint                                   not null,
    currency    text                                     not null,
    fallback    boolean                                  not null,
    "createdAt" timestamp(3) default current_timestamp() not null,
    "updatedAt" timestamp(3)                             not null
);

create table "PackageScreenshot"
(
    "packageId" text                                     not null
        references "Package"
            on update cascade on delete cascade,
    "fileId"    text                                     not null
        references "File"
            on update cascade on delete cascade,
    "order"     bigint                                   not null,
    "createdAt" timestamp(3) default current_timestamp() not null,
    "updatedAt" timestamp(3)                             not null,
    primary key ("packageId", "fileId")
);

create table "Profile"
(
    "userId"      text not null
        primary key
        references "User"
            on update cascade on delete cascade,
    "userName"    text not null,
    "displayName" text not null,
    bio           text,
    "iconFileId"  text
                       references "File"
                           on update cascade on delete set null
);

create table "Release"
(
    id              text                                     not null
        primary key,
    "packageId"     text                                     not null
        references "Package"
            on update cascade on delete cascade,
    version         text                                     not null,
    "targetVersion" text                                     not null,
    title           text                                     not null,
    description     text                                     not null,
    "fileId"        text
                                                             references "File"
                                                                 on update cascade on delete set null,
    published       boolean                                  not null,
    "createdAt"     timestamp(3) default current_timestamp() not null,
    "updatedAt"     timestamp(3)                             not null
);

create table "Session"
(
    id          text                                     not null
        primary key,
    token       text                                     not null
        constraint "Session_sessionToken_key"
            unique,
    "userId"    text                                     not null
        references "User"
            on update cascade on delete cascade,
    "expiresAt" timestamp(3)                             not null,
    "createdAt" timestamp(3) default current_timestamp() not null,
    "updatedAt" timestamp(3)                             not null,
    "ipAddress" text,
    "userAgent" text
);

create table "SocialProfile"
(
    value        text not null,
    "userId"     text not null
        references "User"
            on update cascade on delete cascade,
    "providerId" text not null
        references "SocialProfileProvider"
            on update cascade on delete cascade,
    primary key ("userId", "providerId")
);

create table "UserPackage"
(
    "userId"    text                                     not null
        references "User"
            on update cascade on delete cascade,
    "packageId" text                                     not null
        references "Package"
            on update cascade on delete cascade,
    "createdAt" timestamp(3) default current_timestamp() not null,
    primary key ("userId", "packageId")
);

create table "UserPaymentHistory"
(
    id          text                                     not null
        primary key,
    "userId"    text                                     not null
        references "User"
            on update cascade on delete cascade,
    "paymentId" text                                     not null,
    "packageId" text                                     not null,
    "createdAt" timestamp(3) default current_timestamp() not null,
    "updatedAt" timestamp(3)                             not null
);

create table "Account"
(
    id                      text                                     not null
        primary key,
    "userId"                text                                     not null
        references "User"
            on update cascade on delete cascade,
    "accountId"             text                                     not null,
    "providerId"            text                                     not null,
    "accessToken"           text,
    "refreshToken"          text,
    "accessTokenExpiresAt"  timestamp(3),
    "refreshTokenExpiresAt" timestamp(3),
    scope                   text,
    "idToken"               text,
    password                text,
    "createdAt"             timestamp(3) default current_timestamp() not null,
    "updatedAt"             timestamp(3) default current_timestamp() not null,
    unique ("providerId", "accountId")
);

create table "Passkey"
(
    id             text                                     not null
        primary key,
    name           text,
    "publicKey"    text                                     not null,
    "userId"       text                                     not null
        references "User"
            on update cascade on delete cascade,
    "credentialID" text                                     not null
        unique,
    counter        bigint                                   not null,
    "deviceType"   text                                     not null,
    "backedUp"     boolean                                  not null,
    transports     text,
    "createdAt"    timestamp(3) default current_timestamp() not null,
    aaguid         text,
    "usedAt"       timestamp(3)
);

create table "Verification"
(
    id          text                                     not null
        primary key,
    identifier  text                                     not null,
    value       text                                     not null,
    "expiresAt" timestamp(3)                             not null,
    "createdAt" timestamp(3) default current_timestamp() not null,
    "updatedAt" timestamp(3) default current_timestamp() not null
);

