#!/usr/bin/env bash
set -euo pipefail

bucket="${BEUTL_R2_BUCKET_NAME:-beutl-dev}"
config="${R2_LIFECYCLE_FILE:-apps/web/r2-lifecycle.json}"

echo "Checking lifecycle for ${bucket} using ${config}"
output="$(apps/web/node_modules/.bin/wrangler r2 bucket lifecycle list "${bucket}" 2>&1)" || {
  echo "Unable to read R2 lifecycle; verify Wrangler credentials and bucket name." >&2
  echo "${output}" >&2
  exit 2
}
printf '%s\n' "${output}"
normalized="$(printf '%s\n' "${output}" | perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g')"
if ! printf '%s\n' "${normalized}" | \
  awk -f scripts/validate-r2-lifecycle-output.awk; then
  echo "R2 lifecycle gate failed: incomplete multipart uploads are not configured for 7 days." >&2
  exit 1
fi
echo "R2 lifecycle gate passed: incomplete multipart uploads abort after 7 days."
