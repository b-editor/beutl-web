import { Hono } from "hono";
import discover from "./v3/discover";
import files from "./v3/files";
import library from "./v3/library";
import packages from "./v3/packages";
import users from "./v3/users";
import user from "./v3/user";
import app_ from "./v3/app";
import aiCapabilities from "./v3/ai/capabilities";
import aiImages from "./v3/ai/images";
import aiJobs from "./v3/ai/jobs";
import aiTranscriptions from "./v3/ai/transcriptions";
import aiTranslations from "./v3/ai/translations";
import aiVideos from "./v3/ai/videos";
import { apiOnErrorHandler } from "./api/error";

// basePath 無しの composed app。消費側 (Web route.ts / Worker) が
// プレフィックス (/api/v3) を付与してマウントする。
export const v3 = new Hono()
  .route("/discover", discover)
  .route("/files", files)
  .route("/account/library", library)
  .route("/packages", packages)
  .route("/users", users)
  .route("/user", user)
  .route("/ai/capabilities", aiCapabilities)
  .route("/ai/images", aiImages)
  .route("/ai/jobs", aiJobs)
  .route("/ai/transcriptions", aiTranscriptions)
  .route("/ai/translations", aiTranslations)
  .route("/ai/videos", aiVideos)
  .route("/app", app_)
  .onError(apiOnErrorHandler);
