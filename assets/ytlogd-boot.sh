#!/bin/sh
# Copied to /var/lib/webosbrew/init.d/ytlogd, without the dot run-parts skips it.
# It runs in the background so it never holds the boot.
app=/media/developer/apps/usr/palm/applications/youtube.leanback.v4
(
    while [ -f "$app/ytlogd.js" ]; do
        /usr/bin/node "$app/ytlogd.js"
        sleep 5
    done
) </dev/null >/dev/null 2>&1 &
