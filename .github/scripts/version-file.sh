#!/usr/bin/env bash
# Fail unless the build in <dir> publishes version.json naming <tag>. The other
# Keybard site reads it to show this site's release and the firmware it carries
# (src/utils/site-versions.ts); vite.config.ts writes it for release builds.
set -euo pipefail
tag=${1:?usage: version-file.sh <tag> <dir>}
dir=${2:?usage: version-file.sh <tag> <dir>}
file="$dir/version.json"
[ -f "$file" ] || { echo "::error::$file is missing" >&2; exit 1; }
got=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).tag))" "$file")
[ "$got" = "$tag" ] || { echo "::error::$file names $got, not $tag" >&2; exit 1; }
echo "version.json: $(cat "$file")"
