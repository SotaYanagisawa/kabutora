# Cloud Deployment & Infrastructure Guide

Kabutora is deployed globally on **Cloudflare Workers** (edge compute & market proxy) and uses **Firebase** (Google Authentication, App Check, and Cloud Firestore for ciphertext storage).

---

## 1. Architecture Flow

```mermaid
flowchart LR
    User["📱 Client"] -->|"1. HTTPS / Google Auth"| Firebase["Firebase Auth & App Check"]
    Firebase -->|"2. Verify Token"| Cloudflare["Cloudflare Worker (OpenNext)"]
    Cloudflare -->|"3. Read/Write Encrypted Blobs"| Firestore[("Cloud Firestore\n(AES-256-GCM Blobs)")]
```

---

## 2. Step-by-Step Setup

### Step 1: Firebase Project Setup
1. Create a Firebase project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication** with Google Sign-In.
3. Enable **Cloud Firestore** in Production mode.
4. Enable **reCAPTCHA Enterprise App Check** for your web app.
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
Deploy the OpenNext application to Cloudflare Workers:
```bash
pnpm --filter @kabutora/web deploy:cloudflare
```

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
- [ ] Firestore contains only encrypted ciphertext blobs (no plaintext ticker symbols or quantities).

