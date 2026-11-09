# Settle Up (v2)

Shared expenses for two people. Mobile-first web app on GitHub Pages, Google Sheet as the database,
Google Apps Script as the API. Free, no server.

```
Phone / laptop → GitHub Pages (docs/) → Apps Script web app (apps-script/Code.gs) → "Settle Up v2" Google Sheet
```

**This is a brand-new, separate sheet.** The production "Settle Up!" sheet and form are never touched.

## Try it first (no setup)

Open `docs/index.html` (or the published demo). With no `config.js` the app runs in **demo mode** with sample
data stored in the browser. Tap your name top-right to switch between Chris and Natalie.

## Behaviour

- Money is whole pence. Splits: the *other* person's share of an expense, 0 to 100% (50 = even, 100 = it was all theirs, 0 = personal).
- Any number of named **pots**, each with its own balance. "Settle up" a pot (or all pots) records a normal payment row that brings it to zero.
- Nothing is deleted. **Void** hides an entry from the balance but keeps it in the history. Edit = void + new entry.
- Every entry has a client-generated ID, so a retry after a flaky connection can never double-add. Entries made offline are kept on the phone and synced later.
- Settle up sends the balance you were looking at; if your partner added something in the meantime, the server refuses and shows the fresh figure.
- **Weekly email** (Mondays about 12:00, London) tells each of you where you stand, per pot. Optional Discord post too. A one-off email goes to the other person when someone settles.

## Setup (about 20 minutes, once)

### 1. New sheet and script
1. Create a new Google Sheet called **Settle Up v2**.
2. **Extensions → Apps Script**. Replace the editor contents with `apps-script/Code.gs`.
   Project Settings → tick "Show appsscript.json", and paste in `apps-script/appsscript.json`.
3. Skip step 4 until you have a client ID (step 2 below). Then **Project Settings → Script properties**, add:

   | Property | Value |
   |---|---|
   | `CLIENT_ID` | the OAuth client ID from step 2 |
   | `USER_A_NAME`, `USER_A_EMAIL` | Chris, your Google email |
   | `USER_B_NAME`, `USER_B_EMAIL` | Natalie, her Google email |
   | `DISCORD_WEBHOOK` | optional |

4. Pick `setup` in the function dropdown and **Run**. Accept the permissions. It creates the `Transactions` and `Pots` tabs and the weekly trigger.
5. **Deploy → New deployment → Web app**: Execute as **Me**, access **Anyone**. Copy the web app URL (ends in `/exec`).
   "Anyone" only makes the URL reachable. Every request needs a valid Google sign-in from one of the two addresses above.

### 2. Google sign-in client ID
1. console.cloud.google.com → create a project → **APIs & Services → OAuth consent screen** (External, add both of you as test users, or publish it; only basic sign-in scopes are used).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorised JavaScript origins: `https://YOURNAME.github.io` (and `http://localhost:8000` for local testing).
3. Copy the client ID.

### 3. GitHub Pages
1. Put this repo on GitHub, copy `docs/config.example.js` to `docs/config.js`, fill in the web app URL and client ID, commit.
   (Neither value is a secret: access is enforced by the sign-in check on the server.)
2. Repo → Settings → Pages → deploy from branch, folder `/docs`.
3. Open the site on each phone, sign in, then **Add to Home Screen**.

### Updating later
Code.gs changes: paste, then **Deploy → Manage deployments → edit → New version** (the URL stays the same).
App changes: commit to GitHub.

## Speed
Changes show on screen immediately and are saved in the background (an "outbox" of operations, kept on the phone until
the server confirms each one, in order). Every operation carries client-made IDs, so a dropped connection or a lost reply
can be retried without double-counting. The last known data is cached so the app opens instantly.

## Tests
```
node --test tests/*.test.js
python3 -I tests/ui_live.py docs     # needs Playwright; drives the app against a fake slow server
```
`parity.test.js` runs the server's balance and validation code against the app's on hundreds of random ledgers, so they can't drift apart.
`ui_live.py` checks instant saves, offline queueing, reload survival, lost-reply retries and stale-settle refusal.

## Known limits
- Two people only (the percentage model is pairwise).
- Google ID tokens last about an hour. The app re-signs you in silently when it can, otherwise shows the Google button.
- The weekly notification is email (plus optional Discord). True phone push needs a push server, which Apps Script can't provide on its own.
