#!/usr/bin/env bash
7z a mastodon-notifications.zip . -r
7z d mastodon-notifications.zip -r .git
7z d mastodon-notifications.zip mkzip.sh
7z d mastodon-notifications.zip schemas/gschemas.compiled
