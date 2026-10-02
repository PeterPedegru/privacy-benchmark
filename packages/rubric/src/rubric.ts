import type { AdversaryId, BenchmarkDef, CriterionDef, OptionDef, Rubric, SuiteDef, SuiteId } from "./types.ts";

export const RUBRIC_VERSION = "1.3.0";

// ---------- tiny builders keep the data readable ----------

type CriterionInput = {
  key: string;
  label: string;
  question: string;
  guidance: string;
  options: [string, string, number][];
  highImpact?: boolean;
  naAllowed?: boolean;
  hints?: string[];
  /** See CriterionDef.noDataOption. */
  noData?: string;
};

type BenchmarkInput = {
  key: string;
  name: string;
  question: string;
  description: string;
  weight: number;
  highImpact?: boolean;
  notes?: string[];
  criteria: CriterionInput[];
};

type SuiteInput = {
  id: SuiteId;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  weight: number;
  adversaries: AdversaryId[];
  benchmarks: BenchmarkInput[];
};

function suite(input: SuiteInput): SuiteDef {
  return {
    ...input,
    benchmarks: input.benchmarks.map((b): BenchmarkDef => {
      const benchmarkId = `${input.id}.${b.key}`;
      return {
        id: benchmarkId,
        key: b.key,
        suite: input.id,
        name: b.name,
        question: b.question,
        description: b.description,
        weight: b.weight,
        highImpact: b.highImpact ?? false,
        notes: b.notes ?? [],
        criteria: b.criteria.map(
          (c): CriterionDef => ({
            id: `${benchmarkId}.${c.key}`,
            key: c.key,
            benchmarkId,
            label: c.label,
            question: c.question,
            guidance: c.guidance,
            highImpact: c.highImpact ?? b.highImpact ?? false,
            naAllowed: c.naAllowed ?? false,
            options: c.options.map(([id, label, points]): OptionDef => ({ id, label, points })),
            evidenceHints: c.hints ?? [],
            noDataOption: c.noData ?? null,
          }),
        ),
      };
    }),
  };
}

// ---------- Suite 1 · Privacy coverage ----------

const coverage = suite({
  id: "coverage",
  name: "Privacy coverage",
  shortName: "Coverage",
  tagline: "What's hidden",
  description: "What a careful user using the reference client can keep from public observers, chain analysts and network observers.",
  weight: 24,
  adversaries: ["public_observer", "chain_analyst", "network_observer"],
  benchmarks: [
    {
      key: "confidentiality",
      name: "Confidentiality",
      question: "Can outsiders see how much, and of what?",
      description: "Whether amounts, balances and asset types stay hidden, including at the edges of the private system.",
      weight: 15,
      criteria: [
        {
          key: "amounts",
          label: "Amounts",
          question: "Are transfer amounts hidden from public observers?",
          guidance: "Score the private path. Fixed denominations reveal the amount class, so they count as ranges, not hidden.",
          options: [
            ["hidden", "Hidden", 35],
            ["ranges", "Hidden, but fixed denominations or linked fields reveal ranges", 15],
            ["visible", "Visible", 0],
          ],
          hints: ["protocol docs on transaction format", "explorer view of a private transaction"],
        },
        {
          key: "balances",
          label: "Balances",
          question: "Are holders' balances hidden?",
          guidance: "Derivable means an observer can reconstruct balances with moderate effort from public data.",
          options: [
            ["hidden", "Hidden", 25],
            ["derivable", "Derivable with effort", 10],
            ["public", "Public", 0],
          ],
        },
        {
          key: "asset",
          label: "Asset type",
          question: "Is the token or asset that moved hidden?",
          guidance: "Separate pools or tags per asset reveal which asset moved even if amounts are hidden.",
          options: [
            ["hidden", "Hidden", 20],
            ["per-asset", "Revealed by per-asset pools or tags", 8],
            ["visible", "Visible", 0],
          ],
        },
        {
          key: "boundary",
          label: "Boundary",
          question: "Are amounts visible when funds enter or leave the private system (shield, wrap, bridge)?",
          guidance: "Top option only if a user can receive and spend without ever crossing a public boundary, e.g. native private assets or private bridging.",
          options: [
            ["no-boundary", "Funds can be received and spent without crossing a public boundary", 20],
            ["boundary-public", "Entry and exit amounts are public; everything inside is hidden", 10],
            ["nothing-private", "Nothing is private", 0],
          ],
        },
      ],
    },
    {
      key: "unlinkability",
      name: "Unlinkability",
      question: "Can outsiders tell who paid whom?",
      description: "Whether sender, recipient and transaction history are hidden, including when using public apps and paying fees.",
      weight: 20,
      criteria: [
        {
          key: "sender",
          label: "Sender",
          question: "Is the sender hidden in private transfers?",
          guidance:
            "Mixing means the sender is only hidden by breaking the link between a deposit and a later withdrawal. Judge the transfer itself: whether paying fees exposes the payer is scored under Fees, not here.",
          options: [
            ["hidden", "Hidden", 25],
            ["mixing", "Hidden only through deposit/withdraw mixing", 10],
            ["visible", "Visible", 0],
          ],
        },
        {
          key: "recipient",
          label: "Recipient",
          question: "Is the recipient hidden in private transfers?",
          guidance: "Same scale as the sender.",
          options: [
            ["hidden", "Hidden", 25],
            ["mixing", "Hidden only through deposit/withdraw mixing", 10],
            ["visible", "Visible", 0],
          ],
        },
        {
          key: "history",
          label: "History",
          question: "Are spends cryptographically unlinkable from the receipts that funded them?",
          guidance: "Commitments plus nullifiers, or an equivalent construction, qualify.",
          options: [
            ["unlinkable", "Yes", 20],
            ["linkable", "No", 0],
          ],
        },
        {
          key: "public-apps",
          label: "Public app access",
          question: "Can users call public contracts or DeFi without revealing their account?",
          guidance: "The initiator must stay hidden. The public call itself may be visible.",
          options: [
            ["anonymous", "Initiator hidden", 15],
            ["must-exit", "Must exit privacy to interact", 0],
          ],
        },
        {
          key: "fees",
          label: "Fee payment",
          question: "Does paying fees reveal who paid?",
          guidance:
            "Private: the reference client pays fees through relayers, broadcasters or paymasters from private funds by default (even if users can opt out), and no single operator handles most of that traffic. A default relayer that one operator dominates is the middle option.",
          options: [
            ["private", "Private fees, relayer or paymaster by default", 15],
            ["optional-relayer", "Relayers exist but aren't the reference client's default, or one relayer handles most traffic", 8],
            ["public-payer", "The fee payer's public account is revealed", 0],
          ],
        },
      ],
    },
    {
      key: "identity",
      name: "Identity shielding",
      question: "Does using privacy expose who you are?",
      description: "Persistent identifiers, registration requirements, reusable addresses and private identity proofs.",
      weight: 10,
      criteria: [
        {
          key: "persistent-id",
          label: "Persistent identifier",
          question: "Is any stable public identifier attached to private activity?",
          guidance:
            "Judge every transaction a user must send to use the private feature, including deposits and withdrawals. If each shows the user's public account (a pool's depositor and recipient addresses), answer Public address, even though the link between them is hidden; the link is scored under Unlinkability. Other stable identifiers: a visible sender account ID or a stable discovery tag.",
          options: [
            ["none", "None", 35],
            ["stable-tag", "A stable account ID or discovery tag is visible", 10],
            ["public-address", "Public address on every transaction", 0],
          ],
        },
        {
          key: "registration",
          label: "Registration",
          question: "Must users register an identity or credential to use private features at the protocol level?",
          guidance:
            "Mandatory registration of a viewing key or credential with a third party counts as registration even if it isn't legal identity. Approval of deposits by a screening provider (association sets, proofs of innocence) is not registration; it's scored under Custody → Access.",
          options: [
            ["none", "None", 30],
            ["key-registration", "Mandatory key or credential registration with a third party", 10],
            ["kyc", "KYC or identity allowlist", 0],
          ],
        },
        {
          key: "reusable-address",
          label: "Reusable addresses",
          question: "Can users receive without publishing an address that links their payments?",
          guidance: "Shielded, stealth or one-time receiving in the reference client by default.",
          options: [
            ["unlinkable-receive", "Shielded, stealth or one-time receiving by default", 20],
            ["linkable", "No", 0],
          ],
        },
        {
          key: "identity-proofs",
          label: "Private identity proofs",
          question: "Can users prove attributes (membership, compliance, credentials) without revealing identity?",
          guidance: "Native means the protocol offers the primitive; via apps means developers can build it.",
          options: [
            ["native", "Native support", 15],
            ["apps", "Possible via apps", 8],
            ["no", "No", 0],
          ],
        },
      ],
    },
    {
      key: "execution",
      name: "Private execution",
      question: "Can programs run privately?",
      description: "Private state, private logic, hiding which function ran, and computing over many users' private inputs.",
      weight: 15,
      criteria: [
        {
          key: "private-state",
          label: "Private state",
          question: "Can contracts hold private state?",
          guidance: "Private balances in a fixed asset contract only count as the middle option.",
          options: [
            ["general", "General private state", 30],
            ["balances-only", "Private balances only (fixed asset logic)", 12],
            ["none", "None", 0],
          ],
        },
        {
          key: "private-logic",
          label: "Private logic",
          question: "Can user-defined logic execute privately?",
          guidance:
            "Distinguish hidden logic from public logic running on encrypted inputs. Limited means a fixed menu of private actions beyond moving funds (e.g. adapter-based swaps). A system whose only private actions are deposit, transfer and withdraw (a pool's own proofs) has no private logic: answer None.",
          options: [
            ["general-hidden", "General-purpose; inputs and logic hidden", 30],
            ["general-encrypted", "General-purpose on encrypted inputs, but which logic runs is public", 20],
            ["limited", "Limited fixed actions (e.g. adapter-based swaps)", 12],
            ["none", "None", 0],
          ],
        },
        {
          key: "function-hiding",
          label: "Function hiding",
          question: "Is it hidden which contract and function a transaction called?",
          guidance: "Function privacy in the Zexe sense.",
          options: [
            ["hidden", "Hidden", 25],
            ["contract-hidden", "Contract hidden, function type inferable", 12],
            ["visible", "Visible", 0],
          ],
        },
        {
          key: "shared-state",
          label: "Shared private state",
          question: "Can the system compute over many users' private inputs at once (FHE, MPC, pooled encrypted state)?",
          guidance: "Native means shared encrypted state is a first-class feature developers can use.",
          options: [
            ["native", "Native", 15],
            ["limited", "Limited", 7],
            ["no", "No", 0],
          ],
        },
      ],
    },
    {
      key: "callstack",
      name: "Call-stack privacy",
      question: "Do nested calls leak the call graph?",
      description: "Whether private execution composes across contracts without revealing which contracts ran, or how many.",
      weight: 10,
      notes: [
        "If Private execution → Private logic is “None”, this benchmark scores 0.",
        "Whether private calls can compose at all is scored under Programmability → Composability; this row scores only what leaks.",
      ],
      criteria: [
        {
          key: "targets",
          label: "Call targets",
          question: "Is it hidden which contracts ran inside the transaction?",
          guidance:
            "Partial if observers can narrow the targets to a small set of known contract classes. Only private calls count: if the system has no private calls between contracts (fixed-function circuits, a single pool), the targets are the public contracts users call, so answer Visible.",
          options: [
            ["hidden", "Hidden", 35],
            ["partial", "Partially (e.g. a small set of known contract classes)", 15],
            ["visible", "Visible", 0],
          ],
        },
        {
          key: "structure",
          label: "Call structure",
          question: "Are the depth and number of nested calls hidden from observers?",
          guidance:
            "Fixed-shape or padded proofs hide the structure of private calls. Partial if counts, proof sizes or kernel shapes leak it. Only private call stacks count: a single fixed-function circuit (a pool's withdrawal proof) has no private call structure to hide, and the public contract calls around it are visible, so answer Visible.",
          options: [
            ["hidden", "Hidden (fixed-shape or padded proofs)", 35],
            ["partial", "Partially (counts or sizes leak)", 15],
            ["visible", "Visible", 0],
          ],
        },
        {
          key: "public-boundary",
          label: "Public boundary",
          question: "What leaks when private code calls public code?",
          guidance:
            "Consider the caller's identity, the public call's arguments, and how many public calls were made. Only private calls count: if the system has no private code that calls public contracts (a pool's fixed withdrawal proof), answer Visible.",
          options: [
            ["none", "Fully hidden (private calls to public code exist and leak nothing)", 30],
            ["args-leak", "Caller hidden but public-call arguments or counts leak", 12],
            ["visible", "Caller and arguments visible", 0],
          ],
        },
      ],
    },
    {
      key: "metadata",
      name: "Metadata resistance",
      question: "What leaks around the transaction?",
      description: "Network-level origin, private reads, pending-transaction contents and fingerprinting.",
      weight: 15,
      criteria: [
        {
          key: "network",
          label: "Network layer",
          question:
            "Does the reference client hide the user's IP from every network party by default (Tor, a mixnet, or peer-to-peer gossip for submissions and reads)?",
          guidance:
            "Judge the reference client's default against every network party that handles the user's traffic: its RPC provider, relayers or broadcasters, and ISPs. A relayer that submits the transaction hides the fee payer (scored under Fees), not the IP. Default: the IP is hidden from all of them without configuration (Tor, a mixnet, or peer-to-peer gossip for both submissions and reads). Opt-in: the client offers a setting that does this. None: otherwise.",
          options: [
            ["default", "Built in by default", 25],
            ["opt-in", "Available, opt-in", 12],
            ["none", "None", 0],
          ],
        },
        {
          key: "reads",
          label: "Private reads",
          question: "Can users find and read their private data without revealing which data is theirs to a third-party node?",
          guidance: "Local node or trial decryption qualifies. Tag-based queries, PIR or TEE-ORAM leak partially.",
          options: [
            ["local", "Local node or trial decryption by default", 25],
            ["partial", "Partial leakage (tags, PIR, TEE-ORAM)", 12],
            ["rpc-sees", "Third-party RPC sees queries", 0],
          ],
        },
        {
          key: "pending",
          label: "Pending transactions",
          question: "Do the mempool and sequencer see only proofs or ciphertexts before inclusion?",
          guidance:
            "Opaque: only proofs or ciphertexts are visible before inclusion. Partial: what the system protects (which note or deposit is spent, or the sender) stays hidden before inclusion, but amounts, assets or recipients are plaintext. Plaintext: the mempool, sequencer or relayer sees everything the system later hides.",
          options: [
            ["opaque", "Yes", 25],
            ["partial", "Partially", 12],
            ["plaintext", "Plaintext visible before inclusion", 0],
          ],
        },
        {
          key: "fingerprinting",
          label: "Fingerprinting",
          question: "Are there mitigations for timing, fee, size and shape fingerprints?",
          guidance:
            "Protocol-level means uniform shapes, padding or batching are enforced, not advice to users. Partial: some shapes are uniform (fixed denominations, uniform proof sizes) but timing, fees or counts still distinguish users.",
          options: [
            ["protocol", "Protocol-level mitigations (uniform shapes, padding, batching)", 25],
            ["partial", "Partial", 12],
            ["none", "None, or documented leaks", 0],
          ],
        },
      ],
    },
    {
      key: "anonymity-set",
      name: "Anonymity set",
      question: "How big is the crowd you hide in?",
      description: "Structure of the anonymity set, privacy by default, measured usage and effective (not nominal) anonymity.",
      weight: 15,
      notes: ["“No independent study yet” is a real option, not an unknown, so young systems aren't punished for not having been attacked."],
      criteria: [
        {
          key: "structure",
          label: "Structure",
          question: "How is the anonymity set structured?",
          guidance: "One set shared across assets and apps beats per-asset or per-chain pools.",
          options: [
            ["shared", "One shared set across assets and apps", 25],
            ["per-asset", "Shared per asset or per pool", 12],
            ["fragmented", "Fragmented across many pools or chains", 6],
            ["none", "No anonymity", 0],
          ],
        },
        {
          key: "default",
          label: "Privacy by default",
          question: "Is activity private by default?",
          guidance: "Opt-in privacy shrinks the crowd to people who chose it.",
          options: [
            ["default", "Everything private by default", 25],
            ["opt-in", "Opt-in", 8],
            ["none", "None", 0],
          ],
        },
        {
          key: "usage",
          label: "Measured usage",
          question: "How much value sits in private state, or how many private transactions happen per day? (Use the higher tier.)",
          guidance:
            "Use dashboards such as L2BEAT or DefiLlama, or official stats. When a logged search finds no public figure, the answer is Testnet or no public data.",
          noData: "none",
          options: [
            ["large", "≥ $100M or ≥ 10,000 private tx/day", 30],
            ["medium", "≥ $10M or ≥ 1,000/day", 21],
            ["small", "≥ $1M or ≥ 100/day", 12],
            ["tiny", "Live with any measured usage", 5],
            ["none", "Testnet or no public data", 0],
          ],
        },
        {
          key: "effective",
          label: "Effective anonymity",
          question: "Do independent measurements show how much heuristics shrink the set?",
          guidance:
            "Use academic or independent analyses of linkability (effective vs nominal anonymity). When a logged search finds no independent study, the answer is No independent study yet.",
          noData: "no-study",
          options: [
            ["small-reduction", "Studied; reduction < 20%", 20],
            ["moderate-reduction", "Studied; reduction 20–50%", 10],
            ["no-study", "No independent study yet", 8],
            ["large-reduction", "Studied; > 50%, or many single-candidate exits", 0],
          ],
        },
      ],
    },
  ],
});

// ---------- Suite 2 · Privacy trust model ----------

const trust = suite({
  id: "trust",
  name: "Privacy trust model",
  shortName: "Trust",
  tagline: "Who can see",
  description:
    "Who besides the user can read private data, how much control users have over disclosure, and what must be trusted mathematically and physically.",
  weight: 16,
  adversaries: ["privileged_insider", "future_adversary"],
  benchmarks: [
    {
      key: "decryption",
      name: "Decryption power",
      question: "Who besides you can read your private data?",
      description: "Standing third-party access, infrastructure visibility and retroactive exposure.",
      weight: 45,
      highImpact: true,
      notes: ["“Operator or validators see plaintext routinely” caps this benchmark at 15%."],
      criteria: [
        {
          key: "standing-access",
          label: "Standing access",
          question: "Does any third party have a standing ability to decrypt or view private data?",
          guidance: "Include auditors with master viewing keys, threshold key-management committees, and operators or validators that see plaintext.",
          options: [
            ["none", "Only the user and whoever they choose; no master or global key", 50],
            ["threshold-large", "Threshold committee of ≥ 7 independent, named parties", 20],
            ["threshold-small", "Smaller committee, or one resting mainly on TEEs", 10],
            ["single", "A single designated entity holds a master or auditor key", 5],
            ["operator", "Operator or validators see plaintext routinely", 0],
          ],
          hints: ["compliance docs", "key management docs", "validator design docs"],
        },
        {
          key: "infra-visibility",
          label: "Infrastructure visibility",
          question: "Do sequencers, provers, validators or relayers see plaintext of private transactions?",
          guidance: "Check where proofs are generated in the reference wallets, not only what the whitepaper says.",
          options: [
            ["none", "No; client-side proving, infrastructure sees proofs or ciphertexts only", 30],
            ["tee", "Only inside TEEs", 12],
            ["default-remote", "Client-side possible, but the default path sends plaintext to a service", 8],
            ["plaintext", "Yes", 0],
          ],
        },
        {
          key: "retroactive",
          label: "Retroactive exposure",
          question: "Would compromising one key or committee expose everyone's history?",
          guidance: "A global decryption key, or a master key everyone's viewing keys are encrypted to, means yes.",
          options: [
            ["no", "No global key; compromise is limited to individual users", 20],
            ["yes", "Yes", 0],
          ],
        },
      ],
    },
    {
      key: "disclosure",
      name: "Disclosure control",
      question: "Do you control who gets to see?",
      description: "Selective, scoped and revocable disclosure in the user's hands.",
      weight: 25,
      criteria: [
        {
          key: "selective",
          label: "Selective disclosure",
          question: "Can users share a view or proof of their activity with parties they choose?",
          guidance: "Viewing keys or disclosure proofs supported by the protocol count as native.",
          options: [
            ["native", "Native", 40],
            ["apps", "Via app-specific tooling", 20],
            ["no", "No", 0],
          ],
        },
        {
          key: "granularity",
          label: "Granularity",
          question: "Can disclosure be limited to one transaction, asset or time range?",
          guidance: "Whole-account viewing keys are the middle option.",
          options: [
            ["fine", "Fine-grained", 30],
            ["account", "Whole account only", 12],
            ["no", "No", 0],
          ],
        },
        {
          key: "revocable",
          label: "Revocability",
          question: "Can users rotate keys or limit disclosure going forward?",
          guidance: "Key rotation that stops future visibility counts.",
          options: [
            ["yes", "Yes", 30],
            ["no", "No", 0],
          ],
        },
      ],
    },
    {
      key: "crypto",
      name: "Cryptographic assumptions",
      question: "What must you trust, mathematically and physically?",
      description: "Trusted setup, trusted hardware, post-quantum confidentiality, and whether privacy is formally specified.",
      weight: 30,
      criteria: [
        {
          key: "setup",
          label: "Setup",
          question: "What kind of setup does the proof system rely on (L2BEAT trusted-setup framework, weakest link)?",
          guidance: "Green: ≥ 150 public, verifiable contributions. Yellow: ≥ 30. Red: fewer, or an unverifiable ceremony.",
          options: [
            ["transparent", "Transparent, no trusted setup", 25],
            ["green", "Green: ≥ 150 public, verifiable contributions", 18],
            ["yellow", "Yellow: ≥ 30 contributions", 10],
            ["red", "Red or unverifiable ceremony", 3],
            ["no-proofs", "No proofs; relies on trusted parties", 0],
          ],
        },
        {
          key: "hardware",
          label: "Hardware",
          question: "Does privacy depend on trusted hardware (TEEs)?",
          guidance: "TEEs used only for integrity or as defense-in-depth are the middle option.",
          options: [
            ["none", "No TEE reliance", 25],
            ["integrity-only", "TEEs for integrity or defense-in-depth only", 15],
            ["confidentiality", "Confidentiality depends on TEEs", 0],
          ],
        },
        {
          key: "post-quantum",
          label: "Post-quantum confidentiality",
          question: "Does stored private data resist harvest-now-decrypt-later attacks?",
          guidance: "Hash-based commitments are PQ-hiding; ECDH note encryption is not.",
          options: [
            ["pq", "PQ encryption for private data", 20],
            ["partial", "Partial (e.g. PQ-hiding commitments, classical note encryption)", 10],
            ["no", "No", 0],
          ],
        },
        {
          key: "formal-privacy",
          label: "Formal privacy",
          question: "Is the privacy property formally specified, or only asserted?",
          guidance: "Explicit statements that privacy is “de facto” rather than zero-knowledge are the third option.",
          options: [
            ["formal", "Formally specified zero-knowledge, with a proof or formal verification", 30],
            ["claimed", "Claimed ZK, audited, not formally specified", 15],
            ["de-facto", "Explicitly “de facto” or informal", 5],
            ["none", "None", 0],
          ],
        },
      ],
    },
  ],
});

// ---------- Suite 3 · Custody & control ----------

const custody = suite({
  id: "custody",
  name: "Custody & control",
  shortName: "Custody",
  tagline: "Who can touch your money",
  description: "Who can move, pause, freeze or gate user funds, and whether users can always leave.",
  weight: 18,
  adversaries: ["privileged_insider"],
  benchmarks: [
    {
      key: "self-custody",
      name: "Self-custody",
      question: "Is it really your money?",
      description: "Spending authority, asset backing and whether users can recover funds without the operator.",
      weight: 20,
      highImpact: true,
      criteria: [
        {
          key: "spending",
          label: "Spending authority",
          question: "Who can move user funds?",
          guidance: "Mandatory co-signers, guardians or custodial federations count against self-custody.",
          options: [
            ["user-only", "Only the user's keys", 50],
            ["co-signer", "User plus a mandatory co-signer or guardian", 20],
            ["federation", "A federation or MPC custodian holds the backing", 10],
            ["custodian", "A custodian or operator", 0],
          ],
        },
        {
          key: "backing",
          label: "Backing",
          question: "How are assets in the system backed?",
          guidance: "Native assets, or a canonical bridge secured by validity proofs, are the top option.",
          options: [
            ["native", "Native, or a validity-proven canonical bridge", 25],
            ["committee-bridge", "Committee or multisig bridge", 10],
            ["custodial", "Custodial", 0],
          ],
        },
        {
          key: "recoverability",
          label: "Recoverability",
          question: "Can users rebuild their private balance and spend without the operator's help?",
          guidance: "Requires that the data needed is available publicly and that the user's keys are sufficient.",
          options: [
            ["yes", "Yes", 25],
            ["no", "No", 0],
          ],
        },
      ],
    },
    {
      key: "pause",
      name: "Pause resistance",
      question: "Can anyone stop the system?",
      description: "Pause functions, chain halts, whether exits survive a pause, and the recent track record.",
      weight: 25,
      highImpact: true,
      notes: ["If core upgrades are instant, “Pause function” scores at most the fast-path option: a power that can be added instantly already exists."],
      criteria: [
        {
          key: "pause-fn",
          label: "Pause function",
          question: "Is there a protocol-level pause?",
          guidance: "Look for pause()/unpause() in core contracts, operator pause powers and chain halt switches.",
          options: [
            ["none", "None exists", 35],
            ["gov-delay", "Only via broad governance with ≥ 7-day delay", 20],
            ["fast-path", "DAO or multisig fast path", 8],
            ["any-single", "Any single operator or entity", 0],
          ],
          hints: ["core contract source", "governance docs", "L2BEAT permissions"],
        },
        {
          key: "halt",
          label: "Halt",
          question: "Can a single party halt block production or ordering?",
          guidance: "For apps on a base layer, judge the host chain.",
          options: [
            ["no", "No", 25],
            ["small-set", "Needs collusion of a small set (≥ 3 independent)", 12],
            ["yes", "Yes", 0],
          ],
        },
        {
          key: "exits-during-pause",
          label: "Exits during a pause",
          question: "Do withdrawals keep working through any pause or halt?",
          guidance: "If no pause or halt is possible, answer yes.",
          options: [
            ["yes", "Yes", 25],
            ["partial", "Partially", 10],
            ["no", "No", 0],
          ],
        },
        {
          key: "track-record",
          label: "Track record",
          question: "Have there been pauses or halts, intentional or outages, in the last 12 months?",
          guidance: "Count protocol or chain-level halts, not individual app outages.",
          options: [
            ["none", "None", 15],
            ["one", "One", 7],
            ["several", "Several", 0],
          ],
        },
      ],
    },
    {
      key: "freeze",
      name: "Freeze & seizure resistance",
      question: "Can anyone freeze or take your funds?",
      description: "Blocklists, forced transfers and burns, and freezes that hit every user at once.",
      weight: 25,
      highImpact: true,
      notes: ["If core upgrades are instant, “Blocklist / freeze” scores at most the hooks option."],
      criteria: [
        {
          key: "blocklist",
          label: "Blocklist / freeze",
          question: "Can the protocol or its native token standard freeze individual users?",
          guidance:
            "Issuer hooks in the native token standard count even if a given issuer hasn't used them. Only the protocol's own blocklist or its native token standard counts here: a third-party token's issuer blacklist (e.g. USDC or USDT held in a pool) is scored under Seizure as issuer-only.",
          options: [
            ["none", "No such capability", 40],
            ["issuer-hooks", "Issuer-controlled hooks exist in the standard", 15],
            ["protocol-wide", "Enforced protocol-wide", 0],
          ],
        },
        {
          key: "seizure",
          label: "Seizure",
          question: "Is forced transfer, burn or clawback possible?",
          guidance: "Distinguish an issuer acting on its own asset from a protocol admin acting on any asset.",
          options: [
            ["impossible", "Impossible", 40],
            ["issuer-only", "Only the issuer, for its own asset", 10],
            ["admin", "A protocol admin can", 0],
          ],
        },
        {
          key: "systemic",
          label: "Systemic freeze",
          question: "Could one blacklist action (e.g. on a pool or escrow contract) freeze every user's balance of an asset?",
          guidance:
            "Pooled custody in one contract usually means yes, including a bridge or portal escrow that backs the system's main assets (an issuer blacklisting the escrow freezes every holder).",
          options: [
            ["no", "No; balances held per user or natively", 20],
            ["yes", "Yes", 0],
          ],
        },
      ],
    },
    {
      key: "exit",
      name: "Exit guarantee",
      question: "Can you leave if things go wrong?",
      description: "Unilateral exit, time to exit before unwanted upgrades, and exits that need no one's permission.",
      weight: 20,
      highImpact: true,
      notes: ["Base layers: unilateral exit means moving funds without permission; forks need node operators to opt in, which counts as ∞."],
      criteria: [
        {
          key: "unilateral",
          label: "Unilateral exit",
          question: "Can users exit with their funds if the operator or governance is hostile or offline?",
          guidance: "Forced withdrawals, escape hatches and ragequit count only if live.",
          options: [
            ["permissionless", "Permissionless and live", 45],
            ["costly", "Exists but bonded, costly or slow", 25],
            ["none", "Planned or none", 0],
          ],
        },
        {
          key: "window",
          label: "Exit window",
          question: "How long do users have to leave before an unwanted upgrade takes effect?",
          guidance:
            "Uses L2BEAT's exit-window scale, measured as L2BEAT does: from when an upgrade is publicly visible onchain (a proposal created or a transaction queued in a timelock) until it can execute, minus the time users need to exit. Voting periods count toward the window.",
          options: [
            ["infinite", "∞ (immutable)", 30],
            ["30d", "≥ 30 days", 26],
            ["7d", "≥ 7 days", 18],
            ["short", "< 7 days", 6],
            ["none", "None / instant", 0],
          ],
        },
        {
          key: "gatekeeper",
          label: "No gatekeeper",
          question: "Does exiting need permission or cooperation from anyone (decryption committee, approval list, operator signature)?",
          guidance:
            "If a public exit always works but the private exit can be gated, choose the middle option. The walkaway test still passes then, with a note.",
          options: [
            ["none", "None needed", 25],
            ["private-gated", "Public exit always works; private exit gated", 12],
            ["can-refuse", "A party can refuse", 0],
          ],
        },
      ],
    },
    {
      key: "access",
      name: "Permissionless access",
      question: "Can anyone use it?",
      description: "Entry, private exit and how any compliance screening works.",
      weight: 10,
      criteria: [
        {
          key: "entry",
          label: "Entry",
          question: "Can anyone enter the private system?",
          guidance:
            "Judge the deposit itself. Screened: the protocol or the reference client can refuse to accept a deposit (address screening, geoblocking, a sanctions oracle). If every deposit is accepted but its private spend or exit can later be gated (association sets, proofs of innocence), answer Yes here; the gate is scored under Private exit.",
          options: [
            ["open", "Yes", 40],
            ["screened", "Screening can refuse deposits", 20],
            ["allowlist", "Allowlist or KYC", 0],
          ],
        },
        {
          key: "private-exit",
          label: "Private exit or spend",
          question: "Can a third party deny a user's private exit or spend?",
          guidance: "A public fallback (e.g. withdrawing publicly to the original depositor) is the middle option.",
          options: [
            ["no-gate", "No gate", 40],
            ["gate-fallback", "Gate, but a public fallback exists", 20],
            ["gate", "Gate with no fallback", 0],
          ],
        },
        {
          key: "screening",
          label: "Screening method",
          question: "If there is compliance screening, how does it work?",
          guidance: "User-generated zero-knowledge proofs don't disclose to a screener.",
          options: [
            ["none-or-zk", "None, or user-generated ZK proofs", 20],
            ["address-screening", "Third-party screening of public addresses", 10],
            ["identity", "Identity disclosure", 0],
          ],
        },
      ],
    },
  ],
});

// ---------- Suite 4 · Programmability ----------

const programmability = suite({
  id: "programmability",
  name: "Programmability",
  shortName: "Programmability",
  tagline: "What you can build privately",
  description:
    "Contracts, composition, mixing public and private state, privacy with disclosure, and whether building and using it is practical. What leaks during execution is scored under Privacy coverage.",
  weight: 12,
  adversaries: [],
  benchmarks: [
    {
      key: "contracts",
      name: "Smart contracts",
      question: "Can developers deploy their own private programs?",
      description: "Contract model, permissionless deployment, private standards and programmable accounts.",
      weight: 20,
      criteria: [
        {
          key: "model",
          label: "Contract model",
          question: "What kind of contracts can developers write?",
          guidance: "Confidential-values-only means public logic over encrypted values.",
          options: [
            ["general-hybrid", "General-purpose contracts with both private and public functions", 35],
            ["general-single", "General-purpose, but public-only or confidential-values-only", 20],
            ["fixed", "Fixed-function private actions (transfers, swaps)", 8],
            ["none", "None", 0],
          ],
        },
        {
          key: "deployment",
          label: "Permissionless deployment",
          question: "Can anyone deploy contracts?",
          guidance: "Allowlisted deployers or operator-approved apps are the middle option.",
          options: [
            ["open", "Yes", 25],
            ["allowlisted", "Allowlisted deployers", 10],
            ["none", "No third-party deployment", 0],
          ],
        },
        {
          key: "standards",
          label: "Private standards",
          question: "Are there standard interfaces for private tokens, NFTs and accounts?",
          guidance: "Established means used by several independent apps.",
          options: [
            ["established", "Established, widely used", 20],
            ["emerging", "Emerging or draft", 10],
            ["none", "None", 0],
          ],
        },
        {
          key: "accounts",
          label: "Programmable accounts",
          question: "Is there native account abstraction (custom auth, recovery, fee sponsorship)?",
          guidance: "Via contracts means smart-account patterns on top of externally owned accounts.",
          options: [
            ["native", "Native", 20],
            ["contracts", "Via contracts", 10],
            ["none", "None", 0],
          ],
        },
      ],
    },
    {
      key: "composability",
      name: "Composability",
      question: "Do private apps plug into each other and into public liquidity?",
      description: "Atomic private-to-private and private-to-public calls, access to existing liquidity, and cross-domain messaging.",
      weight: 20,
      criteria: [
        {
          key: "private-private",
          label: "Private ↔ private",
          question: "Can private functions of different contracts call each other atomically in one transaction?",
          guidance: "Limited means only fixed adapters or a single level of calls.",
          options: [
            ["arbitrary", "Arbitrary", 30],
            ["limited", "Limited", 12],
            ["no", "No", 0],
          ],
        },
        {
          key: "private-public",
          label: "Private ↔ public",
          question: "Can private and public logic compose atomically in one transaction?",
          guidance: "Adapter flows that unshield, call and reshield inside one transaction are the third option.",
          options: [
            ["both", "Both directions", 30],
            ["one", "One direction (e.g. private enqueues public)", 18],
            ["exit-reenter", "Only through an adapter that exits, calls and re-enters privacy inside one transaction", 8],
            ["no", "No: using public apps needs a separate withdrawal", 0],
          ],
        },
        {
          key: "liquidity",
          label: "Liquidity access",
          question: "Can private users reach existing public DeFi (AMMs, lending) without leaving privacy?",
          guidance: "Through adapters or bridges is the middle option.",
          options: [
            ["native", "Broad native access", 20],
            ["adapters", "Through adapters or bridges", 10],
            ["no", "No", 0],
          ],
        },
        {
          key: "cross-domain",
          label: "Cross-domain messaging",
          question: "Can private contracts send and receive messages to and from other chains?",
          guidance: "Trust-minimized means canonical messaging secured by proofs or the host chain.",
          options: [
            ["trust-minimized", "Trust-minimized, from private context", 20],
            ["public-legs", "Via bridges with public legs", 10],
            ["none", "None", 0],
          ],
        },
      ],
    },
    {
      key: "blending",
      name: "Public/private blending",
      question: "Can one app mix public and private state sensibly?",
      description: "Granularity of the public/private choice, private reads of public state, and moving values across.",
      weight: 15,
      criteria: [
        {
          key: "granularity",
          label: "Granularity of choice",
          question: "Can developers choose private or public per function or state variable?",
          guidance: "Per contract or per asset is the middle option.",
          options: [
            ["per-function", "Per function or variable", 35],
            ["per-contract", "Per contract or per asset", 15],
            ["none", "No choice", 0],
          ],
        },
        {
          key: "private-reads",
          label: "Reading public state privately",
          question: "Can private logic read public state (prices, config) without leaking what it read?",
          guidance: "Staleness windows or leaking which state was read are the middle option.",
          options: [
            ["consistent", "Yes, with consistency guarantees", 35],
            ["constrained", "With leakage or staleness constraints", 15],
            ["no", "No", 0],
          ],
        },
        {
          key: "crossing",
          label: "Moving state across",
          question: "Can values move between public and private state within the system atomically?",
          guidance: "Separate shield/unshield steps are the middle option.",
          options: [
            ["atomic", "Native, atomic", 30],
            ["steps", "Via shield/unshield steps", 15],
            ["no", "No", 0],
          ],
        },
      ],
    },
    {
      key: "disclosure",
      name: "Programmable disclosure",
      question: "Can apps offer privacy with disclosure, without a backdoor?",
      description:
        "Primitives for app-level disclosure, private compliance proofs and verifiable disclosure. User-side controls are scored under Trust → Disclosure control.",
      weight: 20,
      criteria: [
        {
          key: "primitives",
          label: "Disclosure primitives",
          question:
            "Does the protocol give apps primitives to implement disclosure (per-app viewing keys, encrypted logs to designated recipients, disclosure proofs)?",
          guidance:
            "A single fixed mechanism, such as one account-wide viewing key, is the middle option. A compliance proof required by the protocol flow is scored under Compliance proofs; it counts here only if users or apps can use it to disclose to parties they choose.",
          options: [
            ["native", "Native", 35],
            ["limited", "Limited or fixed mechanism", 15],
            ["none", "None", 0],
          ],
        },
        {
          key: "compliance-proofs",
          label: "Private compliance proofs",
          question:
            "Can users prove compliance statements (association-set membership, not sanctioned, credential attributes) without revealing identity or history?",
          guidance:
            "App-specific means one app on a platform offers it but other apps can't use it. For a single-application protocol (a pool), a compliance proof that every user produces in the protocol's normal flow is Native.",
          options: [
            ["native", "Native or widely supported", 35],
            ["app-specific", "App-specific", 15],
            ["none", "None", 0],
          ],
        },
        {
          key: "verifiable",
          label: "Verifiable disclosure",
          question: "Does disclosed data come with proofs that it is complete and correct?",
          guidance: "Handing over decrypted plaintext without a proof is the middle option.",
          options: [
            ["proven", "Yes", 30],
            ["plaintext", "Disclosed plaintext without proof", 10],
            ["none", "No disclosure mechanism", 0],
          ],
        },
      ],
    },
    {
      key: "developer",
      name: "Developer experience",
      question: "Can teams realistically build on it?",
      description: "Language and toolchain, local development, SDKs and wallets, and familiarity.",
      weight: 10,
      criteria: [
        {
          key: "toolchain",
          label: "Language & toolchain",
          question: "How mature is the language and toolchain for private contracts?",
          guidance: "Frequent breaking releases put a toolchain in the middle option.",
          options: [
            ["stable", "Stable, documented, with testing framework and debugger", 35],
            ["breaking", "Usable but frequently breaking", 20],
            ["experimental", "Experimental", 8],
            ["none", "None", 0],
          ],
        },
        {
          key: "local-dev",
          label: "Local development",
          question: "Is there a local network or sandbox with test tooling?",
          guidance: "Partial means some pieces are missing, e.g. no local prover, or the local network can't run the private features end to end.",
          options: [
            ["full", "Full", 25],
            ["partial", "Partial", 12],
            ["none", "None", 0],
          ],
        },
        {
          key: "sdks",
          label: "SDKs & wallets",
          question: "Are there client SDKs and wallets supporting private apps?",
          guidance:
            "Count independent wallets that support the private features in a released version as of the evaluation date. Announced or in-development integrations don't count.",
          options: [
            ["mature", "Mature SDKs, multiple wallets", 20],
            ["one", "One SDK or wallet", 10],
            ["none", "None", 0],
          ],
        },
        {
          key: "familiarity",
          label: "Familiarity",
          question: "Does it build on widely used languages or tooling?",
          guidance: "Domain-specific languages with mainstream syntax are the middle option.",
          options: [
            ["mainstream", "Mainstream languages or EVM tooling", 20],
            ["dsl", "Domain-specific but approachable", 10],
            ["bespoke", "Low-level or bespoke only", 0],
          ],
        },
      ],
    },
    {
      key: "performance",
      name: "Performance & cost",
      question: "Is private usage practical?",
      description: "Client proving time, throughput and the all-in cost of a private transfer.",
      weight: 15,
      criteria: [
        {
          key: "proving-time",
          label: "Client proving time",
          question: "How long does a private transfer take to prove on a consumer laptop with the reference client?",
          guidance: "Use N/A when users don't generate proofs. When a logged search finds no published figure, the answer is No published figure.",
          naAllowed: true,
          noData: "unknown",
          options: [
            ["fast", "≤ 5 s", 35],
            ["moderate", "≤ 30 s", 20],
            ["slow", "> 30 s", 5],
            ["unknown", "No published figure", 0],
          ],
        },
        {
          key: "throughput",
          label: "Throughput",
          question: "What sustained private-transaction throughput does the live system handle?",
          guidance: "Use measured or documented sustained throughput, not theoretical peaks.",
          options: [
            ["100", "≥ 100 TPS", 35],
            ["10", "≥ 10 TPS", 22],
            ["1", "≥ 1 TPS", 10],
            ["low", "< 1 TPS or unknown", 0],
          ],
        },
        {
          key: "cost",
          label: "Cost",
          question: "What is the typical all-in cost of a private $1,000 transfer, including percentage fees?",
          guidance: "Use the primary deployment and current gas prices.",
          options: [
            ["cents", "< $0.10", 30],
            ["low", "< $1", 20],
            ["moderate", "< $10", 10],
            ["high", "≥ $10", 0],
          ],
        },
      ],
    },
  ],
});

// ---------- Suite 5 · Governance & admin keys ----------

const governance = suite({
  id: "governance",
  name: "Governance & admin keys",
  shortName: "Governance",
  tagline: "Who can change the rules",
  description: "Upgrade powers, privileged roles and who ultimately controls the protocol.",
  weight: 10,
  adversaries: ["privileged_insider"],
  benchmarks: [
    {
      key: "upgrades",
      name: "Upgrade control",
      question: "Who can change the code under your funds, and how fast?",
      description: "Upgradeability and delays, emergency paths, and control over verification keys.",
      weight: 40,
      highImpact: true,
      notes: [
        "Judge upgrade paths by what they can damage: only upgrades that can touch user funds or privacy count here. Peripheral powers belong under Privileged roles.",
      ],
      criteria: [
        {
          key: "upgradeability",
          label: "Upgradeability",
          question: "Can the core contracts or protocol be upgraded, and with what delay?",
          guidance:
            "Immutable pools behind an instantly upgradeable entrypoint score on the entrypoint's worst-case effect on funds and privacy. Delays run from when the upgrade is publicly visible onchain until it can execute, with voting periods counted (unlike the exit window, the time users need to exit isn't subtracted).",
          options: [
            ["immutable", "Immutable; changes only via new versions users opt into", 50],
            ["30d", "Upgradeable with ≥ 30-day delay", 38],
            ["7d", "≥ 7-day delay", 25],
            ["short", "< 7-day delay", 10],
            ["instant", "Instant", 0],
          ],
        },
        {
          key: "emergency",
          label: "Emergency path",
          question: "Can a security council or multisig bypass the delay?",
          guidance: "L2BEAT's standard: ≥ 8 members, ≥ 75% threshold, ≥ half external, publicly named.",
          options: [
            ["none", "None", 25],
            ["standard-council", "Council meeting L2BEAT's standard", 15],
            ["small-multisig", "Smaller or undisclosed multisig", 5],
            ["single", "Single entity", 0],
          ],
        },
        {
          key: "verifier",
          label: "Verifier control",
          question: "Do verification keys and circuits change only through the same delay?",
          guidance:
            "Same delay: keys can be staged by anyone, but only take effect through the same delayed process (or the verifier is immutable). Faster: a party can activate, swap or delete keys without going through that delay.",
          options: [
            ["same", "Same delay or immutable", 25],
            ["faster", "A privileged party can change them faster", 5],
            ["unrestricted", "Unrestricted", 0],
          ],
        },
      ],
    },
    {
      key: "roles",
      name: "Privileged roles",
      question: "Who holds special powers, and are they visible?",
      description: "Scope of privileged roles, who holds them and how transparent they are.",
      weight: 35,
      highImpact: true,
      criteria: [
        {
          key: "scope",
          label: "Role scope",
          question: "What can privileged roles (fee setting, pausing, key admin, allowlists, auditors) do?",
          guidance:
            "Roles that can affect funds or privacy are the third option. Powers exercised only by the same onchain governance that controls upgrades count as None beyond upgrade governance. A role that can only stage changes governance must later activate is Limited.",
          options: [
            ["none", "None beyond upgrade governance", 40],
            ["limited", "Limited; can't touch funds or privacy (e.g. fee parameters)", 25],
            ["funds-or-privacy", "Roles can affect funds or privacy", 5],
            ["broad", "Broad", 0],
          ],
        },
        {
          key: "holders",
          label: "Role holders",
          question: "Who holds privileged roles?",
          guidance:
            "Independent signers means not all from the same company. Powers exercised only by the onchain governance that controls upgrades count as onchain token governance.",
          options: [
            ["none-or-onchain", "No roles, or onchain token governance", 35],
            ["multisig-5", "Multisig ≥ 5 with independent signers", 25],
            ["multisig-small", "Multisig < 5", 10],
            ["single", "A single company or key", 0],
          ],
        },
        {
          key: "transparency",
          label: "Transparency",
          question: "Are role holders and signers named, and are role changes onchain and delayed?",
          guidance:
            "Full: every holder and signer is named and every role change is onchain and delayed. Partial: holders are identifiable as a named organisation (even with anonymous multisig signers), or changes are onchain but instant. No: holders are anonymous keys and changes are instant or off-chain.",
          options: [
            ["full", "Fully", 25],
            ["partial", "Partially", 12],
            ["no", "No", 0],
          ],
        },
      ],
    },
    {
      key: "process",
      name: "Governance",
      question: "Who ultimately decides?",
      description: "Ultimate control of protocol changes, the process and concentration of power.",
      weight: 25,
      criteria: [
        {
          key: "control",
          label: "Ultimate control",
          question: "Who ultimately controls protocol changes?",
          guidance: "Base layers where forks need node operators to opt in count as broad social consensus.",
          options: [
            ["none-or-social", "No one (immutable) or broad social consensus", 40],
            ["token", "Token governance with real quorum and no dominant holder", 30],
            ["foundation", "Foundation or company with community input", 10],
            ["company", "A single company", 0],
          ],
        },
        {
          key: "public-process",
          label: "Process",
          question: "Are decisions public proposals executed onchain?",
          guidance: "Off-chain but public (forum plus multisig execution) is the middle option.",
          options: [
            ["onchain", "Yes", 30],
            ["offchain-public", "Off-chain but public", 15],
            ["opaque", "Opaque", 0],
          ],
        },
        {
          key: "concentration",
          label: "Concentration",
          question: "Can any single entity pass a proposal alone?",
          guidance:
            "Consider token distribution, delegate concentration and default votes. When a logged search finds no distribution or voting data, the answer is Unclear.",
          noData: "unclear",
          options: [
            ["no", "No", 30],
            ["unclear", "Unclear", 10],
            ["yes", "Yes", 0],
          ],
        },
      ],
    },
  ],
});

// ---------- Suite 6 · Decentralization ----------

const decentralization = suite({
  id: "decentralization",
  name: "Decentralization",
  shortName: "Decentralization",
  tagline: "Who runs it",
  description: "Who produces blocks, whether transactions can be censored, who proves, and where state settles.",
  weight: 10,
  adversaries: ["privileged_insider"],
  benchmarks: [
    {
      key: "operators",
      name: "Block production",
      question: "How many independent parties produce blocks?",
      description: "Producer count, open entry and concentration.",
      weight: 30,
      notes: ["Privacy apps on a base layer inherit the host chain's block production."],
      criteria: [
        {
          key: "producers",
          label: "Producers",
          question: "How many independent block producers or sequencers are there?",
          guidance: "Count independent operators, not keys.",
          options: [
            ["permissionless-100", "Permissionless and > 100", 40],
            ["permissionless", "Permissionless, fewer", 30],
            ["permissioned-10", "Permissioned ≥ 10", 15],
            ["permissioned-few", "Permissioned 2–9", 6],
            ["single", "Single", 0],
          ],
        },
        {
          key: "entry",
          label: "Open entry",
          question: "Can anyone meeting objective criteria (e.g. stake) become a producer?",
          guidance: "Planned openness doesn't count.",
          options: [
            ["yes", "Yes", 30],
            ["no", "No", 0],
          ],
        },
        {
          key: "concentration",
          label: "Concentration",
          question: "Does any single entity or client control more than a third of production?",
          guidance: "Consider builders, operators and client software. When a logged search finds no data on who produces, the answer is Unclear.",
          noData: "unclear",
          options: [
            ["no", "No", 30],
            ["unclear", "Unclear", 10],
            ["yes", "Yes", 0],
          ],
        },
      ],
    },
    {
      key: "censorship",
      name: "Censorship resistance",
      question: "Can someone keep your transaction out?",
      description: "Forced inclusion, observed censorship and whether private transactions can be singled out.",
      weight: 30,
      highImpact: true,
      criteria: [
        {
          key: "forced-inclusion",
          label: "Forced inclusion",
          question: "Can users force inclusion of their transaction?",
          guidance: "Probabilistic inclusion through many independent producers is the second option.",
          options: [
            ["bounded", "Protocol-enforced with bounded delay", 50],
            ["probabilistic", "Probabilistic, via many independent producers", 30],
            ["escape-hatch", "Only through an escape hatch or bond", 15],
            ["none", "None", 0],
          ],
        },
        {
          key: "observed",
          label: "Observed censorship",
          question: "What share of blocks censor transactions?",
          guidance: "Use the most recent figure from a public censorship dashboard, dated on or before the evaluation date. Without one the answer is unknown.",
          options: [
            ["low", "< 10%", 25],
            ["medium", "10–50%", 12],
            ["high", "> 50%, or known censorship", 0],
          ],
        },
        {
          key: "indistinguishable",
          label: "Indistinguishable private txs",
          question: "Can producers tell whose, or what, a private transaction is?",
          guidance:
            "If they can't, private transactions can't be singled out for censorship. Partial: producers can tell a transaction uses the private system but not whose it is or what it does.",
          options: [
            ["yes", "They can't; private txs are indistinguishable", 25],
            ["partial", "Partially", 12],
            ["no", "They can", 0],
          ],
        },
      ],
    },
    {
      key: "proving",
      name: "Proving & verification",
      question: "Who proves, and who checks?",
      description: "Client-side proving, prover decentralization and how validity is verified.",
      weight: 20,
      criteria: [
        {
          key: "client-side",
          label: "Client-side proving",
          question: "Are private proofs generated on users' devices by default?",
          guidance: "Check the reference wallets' default mode.",
          options: [
            ["yes", "Yes", 40],
            ["optional", "Optional", 15],
            ["no", "No", 0],
          ],
        },
        {
          key: "provers",
          label: "Provers",
          question: "Who does block or rollup proving?",
          guidance: "Answer “not needed” for systems whose validity is checked by the host chain directly.",
          options: [
            ["permissionless", "Permissionless, or not needed", 30],
            ["permissioned-several", "Permissioned, several", 12],
            ["single", "Single entity", 0],
          ],
        },
        {
          key: "verification",
          label: "Verification",
          question: "How is validity verified?",
          guidance: "Honest-majority committees and re-execution by known parties are the fourth option.",
          options: [
            ["validity", "Validity proofs checked onchain, or L1 consensus", 30],
            ["fraud", "Fraud proofs", 20],
            ["committee", "Committee or honest majority", 8],
            ["trusted", "Trusted operator", 0],
          ],
        },
      ],
    },
    {
      key: "settlement",
      name: "Settlement & data",
      question: "Where does your state live?",
      description: "Settlement layer and data availability.",
      weight: 20,
      criteria: [
        {
          key: "settlement",
          label: "Settlement",
          question: "Where is state settled?",
          guidance: "Base layers settle on their own consensus.",
          options: [
            ["l1-validity", "L1 consensus, or Ethereum with validity proofs", 50],
            ["committee", "Committee or partial proofs", 20],
            ["operator", "Operator attestations", 0],
          ],
        },
        {
          key: "data",
          label: "Data availability",
          question: "Where is the data needed to reconstruct state published?",
          guidance: "Onchain or L1 blobs are the top option.",
          options: [
            ["onchain", "Onchain or L1 DA", 50],
            ["committee", "Committee or external DA", 20],
            ["operator", "Operator only", 0],
          ],
        },
      ],
    },
  ],
});

// ---------- Suite 7 · Security & maturity ----------

const security = suite({
  id: "security",
  name: "Security & maturity",
  shortName: "Security",
  tagline: "Does it hold up",
  description: "Soundness record, assurance, and how long the system has run in production.",
  weight: 10,
  adversaries: [],
  benchmarks: [
    {
      key: "soundness",
      name: "Soundness record",
      question: "Has the cryptography held?",
      description: "Open critical issues, recent history and defense in depth.",
      weight: 40,
      criteria: [
        {
          key: "open-critical",
          label: "Open critical issues",
          question: "Is there a known, unpatched critical vulnerability?",
          guidance:
            "Operational mitigations (caps, pauses of specific features) are the middle option. A bug patched in code that leaves funds at risk until users act (migrate, rotate keys) is Mitigated until the exposure is negligible. Bugs in the reference client and official SDK that could lose user funds or expose users count.",
          options: [
            ["none", "None", 40],
            ["mitigated", "Disclosed, mitigated operationally", 15],
            ["unpatched", "Disclosed and unpatched", 0],
          ],
        },
        {
          key: "history",
          label: "History",
          question: "How many critical vulnerabilities or exploits in the last 24 months?",
          guidance:
            "Count issues in the evaluated system and its direct predecessors run by the same team, including the reference client and official SDK: a bug in them that could lose user funds or expose users counts. Only a dated statement from a source that tracks incidents establishes None.",
          options: [
            ["none", "None", 30],
            ["one", "One, handled transparently", 15],
            ["several", "Several", 0],
          ],
        },
        {
          key: "defense-in-depth",
          label: "Defense in depth",
          question: "Are there layers of defense against proof or crypto bugs (multiple provers, re-execution, caps, delayed withdrawals)?",
          guidance:
            "Count distinct live mechanisms that act within hours without a governance vote: multiple provers, re-execution, caps or rate limits, delayed withdrawals, a guardian pause.",
          options: [
            ["several", "Several layers", 30],
            ["one", "One", 15],
            ["none", "None", 0],
          ],
        },
      ],
    },
    {
      key: "assurance",
      name: "Assurance",
      question: "Can outsiders check it?",
      description: "Open source, reproducibility, audits, formal verification and bug bounties.",
      weight: 30,
      criteria: [
        {
          key: "open-source",
          label: "Open source",
          question: "Are the protocol, circuits and default client open source under an OSI license?",
          guidance: "Source-available licenses don't count.",
          options: [
            ["all", "All, OSI license", 25],
            ["partial", "Partial", 12],
            ["closed", "Closed or source-available only", 0],
          ],
        },
        {
          key: "reproducibility",
          label: "Reproducibility",
          question: "Is prover source published, can verifier contracts and circuit hashes be regenerated, and are deployed contracts verified?",
          guidance:
            "Use Sourcify or Etherscan verification status plus build documentation. Partial: deployed contracts are verified but circuits or verifier keys can't be regenerated from published sources, or the reverse.",
          options: [
            ["full", "Fully", 20],
            ["partial", "Partially", 10],
            ["no", "No", 0],
          ],
        },
        {
          key: "audits",
          label: "Audits",
          question: "Has the live version been audited independently?",
          guidance: "Audits of earlier versions count only if the audited code is what's live.",
          options: [
            ["several", "Several reputable", 25],
            ["one", "One", 15],
            ["none", "Outdated or none", 0],
          ],
        },
        {
          key: "formal-verification",
          label: "Formal verification",
          question: "Are core contracts or circuits formally verified?",
          guidance:
            "Published machine-checked proofs count. Partial: proofs cover some core components (one circuit, one contract) but not the parts that hold funds or protect privacy.",
          options: [
            ["yes", "Yes", 15],
            ["partial", "Partial", 8],
            ["no", "No", 0],
          ],
        },
        {
          key: "bounty",
          label: "Bug bounty",
          question: "Is there a public bug bounty, and how large?",
          guidance:
            'Use the maximum payout for critical findings. A public bounty is a published program with a stated maximum payout; a discretionary "we may reward" policy is None.',
          options: [
            ["1m", "≥ $1M", 15],
            ["smaller", "Smaller", 8],
            ["none", "None", 0],
          ],
        },
      ],
    },
    {
      key: "maturity",
      name: "Production maturity",
      question: "How battle-tested is it?",
      description: "Status, time in production and continuity across upgrades.",
      weight: 30,
      criteria: [
        {
          key: "status",
          label: "Status",
          question: "What is the system's production status?",
          guidance: "Alpha or beta labels on mainnet are the second option.",
          options: [
            ["mainnet", "Mainnet, no training wheels", 40],
            ["mainnet-alpha", "Mainnet alpha or beta", 20],
            ["testnet", "Testnet", 5],
            ["not-live", "Not live", 0],
          ],
        },
        {
          key: "age",
          label: "Time in production",
          question: "How long have the privacy features been live in production?",
          guidance: "Count from mainnet availability of the privacy features to the evaluation date.",
          options: [
            ["3y", "≥ 3 years", 30],
            ["1y", "≥ 1 year", 20],
            ["3m", "≥ 3 months", 10],
            ["new", "< 3 months, or not live", 0],
          ],
        },
        {
          key: "continuity",
          label: "Continuity",
          question: "Have upgrades forced users to migrate funds or state?",
          guidance:
            "Deprecations that required withdraw-and-redeposit count as forced migrations, and so does a migration users had to perform to stay safe after a security bug.",
          options: [
            ["never", "Never", 30],
            ["once", "Once", 15],
            ["repeatedly", "Repeatedly", 0],
          ],
        },
      ],
    },
  ],
});

export const rubric: Rubric = {
  version: RUBRIC_VERSION,
  releasedAt: "2026-10-01",
  suites: [coverage, trust, custody, programmability, governance, decentralization, security],
  presets: [
    {
      id: "balanced",
      name: "Balanced",
      description: "The official weighting.",
      official: true,
      weights: { coverage: 24, trust: 16, custody: 18, programmability: 12, governance: 10, decentralization: 10, security: 10 },
    },
    {
      id: "privacy-first",
      name: "Privacy-first",
      description: "Weights what's hidden and who can see above everything else.",
      official: false,
      weights: { coverage: 36, trust: 24, custody: 14, programmability: 8, governance: 6, decentralization: 5, security: 7 },
    },
    {
      id: "sovereignty-first",
      name: "Sovereignty-first",
      description: "Weights custody, governance and decentralization above privacy features.",
      official: false,
      weights: { coverage: 14, trust: 10, custody: 28, programmability: 6, governance: 18, decentralization: 16, security: 8 },
    },
    {
      id: "builder",
      name: "Builder",
      description: "Weights what developers can build privately: contracts, composability and disclosure.",
      official: false,
      weights: { coverage: 18, trust: 12, custody: 14, programmability: 34, governance: 7, decentralization: 7, security: 8 },
    },
  ],
};

// ---------- lookups ----------

export const suites = rubric.suites;
export const benchmarks: BenchmarkDef[] = suites.flatMap((s) => s.benchmarks);
export const criteria: CriterionDef[] = benchmarks.flatMap((b) => b.criteria);

const suiteById = new Map(suites.map((s) => [s.id, s]));
const benchmarkById = new Map(benchmarks.map((b) => [b.id, b]));
const criterionById = new Map(criteria.map((c) => [c.id, c]));

export function getSuite(id: SuiteId): SuiteDef {
  const s = suiteById.get(id);
  if (!s) throw new Error(`Unknown suite ${id}`);
  return s;
}

export function getBenchmark(id: string): BenchmarkDef {
  const b = benchmarkById.get(id);
  if (!b) throw new Error(`Unknown benchmark ${id}`);
  return b;
}

export function getCriterion(id: string): CriterionDef {
  const c = criterionById.get(id);
  if (!c) throw new Error(`Unknown criterion ${id}`);
  return c;
}

export function findCriterion(id: string): CriterionDef | undefined {
  return criterionById.get(id);
}

export function maxPoints(c: CriterionDef): number {
  return Math.max(...c.options.map((o) => o.points));
}

export function lowestOption(c: CriterionDef): OptionDef {
  return c.options.reduce((lo, o) => (o.points < lo.points ? o : lo));
}

/** Favorable = strictly more than half of the criterion's maximum points. */
export function isFavorable(c: CriterionDef, optionId: string): boolean {
  const opt = c.options.find((o) => o.id === optionId);
  return !!opt && opt.points > maxPoints(c) / 2;
}
