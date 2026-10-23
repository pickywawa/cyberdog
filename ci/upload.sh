#!/bin/sh
# Envoie les fichiers donnés dans le Package Registry générique du projet GitLab (auth : CI_JOB_TOKEN).
# Usage : ci/upload.sh dist/*.exe dist/SHA256SUMS-windows.txt
set -eu
VERSION="${CI_COMMIT_TAG#v}"
for f in "$@"; do
  echo "Upload $(basename "$f")"
  curl --fail --silent --show-error --header "JOB-TOKEN: ${CI_JOB_TOKEN}" \
    --upload-file "$f" \
    "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/generic/cyberdog/${VERSION}/$(basename "$f")"
  echo
done
