#!/usr/bin/env bash
# Deploy the yammbo-iptv Worker. Credentials are read at runtime so they stay
# out of this public repo and out of tool/bash command lines.
set -euo pipefail
cd "$(dirname "$0")"
# /root/.cf-wrangler.sh injects the API token and account id from 600 files.
exec /root/.cf-wrangler.sh deploy "$@"
