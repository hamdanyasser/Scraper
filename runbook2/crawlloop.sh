#!/bin/bash
# crawlloop.sh <KEY> [crawl.js options] — run crawl.js and resume it from the checkpoint whenever its watchdog exits 3.
cd "$(dirname "$0")"
node crawl.js "$@"; rc=$?
while [ $rc -eq 3 ]; do node crawl.js "$1" --resume "${@:2}"; rc=$?; done
exit $rc
