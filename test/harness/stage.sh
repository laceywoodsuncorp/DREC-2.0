#!/bin/sh
# Stages a testable copy of the dashboard. Three rewrites, all of them only
# ever applied to the copy -- the real page must keep its CDN Leaflet and
# must never contain location.search:
#   1. Leaflet from unpkg  -> a local copy, since the test host has no CDN access
#   2/3. the API routes gain location.search, so a test can pick a scenario
#        with a query parameter on the page URL.
#
# Usage: test/harness/stage.sh <scratch-dir>
#   <scratch-dir> must contain node_modules/leaflet (npm install leaflet).
set -e
SCRATCH="$1"
[ -n "$SCRATCH" ] || { echo "usage: stage.sh <scratch-dir>" >&2; exit 2; }
SRC="$(dirname "$0")/../../index_updated_abc_emergency_map.html"
OUT="$SCRATCH/testsite"
mkdir -p "$OUT"
rm -rf "$OUT/leaflet-pkg"
cp -r "$SCRATCH/node_modules/leaflet" "$OUT/leaflet-pkg"
sed -e 's#https://unpkg.com/leaflet@[^/]*/dist/#/leaflet-pkg/dist/#g' \
    -e "s#'/api/incidents'#'/api/incidents'+location.search#g" \
    -e "s#'/api/outages'#'/api/outages'+location.search#g" \
    -e "s#'/api/outages/'+st.toLowerCase()#'/api/outages/'+st.toLowerCase()+location.search#g" \
    "$SRC" > "$OUT/index.html"
echo "staged $OUT/index.html"
