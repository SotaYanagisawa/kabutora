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
        MarketProxy["Market API & Snapshot Reader"]
        Scheduler["10-minute Cron + Queue"]
        D1[("D1 Public Market Data")]
        
        Worker --> AuthCheck
        AuthCheck --> MarketProxy
        Scheduler --> MarketProxy
        MarketProxy <--> D1
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
| [`apps/web`](file:///Users/sotay/Code_Projects/株トラ/apps/web) | **Web App & API** | Next.js 15 App Router application, responsive UI components, Lightweight Charts, and Cloudflare OpenNext entrypoint. |
| [`packages/domain`](file:///Users/sotay/Code_Projects/株トラ/packages/domain) | **Domain Logic** | Pure TypeScript accounting engine. Calculates FIFO cost basis, average cost lots, corporate actions (splits/reverse splits), and multi-currency values with `Decimal.js`. |
| [`packages/market-data`](file:///Users/sotay/Code_Projects/株トラ/packages/market-data) | **Market Models** | Normalized data schemas, provider abstractions, and PTS (night trading) session interfaces. |
| [`firebase`](file:///Users/sotay/Code_Projects/株トラ/firebase) | **Security Rules** | Firestore security rules enforcing user ownership and rejecting unauthenticated or malformed writes. |
| [`scripts`](file:///Users/sotay/Code_Projects/株トラ/scripts) | **Tooling** | Native macOS wrapper and iPhone preview packagers, privacy boundary verification scripts. |

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
    Cron["10-minute Cron"] --> Queue["Public-symbol jobs"]
    Queue --> Fetch["Fetch upstream providers"]
    Fetch --> D1[("D1 snapshots")]
    Client["Client UI"] -->|"One authenticated startup read"| Edge["Cloudflare Worker"]
    Edge --> D1
    D1 --> Client
    Client -->|"Authenticated manual refresh"| Queue
```

- **Intraday 15-Minute Bars**: Real-time 5-day session bars for active holdings.
- **Historical Daily Bars**: Long-term price history loaded incrementally on-demand for the Performance view.
- **Tiered Caching**: Cloudflare D1 snapshots plus the client IndexedDB cache minimize startup requests and preserve offline fallback.
- **Privacy Split**: D1 contains public symbols and market data only; Firestore portfolio documents remain ciphertext and are decrypted only in the client.
- **Snapshot-first refresh**: Browser refreshes enqueue symbol-only work and immediately return to the cached snapshot. Quote completion is merged through conditional ETag reads; price refresh never waits for historical backfill.
- **Search isolation**: Search keystrokes stay inside a small component, local matches render immediately, obsolete provider requests are aborted, and the server applies a bounded provider deadline.
