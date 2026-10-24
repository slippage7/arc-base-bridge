# Rail

Rail is a small, open-source web app for moving **USDC between EVM testnets** with Circle's
Cross-Chain Transfer Protocol (CCTP). USDC is burned on the chain you send from and Circle mints
the same amount on the chain you send to: no wrapped tokens and no liquidity pools.

It is built with Vite, plain TypeScript, HTML and CSS (no framework) and the official
[Circle App Kit](https://developers.circle.com/app-kit). It has no trackers or analytics, and the font is self-hosted.

## Features

- **25 testnets.** Every EVM testnet that the installed App Kit can bridge with a browser wallet (list below). Send from any of them to any other one.
- **Chain picker** with search (by name, chain ID or gas token), real chain logos and a one-click swap button. Logos are self-hosted in `public/chains/` (testnets use their parent network's logo, see `SOURCES.md`); if one ever fails to load, a monogram in the chain's color is shown instead.
- **English and Turkish:** an EN | TR toggle in the header. The choice is remembered; the first visit follows the browser language. Strings live in `src/locales/en.json` and `src/locales/tr.json` (same keys), handled by the small `src/i18n.ts`.
- **Wallet in the header.** Connect from the top-right button. Once connected, a short address chip lets you copy the address, open it in the explorer, or disconnect.
- **Automatic network switching.** Rail asks your wallet to switch to the source chain. If the wallet does not know the chain yet (error `4902`), Rail adds it with the right RPC, explorer and gas token.
- **Balances.** Rail shows your USDC balance on the source chain, plus the gas balance on both chains, and warns you when gas is missing.
- **Safe input.** The amount must be a positive number with at most 6 decimals that does not exceed your balance.
- **Step-by-step progress:** Approve USDC → Burn on source → Waiting for Circle attestation → Mint on destination, with plain-language explanations and an estimated time.
- **Activity log.** Every transaction links to the right block explorer.
- **No surprise retries.** A failed step is retried once, but never when you rejected the request in your wallet.
- **Handles wallet changes.** Account and network changes in the wallet are picked up live.
- **Dark and light themes**, a responsive mobile layout, toasts, and support for reduced motion.

## Before you bridge

1. Get testnet USDC from the [Circle faucet](https://faucet.circle.com).
2. Get a little gas on **both** chains. You pay gas on the source chain for approve and burn, and on the destination chain for the mint. On Arc Testnet, gas is paid in USDC.

A transfer usually takes about 1–3 minutes. From Ethereum Sepolia it can take up to about 20 minutes while Circle waits for block confirmations.

## Supported testnets

| Chain | Chain ID | Gas token | App Kit key |
|---|---|---|---|
| Arc Testnet | `5042002` | USDC | `Arc_Testnet` |
| Base Sepolia | `84532` | ETH | `Base_Sepolia` |
| Ethereum Sepolia | `11155111` | ETH | `Ethereum_Sepolia` |
| Arbitrum Sepolia | `421614` | ETH | `Arbitrum_Sepolia` |
| OP Sepolia | `11155420` | ETH | `Optimism_Sepolia` |
| Avalanche Fuji | `43113` | AVAX | `Avalanche_Fuji` |
| Polygon Amoy | `80002` | POL | `Polygon_Amoy_Testnet` |
| Unichain Sepolia | `1301` | UNI | `Unichain_Sepolia` |
| Linea Sepolia | `59141` | ETH | `Linea_Sepolia` |
| World Chain Sepolia | `4801` | ETH | `World_Chain_Sepolia` |
| Sonic Testnet | `14601` | S | `Sonic_Testnet` |
| Sei Testnet | `1328` | SEI | `Sei_Testnet` |
| Ink Sepolia | `763373` | ETH | `Ink_Testnet` |
| HyperEVM Testnet | `998` | HYPE | `HyperEVM_Testnet` |
| Monad Testnet | `10143` | MON | `Monad_Testnet` |
| Plume Testnet | `98867` | PLUME | `Plume_Testnet` |
| Plasma Testnet | `9746` | XPL | `Plasma_Testnet` |
| Codex Testnet | `812242` | ETH | `Codex_Testnet` |
| Cronos Testnet | `338` | tCRO | `Cronos_Testnet` |
| Edge Testnet | `33431` | ETH | `Edge_Testnet` |
| Injective Testnet | `1439` | INJ | `Injective_Testnet` |
| Morph Hoodi Testnet | `2910` | ETH | `Morph_Testnet` |
| Pharos Testnet | `688689` | PHAROS | `Pharos_Testnet` |
| XDC Apothem | `51` | TXDC | `XDC_Apothem` |
| X Layer Testnet | `1952` | OKB | `X_Layer_Testnet` |

The list comes from App Kit itself (`getSupportedChains("bridge", { chainType: "evm", isTestnet: true })`)
and is stored in [`src/chains.json`](src/chains.json). Two overrides are used:

- **Arc Testnet** uses the RPC `https://rpc.testnet.arc.io` (fallbacks: thirdweb and dRPC) and the explorer `https://explorer.testnet.arc.io`.
- **Monad Testnet** uses the dRPC and thirdweb public RPCs, because the default RPC did not answer during testing.

`npm run check:chains` checks the file against the installed SDK. It confirms every RPC returns the right `eth_chainId` and every USDC contract reports 6 decimals.

## Getting started

You need [Node.js](https://nodejs.org/) v20.19+ or v22.12+ (required by Vite 8) and a browser wallet such as MetaMask.

```bash
npm ci
npm run dev
```

Then open the `localhost` link that is printed.

## Scripts

- `npm run dev`: start the development server.
- `npm run build`: build the site into `dist/`.
- `npm run preview`: serve the built site.
- `npm run typecheck`: check the TypeScript code.
- `npm run check:chains`: compare `src/chains.json` with App Kit and test every RPC and USDC contract.
- `npm run proof`: ask App Kit for bridge fee estimates on several routes. It only reads data, so no funds are needed.
  - Pick routes yourself: `npm run proof -- Base_Sepolia:Arc_Testnet Arc_Testnet:Polygon_Amoy_Testnet`
  - Every route from one chain: `npm run proof -- --all-from Arc_Testnet`
  - By default a random throwaway key is used. To use your own test wallet, copy `.env.example` to `.env` and set `PROOF_PRIVATE_KEY`. Never use a key that holds real funds.
- `npm run verify:ui -- [url] [screenshot-dir]`: a headless Chrome test with a fake wallet (run `npm run build && npm run preview -- --port 4173` first). It checks the pickers, swap, amount validation, network switch/add requests, wallet-rejection handling, both languages (no missing keys or leftover English in Turkish, no overflow at 1280px and 390px) and that every chain logo loads, and saves desktop and mobile screenshots.

## Project structure

- `index.html`: page structure.
- `src/main.ts`: wallet connection, network switching, balances, validation and the App Kit bridge flow.
- `src/chains.json`: chain data (IDs, RPCs, explorers, gas tokens, USDC addresses).
- `src/style.css`: design system, themes and animations.
- `scripts/`: chain check, fee proof and UI test scripts.

## Disclaimer

Testnet only. Tokens on these networks have no real value. Never send mainnet funds to a testnet address.

## License

MIT License, see [LICENSE](LICENSE).
