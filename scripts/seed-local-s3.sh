#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Seed the local SeaweedFS S3 with DemandTldr data so the server can sync
# from it on startup. Run once after `docker compose --profile s3-local up`.
#
# Mirrors what you'd do for real S3 — same `aws s3 sync` command, just
# pointed at the local SeaweedFS endpoint via --endpoint-url.
#
# Usage:
#   ./scripts/seed-local-s3.sh                  # uses defaults
#   DATA_DIR=/path/to/demand_tldr_data ./scripts/seed-local-s3.sh
#   ENDPOINT=http://localhost:8333 BUCKET=meridian-demand-tldr ./scripts/seed-local-s3.sh
#
# Requires: aws CLI installed locally (or run via `docker run amazon/aws-cli`).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Defaults match the DEMANDTLDR_S3_URI layout (s3://meridian/demand-tldr/v1/)
# so local-SeaweedFS testing and a real deployment read from the same layout.
# For a real bucket: ENDPOINT=<seaweedfs-s3> AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… ./scripts/seed-local-s3.sh
ENDPOINT="${ENDPOINT:-http://localhost:8333}"
BUCKET="${BUCKET:-meridian}"
PREFIX="${PREFIX:-demand-tldr/v1/}"
DATA_DIR="${DATA_DIR:-$HOME/code/DemandTldr/meridian-ext/src/demand_tldr_ext/data}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-meridian-local}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-meridian-local-secret}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

if [ ! -d "$DATA_DIR" ]; then
  echo "DATA_DIR=$DATA_DIR does not exist. Set DATA_DIR=... to point at" >&2
  echo "your DemandTldr data directory (or any directory you want synced)." >&2
  exit 1
fi

if ! command -v aws >/dev/null; then
  echo "aws CLI not found. Install it, or run inside a container:" >&2
  echo "  docker run --rm -it --network host -v \"$DATA_DIR\":/data \\" >&2
  echo "    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \\" >&2
  echo "    amazon/aws-cli --endpoint-url $ENDPOINT s3 sync /data s3://$BUCKET/$PREFIX" >&2
  exit 1
fi

# SeaweedFS server starts master + volume + filer + S3 in a chain;
# `up -d` returns as soon as the container is running but S3 isn't
# reachable for another ~10-15s while the subprocesses handshake.
# Poll the S3 endpoint with a short list call until it answers.
echo -n "→ waiting for S3 endpoint at $ENDPOINT "
for i in $(seq 1 60); do
  if aws --endpoint-url "$ENDPOINT" s3 ls >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  echo -n "."
  sleep 1
  if [ "$i" = "60" ]; then
    echo
    echo "S3 endpoint at $ENDPOINT not reachable after 60s. Check:" >&2
    echo "  docker-compose --profile s3-local ps" >&2
    echo "  docker logs meridian-seaweedfs-1 | tail -30" >&2
    exit 1
  fi
done

echo "→ creating bucket s3://$BUCKET (idempotent)"
aws --endpoint-url "$ENDPOINT" s3 mb "s3://$BUCKET" 2>/dev/null || true

echo "→ syncing $DATA_DIR → s3://$BUCKET/$PREFIX"
aws --endpoint-url "$ENDPOINT" s3 sync "$DATA_DIR" "s3://$BUCKET/$PREFIX" --delete

echo
echo "✅ Done. Verify with:"
echo "   aws --endpoint-url $ENDPOINT s3 ls s3://$BUCKET/$PREFIX --recursive | head"
echo
echo "Then set in .env (already in .env.example as a comment):"
echo "   DEMANDTLDR_S3_URI=s3://$BUCKET/$PREFIX"
echo "   DEMANDTLDR_S3_ACCESS_KEY=$AWS_ACCESS_KEY_ID"
echo "   DEMANDTLDR_S3_SECRET_KEY=$AWS_SECRET_ACCESS_KEY"
echo "   DEMANDTLDR_S3_ENDPOINT_URL=http://seaweedfs:8333    # from server container"
echo "   DEMANDTLDR_S3_REGION=$AWS_DEFAULT_REGION"
