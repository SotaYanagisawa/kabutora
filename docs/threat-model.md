# Threat Model & Security Architecture

Kabutora's replacement backend keeps the financial ledger on the device and syncs ciphertext. The cloud or network may be monitored or breached: transactions, accounts, quantities, cost basis, balances and usable keys must remain private. Existing legacy server key records retain their historical exposure until locally verified recovery enrollment replaces them. New raw-key writes are denied. Market reads download the same public catalog/chunks for every member; holdings and transaction dates filter locally. Explicit public search/registration remains visible to the market service.

---

## 1. Trust Boundaries & Security Model

```mermaid
flowchart TD
    subgraph Trusted["🟢 TRUSTED ZONE (Your Device Only)"]
        Plaintext["Plaintext Trades & Portfolio Holdings"]
        Keys["Decryption Key & Passphrase"]
        CryptoEngine["WebCrypto Engine (In-Memory Decryption)"]
    end

    subgraph Boundary["🔒 CRYPTOGRAPHIC BOUNDARY"]
        AES["AES-256-GCM Encryption / Decryption"]
        KDF["Argon2id / PBKDF2 Key Derivation"]
    end

    subgraph Untrusted["🔴 UNTRUSTED ZONE (Cloud & Network)"]
        Firestore[("Cloud Firestore\n(Encrypted Blobs Only)")]
        CFWorker["Cloudflare Worker\n(Auth + Market API)"]
        Market[("Market Durable Object\nPublic Symbols + Market Data")]
        Logs["Access Logs / CDN"]
    end

    Plaintext <--> CryptoEngine
    Keys <--> KDF
    CryptoEngine <--> AES
    AES -- "Encrypted Bytes Only" --> Firestore
    CFWorker --> Market
    AES -. "NO KEYS EVER TRANSMITTED" .- Untrusted
```

---

## 2. Cryptographic Specifications

- **Cipher**: `AES-256-GCM`, with separate authenticated contexts for payloads, events, passphrase wrapping, recovery wrapping and the macOS local vault.
- **Key Derivation (KDF)**: `Argon2id` (64 MiB memory, 3 iterations, 1 lane) for passphrase wrapping. Browser workers keep key derivation off the UI thread. No weaker password KDF is substituted. Recovery keys use independently generated high-entropy wrapping material.
- **IV / Nonce**: Fresh cryptographically secure random 96-bit (12-byte) initialization vector generated for every encryption operation.
- **Revision and nonce rotation**: Snapshot modifications increment the revision and use a fresh IV. A vault-generation migration also generates a fresh AES key; changing an IV alone is not key rotation.
- **Trusted devices**: Google authenticates cloud access. A passphrase or recovery key enrolls each trusted device, which stores a non-extractable CryptoKey locally for automatic unlock. Shared devices retain keys and pending ciphertext only in memory.
- **Legacy migration**: Older releases stored a usable Google-account vault key in Firestore. Those existing vaults do not acquire zero-knowledge protection merely by installing the new client. Under a coordinated write lock, the client reconciles pending events, encrypts with a fresh key, verifies recovery locally, and atomically activates version 2 while deleting the server key. Necessary old keys remain only encrypted under the new generation. Obsolete writes are rejected; pending old-device edits are converted after recovery enrollment.
- **Interrupted migration**: After local recovery verification, trusted devices can retain an encrypted preparation and non-extractable key to resume activation. No passphrase or recovery secret is persisted by that mechanism.

---

## 3. Defense-in-Depth Protections

| Layer | Threat Vector | Mitigation Strategy |
|---|---|---|
| **Cloud Storage** | Database breach or unauthorized inspection | Firestore stores only encrypted portfolio payloads. The market Durable Object stores a catalog of at most 200 public security IDs plus public prices; it has no quantity, account, transaction, cost-basis or user field. |
| **API Endpoints** | Unauthorized market scraping or API abuse | Cloudflare Workers verify Firebase ID Tokens and App Check tokens before serving quote data. |
| **Network & Logs** | Requests reveal holdings or trade dates | V2 reads use common public resource/revision/chunk URLs and filter privately on-device. Search text uses an authenticated POST and is not persisted. Financial events are encrypted. URL invocation logs are disabled. |
| **Market Reads** | Holdings revealed by which prices a member asks for | Snapshot, history and dividend reads carry no symbol list: every member receives the shared catalog and filters locally. History requests reveal only the earliest needed year. Cloud clients register one explicitly searched symbol at a time (enforced server-side); the catalog never records who added it. |
| **Search Privacy** | Search history revealing user intent | Search text exists only in the authenticated POST request and ephemeral Worker memory. It is never stored, put in URLs, or sent to analytics. |
| **Browser Execution** | Cross-Site Scripting (XSS) / Injection | Strict Content Security Policy (CSP) with dynamic nonces on all HTML documents. Prerendered inline scripts are rejected. |
| **Local Storage** | Device theft or file extraction | macOS App uses Login Keychain for AES key storage. PWA uses non-extractable CryptoKey handles in IndexedDB on trusted devices. |

---

## 4. Operational Best Practices

1. **Keep Your Recovery Key Safe**: Store your offline recovery key in a password manager (e.g. 1Password, Bitwarden, Apple Keychain) or write it down.
2. **Shared vs. Trusted Device Mode**: When using a shared or public computer, always select "Shared Device" mode. In shared mode, data is held in browser memory only and immediately purged upon closing the tab.
3. **Enable 2FA**: Ensure your Google account is protected with two-factor authentication (passkeys or authenticator app).
