# Arc ↔ Base Bridge UI

A seamless, developer-friendly bridge interface for transferring USDC between **Base Sepolia** and **Arc Testnet**. Built with Vite, TypeScript, and the official Circle App Kit.

## Features

- **Direct Web3 Connection:** Connects directly via `window.ethereum` for a fast, native MetaMask experience (no complex WalletConnect relays).
- **USDC Bridging:** Utilizes Circle App Kit to estimate and execute cross-chain bridging of USDC.
- **Robust RPC Handling:** Fallback RPCs for Arc Testnet ensuring high reliability during network congestion.
- **Modern UI:** Sleek, dark-mode design with glowing indicators, responsive ledger, and real-time transaction tracking.

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v16 or higher recommended)
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
  - RPC URL: `https://arc-testnet.rpc.thirdweb.com` (or `https://rpc.testnet.arc.network`)

*Note: The application will automatically attempt to add these networks to your wallet if they are missing.*

## Project Structure

- `src/main.ts`: Core application logic (wallet connection, network validation, AppKit integration).
- `index.html`: The user interface structure.
- `index.css`: Styling and animations.
- `scripts/`: Development and testing scripts.

## Built With

- [Vite](https://vitejs.org/)
- [Viem](https://viem.sh/)
- [@circle-fin/app-kit](https://github.com/circlefin/app-kit)
- Vanilla HTML/CSS/TypeScript

## License
MIT License