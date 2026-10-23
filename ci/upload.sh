#!/bin/sh
# Envoie les fichiers donnés dans le Package Registry générique du projet GitLab
# (auth : CI_JOB_TOKEN en pipeline, ou GITLAB_TOKEN = jeton personnel scope api en local).
# Usage : ci/upload.sh dist/*.exe dist/SHA256SUMS-windows.txt
set -eu
VERSION="${CI_COMMIT_TAG#v}"
if [ -n "${GITLAB_TOKEN:-}" ]; then AUTH="PRIVATE-TOKEN: $GITLAB_TOKEN"; else AUTH="JOB-TOKEN: $CI_JOB_TOKEN"; fi
for f in "$@"; do
  echo "Upload $(basename "$f")"
  curl --fail --silent --show-error --header "$AUTH" \
    --upload-file "$f" \
    "${CI_API_V4_URL}/projects/${CI_PROJECT_ID}/packages/generic/cyberdog/${VERSION}/$(basename "$f")"
  echo
done
