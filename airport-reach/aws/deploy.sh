#!/usr/bin/env bash
# Deploy Airport Reach: S3 + CloudFront site and an Amazon Location API key.
#
#   export AWS_REGION=us-east-1      # a Region where Amazon Location Service is available
#   python pipeline/build_dataset.py # or --seed for the sample data
#   bash aws/deploy.sh
#
# The deployed copy gets its own config.js (with the API key). Your local web/config.js is not touched.
set -euo pipefail

STACK="${STACK:-airport-reach}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$ROOT/web/data/cities.geojson" ]; then
  echo "No dataset found. Run: python pipeline/build_dataset.py" >&2
  exit 1
fi

echo "Deploying stack '$STACK' to $REGION ..."
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$ROOT/aws/template.yaml" \
  --region "$REGION"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(out BucketName)"
DIST="$(out DistributionId)"
URL="$(out SiteUrl)"
KEYNAME="$(out KeyName)"
KEY="$(aws location describe-key --key-name "$KEYNAME" --region "$REGION" --query Key --output text)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/web/." "$STAGE/"
cat > "$STAGE/config.js" <<EOF
window.AIRPORT_REACH_CONFIG = {
  region: '$REGION',
  apiKey: '$KEY',
  mapStyle: 'Standard',
  colorScheme: 'Dark',
  basemap: 'plain'
};
EOF

echo "Uploading site to s3://$BUCKET ..."
aws s3 sync "$STAGE" "s3://$BUCKET" --delete --region "$REGION"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*' >/dev/null

echo
echo "Live at: $URL"
