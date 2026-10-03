# System Architecture & Design

Kabutora is designed around a core principle: **financial ledger data belongs entirely to the user**. The system operates as an event-sourced portfolio engine where all holdings, gains, and performance curves are reconstructed on-the-fly inside the client's browser.

---

## 1. System Overview

```mermaid
flowchart TB
    subgraph Browser["💻 Client Application (Browser / PWA / Mac App)"]
        direction TB
        UI["React 19 UI\n(Dashboard, Charts, Watchlist)"]
        State["Client State & View Controllers"]
        Domain["@kabutora/domain\n(FIFO Accounting & Split Engine)"]
        Crypto["Vault Crypto (WebCrypto)\n(AES-256-GCM + PBKDF2)"]
        IDB[("Local Storage / IndexedDB\n(Encrypted Blobs & Fast Cache)")]
        
        UI <--> State
        State <--> Domain
        State <--> Crypto
        Crypto <--> IDB
    end

    subgraph Edge["⚡ Edge Infrastructure (Cloudflare Workers)"]
        Worker["OpenNext Cloudflare Worker"]
        AuthCheck["App Check & Auth Verifier"]
        MarketProxy["Market object\n(Durable Object, catalog snapshot)"]
        Scheduler["1-minute Cron tick\n(PTS, history warm-up)"]
        
        Worker --> AuthCheck
        AuthCheck --> MarketProxy
        Scheduler --> MarketProxy
    end

    subgraph Backend["☁️ Secure Cloud Services"]
        Firestore[("Cloud Firestore\n(Encrypted Ciphertexts ONLY)")]
        Auth["Firebase Authentication\n(Google Sign-In)"]
        Upstream["Upstream Market Providers\n(Tokyo Quotes, US Equities, Funds)"]
    end

    State -- "Authenticated Snapshot / Quote Requests" --> Worker
    Crypto -- "Sync Encrypted Blobs" --> Firestore
    State -- "Session Validation" --> Auth
    MarketProxy <--> Upstream
```

---

## 2. Core Modules & Packages

| Package / Directory | Role | Description |
|---|---|---|
| [`apps/web`](../apps/web) | **Web App & API** | Next.js 15 App Router application, responsive UI components, Lightweight Charts, and Cloudflare OpenNext entrypoint. |
| [`packages/domain`](../packages/domain) | **Domain Logic** | Pure TypeScript accounting engine. Calculates FIFO cost basis, average cost lots, corporate actions (splits/reverse splits), and multi-currency values with `Decimal.js`. |
| [`firebase`](../firebase) | **Security Rules** | Firestore security rules enforcing user ownership and rejecting unauthenticated or malformed writes. |
| [`scripts`](../scripts) | **Tooling** | Native macOS wrapper and iPhone preview packagers, privacy boundary verification scripts. |

---

## 3. Runtime Modes

### A. Local Mode (macOS App)
- **Zero Cloud Footprint**: Runs completely offline without needing cloud services.
- **Keychain Storage**: Portfolio data is encrypted using AES-256-GCM and stored in `~/Library/Application Support/株トラ/local-vault.json`.
- **Hardware-Protected Keys**: The 256-bit encryption key is managed by macOS Login Keychain.

### B. Cloud Mode (PWA Sync)
- **Multi-Device Access**: Syncs seamlessly between Mac, iPhone, and other devices.
- **Encrypted Payloads**: Only encrypted ciphertext documents are stored in Cloud Firestore.
- **Client-Side Decryption**: Decryption keys never leave device memory.

---

## 4. Market Data Pipeline

```mermaid
flowchart LR
    Client["Client UI"] -->|"One GET (ETag + since)"| Edge["Worker router (auth)"]
    Edge --> Hub["Market object\n15 s snapshot"]
    Hub -->|"stale: 10 parallel batches"| Yahoo["Yahoo spark"]
    Hub --> Pages["Fund NAV / TOPIX / Japannext\n(background)"]
    Cron["1-minute Cron"] --> Hub
```

- **One request for prices**: quotes, benchmarks and five days of intraday bars for the whole shared catalog (max 200 symbols) arrive in one response, refreshed on read when older than 15 seconds.
- **Historical Daily Bars**: Stored per symbol and year in the market object; the client requests the catalog from its earliest needed year and filters locally.
- **Caching**: The object keeps the snapshot in memory and SQLite; the client keeps the last snapshot in IndexedDB so a reopened app renders instantly and revalidates with an ETag.
- **Privacy Split**: Market requests carry no holdings; Firestore portfolio documents remain ciphertext and are decrypted only in the client.
- See [Market backend](market-backend.md) for budgets and checks.
- **Search isolation**: Search keystrokes stay inside a small component, local matches render immediately, obsolete provider requests are aborted, and the server applies a bounded provider deadline.
