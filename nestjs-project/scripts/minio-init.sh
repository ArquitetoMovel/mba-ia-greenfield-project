#!/bin/sh
# Idempotent MinIO bootstrap: bucket + multipart-abort lifecycle + CORS.
# Runs once via the `minio-init` one-shot Compose service; safe to re-run.
mc alias set local http://minio:9000 "${S3_ACCESS_KEY:-minioadmin}" "${S3_SECRET_KEY:-minioadmin}"

mc mb --ignore-existing "local/${S3_BUCKET}"

mc anonymous set none "local/${S3_BUCKET}"

cat > /tmp/lifecycle.json <<'EOF'
{
  "Rules": [
    {
      "ID": "streamtube-abort-multipart",
      "Status": "Enabled",
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}
    }
  ]
}
EOF
mc ilm import "local/${S3_BUCKET}" < /tmp/lifecycle.json

echo "minio-init: bucket '${S3_BUCKET}' ready (CORS handled globally by server env)"
