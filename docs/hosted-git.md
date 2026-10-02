# Hosted Git repositories

The desktop API Worker can serve a private Git repository for each Beutl
project. This service is opt in and independent of the existing Forgejo
service. Git history uses `git-fs-s3` over the existing native R2 binding;
media uses Git LFS in the same bucket under separate prefixes. The Beutl
desktop application creates repositories, receives a temporary URL and token,
and runs Git and Git LFS with process scoped authentication settings.

## Deployment

1. Apply `20261002000000_add_git_repositories` to the CockroachDB database.
2. Deploy the desktop API Worker with the `GitRepositoryDurableObject` SQLite
   migration and the existing `BEUTL_R2_BUCKET` binding. No additional bucket
   is required.
3. Set `BEUTL_GIT_TOKEN_SECRET` to a random secret of at least 32 characters.
   Keep it distinct from `JWT_SECRET`.
4. Set `BEUTL_GIT_R2_S3_ENDPOINT` to the R2 S3 HTTPS endpoint, ending in `/`,
   `BEUTL_GIT_R2_S3_BUCKET` to the bound bucket name, and
   `BEUTL_GIT_R2_S3_ACCESS_KEY_ID` /
   `BEUTL_GIT_R2_S3_SECRET_ACCESS_KEY` to credentials for presigned LFS Basic
   PUT/GET URLs. Store all credentials as Worker secrets. Git history and
   multipart uploads use the native binding; only Basic presigning needs S3
   credentials.
5. Set `BEUTL_GIT_ENABLED=true` after the migration and secrets are in place.
   It defaults to `false`. Keep `PUBLIC_ORIGIN` on the desktop API Worker at the
   public Beutl origin.

`BEUTL_GIT_LFS_REPO_QUOTA_BYTES` optionally changes the 20 GiB per repository
LFS quota. Git history is limited to 16 MiB of stored objects and an 8 MiB
incoming pack. Media should be tracked by LFS. At most 20 active repositories
can be created by one user.

The Worker sets `limits.cpu_ms=300000` because final verification of a large
multipart upload hashes the complete private R2 object as a stream. This
requires a Workers Paid plan. Large R2 transfers and CPU behavior must be
measured in the target Cloudflare account before production enablement.

## Protocol and trust boundary

- The standard Beutl API JWT creates, lists, deletes, and mints access for a
  repository under `/api/v3/repos`. A dedicated scoped Git JWT authenticates
  `/api/v3/git/<id>.git` traffic. Every request checks repository ownership and
  the soft delete state in CockroachDB. Git tokens expire after one hour and
  are never stored in Git configuration.
- A per repository Durable Object serializes Git and LFS metadata operations
  across R2 awaits. `git-fs-s3` uses timestamp based incoming pack names, so
  the Durable Object also persists the last push completion time to keep
  consecutive pack names distinct.
- Git LFS `basic` uses a one hour presigned R2 PUT/GET URL for objects up to
  5 GiB. A signed PUT requires the expected SHA-256 checksum and length. The
  Basic verify action compares R2's checksum and size before publication.
- A batch containing an object above 5 GiB selects
  `beutl-r2-multipart` if the client advertises it. The Beutl executable
  includes that Git LFS custom transfer agent. Parts are 64 MiB, giving a
  maximum of 10,000 parts (about 625 GiB), subject to repository quota. Each
  part streams through the Worker into the R2 multipart API; no full video is
  loaded in Worker memory. The Durable Object stores the upload ID and
  accepted part ETags for resume. DELETE aborts the upload and releases the
  quota reservation. Incomplete reservations expire after 24 hours. Keep an
  R2 lifecycle rule that aborts incomplete multipart uploads after seven
  days as a fallback if an abort call fails.
- Multipart action tokens are scoped to one owner, repository, and LFS OID,
  and expire after 24 hours. Completed multipart objects stay private until
  the server streams the entire R2 object into a SHA-256 hash, checks size and
  OID, and marks the record verified. A mismatch deletes the object. R2's
  multipart checksum is composite and cannot substitute for the full LFS OID.
  The download batch issues a 24 hour signed GET only for verified multipart
  records.
- Deleting a repository tombstones it before R2 cleanup. The scheduled Worker
  retries failed cleanup and keeps sweeping for two hours, beyond the Basic
  PUT URL lifetime, to remove objects written after deletion. Account deletion
  nulls repository ownership; the same scheduled cleanup clears its R2 prefixes.

An interrupted Beutl push can be retried. The multipart start response lists
accepted parts, so the agent skips those parts. A Git push that reaches Git
Smart HTTP after its one hour token expires obtains a new token and retries
the Git portion once. Git LFS operations on generic remotes keep their
existing credentials and transfer configuration.

The local test suite covers Git CLI push/clone and competing pushes against
an in memory R2/DO implementation, LFS quota and checksum boundaries, and
multipart start/resume/abort and complete. It does not exercise a real R2
account or a multi gigabyte transfer.
