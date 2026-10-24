# Don Manuel's 60th memory book: project log and handoff

Single source of truth for decisions and the as-built design. Update this file whenever a decision is made or changed. Claude Code: read this first, and do not contradict a DECIDED row without asking the owner.

## Mission

A web app where guests at Don Manuel's 60th birthday party (about 100 people, at a house) leave a note, photo, or short video. No app install, no guest accounts. Contributions become a keepsake memory book after the party (Phase 2).

## Hard constraints

- Party is Saturday 2026-10-24 at 17:00 America/Los_Angeles. Planning started the night of 2026-10-23. Collection must be live and tested before the party. Book, PDF and video montage happen after.
- Guests are on cellular only. The house has no usable wifi. Uploads must survive weak and dropped signal.
- No guest sign-in, no app download. Entry is a QR code or link, plus a typed 4 digit code.
- iOS Safari cannot upload in the background. The page tells guests to keep it open until "All sent", and resumes the queue on the next visit.
- Everything is served over HTTPS (needed for the camera and service workers).
- Owner style rule: no em dashes or en dashes anywhere (content, code comments, UI copy). A test enforces it.
- The owner rejected simulated behavior: this is a real system, not a demo.

## Status (as built)

Deployed 2026-10-24 around 12:30 PDT into account 139023233949 (owner confirmed this account, signed in as root through `aws login`, CLI profile `memorybook`). Backend stack `memory-book-don-manuel` in us-west-2. Amplify app `memory_book` (id d2938vpg535zho) is in us-east-1 because it was created there; it serves globally, so it was kept. Site `https://main.d2938vpg535zho.amplifyapp.com`, repo `github.com/aegironsecurity/memory_book` (Amplify linked, builds on push to main). The scripts run from Windows Git Bash too (CRLF stripped from aws.exe output, `node` fallback when `jq` is missing). `scripts/smoke.sh` passed every check against the live stack on 2026-10-24, which covers items 1 to 4 below for curl. Phones (items 5 and 6) are still untested.

- `backend/` Lambda handlers (guest and host), esbuild bundles committed in `backend/dist`.
- `frontend/` guest page, host page, service worker. No build step.
- `template.yaml` SAM/CloudFormation (cfn-lint clean).
- `scripts/` deploy, host user, smoke test, export (shellcheck clean, dry run against a stub `aws` verified).
- `docs/STANDUP.md` step-by-step deploy walkthrough for the owner.
- Tests: `cd backend && npm test` runs 39 tests (handlers, upload engine against the real handlers with injected failures, a 60 seed failure sweep, front end checks including CSP safety and en dash/em dash ban). `npm run e2e` drives real Chromium with a fake camera through the guest and host pages under the production CSP (needs `backend/test/browser/make-media.sh` first).

### Not verified (only possible once deployed to a real AWS account)

These behave as designed against fakes but must be confirmed by `scripts/smoke.sh` and the two phone test in STANDUP.md:

1. Real S3 presigned multipart PUT from a browser (CORS, no checksum params, ETag handling, `ListParts` sizes).
2. Amplify applying `customHttp.yml` (CSP and other headers) and serving `frontend/` from `amplify.yml`.
3. API Gateway JWT authorizer accepting the Cognito ID token (audience is the user pool client id) and the HTTP API CORS preflight.
4. Lambda Node.js 22 arm64 running the esbuild ESM bundle, Secrets Manager read at cold start, DynamoDB conditional writes.
5. iOS Safari: in-page recording (MediaRecorder mp4), HEIC photo decode, wake lock, upload behavior when the screen locks. Android Chrome: webm recording.
6. Real cellular behavior (stalls, tower handoff). The engine has a 30 s stall watchdog and infinite retry with backoff.

## Decisions

Status key: DECIDED (owner chose), DEFAULT (Claude recommendation, owner has not objected).

| ID | Decision | Status | Notes |
|----|----------|--------|-------|
| D01 | Everything runs in AWS | DECIDED | Owner preference |
| D02 | AWS Amplify Hosting serves the front end | DECIDED | Owner preference. HTTPS and a stable URL |
| D03 | Media uploads go directly from the phone to S3 using presigned multipart uploads. No upload bytes pass through Lambda | DEFAULT | Resumable by listing parts |
| D04 | Postgres on EC2 stays out of the party critical path | DEFAULT | Reliability and time risk. Revisit after the party for the book |
| D05 | DynamoDB (on-demand) stores memory records | DECIDED | Postgres can be added later for the book |
| D06 | AWS SAM defines the infrastructure | DECIDED | One template, deployed with `aws cloudformation package` and `deploy` from CloudShell (no SAM CLI needed) |
| D07 | Region is us-west-2 (Oregon) | DECIDED | |
| D08 | Front end is deployed from a GitHub repo through Amplify | DECIDED | Push to main triggers a build |
| D09 | Guest page is vanilla JS (ES modules) plus a service worker, no build step | DECIDED | Smallest payload on weak cell |
| D10 | Video is recorded in the page at 720p, capped at 60 seconds | DECIDED | Revised by D33 for library files |
| D11 | Owner may post the link online but only party guests should be able to use it | DECIDED | Requires an access gate (D12) |
| D12 | Access gate is QR plus a typed 4 digit code | DECIDED | The QR carries only the event link. The code is verified server side before any token or upload URL is issued. Host can rotate it |
| D13 | Upload link closes Mon 2026-10-26 17:00 America/Los_Angeles | DECIDED | Enforced server side. See D27 for the stored value |
| D14 | Host signs in with Amazon Cognito, one admin-created host user, optional TOTP | DECIDED | Host API routes require a valid Cognito JWT |
| D15 | Scope: web book, PDF book export, video montage. No live wall for a TV | DECIDED | |
| D16 | Delivery phases | DEFAULT | Phase 1 before the party: collection, host moderation, cards, phone test. Phase 2 after: book, PDF, montage |
| D17 | Abuse limits: API throttling (50 rps, burst 100), per-guest caps (15 files, 400 MB), content type and magic byte checks, stale multipart uploads aborted by lifecycle rule. No WAF | DECIDED | Wrong-code rate limit: 20 per IP and 300 per event per 10 minutes, counting only wrong codes because carrier NAT shares IPs |
| D18 | No budget or error alerting | DECIDED | Owner chose to skip, risk flagged twice. An AWS Budgets email costs nothing and takes 3 minutes |
| D19 | Media bucket is private: Block Public Access, SSE-S3, TLS only policy, no versioning, retained on stack delete | DECIDED | Host views files through 15 minute presigned URLs |
| D20 | Owner needs a step-by-step deploy walkthrough | DECIDED | `docs/STANDUP.md` |
| D21 | Guests use the default Amplify URL | DECIDED | No custom domain |
| D22 | Photos are shrunk in the browser to a 2048 px long edge JPEG (quality 0.82) before upload | DECIDED | Re-encoding applies EXIF rotation and strips EXIF (GPS) |
| D23 | English and Spanish toggle | DECIDED | Auto-detect from browser language, remembered. A test checks both dictionaries have the same keys and placeholders |
| D24 | Cognito sign-in uses direct InitiateAuth (USER_PASSWORD_AUTH) over TLS, no hosted UI | DEFAULT | Avoids the callback URL chicken and egg. TOTP supported by the host page but not enabled tonight |
| D25 | Guest of honor is Don Manuel. Page title "Don Manuel's 60th". Host user jon@aegironsecurity.com. Own AWS account | DECIDED | Email exactly as the owner typed it |
| D26 | Party code is 1966 | DECIDED | Flagged: Don Manuel's birth year, so guessable. The 128 bit event id in the link is the real secret. Rotate from the host page |
| D27 | Upload window closes 2026-10-27T00:00:00Z (Mon Oct 26 17:00 PDT) | DECIDED | In-flight uploads may finish for 6 hours after close (grace). New sessions are refused after close |
| D28 | Lambda code is bundled with esbuild into `backend/dist` and committed | DECIDED | Deploys need no npm install. Run `npm run build` in `backend` after ANY backend change |
| D29 | Guest token signing key is a CloudFormation generated secret in Secrets Manager, read at cold start | DECIDED | Nobody types or sees it |
| D30 | All media, photos included, uses S3 multipart with 5 MiB parts. Thumbnails (320 px JPEG, up to 60 KB) are sent base64 in the create call and written by the Lambda | DECIDED | One upload path to test. The server lists parts as the source of truth, so the client never tracks ETags |
| D31 | Create is idempotent through a client generated memory id (`^[0-9a-z]{9}-[0-9a-f]{16}$`) | DECIDED | A lost response never duplicates a memory |
| D32 | S3 client sets `requestChecksumCalculation: WHEN_REQUIRED` | DECIDED | Newer SDKs otherwise add CRC32 params to presigned URLs, which breaks browser uploads |
| D33 | Library videos must be 60 s or shorter (1.5 s slack) and 100 MB or smaller, otherwise refused with a message to record in the page. Nothing is trimmed in the browser | DECIDED | Server caps: photo 12 MB, video 120 MB, 62 s |
| D34 | No bulk download in the browser. Host page has per-item Open and Download links and a JSON metadata export. Bulk export uses `scripts/export.sh` (aws s3 sync) | DECIDED | |
| D35 | No Lambda reserved concurrency. API stage throttling is the cost control | DECIDED | New accounts can have low concurrency quota, and reserving would fail the deploy |
| D36 | Fonts are self-hosted (Bricolage Grotesque for display, system fonts for body) | DECIDED | Strict CSP, nothing from third parties |
| D37 | Guest link is `https://<amplify-domain>/#e=<eventId>` | DECIDED | The id lives in the URL fragment, so it never reaches a server or a referrer. The page stores it in localStorage and clears the fragment |
| D38 | Event id is generated by `scripts/deploy.sh` (kept in `.deploy/event-id`) and passed to the stack as a parameter. The script seeds the event item once | DECIDED | Amplify app is created first so its domain can be the allowed origin |
| D39 | Cap errors (`limit_reached`) are HTTP 403, not 429 | DECIDED | Found by tests: 429 is treated as transient by the engine, so a guest at the cap retried forever |
| D40 | Service worker serves repeat visits from its saved copy if the network has not answered within 2.5 s, and stops waiting for 30 s after a slow answer. First visits wait for the network | DECIDED | Found by tests: waiting per module layer made a hanging connection take 10 s to open the page, now 2.6 s |
| D41 | Host table cards are printed from the host page (QR drawn in the browser from the vendored `qrcode-generator`, 6 cards per sheet, bilingual). The host types the code to print because only its hash is stored | DECIDED | The QR was verified by decoding a screenshot with OpenCV |
| D42 | Production headers live in `customHttp.yml`: CSP with `default-src 'none'`, `script-src 'self'`, `style-src 'self'` (no inline anything), HSTS, nosniff, no-referrer, camera and microphone for self only | DECIDED | No inline script, style attribute or handler may be added. Tests enforce it |

## Open items for the owner

- Amplify app is in us-east-1, not us-west-2 (D07). Harmless; recreate later only if wanted.
- Confirm `1966` stays (D26) given it is guessable.

## Architecture

Region us-west-2. One SAM stack for everything except the Amplify app, which is created in the console and linked to GitHub.

```
Phone browser (static site on Amplify, service worker, IndexedDB queue)
   |  HTTPS JSON                         |  HTTPS PUT of 5 MiB parts (presigned)
   v                                     v
API Gateway HTTP API  ---- Lambda ----> S3 media bucket (private)
 (CORS to Amplify origin,   |
  throttle 50/100,          +--------> DynamoDB table (single table, on demand, PITR)
  JWT authorizer on /host/*)+--------> Secrets Manager (token key)
Cognito user pool (one admin-created host user)
```

- **Amplify Hosting** serves `frontend/` (`amplify.yml`), headers from `customHttp.yml`.
- **API Gateway HTTP API** with stage throttling, CORS limited to the Amplify origin, access logs, and a Cognito JWT authorizer on `/host/*` only.
- **Lambda** Node.js 22 arm64 256 MB 15 s. Two functions: guest and host, each with a least privilege role. Logs kept 14 days.
- **DynamoDB** single table `PK`/`SK`, on demand, point in time recovery, deletion protection, TTL attribute `ttl` for rate limit rows.
- **S3** private bucket, BucketOwnerEnforced, SSE-S3, TLS only, CORS for PUT/GET/HEAD exposing ETag, lifecycle aborts incomplete multipart uploads after 1 day.
- **Cognito** admin-created users only, password min 12, optional TOTP, client without secret, ID token 8 h, refresh 7 days.

### Data model (table, keys PK and SK)

| Item | PK | SK | Attributes |
|------|----|----|------------|
| Event | `EVENT#<eventId>` | `META` | guestOfHonor, codeHash = sha256(`<eventId>:<code>`), codeVersion, opensAt, closesAt |
| Memory | `EVENT#<eventId>` | `MEM#<memoryId>` | kind (note, photo, video), name, text, caption, contentType, sizeBytes, durationSec, key, thumbKey, uploadId, partSize, totalParts, status (pending, complete), hidden, guestId, createdAt, completedAt |
| Guest quota | `EVENT#<eventId>` | `GUEST#<guestId>` | fileCount, bytesTotal (conditional atomic ADD) |
| Rate limit | `RATE#IP#<ip>#<window>` and `RATE#EVT#<eventId>#<window>` | `CODE` | attempts, ttl |

Object keys: `events/<eventId>/<memoryId>/original.<ext>` and `.../thumb.jpg`. Notes live in DynamoDB only.

### Guest API (header `Authorization: Bearer <token>` except `/guest/start`)

- `POST /guest/start` {eventId, code, guestId}: checks window and rate limits, verifies the code (constant time), returns `{token, exp, guestOfHonor, closesAt, limits}`. Token is `v1.<payload>.<hmac>` with eid, gid, codeVersion `cv`, `exp = min(now + 48 h, closesAt + 6 h)`. Rotating the code invalidates all tokens (`code_changed`, 401).
- `POST /guest/memories`: idempotent create. Note returns `complete`. Media validates type, size, duration and thumbnail, reserves quota, starts the multipart upload, returns `{status: pending, uploadId, partSize, totalParts}`.
- `POST /guest/memories/{id}/parts` {partNumbers}: returns presigned UploadPart URLs (15 minutes) and the parts S3 already holds (`uploaded: [{partNumber, size}]`).
- `POST /guest/memories/{id}/complete`: 409 `incomplete` with `missing` and `wrongSize` lists, 422 `size_mismatch` or `bad_file` (magic bytes) which also removes the object, 410 `upload_gone` if the multipart upload expired, otherwise completes.
- `DELETE /guest/memories/{id}`: aborts an unfinished upload and frees quota.

### Host API (Cognito JWT)

- `GET /host/memories`: event summary, counts, every memory with presigned `url`, `downloadUrl`, `thumbUrl`.
- `POST /host/memories/{id}/hide` and `/show`.
- `POST /host/code/rotate` {code?}: new 4 digit code (random if omitted), bumps `codeVersion`.
- `POST /host/window` {closeNow | extendHours 1..168 | closesAt}.

### Upload engine (`frontend/js/uploader.js`)

Pure logic with injected dependencies, so it runs in Node tests and in the browser.

1. Persist the item and its Blob to IndexedDB before any network call.
2. Idempotent create, then probe parts on the server, upload only missing parts (2 in flight), refresh the URL on 403/400, complete, loop if the server says `incomplete`.
3. Transient errors (no answer, 5xx, 408, 429, S3 5xx) retry forever with exponential backoff and jitter. 401 asks for the code again. 403 `closed`, `limit_reached`, 422 `bad_file` fail that item only. 410 or 404 restarts under a new id (max 2).
4. Triggers: `online`, `visibilitychange`, `pageshow`, a 15 s timer while anything is queued, and page load. Wake Lock while uploading, `beforeunload` warning, `navigator.storage.persist()`.
5. XHR `putPart` has a 30 s stall watchdog.

## Security checklist

- Bucket private, TLS only, encrypted, presigned URLs only (15 minute expiry).
- No secrets in the repo or template. Signing key in Secrets Manager.
- Server side enforcement of window, caps, content type allowlist (jpeg, png, webp, mp4, webm, quicktime), sizes, magic bytes, thumbnail validity.
- Guest text is rendered with `textContent` only. The host page never injects guest HTML.
- CORS and CSP restricted to known origins. `.deploy/` (holds the event id) is gitignored.
- Known gaps by owner choice: no alerting (D18), no MFA tonight (D24), no WAF (D17), guessable code (D26).

## Cost estimate (rough, unverified)

A few GB of media and a few thousand requests: S3, DynamoDB, Lambda, API Gateway and Amplify should total well under a few dollars for the event. Secrets Manager is about 0.40 per month. Verify on the AWS pricing pages.

## Test plan before 17:00 on 2026-10-24

Automated (here): `npm test`, `npm run e2e`.

On real infrastructure (owner, STANDUP.md steps 6 and 7): `scripts/smoke.sh`, then two real phones on cellular with wifi off: note, photo, 60 second video recorded in the page, airplane mode mid-upload, close the tab mid-upload and reopen, wrong code, bare link, host hide and show, code rotation, Spanish toggle. Fallback: a shared album link on the table cards.

## Timeline (America/Los_Angeles)

- Friday night: design, code, tests (done).
- Saturday morning: owner follows STANDUP.md, deploys, runs the phone test.
- Saturday midday: print table cards from the host page.
- Saturday 15:00: freeze changes. 17:00 party.

## Phase 2 (after the party)

Run locally with Claude Code against `scripts/export.sh` output (`export/files/<memoryId>/original.*` and `export/memories.json`, hidden items flagged): a static web book, a PDF via headless Chromium (video pages carry a QR code to the clip), and a montage with ffmpeg. Use MediaConvert only if local processing is too slow. Postgres on EC2 is optional here (D04).

## Handoff notes for Claude Code

- After any backend change: `cd backend && npm test && npm run build` and commit `backend/dist`.
- After any front end change: `npm test` and `npm run e2e`. Do not add inline script, style attributes or inline handlers (D42). Add new UI strings to both languages (D23).
- Never edit `frontend/js/config.js` by hand for production, `scripts/deploy.sh` writes it.
- The prototype in `docs/prototype-guest-flow.html` is a design reference only and still says "Dad".
- Keep this log current. Do not use em dashes or en dashes anywhere.
