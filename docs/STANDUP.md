# Stand-up walkthrough: Don Manuel's 60th memory book

Plan for about 60 to 90 minutes on Saturday morning. The party is at 5:00 PM Pacific, so aim to be done with testing by 1:00 PM and print cards by 2:00 PM. Every step says what you should see when it worked.

You will use three places: **GitHub** (holds the code), **AWS Amplify** (serves the web page), and **AWS CloudShell** (a terminal in your browser that builds the back end). Everything runs in your own AWS account in **us-west-2 (Oregon)**.

> Stuck at any point? Do not burn time. Jump to the fallback at the end (shared album link on the table cards) and fix this after the party. Guests can still leave memories there.

## Before you start (5 minutes)

- Sign in to the AWS console with a user that can create things (an administrator). Check the region in the top right says **US West (Oregon) us-west-2**. Stay on that region for everything.
- You need the project zip (`memory-book.zip`) on your computer, unzipped.
- Your GitHub repo for this project (empty or not). Note its name.

## Step 1. Put the code on GitHub (5 minutes)

Pick one way.

**A. On your computer with git**

```
cd memory-book
git init
git add -A
git commit -m "Memory book"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main --force
```

**B. In the browser, no git**: open your repo on github.com, click **Add file, Upload files**, drag in everything from inside the unzipped `memory-book` folder (including the `frontend`, `backend`, `scripts`, `docs` folders and the files `template.yaml`, `amplify.yml`, `customHttp.yml`, `CLAUDE.md`, `README.md`, `.gitignore`), then **Commit changes**. If GitHub refuses folders, do it one folder at a time.

Check: on github.com you can see `frontend/index.html`, `backend/dist/guest/index.mjs`, `amplify.yml`, and `customHttp.yml` at the top level of the repo.

## Step 2. Create the Amplify site (10 minutes)

You do this first only because Amplify decides the web address, and the back end needs to know it.

1. AWS console, search **Amplify**, open it, click **Create new app** (or **Deploy an app**).
2. Choose **GitHub** as the source and click Continue. Approve the GitHub pop-up ("Authorize AWS Amplify" and install it on your repo). If you have many repos, choose **Only select repositories** and pick this one.
3. Select the repo and the branch **main**.
4. On the build settings page leave everything as detected. It should find `amplify.yml` and say the app is a static site served from `frontend`. If it asks about a monorepo, leave that off.
5. Save and deploy. Wait for **Provision, Build, Deploy** to turn green (1 to 3 minutes).
6. Copy the **domain**. It looks like `https://main.d1abc23def.amplifyapp.com`. This is your **site address**. Keep it handy, you will paste it in Step 3.

Check: open the site address in a browser. You will see a page saying "This link is not complete". That is correct, you have not got the guest link yet.

Check the security headers took effect: in Amplify click **Hosting, Custom headers** and confirm you see the Content-Security-Policy rules (they come from `customHttp.yml`). If that tab is empty, tell me and we will paste them in by hand.

## Step 3. Build the back end with CloudShell (15 minutes)

1. In the AWS console click the **CloudShell** icon (the `>_` in the top bar). Wait for the prompt. Confirm the region is still us-west-2.
2. Click **Actions, Upload file**, choose `memory-book.zip`.
3. Run:

```
unzip -o memory-book.zip
cd memory-book
chmod +x scripts/*.sh
./scripts/deploy.sh https://main.d1abc23def.amplifyapp.com 1966
```

Use your own site address from Step 2 (no slash at the end). `1966` is the party code you chose.

The first run takes about 3 to 5 minutes. It prints `Event created with party code 1966.` and then a **Guest link** that looks like `https://main.d1abc23def.amplifyapp.com/#e=…` followed by the contents of `frontend/js/config.js`.

Save the guest link somewhere safe (a note to yourself). **That link is what the QR code holds.** It is also on the host page later.

Check: CloudFormation (console) shows the stack `memory-book-don-manuel` as `CREATE_COMPLETE`.

## Step 4. Tell the web page where the API is (5 minutes)

CloudShell wrote `frontend/js/config.js` inside CloudShell, but Amplify builds from GitHub, so GitHub needs the same file.

- On github.com open `frontend/js/config.js`, click the pencil (Edit), select all, paste the file contents printed at the end of Step 3, **Commit changes**.
- Or, if you use git on your computer: edit the same file locally and push.

Amplify rebuilds in about a minute. Wait until the build is green.

## Step 5. Create the host login (3 minutes)

Back in CloudShell:

```
./scripts/create-host-user.sh jon@aegironsecurity.com
```

Type a password twice (12 or more characters with upper and lower case, a number and a symbol). Nothing is emailed.

Check: open `https://<your site address>/host.html`, sign in with that email and password. You should see the dashboard. Do this on your phone too, so you know it works before the party.

## Step 6. Run the automatic check (2 minutes)

```
./scripts/smoke.sh https://main.d1abc23def.amplifyapp.com
```

You want every line to say `ok` and the last line `All checks passed.` It leaves one note and one tiny test photo from "Smoke Test". Hide them on the host page (the **Hide** button) so they stay out of the book.

If a line says FAIL, read the message, it says what to look at. The most common one is `config.js does not match`, which means Step 4 was not finished.

## Step 7. Test on two real phones on cellular (20 minutes)

This is the test that matters. Use one iPhone and one Android if you can. **Turn wifi off** on both so you are truly on cellular.

Open the guest link on each phone, type `1966`, then check each row:

| Test | What should happen |
|------|--------------------|
| Write a note and save it | Green "Sent" in the tray at the bottom within a few seconds |
| Add a photo from the camera roll | Tray shows progress, then "All sent" |
| Record a 60 second video in the page | Timer stops at 1:00 by itself, review plays, saving sends it |
| Start a video upload, then switch on **airplane mode** for 20 seconds, then off | The tray says "Waiting for signal", then continues by itself and finishes |
| Start an upload, **close the tab**, reopen the link | The queue resumes where it stopped |
| Type a wrong code | Clear message, no lockout for the next guest |
| Open the guest page from a **second phone with no stored link** and the plain site address (no `#e=`) | "This link is not complete" |
| On the host page: do all test items appear, with thumbnails, and can you play the video? | Yes |
| Hide one memory, then Show it again | The row greys out, then returns |
| Spanish toggle ("Español" button, top right) | Whole page switches language |

Keep the page open until the tray says **All sent** (iPhone cannot upload in the background). The page tells guests this too.

Delete your test memories with **Hide** (the host page has no delete on purpose) or leave them, they are small.

## Step 8. Print the table cards (10 minutes)

1. Open the host page, **Table card** panel.
2. Type `1966` in **Code to print on the card**.
3. Click **Print 6 cards**. Use your printer, or choose **Save as PDF** and print later. Print as many sheets as you have tables.
4. **Scan one printed card with a phone** to confirm the QR opens the page and asks for the code.

The card also prints the full link in tiny type as a backup if someone cannot scan.

## Step 9. The fallback (5 minutes, do it now so you never need it)

Create a shared album (Google Photos or iCloud shared album) and put its link on a second, handwritten line of the card, or on one extra card per table. If anything fails during the party, guests can drop photos there and you merge them into the book later.

## Day of the party

- Freeze changes at 3:00 PM. Do not redeploy after that.
- Keep the host page open on your phone. Tap **Refresh** any time. It also updates itself every 30 seconds.
- If a code leaks: host page, **Party code**, **Change code**, then reprint. Guests who already have the page will be asked for the new code before the next upload.
- If a stranger gets the link, you can close uploads at once: **Upload window, Close now** (tap twice).

## After the party

- Uploads close by themselves on **Monday Oct 26 at 5:00 PM Pacific** (plus 6 hours for uploads already in progress). Extend with **Add 24 hours** if you want.
- Get everything: in CloudShell run `./scripts/export.sh`. It copies all original files and a `memories.json` into `export/`. Use **Actions, Download file** or `aws s3 sync` from your computer.
- Phase 2 (book, PDF, video montage): see `CLAUDE.md`, "Phase 2". Hidden memories are marked in `memories.json`.

## Known risks you chose to accept

- **No alerts or budget alarms.** Nothing tells you if something breaks or costs spike. The expected cost is a few dollars. If you want a safety net, create an AWS Budget with an email alert at 10 dollars (Billing, Budgets). It takes 3 minutes.
- **The code `1966` can be guessed** (it is Don Manuel's birth year). The long secret in the link is the real protection, and wrong guesses are rate limited. Do not post the link or a photo of the card publicly. You can change the code any time from the host page.
- **No MFA on the host login tonight.** You can add an authenticator app later in Cognito. The host page already supports the code prompt.

## If something goes wrong

| Symptom | Fix |
|---------|-----|
| `deploy.sh` says "backend/dist is missing" | The zip was extracted without `backend/dist`. Re-extract the original zip. |
| `deploy.sh` fails with "AccessDenied" | Your AWS user lacks permissions. Use an administrator user. |
| `deploy.sh` fails on the bucket name | Another account used that name. Set `STACK_NAME=memory-book-2` and rerun. |
| Site shows "This link is not complete" for guests | They opened the plain address. They must use the full link with `#e=...` (the QR). |
| Page loads but "Cannot reach the server" | `config.js` is still empty (Step 4) or Amplify has not finished rebuilding. |
| Uploads stall at 0% forever on cellular only | Run `smoke.sh` and read the S3 CORS line. The site address given to `deploy.sh` must match exactly. Re-run `deploy.sh` with the right address. |
| Host login says "Email or password is not right" | Run `create-host-user.sh` again to set a new password. |
| Camera does not open on a guest phone | They denied permission. Use **Choose from your library** instead, or allow the camera in browser settings. |
| Need to redeploy the back end | Run `deploy.sh` again with the same arguments. It keeps your event, link and code. |
| Want to remove everything later | `aws cloudformation delete-stack --stack-name memory-book-don-manuel`. The media bucket and user pool are kept on purpose. Delete them by hand when you are sure. |
