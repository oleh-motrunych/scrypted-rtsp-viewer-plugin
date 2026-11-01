#!/bin/sh
set -eu
umask 077
cd /plugin
case "${1:-help}" in
  login|deploy)
    if [ "$#" -ne 2 ]; then
      echo 'Usage: IMAGE login|deploy HOST:PORT' >&2
      exit 1
    fi
    exec node "scripts/scrypted-$1.cjs" "$2"
    ;;
  help|--help|-h)
    echo 'Scrypted RTSP Live Viewer uploader: login HOST:PORT or deploy HOST:PORT'
    echo 'Mount the same credentials volume at /root/.scrypted for both commands.'
    ;;
  *) echo 'Unknown command. Use login HOST:PORT or deploy HOST:PORT.' >&2; exit 1 ;;
esac
