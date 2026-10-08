#!/usr/bin/env bash
# Standalone repro (no node_modules needed; Node >= 23 type stripping).
set -e
R=$(cd "$(dirname "$0")/../.." && pwd); D=$(mktemp -d)
mkdir -p $D/utils $D/constants $D/telegram
echo 'export const createLogger=()=>({debug(){},info(){},warn(){},error(){}});' > $D/utils/logger.ts
echo 'export const TELEGRAM_MAX_MESSAGE_LENGTH=4096;' > $D/constants/limits.ts
for f in flood-retry message-splitter; do sed 's/\.js"/.ts"/' $R/src/telegram/$f.ts > $D/telegram/$f.ts; done
sed -n 53,108p $R/src/telegram/admin.ts > $D/admin-methods.txt
cp "$(dirname "$0")/repro-telegram-1.ts" $D/repro.ts
cd $D && node repro.ts
