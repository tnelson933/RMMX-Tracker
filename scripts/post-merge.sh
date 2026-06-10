#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push-force
pnpm --filter @workspace/scripts run migrate:entry-fee-category
pnpm --filter @workspace/local-server run build
