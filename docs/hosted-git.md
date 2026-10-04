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
configuration. Presigned LFS upload URLs reveal the key ID and bucket name, not
the application key. The checked-in Web Wrangler configuration includes the SQLite Durable
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
  `git-receive-pack`) and Git LFS (`info/lfs/objects/batch`, object `download`,
  `verify` and `tus` uploads, and `info/lfs/locks/verify`). These use a
  repository access token.

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
repository objects, 128 refs and 9,000 history objects. Fetches negotiate with
`multi_ack_detailed`, so a client receives only the objects its common history
with the server lacks. Track videos and other large media with Git LFS. An LFS
object can hold up to 312.5 GiB (10,000 tus parts of 32 MiB). A repository's
LFS data is bounded only by the account's plan quota and 10,000 objects.

Stock Git LFS uses the `basic` transfer, so pushing media needs no desktop app.
The batch response gives each object a presigned B2 PUT URL that signs its
`Content-Length` and `x-amz-checksum-sha256`; B2 stores the body only when both
match the LFS object. The URL is valid for up to an hour and never past the
upload reservation, after which Git LFS asks for a new batch. Its `verify`
action then checks the stored size and checksum, pins the B2 version and commits
the account reservation. B2 limits a single PUT to 5 GB, so larger objects need
the desktop's `beutl-tus` transfer. B2 has no conditional PUT, so repeating a PUT
before its URL expires can leave identical extra versions until the next version
sweep. File locking is not offered: `info/lfs/locks/verify` answers 501, which
makes Git LFS stop checking locks on later pushes.

The desktop negotiates the `beutl-tus` transfer. Its upload action is a
standard tus 1.0 endpoint (core, creation and expiration) that any tus client
can use with the repository access token, for example tus-js-client with a
`chunkSize` from 5 to 32 MiB. Each PATCH stores one B2 multipart part, so
non-final PATCH requests must contain 5–32 MiB, an object has at most 10,000
parts, and the 10,000th part must finish it; the desktop sends 32 MiB parts.
An empty object is complete once it is created. HEAD recovers the accepted
offset after interruption or a lost response. An upload reservation lasts 24
hours; accepted parts extend it, so a large upload on a slow link keeps going.

One tus stream is limited by its single connection; measured from Japan through
the production Worker it moved 5 MiB/s, and four concurrent streams 20 MiB/s.
The endpoint therefore also takes parts out of order, which the desktop sends
four at a time. Responses carry `Beutl-Part-Size: 33554432`. A PATCH may store
any 32 MiB part at or after the accepted offset (the last part may be shorter)
when its `Beutl-Sha256-State` header names the SHA-256 state of the object's
bytes before it, as 64 hex digits of the eight chaining words; every part
already accepted must then be a full 32 MiB part. The part is hashed from that
state as it streams to B2. The accepted offset passes a stored part only when
the state it named equals the state the bytes before it reached, so a claimed
state can never stand in for different earlier bytes; a mismatch discards the
upload. A part being sent again is passed only once that upload settles, and a
receipt that arrives after the offset passed its part is refused, so the stored
digest always belongs to the part B2 assembles. HEAD returns the state at the
accepted offset, so a resumed upload
continues hashing there. Clients that send parts in order need none of this.

For tus, an ordinary Worker streams each part into a B2 multipart upload and
continues the object's SHA-256 over the bytes as they pass. The repository
Durable Object serializes metadata, reservations, offsets, receipts and the hash
state at the accepted offset (eight words and fewer than 64 tail bytes). It
never relays LFS upload or download bodies, and stored bytes are never read
back. The PATCH that stores the last byte compares the digest with the LFS OID
before B2 assembles the parts: a mismatch discards the upload, and a match pins
the B2 version and commits the account reservation. A tus client is therefore
finished when that PATCH returns 204 with `Upload-Verified: true`; if the
response is lost, HEAD completes the publication.

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

The daily alarm also collects LFS objects that no branch or tag points to
anywhere in its history, such as media of a deleted branch or an upload whose
push never happened. An object becomes a candidate seven days after it was last
uploaded or offered to an upload batch, because clients upload media before
pushing the commits that point to it. The repository object walks every commit,
tree, annotated tag and small blob reachable from its refs and treats any blob
of at most 1 KiB with an `oid sha256:` line as a pointer. If any ref or object
cannot be read, nothing is collected and the walk is retried an hour later.
Collection unpublishes the record, deletes every B2 version and releases the
account reservation, at most 100 objects per run. The walk is skipped while no
push has happened and no new object has become a candidate since the last one.

Validation uses mocked B2/CockroachDB interfaces, resumable SHA-256 vectors,
streaming/range tests and native Git push/clone/pull. Stock Git LFS (basic) and
tus-js-client (resumed tus) uploads have also run locally against the B2
development bucket, including a resumed 5.03 GiB object through the desktop agent. Provider
billing and CockroachDB contention/migration deployment still require an
authorized staging rehearsal.
