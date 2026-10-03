# Hosted Git repositories

The desktop API Worker serves one private Git repository per Beutl project.
This service is opt in and independent of Forgejo. Git history uses
`git-fs-s3`; Git LFS media uses separate prefixes in a **Backblaze B2 bucket
through its S3-compatible HTTPS API**. The existing `BEUTL_R2_BUCKET` binding
continues to serve unrelated Beutl user files and is not used for hosted Git.

## Deployment

1. Apply the CockroachDB migrations `20261002000000_add_git_repositories`,
   `20261002010000_git_account_storage`, and `20261002190000_git_maintenance_fairness`.
   They add the account meter, a nullable `accountedAt` marker for old
   repositories, and persistent maintenance attempt/failure fields.
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
4. Run scheduled account reconciliation with B2 configured. It adopts old
   repositories' LFS reservations, lists current Git object sizes, and marks
   `accountedAt`. Until then, storage admission and Git traffic for an affected
   account fail closed. Check that no active repository has `accountedAt IS NULL`
   and compare account usage before and after reconciliation. Existing bytes
   remain counted even if they exceed the current plan; new uploads then wait
   for space or a larger plan.
5. Set `BEUTL_GIT_ENABLED=true` only after the migrations, secrets,
   reconciliation, and storage smoke test are complete. It defaults to `false`.

`BEUTL_GIT_LFS_REPO_QUOTA_BYTES` optionally changes the 20 GiB per repository
LFS quota. A single object is capped at 20 GiB even if that quota is raised.
Git history is limited to 16 MiB of stored objects, an 8 MiB incoming pack,
and 9,000 stored object entries. A non-empty push reserves two entries for its
pack and index and is rejected before it could make listings unusable. Fetches,
ref-only pushes and repository deletion remain available at this limit.
Each repository can retain at most 10,000 LFS records, counting both pending
reservations and verified objects, including zero-byte objects. Reusing an OID
does not consume another slot; completed cleanup frees expired reservations.
Track media with LFS. Each user can create at most 20 active repositories.

The existing account storage API, dashboard, billing, and admin totals include
current Git objects and one copy of every verified LFS OID per repository,
alongside File bytes. Pending LFS, Git push, and File writes reserve capacity
against the same account quota. CockroachDB serializes admission through the
user's `storageRevision` row. Repository creation uses the same serializable
user lock to enforce the active repository count under concurrent requests.
A Git push reserves the incoming pack and its index bound, then settles to
actual stored size. Small pushes can use the remaining account capacity.
Git history counts current
objects under `repo.git/objects/`, including packs and loose objects; refs and
Git configuration are small control metadata and are not metered. Old B2
versions and multipart pieces are physical garbage collected separately.

The Worker sets `limits.cpu_ms=300000`. SHA-256 verification reads at most
128 MiB of a fixed B2 `versionId` per step and persists the chaining words,
byte offset, OID, size, and version ID in the repository Durable Object.
Interruption may repeat one range; retries resume from the last checkpoint.
A different object version discards the prior checkpoint. The object stays
private until the full digest matches its OID. These checkpoint steps apply
to tus and legacy multipart transfers. The Beutl tus agent polls HEAD
for `Upload-Verified: true` after the byte offset reaches the length; the
legacy agent polls complete while it returns `verifying: true`. Basic LFS
verify streams the pinned version through the native SHA-256 implementation
in one request, avoiding the JavaScript compression loop over a multi-GB file.
This still needs a
Workers Paid plan and **has not** been measured on a real B2 bucket or
Cloudflare account at 5 to 20 GiB. Measure wall time, CPU, restart, and retry
behavior before enabling production traffic.

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
- Git LFS `basic` uses a presigned B2 PUT/GET for objects up to 5 GB
  (5,000,000,000 bytes). PUT expiry is capped by its reservation's remaining
  one-hour window, including repeated batch requests.
  The signed PUT fixes length and content type. The verify action reads the
  precise B2 object version as a stream and checks its full size and SHA-256
  against the LFS OID before publishing it. B2 ETags are not treated as hashes.
- A batch with an object above 5 GB selects `beutl-tus` when the client
  advertises it. The Beutl executable registers the matching Git LFS custom
  transfer agent. Older clients can still use `beutl-multipart` as a fallback.
  Git LFS chooses one transfer for a whole batch, so smaller objects in the
  same batch use that custom transfer too; empty objects finish without a B2
  multipart upload.
  Both stream 64 MiB chunks through the Worker to B2 without buffering a full
  media file. The Worker request-body limit for the account must allow a 64 MiB
  PATCH. Unfinished reservations expire after 24 hours. The Durable Object
  retries failed aborts. A daily S3 multipart listing also aborts untracked
  uploads older than 26 hours, including a Create response lost before its ID
  was saved, while protecting IDs in active records. A B2 lifecycle rule to
  abort incomplete uploads after seven days is an optional backstop.
- The tus endpoint supports protocol version 1.0.0 with Creation, Expiration,
  and Termination: `OPTIONS` and `POST` on `/objects/<oid>/tus`, then `HEAD`,
  `PATCH`, and `DELETE` on the returned upload URL. `Tus-Resumable: 1.0.0` is
  required except for `OPTIONS`. `POST` is idempotent for the same reservation;
  the resource URL stays stable across retries. PATCH requires an exact
  `Upload-Offset`, `Content-Length`, and
  `Content-Type: application/offset+octet-stream`. PATCH bodies may be any size
  up to 64 MiB. The Durable Object persists tails below B2's 5 MiB non-final
  part minimum in 1 MiB SQLite values, then streams them into a B2 part when
  enough bytes arrive. Each new tail is written copy-on-write before its
  offset becomes visible, so a lost response or DO restart can resume it.
  Creation with upload, deferred length, and concatenation are not supported.
  `X-HTTP-Method-Override` is accepted for PATCH when a proxy blocks the verb.
- The repository Durable Object serializes PATCH requests. B2 `ListParts`
  gives the committed part prefix on every HEAD and before every PATCH; its
  offset plus the persisted tail length is the resumable tus offset. This also
  covers an accepted part that loses its response or a Durable Object restart.
  A stale offset gets 409 without uploading its body. The final PATCH or
  subsequent HEAD assembles the B2 object; later HEAD requests may advance
  verification until `Upload-Verified: true` reports completion. DELETE aborts
  an unfinished upload and releases
  its quota reservation.
- Multipart action tokens are scoped to one owner, repository, and LFS OID,
  and expire after 24 hours. Completed media remains private until the server
  streams a specific B2 version through SHA-256, checks size and OID, and
  marks the record verified. A mismatch removes the object. Download actions
  presign the verified `versionId`, so a later write to the same key cannot
  change the bytes served by an existing action.
- B2 buckets retain versions. Repository deletion tombstones the repository,
  aborts known and orphaned uploads, and deletes **all** versions and delete markers under both
  Git prefixes. Scheduled cleanup retries failures and sweeps for two hours
  after deletion, beyond the one-hour Basic PUT URL lifetime. Account deletion
  nulls ownership and uses the same cleanup.
  Expired Basic uploads keep their DO record and account reservation until a
  second sweep two hours after expiry. A daily DO alarm also removes orphan
  objects and rechecks pinned versions, including PUTs that finish after that
  grace period. Deleted repositories retain a daily prefix sweep as well.
  For active repositories, LFS cleanup keeps each verified record's pinned
  `versionId` and removes other versions only after the signed PUT window plus
  two hours. Git cleanup keeps current live versions and removes older versions
  before a latest delete marker. Do not apply blanket B2 noncurrent-version
  expiration to LFS keys: a verified version can be noncurrent after another
  Basic PUT and still be the version served to readers. Failed cleanup retries.
  Scheduled deletion, account reconciliation, and expired-reservation batches
  order by persisted last-attempt time. Failing rows move behind unattempted
  rows; repeated failures increment counters and log an intervention flag at
  five failures. Cleanup continues when `BEUTL_GIT_ENABLED=false` while the
  storage bindings remain configured. Each queued DO invocation lazily opens
  one DB client and closes it at completion, including cold-start alarms.

An interrupted multipart push can be retried. A Git push that reaches Smart
HTTP after its Git token expires obtains a new token and retries the Git
portion within five total attempts, checking actual push URLs (including
`pushurl` and Git URL rewrites) and authenticating every hosted target.
Hosted commands disable interactive askpass helpers. Git LFS operations against other remotes retain their normal
credentials and transfer configuration.

Local tests cover real Git CLI push, clone, pull after a second push, and
competing pushes against an in-memory bucket and Durable Object; LFS quota,
SHA-256 verification and tus/multipart resume/abort; and an S3 HTTP fixture for
B2-style signing, multipart calls and versioned deletion. A local `git lfs
push` fixture also confirms that Git LFS starts the bundled Beutl transfer
agent and completes the init handshake. The fixture intentionally rejects a
non-HTTPS transfer action; it does not upload to B2. These are **not** a real
B2 integration or multi-GiB Cloudflare verification test.

References: [B2 S3 API](https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api),
[B2 multipart operations](https://www.backblaze.com/apidocs/s3-create-multipart-upload),
[B2 multipart listing](https://www.backblaze.com/apidocs/s3-list-multipart-uploads),
[B2 object versions](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api-bucket-versions),
[B2 lifecycle configuration](https://www.backblaze.com/apidocs/s3-put-lifecycle-configuration),
[B2 single-file limits](https://www.backblaze.com/docs/cloud-storage-files),
[Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/),
[Cloudflare Durable Object storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[tus 1.0 protocol](https://tus.io/protocols/resumable-upload).
