# Cloud Deployment & Infrastructure Guide

Kabutora is deployed globally on **Cloudflare Workers** (edge compute & market proxy) and uses **Firebase** (Google Authentication, App Check, and Cloud Firestore for ciphertext storage).

---

## 1. Architecture Flow

```mermaid
flowchart LR
    User["📱 Client"] -->|"1. HTTPS / Google Auth"| Firebase["Firebase Auth & App Check"]
    Firebase -->|"2. Verify Token"| Cloudflare["Cloudflare Worker (OpenNext)"]
    Cloudflare -->|"3. Serve public market snapshots"| D1[("Cloudflare D1\nSymbols + Market Data")]
    User -->|"Encrypted portfolio sync"| Firestore[("Cloud Firestore\n(AES-256-GCM Blobs)")]
```

---

## 2. Step-by-Step Setup

### Step 1: Firebase Project Setup
1. Create a Firebase project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication** with Google Sign-In.
3. Enable **Cloud Firestore** in Production mode.
4. Enable **reCAPTCHA Enterprise App Check** (or reCAPTCHA v3) for your web app:
   - In Firebase Console > App Check > Apps, register your web app with **reCAPTCHA Enterprise** (recommended) or **reCAPTCHA v3**.
   - Copy the generated site key to `NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY` in `apps/web/.env.production.local`.
   - Set `NEXT_PUBLIC_FIREBASE_APP_CHECK_PROVIDER` to `enterprise` or `v3` (the backward-compatible default), matching the provider registered in **Firebase App Check**. A key managed in Google Cloud reCAPTCHA does not by itself mean the App Check Enterprise exchange is configured. The existing production app uses the v3 registration.
   - Verify your production domain (and any preview domains) are added to the allowed domains list in Google Cloud Console (under **Security > Fraud Defense > reCAPTCHA**).
5. Deploy Firestore security rules and composite indexes:
   ```bash
   npx firebase-tools deploy --only firestore
   ```

### Step 2: Authorize Your User ID
1. Sign in once with your Google account.
2. Note your Firebase User UID from the Authentication tab.
3. In Firestore console, create an authorization document at `appAccess/{YOUR_UID}`.

### Step 3: Configure Cloudflare Secrets
Set your Firebase project secrets in Wrangler:
```bash
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put FIREBASE_PROJECT_NUMBER
npx wrangler secret put FIREBASE_WEB_APP_ID
npx wrangler secret put KABUTORA_ALLOWED_UID
```

### Step 4: Deploy the Cloudflare Worker
Create the existing Worker's market resources once, apply migrations, then deploy the OpenNext application:
```bash
node node_modules/wrangler/bin/wrangler.js d1 create kabutora-market
node node_modules/wrangler/bin/wrangler.js queues create kabutora-market-refresh
node node_modules/wrangler/bin/wrangler.js d1 migrations apply kabutora-market --remote
pnpm --filter @kabutora/web deploy:cloudflare
```

Record the D1 `database_id` returned by the create command in `apps/web/wrangler.jsonc`. The same `kabutora` Worker owns the Cron trigger, Queue producer/consumer, and D1 binding; do not create a separate website project.

---

## 3. Initial Migration from Local to Cloud

```mermaid
sequenceDiagram
    autonumber
    actor User as 👤 You
    participant Mac as 💻 macOS App
    participant Phone as 📱 Mobile (iPhone / Android)
    participant Cloud as ☁️ Cloud Firestore

    User->>Mac: Settings → Export Encrypted Backup
    Mac-->>User: Save `kabutora-encrypted-backup.json` + Recovery Key
    User->>Phone: Open Cloudflare Worker URL
    User->>Phone: Sign in with Google & Select "Personal Device"
    User->>Phone: Import encrypted JSON & Enter Passphrase
    Phone->>Phone: Decrypt in browser memory
    Phone->>Cloud: Sync encrypted events
    Phone-->>User: Portfolio fully restored & synced!
```

---

## 4. Verification Checklist

- [ ] Production URL returns `HTTP 200` with strict Content Security Policy headers.
- [ ] Unauthenticated API requests to `/api/market/*` return `HTTP 401 Unauthorized`.
- [ ] Authenticated requests from authorized Google UID return live quotes with `HTTP 200`.
- [ ] App Check tokens are actively generated and verified (`X-Firebase-AppCheck`), and reCAPTCHA assessment traffic appears in Google Cloud / Firebase Console.
- [ ] Firestore contains only encrypted ciphertext blobs (no plaintext ticker symbols or quantities).
- [ ] D1 contains public security IDs and market values only; its schema has no transaction, account, quantity, cost-basis, balance, or portfolio fields.
- [ ] The Queue consumer and both the `*/10 * * * *` market refresh and `* * * * *` PTS collection Cron triggers are attached to the existing `kabutora` Worker.
- [ ] Migration `0005_japannext_pts_frames.sql` is applied before deploying the Worker code.
