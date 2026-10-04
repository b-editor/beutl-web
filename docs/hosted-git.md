# Hosted Git and large media

Hosted Git is an optional service in the public `beutl-web` Worker. It adds a private
Git remote and Git LFS storage in Backblaze B2. Existing Forgejo repositories
and desktop remotes remain in place; no migration is performed.

## Storage configuration

Git/LFS and ordinary File/AI storage use the same `BEUTL_S3_*` connection
configuration and private bucket in each environment. Development and production
keep separate buckets and credentials. Git enablement and token signing are
configured independently of storage.
Git/LFS pins object versions, so its bucket must retain referenced versions.
It can share the environment's existing private File/AI bucket when lifecycle
rules expire ordinary objects only, without matching `git/` or `git-lfs/`.
Backblaze applies every matching lifecycle rule; adding a more specific rule
does not override a bucket-wide expiration rule. Enable Git through the environment only after its
bucket, secrets and database schema are ready; deployments preserve that setting.

## Enablement

Apply `20261003000000_add_hosted_git` through the existing CockroachDB migration
procedure before enabling the API. Web (including its APIs) and admin must use that schema
because their account storage queries include Git usage. The migration adds
new tables and a storage admission counter; it does not import old repositories.
Apply `20261004000000_add_git_access_tokens` the same way before deploying the
access-token release; Git and LFS requests authenticate against its table.

Configure the Web Worker (`apps/web/wrangler.jsonc`) with a private B2 bucket and these values:

| Setting | Value |
| --- | --- |
| `BEUTL_GIT_ENABLED` | `true` after configuration and validation |
| `BEUTL_S3_ENDPOINT` | The bucket's HTTPS S3 endpoint |
| `BEUTL_S3_REGION` | The B2 region, such as `us-west-004` |
| `BEUTL_S3_BUCKET` | The private bucket name |
| `BEUTL_S3_FORCE_PATH_STYLE` | `true` for path-style requests |
| `BEUTL_S3_ACCESS_KEY_ID` | Bucket-scoped application key ID (secret) |
| `BEUTL_S3_SECRET_ACCESS_KEY` | Application key (secret) |
| `BEUTL_S3_SESSION_TOKEN` | Session token for temporary credentials, when required (optional secret) |

The key needs object read, write, list, version deletion and multipart operations
for `git/` and `git-lfs/`. Keep credentials in Worker secrets and ignored local
configuration. The checked-in Web Wrangler configuration includes the SQLite Durable
Object binding/migration and leaves the feature disabled. Use Workers Paid for
the bundle size and bounded Git pack processing.

When sharing a bucket, ordinary File keys are lowercase UUIDs, and AI/upload
keys use `ai/` and `storage-upload/`. Scope their noncurrent-version expiration
to the UUID first-character prefixes `0`–`9`, `a`–`f` (which also cover `ai/`)
and `storage-upload/`; remove the equivalent rule with an empty prefix.
Git prefixes retain versions and can abort unfinished multipart uploads after
seven days. Update these rules when introducing another ordinary key prefix.

Retain the existing five-minute API cron and Hyperdrive binding. Do not add an
age-based lifecycle rule that deletes noncurrent versions in these prefixes:
an LFS record can intentionally reference a noncurrent B2 `versionId`. Object
Lock or retention that prevents deletion will also prevent quota release.

## API routes

All Hosted Git endpoints are Hono routes in the shared `v3` API, served by the
Web Worker entry and by the Next.js `/api/v3` route alike:

- `/api/v3/repos` lists and creates repositories; `/api/v3/repos/:id` reads,
  renames and deletes one; `/api/v3/repos/:id/tokens` lists, creates
  (`{ name, scope }`) and, with `/:tokenId`, revokes access tokens. These use
  the desktop API JWT.
- `/api/v3/git/:id.git/` serves Git smart HTTP (`info/refs`, `git-upload-pack`,
  `git-receive-pack`) and Git LFS (`info/lfs/objects/batch`, object `download`
  and `tus` uploads). These use a repository access token.

The Web dashboard calls the same repository functions directly with the
signed-in account, without an API token.

## Access tokens

Each repository can have up to 50 access tokens with `read` or `write` scope.
Tokens do not expire. Revoking a token, deleting its repository, or the
repository leaving the account that created the token stops it working. Only a
SHA-256 of each token is stored; the dashboard shows the secret once.

Git and Git LFS take the token from the remote URL as Basic credentials; the
user name is ignored:

```sh
git clone https://git:TOKEN@beutl.beditor.net/api/v3/git/REPOSITORY_ID.git
```

API clients may send `Authorization: Bearer TOKEN` instead. Last use is
recorded at most once an hour.

## Transfers and limits

The desktop's **Create Beutl remote** action creates a repository only when
`origin` is absent. Existing origin configuration is preserved even if it has
only a push URL. Hosted pushes require one destination; configure separate
remotes for additional destinations. External Git remotes retain their existing
behavior. Git and Git LFS must be installed on the client.

Git smart HTTP supports small project history: an 8 MiB push, 16 MiB of current
repository objects, 128 refs and 9,000 history objects. Track videos and other
large media with Git LFS. Each LFS object and a repository's aggregate LFS data
are limited to 20 GiB, subject to the account's existing plan quota.

LFS uploads negotiate the single `beutl-tus` custom transfer. Non-final PATCH
requests must contain 5–32 MiB; the desktop sends 32 MiB parts. A final part can
be smaller, including an empty object. This deliberately avoids persisting byte
tails in Durable Objects. Basic signed PUT and a second multipart protocol are
not offered. HEAD recovers the accepted offset after interruption or a lost
response. Upload reservations and OID-scoped tokens expire after 24 hours.

An ordinary Worker streams each part into a B2 multipart upload. The repository
Durable Object serializes metadata, reservations, offsets and receipts. It never
relays LFS upload or download bodies. After completion, Worker HEAD requests
verify one 32 MiB range at a time against the pinned B2 version. SHA-256 chaining
words and offsets are checkpointed so verification resumes after a restart.
`Upload-Verified: true` is returned only after the complete SHA-256 matches the
LFS OID and the account reservation is committed.

Downloads use **B2 → ordinary Cloudflare Worker → client** streaming. They check
repository ownership and token scope, fetch the recorded version, and support
HEAD, single byte ranges and If-Range. Responses are private/no-store, with no
direct B2 URL redirect. The desktop retains and rehashes interrupted downloads.
This follows Backblaze's documented
[private-bucket Cloudflare route](https://www.backblaze.com/docs/cloud-storage-deliver-private-backblaze-b2-content-through-cloudflare-cdn)
for free B2-to-Cloudflare transfer; storage, B2 API operations and Worker compute
still have their provider charges. Production billing has not been measured.

## Storage accounting and cleanup

The existing account storage API/UI meter adds ordinary File bytes, current Git
objects and verified LFS bytes. Pending File uploads and Git/LFS reservations
also count during admission. Each admission writes the same account row inside
the retryable transaction so concurrent File and Git requests cannot both admit
the same remaining capacity. AI output accounting keeps its existing behavior.

Alarms clean expired uploads, abort orphan multipart uploads and prune old B2
versions while preserving every verified record's exact version. Daily sweeps
also catch later versions. Cron recovers stranded reservations and deleted
repositories independently of the feature flag. Deletion retains its reservation
until physical cleanup succeeds and a final multipart abort after a two-hour
grace period covers in-flight parts. Repeated cleanup failures are logged with
repository/OID and failure counts; investigate provider permissions or retention
before manually changing accounting.

Validation uses mocked B2/CockroachDB interfaces, resumable SHA-256 vectors,
streaming/range tests and native Git push/clone/pull. The virtual object test
exercises offsets above 5 GiB and bounded verification reads; it is not a real
5 GiB B2 transfer. Real B2 operations, provider billing and CockroachDB contention/
migration deployment still require an authorized staging rehearsal.
