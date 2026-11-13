# ADR 001: Stack

Status: accepted, 13 November 2026 (C8 milestone)

## Context

The app has to fit what the course fixes in fly.toml and the Dockerfile:

- one shared-cpu-1x machine with 256 MB of memory
- one volume at /data, the only storage that survives a restart or redeploy
- HTTP on 0.0.0.0:$PORT, with Fly handling TLS
- no separate database server

The starter already uses Node 24, TypeScript and vitest, and its checks talk to the running app over HTTP. /readme/ has to contain README.md's headings in the HTML the server sends, before any script runs.

The C8 version only needs a handful of routes: a lecture page, a tap endpoint, /readme/ and a 404. C9 will add live updates to every open browser.

## Options

*Server*
- node:http (built in): no dependencies, but routing and cookies are written by hand.
- Hono or Express: nicer routing, but it's another dependency to learn and keep updated, for about five routes.
- A full framework like Next.js: build step, much more memory, and solves problems this app doesn't have.

*Database*
- node:sqlite (built in): no install, no native compile. Still marked experimental, so Node 24.13 prints a warning.
- better-sqlite3: stable and widely used, but it's a native module that has to compile or download a binary in the Docker image.
- A JSON file: simplest, but two people tapping at once could overwrite each other's writes.
- Postgres: outside the course setup (it would be a second Fly app).

*README rendering*
- marked on the server: one small dependency, real HTML headings.
- Hand-written markdown parser: no dependency, but easy to get wrong.
- Rendering in the browser: fails the shipped check, which reads the HTML before scripts run.

*pnpm in Docker*
- corepack enable: built into Node, but without a packageManager field in package.json it can pick a different pnpm version.
- npm install -g pnpm@11.9.0: matches the version mise.toml pins.

## Decision

Node 24 running TypeScript directly, node:http, node:sqlite with the database at $DATA_DIR/meter.db, marked for /readme/, and pnpm 11.9.0 installed with npm in a node:24-slim image. marked is the only runtime dependency.

All pages render on the server and work without JavaScript. The tap button is a plain HTML form.

## What it costs

- *Hand-written routing.* Every new route is a few lines of if statements. That's fine at this size but would get messy past about 15 routes.
- *An experimental API.* node:sqlite could change between Node versions. That risk is contained because mise.toml and the Dockerfile pin the version, but upgrading Node means re-running the checks.
- *No migrations tool.* Schema changes for C10 (browser IDs, lecturer codes) have to be written by hand with ALTER TABLE and tested against a copy of the real database.
- *One machine only.* SQLite on one volume can't be shared across machines. That suits the course limits, and it means C9 can keep the list of open connections in memory.
- *Persistence can't be tested in spec/.* Tests can't restart the machine, so it's checked by hand: tap, flyctl machine restart, reload.
