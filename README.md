# PortaFlow

Contributor funding on Portaldot V3: shared treasury approvals, upfront payments, native vesting, and verifiable transaction receipts.

Built with React, daisyUI, Fastify, MongoDB Atlas (hosted) or SQLite (local), and the Polkadot API library connecting to **Portaldot**, not Polkadot's network. Transactions use Portaldot's native `multisig`, `utility`, `balances`, `vesting`, and `system` pallets; no custom contracts are required.

## Run locally

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:8787. For development, run `npm run dev` and `npm run dev:web` in separate terminals.

## Funding flow

1. Connect a native Portaldot wallet and create a treasury with 2–5 signers.
2. Fund its derived multisig address with testnet tPOT.
3. Create an award or import CSV drafts, then approve with the required signers.
4. Final approval atomically transfers the upfront portion, funds native vesting, and records a hash of the award terms.
5. The recipient or another funded account can update the vesting lock as funds vest. The signing account pays the network fee.

The entire award is transferred to the recipient at funding; the vested portion is locked until its block schedule permits release. Funding is irrevocable through ordinary sender operations. Work references provide context and do not verify work or gate vesting.

## Network and deployment

- Native RPC: `wss://test-node-v3.portaldot.dev`
- Network: Portaldot V3 Testnet; native token: tPOT (14 decimals).
- Configuration: see `.env.example`; set environment variables in your shell or hosting provider.
- `vercel.json` deploys the Vite frontend and a shared Node.js API function. Set `MONGODB_URI` and `MONGODB_DB=portaflow` in Vercel's environment settings. For a custom domain, also set `PORTAFLOW_ORIGIN` to its exact HTTPS origin.
- Configure an Atlas database user restricted to this application's database, and network access for the deployment. Credentials belong in hosting secrets, never browser code.
- MongoDB connections are reused by warm function instances. Sign-in challenges are consumed atomically; sessions expire; an expiring database lease serializes receipt indexing across instances.
- Serverless mode uses request-driven chain refreshes. Finalized transactions are queued in the browser and verified against the canonical finalized chain by the API before receipts are saved. No always-running worker or scheduled unlock signer is required. Helpers can still sign unlocks through their own wallets.
- Database files, sessions, local tools, and environment secrets are excluded from Git. To preserve an existing local workspace, set `MONGODB_URI` securely and run `npm run migrate:atlas` once. This imports treasury, award, receipt, and cursor data without copying login sessions or overwriting existing records. Local SQLite data remains intact.

Wallet keys remain in the user's wallet. PortaFlow requests signatures through the browser extension.

MIT licensed. Dependencies retain their respective licenses.
