# Raccoon plugin license Worker

Cloudflare C3 TypeScript Worker + D1. Deployed at
`https://raccoon-license.bravesfly.workers.dev` with the `raccoon-license` D1 database.
The Desktop host gates all eleven first-party plugins independently; each plugin needs
its own card. No card-shop payment integration has been provisioned.

## Local setup

1. `rtk proxy pnpm install --frozen-lockfile`
2. Generate independent strong values for `CARD_PEPPER` and `ADMIN_TOKEN` and an Ed25519 PKCS#8
   DER private key (base64) for `LEASE_SIGNING_KEY`. Set `LEASE_KEY_ID` to the public-key version.
   Save these in `apps/license-worker/.dev.vars` (ignored), never commit them.
3. `rtk proxy pnpm --dir apps/license-worker exec wrangler d1 migrations apply DB --local`
4. `rtk proxy pnpm --dir apps/license-worker exec wrangler dev`

The worker has no built-in development secrets. `GET /health` responds without them;
all mutation and lease routes require configured secrets. The public Ed25519 key must be pinned
in the Desktop application before trusting any lease. Rotate keys by ID without losing verification
for leases already issued. Never expose the private signing key or `ADMIN_TOKEN` in the client.

## Production

The D1 binding and the four Worker secrets are already deployed. Secrets are kept outside
the repository under `~/.config/raccoon/license-worker/` on the operator machine;
the public verifier is pinned in the Desktop host. For subsequent migrations, use
`rtk proxy pnpm --dir apps/license-worker exec wrangler d1 migrations apply DB --remote`,
then `rtk proxy pnpm --dir apps/license-worker exec wrangler deploy`.
Do not put the long-lived admin bearer token in a public browser session.
No card-shop webhook is wired yet: the operator must confirm payment with the card shop and
then issue cards through the admin route. Set Cloudflare WAF rules for the public redemption
route and admin routes before opening it to customers. Pricing in D1 is informational;
no client-supplied price or order receipt grants a license.

To issue cards after confirming payment, use the operator-only CLI. It writes the cards
to a new file with mode `0600`, and never prints the codes or admin token:

```sh
rtk proxy node apps/license-worker/scripts/issue-cards.mjs ai-image-month 1 /private/path/ai-image-cards.txt socks5h://127.0.0.1:7890
```

The fourth argument is optional if direct HTTPS works. Each plugin has `-month`,
`-quarter`, and `-year` SKUs, for example `vinted-accounts-year`. The full list is
documented in `~/.config/raccoon/license-worker/ISSUE-CARDS.md`. Cards appear in the
response only once; if the network response is lost after issuance, those codes cannot be recovered.

## Protocol v1

- `POST /v1/admin/cards` bearer `ADMIN_TOKEN`, body `{ "sku": "sim8-month", "count": 1 }`.
  Returns cards **once**. All eleven first-party plugin IDs have independent monthly,
  quarterly, and annual SKUs.
- `POST /v1/admin/licenses/revoke` bearer, body `{ "licenseId": "..." }`.
- `POST /v1/cards/redeem` body `{ "card": "...", "pluginId": "studio.sim8", "devicePublicKey": "base64-raw-ed25519-key" }`.
- `POST /v1/leases/refresh` body `{ "licenseId": "...", "devicePublicKey": "..." }`.

Both device routes sign these exact UTF-8 bytes with the device private key. Each line
separator is one actual LF byte (`0x0a`), with no trailing newline:

```text
v1
POST
/path
<unix-seconds>
<32-lowercase-hex-nonce>
<sha256-hex-of-exact-json-body>
```

Send base64 signature as `x-device-signature`, timestamp as `x-device-time`, nonce as
`x-device-nonce`. Timestamp skew is at most five minutes; nonce is unique per device.
The response is `{ payload, signature }` where signature is Ed25519 over the UTF-8 bytes of
`JSON.stringify(payload)` in its original field order; `payload` contains plugin ID, device
public key, expiry and at most 72-hour offline period. The same device may recover its lease
with its card after a response is lost; other devices cannot redeem that card.
Invalid requests and unavailable service state return distinct responses (`403 request_denied`
and `503 service_unavailable`). Neither response includes a card, token, signature or SQL details.

Run `rtk proxy pnpm --dir apps/license-worker exec vitest run` for the cryptography and
Miniflare D1 protocol tests. This uses an isolated in-memory database and test-only keys.

**Limits:** No payment/renewal webhook, device replacement, or production rate limiter yet.
The host gate applies to all eleven first-party plugins. Revocation is observed on refresh,
not immediately when offline.
Local device keys stored in plaintext are copyable. The existing plugin package encryption
does not prevent an authorized user from extracting code. Do not market this as unbreakable protection.
