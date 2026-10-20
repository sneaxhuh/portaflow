# PortaFlow

Contributor funding on Portaldot V3: shared treasury approvals, upfront payments, native vesting, and verifiable transaction receipts.

Built with React, daisyUI, Fastify, SQLite, and the Polkadot API library connecting to **Portaldot**, not Polkadot's network. Transactions use Portaldot's native `multisig`, `utility`, `balances`, `vesting`, and `system` pallets; no custom contracts are required.

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
- `render.yaml` runs the frontend and API as one service with a persistent SQLite disk. This configuration uses paid Render resources; review pricing before applying it.
- Database files, sessions, local tools, and environment secrets are excluded from Git. A new deployment starts with an empty workspace database; local data is not automatically migrated.

Wallet keys remain in the user's wallet. PortaFlow requests signatures through the browser extension.

MIT licensed. Dependencies retain their respective licenses.
