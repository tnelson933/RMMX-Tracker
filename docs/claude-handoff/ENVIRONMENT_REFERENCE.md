# Environment and external-service reference

This file contains **names and purposes only**, not exported values.
Some variables are optional or feature-specific. A name appearing in source
does not mean it is set in every deployment.

The API does not automatically load a root `.env` file. Configure the actual
process environment or add a reviewed development-only loader.

## Essential cloud API and web configuration

| Name | Used by | Purpose / notes |
| --- | --- | --- |
| `DATABASE_URL` | API/shared DB, Drizzle, some scripts | PostgreSQL connection; secret |
| `SESSION_SECRET` | API/local server | Cookie-signing secret; generate a strong value; source has unsafe-for-production development defaults |
| `NODE_ENV` | API/build/web | Production enables secure cookies; configure TLS/trusted proxy correctly |
| `PORT` | Each service | API 8080; web dev 19869; local 9090; Expo currently 18530 |
| `BASE_PATH` | Web/Expo builds and servers | Web `/`; current rider web export `/rider-app/` |
| `APP_URL` | Email, onboarding and public URL construction | Full public web origin; audit Replit-domain fallback precedence |
| `LOG_LEVEL` | API logger | Optional logging verbosity |
| `VITE_CLOUD_URL` | Built web client / desktop UI | Public cloud origin, not a secret; used for links from desktop |

## Payments, email, storage and AI

| Name | Purpose / migration constraint |
| --- | --- |
| `STRIPE_SECRET_KEY` | Preferred direct Stripe platform server key; secret |
| `Stripe_secret_key` | Case-sensitive legacy supported alternative; secret |
| `STRIPE_PUBLISHABLE_KEY` | Stripe public client configuration |
| `RESEND_API_KEY` | Resend server credential |
| `EMAIL_FROM` | Verified sender identity |
| `SUPPORT_ALERT_EMAILS` | Rocky support request email recipients (comma-separated; default every super admin) |
| `SUPPORT_ALERT_PHONES` | Rocky support request text recipients (comma-separated, E.164) |
| `TWILIO_ACCOUNT_SID` | Twilio account for support request texts |
| `TWILIO_AUTH_TOKEN` | Twilio server credential |
| `TWILIO_FROM_NUMBER` | Twilio sending number (or `TWILIO_MESSAGING_SERVICE_SID`) |
| `GITHUB_TOKEN` | Support investigation: code search, and pull requests for approved code fixes (contents + pull requests write) |
| `SUPPORT_GITHUB_REPO` | Repository the support investigation reads (default `tnelson933/RMMX-Tracker`) |
| `SUPPORT_GITHUB_BRANCH` | Branch it reads and opens pull requests against (default `claude/railway-deploy`) |
| `PUBLIC_OBJECT_SEARCH_PATHS` | Current storage search prefixes, comma-separated |
| `PRIVATE_OBJECT_DIR` | Current private object prefix |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` | Replit-provisioned bucket identifier; inventory may include it even where application code reads the other paths |
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | Current Anthropic-compatible proxy base; replace/adapt outside Replit |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Current managed proxy credential; not a portable direct Anthropic key |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Current OpenAI-compatible proxy base |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Current managed OpenAI proxy credential |

Server-side AI variables must never become `VITE_*` or `EXPO_PUBLIC_*`.
A Claude programming subscription does not automatically replace the running
application's AI API access.

The app's object-storage implementation also needs Replit's sidecar credential
and signing service. These path variables alone are insufficient off-platform.

## Local server, desktop and synchronization

| Name | Purpose / notes |
| --- | --- |
| `SQLITE_FILE` | Persistent local race database path |
| `STATIC_FILES_DIR` | Path to built frontend for standalone local-server |
| `CLOUD_URL` | Full cloud origin, runtime sync and/or baked into installer builds |
| `CLUB_ID` | Club scope for standalone sync |
| `SYNC_TOKEN` | Secret sync credential where supported |
| `CLOUD_EMAIL` | Private login identifier for authorized sync fallback |
| `CLOUD_PASSWORD` | Secret; never commit or include in export |
| `GITHUB_TOKEN` / workflow `GH_TOKEN` | Owner-controlled source/release automation, not needed by ordinary race operators |

Electron also stores credentials using its own encrypted storage. Those local
user stores are not in the source package.

## Rider mobile / Expo

| Name | Purpose / notes |
| --- | --- |
| `EXPO_PUBLIC_DOMAIN` | API hostname, **without** `https://`; current code prepends HTTPS |
| `EXPO_PUBLIC_REPL_ID` | Replit preview/build metadata; review necessity outside Replit |
| `EXPO_PACKAGER_PROXY_URL` | Replit preview proxy configuration; adapt normal Expo development |
| `REACT_NATIVE_PACKAGER_HOSTNAME` | Development bundler reachability |
| `METRO_PORT` | Optional Metro build diagnostic/export port |
| `EXPO_TOKEN` / `expo_access_token` | Expo service access; secret; do not distribute |

Public-prefixed mobile variables are embedded in the application binary.
Do not put credentials there. Inspect `app.json`, `eas.json`, Metro config,
the mobile build script, and the EAS workflow together.

## Replit-specific runtime variables

These are platform metadata/identity, not values to recreate from guessed text:

- `REPL_ID`, `REPLIT_DOMAINS`, `REPLIT_DEV_DOMAIN`, `REPLIT_EXPO_DEV_DOMAIN`.
- `REPLIT_INTERNAL_APP_DOMAIN`.
- `REPLIT_DEPLOYMENT`, `REPLIT_DEPLOYMENT_ID`, `REPLIT_ENVIRONMENT`.
- `REPLIT_CONNECTORS_HOSTNAME`, `REPL_IDENTITY`, `WEB_REPL_RENEWAL`.

The last two identity variables are sensitive runtime tokens. Do not copy them.
Refactor integration fallback code to target-host credentials where needed.
Do not use the old development domain as a replacement production origin.

## Test and benchmark configuration

- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`: optional explicit browser executable.
- `LIVE_TIMING_API_URL`, `API_PORT`: benchmark target configuration.
- `LIVE_TIMING_ALLOW_DATABASE_WRITES`: explicit benchmark safety opt-in.
- `LIVE_TIMING_REQUEST_P95_MS`, `LIVE_TIMING_BROADCAST_P95_MS`,
  `LIVE_TIMING_BROADCAST_MAX_MS`: benchmark thresholds.

The live-timing benchmark creates/writes fixture data. It is not a read-only
production health check.

## Secure configuration worksheet

For each service on the new host, record **outside the repository**:

1. Secret manager location and owner.
2. Development versus production scope.
3. Required public origins/callback URLs.
4. Provider account ownership and recovery access.
5. Rotation/revocation plan.
6. Which process consumes each secret.

No existing secret was read or copied into this handoff. New provider credentials
and any private data backups must be transferred through secure tools, not chat.
