# Arc ↔ Base Bridge UI

A seamless, developer-friendly bridge interface for transferring USDC between **Base Sepolia** and **Arc Testnet**. Built with Vite, TypeScript, and the official Circle App Kit.

## Features

- **Direct Web3 Connection:** Connects directly via `window.ethereum` for a fast, native MetaMask experience (no complex WalletConnect relays).
- **USDC Bridging:** Utilizes Circle App Kit to estimate and execute cross-chain bridging of USDC.
- **Robust RPC Handling:** Fallback RPCs for Arc Testnet ensuring high reliability during network congestion.
- **Modern UI:** Sleek, dark-mode design with glowing indicators, responsive ledger, and real-time transaction tracking.

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) v20.19+ or v22.12+ (required by Vite 8)
- A Web3 wallet (e.g., MetaMask) installed in your browser.

### Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open the provided `localhost` link in your browser.

## Network Requirements

To use the bridge, ensure your wallet is configured with the following networks:

- **Base Sepolia**
  - Chain ID: `84532` (0x14a34)
  - RPC URL: `https://sepolia.base.org`
  
- **Arc Testnet**
  - Chain ID: `5042002` (0x4cef52)
  - RPC URL: `https://rpc.testnet.arc.io` (fallbacks: `https://arc-testnet.rpc.thirdweb.com`, `https://arc-testnet.drpc.org`)
  - Currency symbol: `USDC` (Arc uses USDC as native gas)
  - Block explorer: `https://explorer.testnet.arc.io`

*Note: The application will automatically attempt to add these networks to your wallet if they are missing.*

## Project Structure

- `src/main.ts`: Core application logic (wallet connection, network validation, AppKit integration).
- `index.html`: The user interface structure.
- `src/style.css`: Styling and animations.
- `scripts/`: Development and testing scripts (see below).

## Scripts

- `npm run dev`: start the development server.
- `npm run build`: build the site into `dist/`.
- `npm run typecheck`: check the TypeScript code.
- `npm run proof`: ask Circle App Kit for a bridge fee estimate in both directions (Base Sepolia ⇄ Arc Testnet). It only reads data, so no funds are needed. To use your own test wallet, copy `.env.example` to `.env` and set `PROOF_PRIVATE_KEY` (never a key with real funds). Without it a random throwaway key is used.
- `scripts/check.js`, `scripts/check2.js`, `scripts/check_ui.js`: quick Puppeteer checks; start `npm run dev` first, then run e.g. `node scripts/check_ui.js`.

## Built With

- [Vite](https://vite.dev/)
- [Viem](https://viem.sh/)
- [@circle-fin/app-kit](https://github.com/circlefin/app-kit)
- Vanilla HTML/CSS/TypeScript

## License
MIT License, see [LICENSE](LICENSE).
