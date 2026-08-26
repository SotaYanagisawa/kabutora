# Kabutora (株トラ)

<div align="center">

**A modern, privacy-first investment portfolio tracker and Progressive Web App (PWA) for Japanese & US equities, investment trusts, and multi-currency assets.**

[![Next.js](https://img.shields.io/badge/Next.js-15-black?style=flat&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-blue?style=flat&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?style=flat&logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?style=flat&logo=cloudflare)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-161%20Passing-brightgreen?style=flat)]()

</div>

---

## Overview

**Kabutora (株トラ)** is an open-source, edge-rendered financial portfolio tracking application designed for investors managing diversified assets across the Tokyo Stock Exchange (TSE), US markets (NASDAQ/NYSE), mutual funds (投資信託), and cash reserves.

Built with a **zero-knowledge, privacy-by-design architecture**, your private financial transactions and ledger data are encrypted client-side (AES-256-GCM). Cloud backends and edge servers only store encrypted ciphertexts—plain financial data and decryption keys never leave your devices.

---

## Key Features

### 📊 Comprehensive Market Coverage
- **Japanese Equities & ETFs**: Real-time quotes and historical price charts for Tokyo Stock Exchange (XTKS).
- **US Equities**: Full support for US stocks (NASDAQ / NYSE) with real-time USD/JPY FX conversion.
- **Japanese Investment Trusts (投資信託)**: Mutual fund NAV tracking with standard 10,000-unit basis calculations.
- **PTS Night & Off-Hours Trading**: Track proprietary trading system (PTS / JNX) day and night sessions.
- **Market Benchmarks**: Live tracking of Nikkei 225, TOPIX, S&P 500, NASDAQ, Dow Jones, and USD/JPY FX rates.

### 🔒 Zero-Knowledge Security & Privacy
- **Client-Side AES-256-GCM Encryption**: All portfolios, transactions, and account details are encrypted before leaving your browser.
- **Bi-directional Protection**:
  - **Local Mode (Desktop)**: Encrypted local storage managed securely via macOS Keychain.
  - **Cloud Mode (Sync)**: Synchronized across devices via Firebase / Cloudflare with client-held recovery passphrases.
- **Privacy Boundary Verification**: Automated CI tests verify that no unencrypted transactions or identifiable financial data ever leak into build bundles or API calls.

### ⚡ Accurate Accounting & Performance Engine
- **FIFO & Average Cost Basis**: Multi-account tax categorization (NISA, 特定口座, 一般口座).
- **Corporate Action Reconstruction**: Automated history adjustment for stock splits and reverse splits.
- **Time-Weighted & Money-Weighted Returns**: Real-time intraday gains, total unrealized/realized returns, and multi-period performance (1D, 1W, 1M, 3M, YTD, ALL, Custom ranges).

### 📱 Responsive PWA & Mobile UX
- **Mobile First**: Built with native-feeling gestures, smooth tab navigation, and touch-driven pull-to-refresh.
- **Offline Capable**: Multi-tier caching with IndexedDB, Service Workers, and Cloudflare edge caches.
- **Modern Themes**: Light and Dark mode with accent theme customization (Graphite, Blue, Forest, Plum).

---

## Architecture & Monorepo Structure

```
株トラ/
├── apps/
│   └── web/                     # Next.js 15 App Router frontend & OpenNext Cloudflare edge entry
│       ├── app/                 # App routes and authenticated API proxies
│       ├── components/          # React components (Dashboard, Charts, Watchlist, etc.)
│       ├── lib/                 # Core utilities (Crypto, Market clients, Session managers)
│       └── worker-entry.ts      # Cloudflare Worker entrypoint with Firebase App Check
├── packages/
│   ├── domain/                  # Pure TypeScript domain calculation & FIFO accounting engine
│   └── market-data/             # Market data models, provider interfaces & PTS abstractions
├── firebase/                    # Security rules and Firestore index configurations
├── docs/                        # Architecture specs, calculation rules, threat models
└── scripts/                     # Standalone app builders (macOS / iOS Preview) and verification tools
```

---

## Getting Started

### Prerequisites
- **Node.js**: `v20.x` or higher
- **pnpm**: `v10.x` or higher

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/SotaYanagisawa/kabutora.git
   cd kabutora
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Start the local development server**:
   ```bash
   pnpm dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Testing & Quality Assurance

Kabutora maintains strict test coverage and verification for financial domain logic, encryption security, and build artifacts:

```bash
# Run unit test suite (37 test files, 161 tests)
pnpm test

# Run TypeScript type checks across all workspaces
pnpm typecheck

# Verify zero-knowledge private data boundary
pnpm verify:privacy

# Run Next.js production build
pnpm build

# Run Cloudflare OpenNext edge build
pnpm --filter @kabutora/web build:cloudflare
```

---

## Cloud Deployment

Kabutora is optimized for deployment to **Cloudflare Workers** using **OpenNext**:

```bash
# Deploy to Cloudflare Workers
pnpm --filter @kabutora/web deploy:cloudflare
```

For complete cloud setup instructions (including Firebase Authentication, App Check, and Firestore security rules), see the [Cloud Deployment Guide](docs/cloud-deployment.md).

---

## Documentation

- [Architecture & Data Flow](docs/architecture.md)
- [Calculation & Accounting Rules](docs/calculation-rules.md)
- [Cloud Deployment & Firebase Setup](docs/cloud-deployment.md)
- [Market Data Scaling & Edge Caching](docs/market-data-scaling.md)
- [Security Threat Model](docs/threat-model.md)

---

## License

This project is open-sourced under the [MIT License](LICENSE).
