import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  boolean,
  bigint,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";

// ============ Enums ============

export const confirmationTokenPurposeEnum = pgEnum(
  "ConfirmationTokenPurpose",
  ["EMAIL_UPDATE", "ACCOUNT_DELETE"],
);
export const fileVisibilityEnum = pgEnum("FileVisibility", [
  "PUBLIC",
  "PRIVATE",
  "DEDICATED",
]);
export const paymentIntervalEnum = pgEnum("PaymentInterval", [
  "ONCE",
  "MONTHLY",
  "YEARLY",
]);
export const feedbackCategoryEnum = pgEnum("FeedbackCategory", [
  "BUG_REPORT",
  "FEATURE_REQUEST",
  "QUESTION",
  "OTHER",
]);

// ============ Tables ============

export const user = pgTable("User", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").notNull().unique(),
  image: text("image"),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
  emailVerified: boolean("emailVerified").default(false),
});

export const account = pgTable(
  "Account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", {
      precision: 3,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", {
      precision: 3,
      mode: "date",
    }),
    scope: text("scope"),
    idToken: text("idToken"),
    password: text("password"),
    createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.providerId, table.accountId)],
);

export const session = pgTable("Session", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  token: text("token").notNull().unique("Session_sessionToken_key"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expiresAt", { precision: 3, mode: "date" }).notNull(),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
});

export const verification = pgTable("Verification", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt", { precision: 3, mode: "date" }).notNull(),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const passkey = pgTable("Passkey", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  publicKey: text("publicKey").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credentialID").notNull().unique(),
  counter: bigint("counter", { mode: "number" }).notNull(),
  deviceType: text("deviceType").notNull(),
  backedUp: boolean("backedUp").notNull(),
  transports: text("transports"),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  aaguid: text("aaguid"),
  usedAt: timestamp("usedAt", { precision: 3, mode: "date" }),
});

export const confirmationToken = pgTable(
  "ConfirmationToken",
  {
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { precision: 3, mode: "date" }).notNull(),
    purpose: confirmationTokenPurposeEnum("purpose").notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

export const profile = pgTable("Profile", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  userName: text("userName").notNull(),
  displayName: text("displayName").notNull(),
  bio: text("bio"),
  iconFileId: text("iconFileId").references(() => file.id, {
    onDelete: "set null",
  }),
});

export const socialProfileProvider = pgTable("SocialProfileProvider", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  urlTemplate: text("urlTemplate").notNull(),
});

export const socialProfile = pgTable(
  "SocialProfile",
  {
    value: text("value").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerId: text("providerId")
      .notNull()
      .references(() => socialProfileProvider.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.providerId] })],
);

export const file = pgTable("File", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  mimeType: text("mimeType").notNull(),
  objectKey: text("objectKey").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  sha256: text("sha256"),
  visibility: fileVisibilityEnum("visibility").notNull(),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export const packageTable = pgTable("Package", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  displayName: text("displayName"),
  description: text("description").notNull(),
  shortDescription: text("shortDescription").notNull(),
  published: boolean("published").notNull(),
  webSite: text("webSite").notNull(),
  tags: text("tags").array(),
  iconFileId: text("iconFileId").references(() => file.id, {
    onDelete: "set null",
  }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
  interval: paymentIntervalEnum("interval"),
});

export const packagePricing = pgTable("PackagePricing", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  packageId: text("packageId")
    .notNull()
    .references(() => packageTable.id, { onDelete: "cascade" }),
  price: bigint("price", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  fallback: boolean("fallback").notNull(),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export const packageScreenshot = pgTable(
  "PackageScreenshot",
  {
    packageId: text("packageId")
      .notNull()
      .references(() => packageTable.id, { onDelete: "cascade" }),
    fileId: text("fileId")
      .notNull()
      .references(() => file.id, { onDelete: "cascade" }),
    order: bigint("order", { mode: "number" }).notNull(),
    createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.packageId, table.fileId] })],
);

export const userPackage = pgTable(
  "UserPackage",
  {
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    packageId: text("packageId")
      .notNull()
      .references(() => packageTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.packageId] })],
);

export const release = pgTable("Release", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  packageId: text("packageId")
    .notNull()
    .references(() => packageTable.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  targetVersion: text("targetVersion").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  fileId: text("fileId").references(() => file.id, { onDelete: "set null" }),
  published: boolean("published").notNull(),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export const nativeAppAuth = pgTable("NativeAppAuth", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  continueUrl: text("continueUrl").notNull(),
  sessionId: text("sessionId")
    .notNull()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
  code: text("code"),
  codeExpires: timestamp("codeExpires", { precision: 3, mode: "date" }),
});

export const auditLog = pgTable("AuditLog", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("userId").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  details: text("details"),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  port: text("port"),
});

export const customer = pgTable("Customer", {
  userId: text("userId")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  stripeId: text("stripeId").notNull(),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export const userPaymentHistory = pgTable("UserPaymentHistory", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  paymentId: text("paymentId").notNull(),
  packageId: text("packageId").notNull(),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { precision: 3, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export const appReleaseAsset = pgTable("AppReleaseAsset", {
  id: text("id").primaryKey(),
  version: text("version").notNull(),
  minVersion: text("minVersion"),
  os: text("os").notNull(),
  arch: text("arch").notNull(),
  type: text("type").notNull(),
  standalone: boolean("standalone").notNull(),
  url: text("url").notNull(),
});

export const feedback = pgTable("Feedback", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  email: text("email").notNull(),
  category: feedbackCategoryEnum("category").notNull(),
  message: text("message").notNull(),
  userId: text("userId").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { precision: 3, mode: "date" })
    .notNull()
    .defaultNow(),
});
