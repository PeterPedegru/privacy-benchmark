OutLayer DocumentationAgent CustodyInstitutional-grade custody for AI agents. Give your agent a multi-chain wallet with full policy controls — the agent can send and receive tokens, but it physically cannot lose or leak the private key because it never has one. You stay in control of how your agent spends crypto: set spending limits, whitelists, require manual confirmations for large transactions, or freeze the wallet instantly.🔒No Private Key ExposureThe agent never sees or stores a private key. It authenticates with an API key. All transaction signing happens inside a TEE (Trusted Execution Environment) — even if the agent is fully compromised, the key stays safe.🌐Cross-Chain ValueOne NEAR-native wallet that deposits from and withdraws to NEAR, Ethereum, Bitcoin, Solana, and other chains via the NEAR Intents protocol. No bridges, no wrapping. EVM signing (EIP-712 / EIP-191 / raw tx) and Solana signing (messages / transaction messages, ed25519) are supported — you broadcast, the TEE only signs.📜Policy EnginePer-transaction limits, daily/hourly/monthly caps, address whitelists, time restrictions, rate limits, and multisig approval. All policy checks happen inside the TEE — the agent cannot bypass or tamper with them.⛽️Gasless TransactionsSwaps and cross-chain transfers work without the agent holding gas tokens on the destination chain. The NEAR Intents protocol handles gas abstraction.Security foundation: The keystore that holds wallet keys runs inside Intel TDX enclaves (TEE). Its master secret is derived from the NEAR Protocol MPC network — the same distributed key infrastructure that secures billions of dollars across the NEAR ecosystem. All critical operations — key derivation, transaction signing, and policy evaluation — happen exclusively inside the TEE. No single party, not even the infrastructure operator, can extract keys or bypass policy rules.Optional: sovereign vaults. Custody wallets are derived from a shared OutLayer master by default — convenient and recovery-free. If your application’s value-at-risk justifies an extra setup step, you can deploy a per-customer sovereign vault: the wallet’s keys are then derived from a master that’s recoverable by you through DAO cessation or your own unilateral exit, even if OutLayer ceases. The agent code does not change — the API key fully determines which master is used.How It Works#🤖AI AgentHas API key only👤Wallet OwnerControls policytransfer, swap, callset policy, freezeTEE (Intel TDX) — all security here🔑Key DerivationMPC master secret + HMACPrivate keys never leave✍️Transaction SigningSigns transfer, intents_withdraw, intents_swap, call, deleteinside secure enclave🛡Policy EvaluationDecrypts policy from chainEnforces all limits & rulessubmit signed txread encrypted policy⛓️NEAR BlockchainEncrypted policy storageFreeze / unfreeze on-chain🔀NEAR IntentsGasless cross-chain transfersNEAR, ETH, BTC, SOLThe API gateway is a stateless proxy — it authenticates the API key and forwards requests to the TEE. Everything security-critical (keys, signing, policy checks) happens exclusively inside the Trusted Execution Environment.Register — one API call creates a wallet and returns an API key. The TEE derives the private key from the MPC master secret and returns the public key. No blockchain transaction needed.Operate — the agent uses the API key to transfer NEAR, swap tokens, call smart contracts, or withdraw cross-chain. The TEE checks the policy, signs the transaction, and broadcasts it to the NEAR network.Control — the wallet owner configures policies for the agent via the dashboard: spending limits, address whitelists, transaction confirmations, multisig, or instant freeze.Agent ID#Every wallet is identified by its Agent ID — a public key derived deterministically inside the TEE from the MPC master secret. The agent receives an API key for authentication, while the Agent ID serves as the on-chain identity.ConceptDescriptionExampleAgent IDPublic key (wallet identity)ed25519:9a65d26b...API KeySecret token for API authwk_15807dbda492...NEAR addressDerived implicit account36842e2f73d0b7...Intents balanceCross-chain value, held on intents.nearUSDC, USDT, ETH, SOL...The agent uses the API Key to authenticate all requests. The private key behind the Agent ID never leaves the TEE — transactions are signed inside the secure enclave and the agent never has access to it.Multi-Chain Support#The wallet is NEAR-native: its identity and signing key live on NEAR, and its cross-chain value is custodied on intents.near. You move value across chains the way you would with a centralized exchange — deposit in, operate, withdraw out to an external address — all via the NEAR Intents protocol and the 1Click solver network. No bridges, and no gas tokens needed on the destination chain.The wallet signs EVM payloads directly. GET /wallet/v1/address returns the NEAR address and a single shared secp256k1 0x address (the same across all EVM chains), and the wallet signs EIP-712 typed data, EIP-191 messages, and raw EVM transactions via /wallet/v1/evm/* — you build and broadcast the transaction; the TEE only keccak-hashes and signs. Solana works the same way via /wallet/v1/solana/*: the wallet has its own base58 ed25519 address and signs off-chain messages and serialized transaction messages (base58 signature); you assemble and broadcast. Cross-chain deposits and withdrawals via NEAR Intents do not need any of this.ChainDepositWithdrawNative address / contract callsNEAR✓ direct to Intents balance✓ via Intents (gasless)✓ NEAR address + direct contract callsEthereum✓ cross-chain (1Click)✓ via Intents (gasless)✓ shared 0x address + signing via /wallet/v1/evm/* (client broadcasts)Bitcoin✓ cross-chain (1Click)✓ via Intents (gasless)— (planned)Solana✓ cross-chain (1Click)✓ via Intents (gasless)✓ base58 address + signing via /wallet/v1/solana/* (client broadcasts)Base, Arbitrum, BSC, Polygon, Optimism, Avalanche✓ cross-chain (1Click)✓ via Intents (gasless)✓ same shared 0x address + /wallet/v1/evm/* signingGasless cross-chain: When the agent calls POST /wallet/v1/intents/withdraw to send tokens to Ethereum or Solana, it does not need ETH or SOL for gas. The NEAR Intents protocol handles execution and fee settlement natively.⚠️ Only send whitelisted Intents assets — anything else is lost permanentlyDeposits only work for assets in the NEAR Intents / 1Click token catalog (GET /wallet/v1/tokens), sent on the exact chain the deposit address was issued for. If you send an unsupported token, the wrong token, a token on the wrong chain, an NFT, or a native gas coin that is not a listed asset, it cannot be credited or recovered. Deposit addresses from/wallet/v1/intents/deposit/cross-chain (legacy alias /wallet/v1/deposit-intent) are per-request and expire (30 min) — never reuse an old one or send after expiry.Policy Engine#The wallet owner controls the agent's permissions through a policy — a set of rules that are encrypted and stored on-chain. The policy is decrypted and evaluated inside the TEE on every transaction. The agent cannot bypass or modify it.RuleDescriptionExamplePer-transaction limitMax amount per single transaction, per tokennative: 10 NEAR, USDT: $1,000Hourly limitTotal spending cap per hour*: 50 NEAR/hourDaily limitTotal spending cap per day*: 500 NEAR/dayMonthly limitTotal spending cap per month*: 5,000 NEAR/monthAddress whitelistOnly allow transfers to approved addressesbob.near, dex.nearAddress blacklistBlock transfers to specific addressesscammer.nearTime restrictionsAllow operations only during business hoursMon-Fri 9:00-17:00 UTCRate limitMax transactions per hour60 tx/hourMultisig approvalRequire human approval above a threshold2-of-3 above $1,000Transaction typesRestrict allowed operations: transfer, call (incl. deposits to Intents), withdraw, swap, cross_chain_withdraw (separate, default-deny), deletecall, swap onlyCapabilitiesOpt-in gates for powerful primitives, all default-deny under a policy except sign_message (default-allow): raw_sign (+ per-chain allowlist), swap, cross_chain_withdraw, confidential, payment_check, sign_message (+ recipient allowlist), evm_sign (EVM EIP-712/EIP-191/raw-tx; default-DENY — set allowed:true to permit, with a raw_tx sub-flag default-OFF), solana_sign (Solana messages/transactions; same model as evm_sign — default-DENY with a raw_tx sub-flag default-OFF). A wallet with no policy is unrestricted. Each may also set requires_approvalswap: allowedEmergency freezeInstantly halt all operationsOne-click from dashboardPolicies are stored encrypted on-chain (on the NEAR blockchain). Only the TEE can decrypt and evaluate them. This means neither the API gateway operator nor the agent can see or tamper with the raw policy rules.Velocity limits are best-effort under concurrencyPer-transaction limits, whitelists, time windows, capabilities, freeze, and the multisig trigger are enforced exactly inside the TEE on every signature. The cumulative limits — daily / hourly / monthly spend and the hourly transaction-count (rate_limit) — are checked against a usage counter the API gateway supplies; the TEE keeps no state of its own. If you fire several requests concurrently, they can each read the same pre-spend counter and all pass, so the cumulative caps may be exceeded by the in-flight batch (e.g. a “60 tx/hour” cap could admit a few extra under a burst). Single-threaded agents (one request at a time) are unaffected.If exact cumulative enforcement matters to you, either serialize your agent’s spending requests (don’t issue the next until the previous returns), or leave a safety margin in the limit to absorb the maximum number of requests you might have in flight at once. For hard stops use the per-transaction limit, multisig, or freeze — those are exact.Example Policy{
  "rules": {
    "transaction_types": ["transfer", "call", "withdraw", "swap", "delete"],
    "allowed_tokens": ["*"],
    "addresses": {
      "mode": "whitelist",
      "list": ["bob.near", "dex.near"]
    },
    "limits": {
      "per_transaction": { "native": "10000000000000000000000000" },
      "daily": { "*": "100000000000000000000000000" },
      "hourly": { "*": "50000000000000000000000000" }
    },
    "rate_limit": { "max_per_hour": 60 },
    "time_restrictions": {
      "timezone": "UTC",
      "allowed_hours": [9, 17],
      "allowed_days": [1, 2, 3, 4, 5]
    }
  },
  "approval": {
    "threshold": { "required": 2 },
    "approvers": [
      { "id": "alice.near", "role": "admin",  "pubkey": "ed25519:<base58>" },
      { "id": "bob.near",   "role": "signer", "pubkey": "ed25519:<base58>" },
      { "id": "carol.near", "role": "signer", "pubkey": "ed25519:<base58>" }
    ]
  },
  "capabilities": {
    "raw_sign":     { "allowed": false, "chains": ["ethereum", "solana"], "requires_approval": true },
    "confidential": { "allowed": false },
    "sign_message": { "allowed": true,  "allowed_recipients": [] },
    "swap":         { "allowed": false },
    "cross_chain_withdraw": { "allowed": false },
    "payment_check": { "allowed": false },
    "evm_sign":     { "allowed": true,  "raw_tx": false },
    "solana_sign":  { "allowed": false, "raw_tx": false }
  }
}Multisig Approval#On a wallet with an approval threshold, fund-moving operations go into a pending state. Designated approvers sign the request using their NEAR wallet (NEP-413 signature). Once the required number of signatures is collected, the transaction executes automatically.Multisig also covers NEAR Intents operations. On a multisig wallet, a swap — or any NEAR Intents Trusted operation (swap,confidential, cross_chain_withdraw) — executes only after the required approvers confirm it. Approval controls whether the operation happens: the TEE verifies the approver signatures and pins the recipient. It doesnot itself re-check the token or amount — for these Trusted operations the gateway builds the 1Click artifact (quote → deposit address) at execution and the TEE signs it, trusting the gateway to have built it from the approved operation. The off-chain destination (the 1Click deposit address) is the same way: provided by the gateway at execution andnot independently verifiable by the TEE. So a compromised gateway could substitute the token, amount, or routing after approval — the on-chain guarantees are the recipient pin and the approver signatures, not the value terms (a documented tradeoff). Claimable links (payment_check) are the exception — they are gated by their capability and the per-transaction amount cap rather than by multisig.Agent: POST /wallet/v1/intents/withdraw { amount: "$5,000" }
  -> Response: { status: "pending_approval", required: 2, approved: 0 }

Approver 1: Signs approval via NEAR wallet (dashboard)
  -> { approved: 1, required: 2 }

Approver 2: Signs approval via NEAR wallet (dashboard)
  -> Threshold met -> auto-execute -> { status: "success", tx_hash: "..." }RoleApprove transactionsModify policyFreeze walletAdmin✓✓ (quorum)✓Signer✓✗✗Quick Start#1. Register a walletcurl -s -X POST https://api.outlayer.fastnear.com/register

# Response:
# {
#   "api_key": "wk_15807dbda492...",
#   "near_account_id": "36842e2f73d0...",
#   "handoff_url": "https://outlayer.fastnear.com/wallet?key=wk_..."
# }The api_key is shown only once. Store it securely.2. Get address# NEAR address (wallet identity; chain=near only — native ETH/SOL
# addresses are not issued, see Multi-Chain Support above)
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.fastnear.com/wallet/v1/address?chain=near"

# To fund from another chain, request a cross-chain deposit address
# (via 1Click / NEAR Intents). Pass a defuse `source_asset` from
# GET /wallet/v1/tokens — the source chain is derived from its prefix
# (e.g. `eth-…` → Ethereum).
# ⚠️ Only send the exact whitelisted token on the exact chain below —
#    any other asset sent to this address is lost permanently.
# (Legacy alias /wallet/v1/deposit-intent still works.)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"source_asset":"nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near","amount":"10000000"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/intents/deposit/cross-chain"

# Returned `deposit_address` format depends on the source chain:
# NEAR — 64-char hex implicit account; EVM — 0x + 40 hex;
# Solana — base58; Bitcoin — bc1…/1…/3….
# For NEAR-source funds prefer POST /wallet/v1/intents/deposit
# (one direct ft_transfer_call, ~3s, no solver hop).3. Check balance# Native NEAR balance
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.fastnear.com/wallet/v1/balance?chain=near"

# FT token balance (e.g. USDT)
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.fastnear.com/wallet/v1/balance?chain=near&token=usdt.tether-token.near"4. Transfer NEARcurl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"bob.near","amount":"1000000000000000000000000"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/transfer"5. Swap tokens# Swap wNEAR -> USDT (handles deposit, storage, and settlement automatically)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"token_in":"nep141:wrap.near","token_out":"nep141:usdt.tether-token.near","amount_in":"1000000000000000000000000"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/intents/swap"6. Call a NEAR contractcurl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"receiver_id":"wrap.near","method_name":"near_deposit","args":{},"deposit":"10000000000000000000000"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/call"If the transaction is broadcast but its execution reverts on-chain (contract panic, out of gas), the response is HTTP 422 witherror: onchain_tx_failed, the decoded execution error, and the real tx_hash — the transaction is on chain, so do not retry it. Same contract on/transfer,/delete,/storage-deposit and/intents/deposit. For operations that go through multisig approval, execution happens in the background after the threshold is met — a revert there surfaces asstatus: "failed" viaGET /wallet/v1/requests/{id} and therequest_completed webhook, not as a synchronous 422.7. Withdraw (gasless cross-chain via Intents)# Tokens must be in Intents balance first (use /intents/deposit or /swap).
# Only whitelisted Intents assets can be withdrawn (see GET /wallet/v1/tokens).

# Withdraw NATIVE NEAR (default for chain=near): intents.near unwraps your wNEAR
# and sends native NEAR. Gasless, and the recipient needs NO wrap.near storage.
# amount is in yoctoNEAR (24 decimals) — 1 NEAR = 1000000000000000000000000.
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"receiver.near","amount":"1000000000000000000000000","token":"near","chain":"near"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/intents/withdraw"

# Withdraw wNEAR (NEP-141) instead — explicit opt-in; recipient must be
# storage-registered on wrap.near (POST /wallet/v1/storage-deposit):
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"receiver.near","amount":"1000000000000000000000000","token":"nep141:wrap.near","chain":"near"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/intents/withdraw"

# Withdraw USDT (NEP-141) to a NEAR account (recipient must have usdt storage):
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"receiver.near","amount":"1000000","token":"usdt.tether-token.near","chain":"near"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/intents/withdraw"

# Withdraw cross-chain to an external address (1Click bridges + delivers native):
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"0xRecipient...","amount":"1000000","token":"usdt.tether-token.near","chain":"ethereum"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/intents/withdraw"Cross-chain withdrawals: prefer "async": true. The 1Click bridge can take longer than the synchronous response window, so add "async": true to the body. The call then returns immediately with status: "processing" and a poll_url; poll GET /wallet/v1/requests/{request_id} until terminal. Same-chain NEAR settles in seconds, so async is optional there.Status values (exact). The withdraw/swap row returned by GET /wallet/v1/requests/{id} holds only these status strings: processing (keep polling), success, failed (a 1Click refund/expiry is normalized to failed; reason in result.reason), and needs_review. On a multisig wallet the submit can return pending_approval / approved / rejected instead. Do not invent synonym sets (settled/completed/…) — none of those are emitted.needs_review is terminal but special: execution was interrupted or unresolved and the fund state is unknown. Surface it as “needs manual review” — do not auto-retry (the transfer may have fired, so a retry can double-spend). Without handling it you would poll forever.8. Transfer inside Intents (to another account)Move a token from your Intents balance to another account's Intents balance, gasless, staying inside intents.near — the recipient is credited there, nothing lands on the public chain. This is not a withdrawal: use it when the recipient also holds an Intents balance (e.g. another OutLayer custody wallet); use /intents/withdraw to deliver to a plain on-chain account instead. NEAR-only (no chain field); token is required (to send NEAR, transfer nep141:wrap.near). The recipient need not exist on-chain.# Transfer 1 USDT to another account's Intents balance (gasless, stays inside Intents):
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"partner.near","amount":"1000000","token":"nep141:usdt.tether-token.near"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/intents/transfer"9. Delete wallet (irreversible)Delete the on-chain account, send all NEAR to a beneficiary, and revoke all API keys:curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"beneficiary":"receiver.near","chain":"near"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/delete"Warning: Only native NEAR tokens are sent to the beneficiary. FT tokens (USDT, wNEAR, etc.) and Intents balances are lost permanently because the account is deleted from the network. Withdraw or transfer those assets before deleting.10. Configure policy (optional)Share the handoff URL with the wallet owner so they can set spending limits, whitelists, and multisig rules from the dashboard:https://outlayer.fastnear.com/wallet?key=wk_...API Reference#All endpoints except /register require the Authorization: Bearer <api_key> header.ActionMethodEndpointRegister walletPOST/registerGet addressGET/wallet/v1/address?chain={chain}Check balanceGET/wallet/v1/balance?chain=near&token={token}Transfer NEARPOST/wallet/v1/transferCall NEAR contractPOST/wallet/v1/callSwap tokensPOST/wallet/v1/intents/swapSign EVM typed data (EIP-712)POST/wallet/v1/evm/sign-typed-dataSign EVM message (EIP-191)POST/wallet/v1/evm/sign-messageSign raw EVM transaction (needs evm_sign.raw_tx; client serializes & broadcasts)POST/wallet/v1/evm/sign-transactionSign Solana message (raw-bytes ed25519, base58 sig; rejects bytes that parse as a tx message)POST/wallet/v1/solana/sign-messageSign Solana transaction (needs solana_sign.raw_tx; client sends base64 serialized tx message, assembles & broadcasts)POST/wallet/v1/solana/sign-transactionDeposit to IntentsPOST/wallet/v1/intents/depositWithdraw (cross-chain)POST/wallet/v1/intents/withdrawDry-run withdrawPOST/wallet/v1/intents/withdraw/dry-runTransfer inside Intents (to another account's intents balance)POST/wallet/v1/intents/transferDelete walletPOST/wallet/v1/deleteRequest statusGET/wallet/v1/requests/{request_id}List requestsGET/wallet/v1/requestsList tokensGET/wallet/v1/tokensView policyGET/wallet/v1/policyAudit logGET/wallet/v1/auditRegister (deterministic)POST/register (with NEAR sig body)Register delegate keyPUT/wallet/v1/api-keyRevoke delegate keyDELETE/wallet/v1/api-key/{key_hash}Base URL: https://api.outlayer.fastnear.com (mainnet) · https://testnet-api.outlayer.fastnear.com (testnet)NEAR Intents is mainnet-only. There are no testnet Intents solvers, so on testnet the coordinator returns HTTP 503 for every intents-dependent endpoint — namely /wallet/v1/intents/* (deposit, withdraw, swap, cross-chain deposit, payment-check, and their quote / dry-run variants), cross-chain gasless withdrawals, and all /wallet/v1/confidential/* routes. Test these against the mainnet API only. Account, address, balance, transfer, contract call, message signing, policy, approval, and delete endpoints work on both networks.Confidential Intents#Move balances between your public intents shard, a confidential shielded-pool shard, and external chains — same TEE-mediated signing, a different shard. The /wallet/v1/confidential/* routes mirror /wallet/v1/intents/*. Like all Intents flows they are mainnet-only — they return HTTP 503 on testnet (no testnet solvers) or wherever the deployment has not enabled confidential intents. The confidential shard is the intents.far contract on a private NEAR shard with no public RPC: balances are real on-chain state there, just not publicly readable. Full integration guide: CONFIDENTIAL_INTENTS.md.POST /confidential/shield — SHIELD: public intents → confidential (legacy alias /confidential/deposit, still works)POST /confidential/unshield — confidential → public intentsPOST /confidential/withdraw — confidential → external chain (or chain="near" for native NEAR delivery via native_withdraw)POST /confidential/transfer — private confidential → confidential transferPOST /confidential/swap (+ /swap/quote, /withdraw/dry-run) — on a multisig wallet, like a public swap, approval controls whether it runs (the TEE does not itself re-check the swap's token/amount against the artifact — that relies on gateway trust)POST /confidential/deposit/cross-chain — cross-chain deposit (via 1Click / NEAR Intents; legacy alias /confidential/deposit-intent, still works)GET /confidential/balance — read confidential balancesAction routes are asynchronous — they return request_id with status pending_deposit; poll GET /wallet/v1/requests/{id} until terminal.Privacy is nuanced. Confidential balances are real on-chain state on a private shard (intents.far) with no public RPC — chain-graph bots cannot read them. SHIELD/UNSHIELD link your wallet on the public chain (entry/exit reveal). Cross-chain deposit/withdraw keep your NEAR wallet off the public chain — only the external-chain sender/receiver is public, on that chain. Never hidden: the shard itself is an auditable smart contract — the Defuse/1Click solver layer (sees plaintext intents), the partner mapping, your source-chain identity, and the shard operator / auditors / law enforcement with a warrant can all see confidential state. For unlinkability, fund via cross-chain deposit and exit via cross-chain withdraw rather than SHIELD/UNSHIELD — only one confidential identity per wallet, so multi-op unlinkability is not achievable today.# SHIELD 0.01 wNEAR into the confidential shard
# (legacy alias /wallet/v1/confidential/deposit still works)
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"token":"nep141:wrap.near","amount":"10000000000000000000000"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/confidential/shield"

# Read confidential balances
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.fastnear.com/wallet/v1/confidential/balance"Delete Wallet#Permanently delete the wallet's on-chain NEAR account using the native DeleteAccount action. All remaining native NEAR balance is automatically sent to the beneficiary. All API keys are revoked.Warning: Only native NEAR tokens are sent to the beneficiary (handled by NEAR's DeleteAccount). FT tokens (USDT, wNEAR, etc.) and Intents balances are lost permanently because the account is deleted from the network. Withdraw or transfer those assets before deleting the wallet.Before deletingTransfer all FT tokens via POST /wallet/v1/call with ft_transferWithdraw Intents balances via POST /wallet/v1/intents/withdrawMove any other on-chain assets to another accountRequestcurl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"beneficiary":"receiver.near","chain":"near"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/delete"Response{
  "request_id": "uuid",
  "status": "success",
  "tx_hash": "...",
  "beneficiary": "receiver.near"
}After deletion, the on-chain account no longer exists and all API keys are revoked. Subsequent API requests will return invalid_api_key.Sign Message (NEP-413)#Sign an arbitrary message using the wallet's NEAR private key following the NEP-413 standard. Use this to authenticate your agent to external services that verify NEAR signatures — no on-chain transaction needed.Requestcurl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"message":"Login to example.com","recipient":"example.com"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/sign-message"Response{
  "account_id": "aabbccdd11223344...",
  "public_key": "ed25519:...",
  "signature": "ed25519:...",
  "nonce": "base64-encoded-32-bytes"
}ParametersFieldRequiredDescriptionmessageYesText to sign (max 10,000 bytes)recipientYesService that will verify the signature (1–128 chars)nonceNoBase64-encoded 32 bytes. Auto-generated if omittedVerification: The signature follows NEP-413. For implicit accounts, the verifier can confirm identity without RPC: account_id == hex(public_key_bytes).Deterministic Wallets#For servers, bots, and agents with a NEAR account: create wallets that require zero per-user key storage. The wallet ID is derived from (account_id, seed, vault_or_none) — same inputs always produce the same wallet, and different vault scopes legitimately mint independent sub-wallets under the same seed. Auth uses NEAR ed25519 signatures on every request instead of stored API keys. Seed format: [a-zA-Z0-9._-], 1-256 chars.Zero stored secrets. The coordinator stores no auth credentials for deterministic wallets. Key revocation = remove the key from your NEAR account. Access is revoked within 60 seconds (cache TTL). No coordinator action needed.NEAR signature auth is for integrators who have their own NEAR account key (bots, servers). Custody wallets (wk_ API key) can also create sub-agents — just pass your Bearer header to PUT /wallet/v1/api-key with seed and key_hash in body, no NEAR signatures needed.Telegram / Discord BotOne NEAR key in env. seed = SHA256(user_id). Creates wallets for thousands of users. Zero per-user DB.Web App (OAuth)Server has one NEAR key. seed = SHA256(provider:user_id). Google login → instant wallet.Sub-agentsParent derives wk_ keys from NEAR key + seed. Sub-agent uses simple Bearer token — no crypto.Two auth methodsHeaderForStored secretsBearer wk_...Random wallets, sub-agentsAPI key hash in DBBearer near:<base64url>Deterministic walletsNothing — verified via NEAR RPCSignature formatAll signatures are raw ed25519 — sign the message string bytes directly with your NEAR key, then base58-encode the 64-byte result. This is NOT NEP-413 (the /sign-message endpoint returns NEP-413 signatures, which are a different format and won't work here).FieldFormatExamplepubkeyWith ed25519: prefixed25519:6E8sCc...signatureBase58, no prefix4dJh2r...Register a deterministic wallet# Sign "register:<seed>:<timestamp>" with your NEAR ed25519 key (raw, not NEP-413)
curl -s -X POST -H "Content-Type: application/json" \
  -d '{
    "account_id": "my-bot.near",
    "seed": "user-42",
    "pubkey": "ed25519:<base58_pubkey>",
    "message": "register:user-42:1712000000",
    "signature": "<base58_signature>"
  }' \
  "https://api.outlayer.fastnear.com/register"

# Timestamp window: ±5 minutes for registration
# Response: { "wallet_id": "...", "near_account_id": "..." }
# No api_key — use Bearer near:... for all requestsBearer near: token formatBase64url-encode a JSON object. The signed message format depends on whether you include a vault scope (±30s window):No vault: auth:<seed>:<timestamp>With vault: auth:<seed>:<timestamp>:<vault_id> — vault_id MUST be inside the signed message (not only in JSON), otherwise verify fails with 401.{
  "account_id": "my-bot.near",
  "seed": "user-42",
  "pubkey": "ed25519:<base58>",
  "timestamp": 1712000000,
  "signature": "<base58>",
  "vault_id": "vault.my-bot.near"   // optional; include in signed message too
}Key lives in the TEE? The signature above assumes you hold the NEAR ed25519 key locally. For a wallet whose key lives in OutLayer custody (the TEE), you don't have the private key — instead call POST /wallet/v1/auth-sign with { "purpose": "bearer", "seed": "<seed>" } and it returns the auth:<seed>:<timestamp> message and signature (signed inside the TEE with a fresh server timestamp) to drop into the token.Delegate keys for sub-agentsRegister a wk_ key hash so a sub-agent can use simple Bearer auth. Works from both custody wallets (Bearer wk_...) and external NEAR accounts (signature in body).# From a custody wallet — just pass your Bearer token, no NEAR signatures needed
# key_hash = SHA256("wk_" + derived_key_hex)
curl -s -X PUT -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"seed": "sub-task", "key_hash": "<sha256_hex_of_wk_key>"}' \
  "https://api.outlayer.fastnear.com/wallet/v1/api-key"
# Response: { "wallet_id": "...", "near_account_id": "..." }

# Sub-agent: simple Bearer token, no crypto
curl -H "Authorization: Bearer wk_derived_key_here" \
  "https://api.outlayer.fastnear.com/wallet/v1/balance?chain=near"

# Revoke: DELETE /wallet/v1/api-key/{key_hash}
# Returns 409 if last active key for the walletKey rotationNo endpoint needed. Add a new key to your NEAR account, start signing with it, remove the old key. Old key access is revoked within 60 seconds (cache TTL). Wallet identity is tied to (account_id, seed, vault_or_none), not to which key signs.Security Model#MPC master secretThe keystore TEE obtains its master secret from the NEAR Protocol MPC network via a DAO-governed approval process. Individual wallet keys are then derived inside the TEE using HMAC-SHA256(master_secret, "wallet:{id}:{chain}"). The same wallet ID always produces the same addresses across chains.TEE attestationKey derivation, transaction signing, and policy evaluation all happen inside Intel TDX enclaves. TEE attestation proves that the code running inside the enclave has not been tampered with. No one — not even the infrastructure operator — can extract keys or bypass policy checks.Policy on-chainPolicies are stored encrypted on the NEAR blockchain. Only the TEE can decrypt them. The controller (wallet owner) can freeze the wallet instantly via an on-chain transaction — no API gateway involvement needed.Agent compromise recoveryIf the agent's API key is compromised: (1) freeze the wallet from the dashboard (instant), (2) revoke the API key, (3) create a new API key, (4) transfer funds to a new wallet if needed. The private key itself is never exposed — there is nothing to rotate.AI Agent Skill File#For AI agents that support skill files (Claude MCP, OpenAI functions, etc.), OutLayer provides a ready-to-use skill definition that teaches the agent how to register, fund, and operate the wallet.# Fetch the skill file
curl -s https://skills.outlayer.ai/agent-custody/SKILL.mdThe skill file contains step-by-step instructions, API reference, error handling, and guidelines for the AI agent. Point your agent framework to this URL and the agent will know how to set up and use its wallet automatically.What the skill file covers:Wallet registration (one POST call, no blockchain needed)Getting addresses and balances on any supported chainNative NEAR transfers, FT transfers, token swapsCross-chain withdrawals via Intents (gasless)Intents deposits for manual balance managementContract calls with arbitrary function argumentsBalance checks before every operation (required)Status polling, error handling, and automatic storage registrationFund link generation for requesting NEAR from the userGuiding the user to configure spending policiesOutLayer CLI Integration#Agents with custody wallets can use the OutLayer CLI directly — no NEAR private key needed. Login with the wallet API key and all commands route signing through the coordinator's wallet API transparently.# Login with wallet key (instead of NEAR private key)
outlayer login --wallet-key wk_15807dbda492636df5280629d7617c3ea80f915ba960389b621e420ca275e545

# All commands work transparently
outlayer deploy my-agent
outlayer keys create
outlayer run alice.near/my-agent '{"test": true}'
outlayer secrets set '{"API_KEY":"sk-..."}' --project alice.near/my-agent
outlayer earningsHow it works: When logged in with --wallet-key, the CLI stores the auth type as wallet_key. All contract operations are routed through POST /wallet/v1/call instead of local transaction signing. NEP-413 signatures (used by secrets update) go through POST /wallet/v1/sign-message.Supported commandsCommandStatusdeploy, run, keys, secrets, earnings, versionsSupportedupload (FastFS)Not yet — requires raw Borsh argsComparison with Traditional Custody#FeatureOutLayer Agent CustodyTraditional (Fireblocks etc.)SetupOne API call, instantEnterprise onboarding, days-weeksKey managementMPC + TEE, no key exposureMPC, HSMPolicy engineOn-chain encrypted, TEE-enforcedServer-side, proprietaryCross-chainNEAR Intents (gasless)Per-chain integrationGas tokensNot needed for transfersRequired per chainAI agent readySkill file, REST API, WASI host functionsSDK integrationPricingPay per transactionMonthly subscription + per-txDashboard#The wallet owner manages everything through the OutLayer dashboard. The agent only sees the API.PageWhat it does/wallet/manageCreate and edit policies, manage approvers, freeze/unfreeze wallet/wallet/approvalsView and sign pending multisig approvals/wallet/auditFull history of all transactions, policy changes, approvals, freezes
