# Don Manuel's 60th, memory book

Guests scan a QR code, type a 4 digit code, and leave a note, photo, or short video. No app, no account. Built to survive weak cell signal at a house with no wifi: everything saves on the phone first, uploads resume where they stopped, and nothing is lost if the page closes.

- **Start here:** [docs/STANDUP.md](docs/STANDUP.md) is the step-by-step deploy walkthrough.
- **For Claude Code or any developer:** [CLAUDE.md](CLAUDE.md) holds every decision, the architecture, and the test plan.

```
frontend/   static site (vanilla JS, no build step), served by Amplify
backend/    Lambda handlers, tests, and the committed esbuild bundles in backend/dist
template.yaml   SAM/CloudFormation for S3, DynamoDB, Cognito, API Gateway, Lambda
scripts/    deploy.sh, create-host-user.sh, smoke.sh, export.sh
docs/       STANDUP.md and the original UI prototype
```

## Develop

```
cd backend
npm ci
npm test          # 39 unit and end to end tests (handlers + upload engine + front end checks)
npm run build     # rebuild backend/dist after ANY backend change, and commit it
npm run e2e       # real Chromium test of the guest and host pages (needs Playwright)
```

`npm run e2e` serves the real pages under the production Content Security Policy, with the real Lambda handlers behind in-memory AWS fakes, a fake camera, offline mode, and injected failures. First run `backend/test/browser/make-media.sh` (needs Pillow and ffmpeg) to create the sample photo and videos. Screenshots land in `backend/test/browser/out`.
