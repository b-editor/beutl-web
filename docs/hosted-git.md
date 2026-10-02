# Hosted Git repositories

The desktop API Worker serves one private Git repository per Beutl project.
This service is opt in and independent of Forgejo. Git history uses
`git-fs-s3`; Git LFS media uses separate prefixes in a **Backblaze B2 bucket
through its S3-compatible HTTPS API**. The existing `BEUTL_R2_BUCKET` binding
continues to serve unrelated Beutl user files and is not used for hosted Git.

## Deployment

1. Apply the CockroachDB migration `20261002000000_add_git_repositories`.
2. Deploy the desktop API Worker with the `GitRepositoryDurableObject` SQLite
   migration. Keep `BEUTL_GIT_ENABLED=false` until configuration and a B2
   integration test have succeeded.
3. Configure these values on the desktop API Worker:

   | Variable | Value |
   | --- | --- |
   | `BEUTL_GIT_S3_ENDPOINT` | Regional B2 S3 HTTPS endpoint, for example `https://s3.us-east-005.backblazeb2.com/` |
   | `BEUTL_GIT_S3_REGION` | Region matching the endpoint, for example `us-east-005` |
   | `BEUTL_GIT_S3_BUCKET` | Dedicated private B2 bucket name |
   | `BEUTL_GIT_S3_PATH_STYLE` | `true` (default) for `/bucket/key`; `false` for `bucket.endpoint/key` |
   | `BEUTL_GIT_S3_ACCESS_KEY_ID` | B2 application key ID; Worker secret |
   | `BEUTL_GIT_S3_SECRET_ACCESS_KEY` | B2 application key; Worker secret |
   | `BEUTL_GIT_TOKEN_SECRET` | Independent random secret of at least 32 characters; Worker secret |

   The B2 key must allow listing objects and versions, reading and writing
   objects, deleting specific versions, and creating, listing, uploading,
   completing and aborting multipart uploads. Keep the bucket private. Do not
   put credentials in `wrangler.jsonc`, source control, or desktop settings.
   `PUBLIC_ORIGIN` must remain the public Beutl origin.
4. Set `BEUTL_GIT_ENABLED=true` only after the database and Durable Object
   migrations, secrets, and storage smoke test are complete. It defaults to
   `false`.

`BEUTL_GIT_LFS_REPO_QUOTA_BYTES` optionally changes the 20 GiB per repository
LFS quota. A single object is capped at 20 GiB even if that quota is raised.
Git history is limited to 16 MiB of stored objects and an 8 MiB incoming pack;
track media with LFS. Each user can create at most 20 active repositories.

The Worker sets `limits.cpu_ms=300000`. The final SHA-256 check streams the
entire B2 object through a Durable Object request. This needs a Workers Paid
plan and may take longer than a deployment or client connection survives.
Cloudflare allows up to 300 seconds of active CPU for a paid Worker request,
but this implementation has **not** been measured against a real B2 bucket or
Cloudflare account at 5–20 GiB. Measure the upload, verify, download, and
retry path before enabling production traffic. A failed or interrupted
verification leaves the object private and can be retried with the multipart
complete action while its reservation is valid.

## Protocol and trust boundary

- The standard Beutl API JWT creates, lists, deletes, and mints access for a
  repository under `/api/v3/repos`. A dedicated scoped Git JWT authenticates
  `/api/v3/git/<id>.git`. Every request checks ownership and soft deletion in
  CockroachDB. Git tokens expire after one hour and are not written into Git
  configuration.
- A per-repository Durable Object serializes Git and LFS metadata operations
  across B2 requests. `git-fs-s3` uses timestamp-based incoming pack names;
  the Durable Object persists the last push completion time to distinguish
  consecutive packs.
- Git LFS `basic` uses a one-hour presigned B2 PUT/GET for objects up to 5 GiB.
  The signed PUT fixes length and content type. The verify action reads the
  precise B2 object version as a stream and checks its full size and SHA-256
  against the LFS OID before publishing it. B2 ETags are not treated as hashes.
- A batch with an object above 5 GiB selects `beutl-multipart` if the client
  advertises it. The Beutl executable includes the matching Git LFS custom
  transfer agent. Parts are 64 MiB and stream through the Worker to B2; no
  full media file is buffered in Worker memory. The Worker request-body limit
  for the account must allow a 64 MiB part. B2 `ListParts` is authoritative
  for resume, including when a part succeeded but its metadata write did not.
  The agent retries failed parts and skips accepted parts. DELETE aborts an
  upload and releases its quota reservation. Unfinished reservations expire
  after 24 hours. Configure a B2 lifecycle rule to abort incomplete multipart
  uploads after seven days if an abort attempt fails.
- Multipart action tokens are scoped to one owner, repository, and LFS OID,
  and expire after 24 hours. Completed media remains private until the server
  streams a specific B2 version through SHA-256, checks size and OID, and
  marks the record verified. A mismatch removes the object. Download actions
  presign the verified `versionId`, so a later write to the same key cannot
  change the bytes served by an existing action.
- B2 buckets retain versions. Repository deletion tombstones the repository,
  aborts uploads, and deletes **all** versions and delete markers under both
  Git prefixes. Scheduled cleanup retries failures and sweeps for two hours
  after deletion, beyond the one-hour Basic PUT URL lifetime. Account deletion
  nulls ownership and uses the same cleanup.

An interrupted multipart push can be retried. A Git push that reaches Smart
HTTP after its Git token expires obtains a new token and retries the Git
portion once. Git LFS operations against other remotes retain their normal
credentials and transfer configuration.

Local tests cover real Git CLI push, clone, pull after a second push, and
competing pushes against an in-memory bucket and Durable Object; LFS quota,
SHA-256 verification and multipart resume/abort; and an S3 HTTP fixture for
B2-style signing, multipart calls and versioned deletion. A local `git lfs
push` fixture also confirms that Git LFS starts the bundled Beutl transfer
agent and completes the init handshake. The fixture intentionally rejects a
non-HTTPS transfer action; it does not upload to B2. These are **not** a real
B2 integration or multi-GiB Cloudflare verification test.

References: [B2 S3 API](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api),
[B2 multipart operations](https://www.backblaze.com/apidocs/s3-create-multipart-upload),
[B2 object versions](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api-bucket-versions),
[B2 lifecycle configuration](https://www.backblaze.com/apidocs/s3-put-lifecycle-configuration),
[Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
