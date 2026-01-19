#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env" ]]; then
  set -a
  source ".env"
  set +a
fi

: "${AZ_RESOURCE_GROUP:?Set AZ_RESOURCE_GROUP in .env}"
: "${AZ_SWA_NAME:?Set AZ_SWA_NAME in .env}"

npm run build

DEPLOY_TOKEN="$(az staticwebapp secrets list --name "$AZ_SWA_NAME" --resource-group "$AZ_RESOURCE_GROUP" --query "properties.apiKey" -o tsv)"

if ! command -v swa >/dev/null 2>&1; then
  echo "Missing SWA CLI. Install with: npm install -g @azure/static-web-apps-cli"
  exit 1
fi

swa deploy "./dist" \
  --api-location "./api" \
  --api-language "node" \
  --api-version "18" \
  --env production \
  --deployment-token "$DEPLOY_TOKEN"

echo "Deployment complete."
