import { readFileSync } from "node:fs";
import { getContractAddress } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { expandLinks } from "../src/lib/externals.ts";
import type { SourcifyContract } from "../src/lib/sourcify.ts";
import {
  extractAddresses,
  extractFromDeploymentJson,
  groupVerifiedSources,
  mergeAddresses,
  THIRD_PARTY_CONTRACTS,
  thirdPartyContract,
} from "../src/services/lanes/addresses.ts";
import {
  anchoredToProject,
  auditCutoff,
  containment,
  findDate,
  groupReports,
  INDUSTRY_REPORT,
  isListingPage,
  looksLikeAudit,
  oldAuditsToDrop,
  parseAuditMeta,
  type ReportCopy,
  shingles,
} from "../src/services/lanes/audits.ts";
import { closestSlug, digestDiscovered, hostChainSlug, matchHacks, templateNote } from "../src/services/lanes/data.ts";
import { MAX_TOPIC_CHARS, rankTopics, SKIP_CATEGORY, topicIdFromUrl } from "../src/services/lanes/forum.ts";
import { cryptoTerms, newsRelevance, normalizeTitle, PRICE_CHATTER } from "../src/services/lanes/news.ts";
import { acceptCandidate, guessHandles, monthOf, parseStoredPosts } from "../src/services/lanes/x.ts";

describe("news relevance (SRC-5)", () => {
  const filler = "Lorem ipsum dolor sit amet. ".repeat(30);

  it("no longer passes 'definitely' as DeFi context", () => {
    const ace = {
      title: "Ace Combat 7 review: Railgun mode is definitely the best addition",
      text: `${filler} The Railgun is definitely fun, and the campaign will define the genre. Railgun upgrades are a deficit fix.`,
      url: "https://games.example.com/ace-combat",
      source: "Games Weekly",
    };
    expect(newsRelevance(ace, ["Railgun"])).toMatchObject({ ok: false, reason: "no crypto context near a mention" });
  });

  it("accepts articles that name the project near crypto terms", () => {
    const real = {
      title: "Railgun DAO votes on new relayer fees",
      text: "The Railgun privacy system on Ethereum shields ERC-20 tokens. Holders voted on smart contract upgrades.",
      url: "https://www.theblock.co/post/1",
      source: "The Block",
    };
    expect(newsRelevance(real, ["Railgun", "RAILGUN"]).ok).toBe(true);
  });

  it("needs the name in the title or twice in the text", () => {
    expect(
      newsRelevance({ title: "Weekly crypto roundup", text: `${filler} Ethereum privacy, including Aztec, grew.`, url: "https://n.example/1" }, ["Aztec"]).ok,
    ).toBe(false);
    expect(
      newsRelevance(
        {
          title: "Weekly crypto roundup",
          text: "Aztec launched its Ethereum rollup. Separately, Aztec Labs raised funds for zero-knowledge research.",
          url: "https://n.example/2",
        },
        ["Aztec"],
      ).ok,
    ).toBe(true);
  });

  it("drops casino spam and publishers named like the project", () => {
    const casino = {
      title: "Aztec Gold slots: best crypto casino bonus",
      text: "Play Aztec Gold at this Bitcoin casino with free spins.",
      url: "https://spam.example/1",
    };
    expect(newsRelevance(casino, ["Aztec"]).ok).toBe(false);
    const tempoCo = {
      title: "Tempo blockchain partners with local bank",
      text: "Tempo said the stablecoin pilot runs on its blockchain. Tempo also covered the elections.",
      url: "https://en.tempo.co/read/1",
      source: "TEMPO.CO",
    };
    expect(newsRelevance(tempoCo, ["Tempo"])).toMatchObject({ ok: false, reason: "publisher shares the project's name" });
    const lowercase = {
      title: "Markets keep their tempo",
      text: "The tempo of crypto trading on Ethereum slowed; tempo matters for blockchain.",
      url: "https://n.example/3",
    };
    expect(newsRelevance(lowercase, ["Tempo"]).ok).toBe(false);
  });

  it("normalizes syndicated titles", () => {
    expect(normalizeTitle("Citrea partners with Privacy Pools - Crypto Daily")).toBe(normalizeTitle("Citrea Partners With Privacy Pools | CoinNews"));
  });
});

describe("L2BEAT and DefiLlama (SRC-10)", () => {
  const discovered = JSON.parse(readFileSync(new URL("./fixtures/l2beat-discovered.json", import.meta.url), "utf8"));

  it("digests discovered.json into contracts, proxies, admins, Safes, roles and permissions", () => {
    const { markdown, contracts } = digestDiscovered(discovered);
    const entry = contracts.find((c) => c.name === "PrivacyPoolsEntrypoint")!;
    expect(entry).toMatchObject({
      chainId: 1,
      address: "0x6818809EefCe719E480a7526D76bD3e561526b46",
      proxyType: "EIP1967 proxy",
      implementation: "0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c",
      critical: true,
    });
    const safe = contracts.find((c) => c.name === "Privacy Pools Multisig")!;
    expect(safe.safe).toEqual({ threshold: 2, members: 4 });
    expect(markdown).toContain("## PrivacyPoolsEntrypoint · eth:0x6818809EefCe719E480a7526D76bD3e561526b46");
    expect(markdown).toContain("- Implementation: Entrypoint 0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c");
    expect(markdown).toContain("- Upgrades: 2 (last 2025-05-22)");
    expect(markdown).toContain("- Role OWNER_ROLE (admin role OWNER_ROLE): Privacy Pools Multisig 0xAd7f9A19E2598b6eFE0A25C84FB1c87F81eB7159");
    expect(markdown).toContain("- Safe: threshold 2 of 4 signers (2 of 4 (50%))");
    expect(markdown).toContain(
      "- Can authorize UUPS upgrades to the Entrypoint implementation. on PrivacyPoolsEntrypoint 0x6818809EefCe719E480a7526D76bD3e561526b46",
    );
    // The zero proxy admin isn't reported as an admin; unnamed EOAs without permissions are omitted.
    expect(markdown).not.toContain("Proxy admin: none");
    expect(markdown).not.toContain("0xb1A1D5b0f3d4E8e89E55daBFEb0B96118cbc16fc ·");
    expect(markdown).toContain("## EOA · eth:0x1f4Fe25Cf802a0605229e0Dc497aAf653E86E187");
  });

  it("suggests the closest L2BEAT folder for a wrong slug", () => {
    const folders = ["zama-cw", "aztecnetwork", "privacy-pools", "railgun", "zksync2", "zkspace"];
    expect(closestSlug("zama-confidential-tokens", folders)).toBe("zama-cw");
    expect(closestSlug("aztec", folders, ["aztec"])).toBe("aztecnetwork");
    expect(closestSlug("nothing-like-it", ["railgun"])).toBeNull();
  });

  it("matches hacks by DefiLlama id, parent, or the name as a whole word", () => {
    const hacks = [
      { date: 1781395200, name: "Aztec Connect", defillamaId: "1016" },
      { date: 1781654400, name: "Aztec Bridge", defillamaId: null },
      { date: 1739232000, name: "zkLend", defillamaId: "3079", parentProtocolId: "parent#zklend-finance" },
      { date: 1700000000, name: "Aztecoin Swap", defillamaId: null },
    ];
    expect(matchHacks(hacks, { aliases: ["Aztec"] }).map((h) => h.name)).toEqual(["Aztec Connect", "Aztec Bridge"]);
    expect(matchHacks(hacks, { aliases: ["Other"], parentId: "parent#zklend-finance" }).map((h) => h.name)).toEqual(["zkLend"]);
  });
});

describe("address extraction", () => {
  it("reads docs tables and explorer links with labels and chains", () => {
    const md = [
      "## Ethereum Mainnet",
      "| Contract | Address |",
      "|---|---|",
      "| Entrypoint | [0x6818809EefCe719E480a7526D76bD3e561526b46](https://etherscan.io/address/0x6818809EefCe719E480a7526D76bD3e561526b46) |",
      "",
      "## Sepolia",
      "- **Entrypoint (testnet)**: 0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c",
      "- Burn: 0x000000000000000000000000000000000000dEaD",
    ].join("\n");
    const found = extractAddresses(md, "https://docs.privacypools.com/deployments");
    expect(found).toEqual([
      {
        address: "0x6818809EefCe719E480a7526D76bD3e561526b46",
        chainId: 1,
        label: "Entrypoint",
        origin: "https://docs.privacypools.com/deployments",
        priority: 1,
      },
      {
        address: "0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c",
        chainId: 11155111,
        label: "Entrypoint (testnet)",
        origin: "https://docs.privacypools.com/deployments",
        priority: 1,
      },
    ]);
  });

  it("reads Foundry broadcasts, hardhat-deploy artifacts and JSON maps", () => {
    const broadcast = JSON.stringify({
      chain: 1,
      transactions: [
        { transactionType: "CREATE", contractName: "Entrypoint", contractAddress: "0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c" },
        { transactionType: "CALL", contractName: "Entrypoint", contractAddress: "0x6818809EefCe719E480a7526D76bD3e561526b46" },
      ],
    });
    expect(extractFromDeploymentJson(broadcast, "broadcast/Deploy.s.sol/1/run-latest.json", "repo")).toEqual([
      { address: "0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c", chainId: 1, label: "Entrypoint", origin: "repo", priority: 2 },
    ]);
    const hh = JSON.stringify({ address: "0x6818809eefce719e480a7526d76bd3e561526b46", abi: [] });
    expect(extractFromDeploymentJson(hh, "deployments/sepolia/Pool.json", "repo")[0]).toMatchObject({ chainId: 11155111, label: "Pool" });
    const map = JSON.stringify({
      mainnet: { entrypoint: "0x6818809EefCe719E480a7526D76bD3e561526b46" },
      base: { entrypoint: "0x15e355024de1CDc74ADdea7EBDf98418Ba5B1a2c" },
    });
    expect(extractFromDeploymentJson(map, "deployments.json", "repo").map((f) => [f.chainId, f.label])).toEqual([
      [1, "mainnet.entrypoint"],
      [8453, "base.entrypoint"],
    ]);
  });

  it("merges findings, keeping the stronger origin's label and a known chain", () => {
    const merged = mergeAddresses([
      { address: "0x6818809EefCe719E480a7526D76bD3e561526b46", chainId: null, label: "Entry", origin: "docs", priority: 1 },
      { address: "0x6818809EefCe719E480a7526D76bD3e561526b46", chainId: 1, label: "PrivacyPoolsEntrypoint", origin: "L2BEAT", priority: 4 },
    ]);
    expect(merged).toEqual([
      { address: "0x6818809EefCe719E480a7526D76bD3e561526b46", chainId: 1, label: "PrivacyPoolsEntrypoint", origin: "L2BEAT", priority: 4 },
    ]);
  });
});

describe("audit metadata", () => {
  const report = [
    "AUDIT REPORT",
    "Railgun Privacy Contract",
    "April 1, 2021",
    "About ABDK: ABDK Consulting audits smart contracts.",
    "1. Scope",
    "The audit covered commit 4f2a9c1d of Railgun-Privacy/contract: RailgunLogic.sol, Commitments.sol.",
    "2. Findings",
    "Critical: 0",
    "High: 2",
    "Medium: 3",
    "Low severity issues were fixed.",
  ].join("\n");

  it("parses auditor, date, commit, scope and finding counts", () => {
    const m = parseAuditMeta(report, "https://assets.railgun.org/docs/audits/2021-04-01%20ABDK.pdf");
    // On the project's host the firm is a claim; only the auditor's own host or repo attributes it (R3-SEC-4).
    expect(m.auditor).toBeNull();
    expect(m.claimedAuditor).toBe("ABDK");
    expect(parseAuditMeta(report, "https://abdk.consulting/audits/railgun.pdf").auditor).toBe("ABDK");
    expect(m.date).toBe("2021-04-01");
    expect(m.commits).toEqual(["4f2a9c1d"]);
    expect(m.scope).toContain("RailgunLogic.sol");
    expect(m.findings).toEqual({ critical: 0, high: 2, medium: 3 });
    expect(looksLikeAudit(report)).toBe(true);
    expect(looksLikeAudit("Railgun price rallies as traders cheer the audit news.")).toBe(false);
  });

  it("finds report dates in file names and prose", () => {
    expect(findDate("2023-02-03 Zokyo.pdf")).toBe("2023-02-03");
    expect(findDate("Report prepared 14 March 2025 for the team")).toBe("2025-03-14");
    expect(findDate("Engagement: September 2024")).toBe("2024-09");
    expect(findDate("no date here")).toBeNull();
  });
});

describe("X helpers (SRC-11)", () => {
  it("guesses _project, 0x and joined handles", () => {
    expect(guessHandles("Railgun", "railgun")).toEqual(expect.arrayContaining(["railgun", "railgun_project", "0xrailgun"]));
    expect(guessHandles("Privacy Pools", "privacy-pools")).toEqual(expect.arrayContaining(["privacypools", "0xprivacypools"]));
  });

  it("requires reach or a badge for guessed handles", () => {
    expect(acceptCandidate("guess", { official: true, followers: 120 })).toBe(false);
    expect(acceptCandidate("guess", { official: true, followers: 25_000 })).toBe(true);
    expect(acceptCandidate("guess", { official: true, followers: 10, verifiedType: "business" })).toBe(true);
    expect(acceptCandidate("github", { official: true, followers: 10 })).toBe(true);
    expect(acceptCandidate("site", { official: false, followers: 1e6 })).toBe(false);
  });

  it("expands t.co links and round-trips stored posts", () => {
    expect(
      expandLinks("Read the post-mortem https://t.co/abc and see https://t.co/pic", [
        { url: "https://t.co/abc", expanded_url: "https://aztec.network/blog/incident" },
        { url: "https://t.co/pic", expanded_url: "https://x.com/aztecnetwork/status/1/photo/1" },
      ]),
    ).toBe("Read the post-mortem https://aztec.network/blog/incident and see");
    const stored =
      "[2026-09-01] @aztecnetwork: Hello world (https://x.com/aztecnetwork/status/1900000000000000001)\n\n[2026-08-01] @aztecnetwork: Older (https://x.com/aztecnetwork/status/1800000000000000001)";
    expect(parseStoredPosts(stored).map((p) => p.id)).toEqual(["1900000000000000001", "1800000000000000001"]);
  });
});

describe("forum helpers", () => {
  it("ranks topics by search matches, then views, and reads topic ids", () => {
    const hits = new Map([
      [1, { topic: { id: 1, title: "Welcome", views: 9000 }, terms: 0.5 }],
      [2, { topic: { id: 2, title: "RFC: governance upgrades", views: 300 }, terms: 3 }],
      [3, { topic: { id: 3, title: "Security council", views: 50 }, terms: 2 }],
    ]);
    expect(rankTopics(hits, 2).map((t) => t.id)).toEqual([2, 3]);
    expect(topicIdFromUrl("https://forum.aztec.network/t/request-for-comments-aztec-governance/7413")).toBe(7413);
    expect(topicIdFromUrl("https://forum.aztec.network/t/7413/12")).toBe(7413);
  });

  it("puts governance and security titles ahead of popular chatter, and skips showcase/support categories", () => {
    const hits = new Map([
      [1, { topic: { id: 1, title: "I built a confidential payroll dApp", views: 20000 }, terms: 3 }],
      [2, { topic: { id: 2, title: "[Upgrade Proposal] Slow upgrade mechanism", views: 40 }, terms: 1 }],
    ]);
    expect(rankTopics(hits, 2).map((t) => t.id)).toEqual([2, 1]);
    for (const c of ["Zama Developer Program", "Zama FHE Libraries Technical Support", "🤷‍♀️ All-Purpose Hangout", "Site Feedback", "General"])
      expect(SKIP_CATEGORY.test(c), c).toBe(true);
    for (const c of ["Governance", "Governance Proposals", "SNIPs", "Aztec", "Zama Protocol", "Research"]) expect(SKIP_CATEGORY.test(c), c).toBe(false);
  });
});

describe("price chatter and audit pages", () => {
  it("drops ticker and price-prediction headlines", () => {
    for (const t of [
      "Zama (ZAMA) Trading Up 18.1% Over Last 7 Days",
      "Zama Price Reaches $0.0591 on Major Exchanges",
      "STRK slides around 10.5% as technical strength diverges",
      "Next Crypto To Explode: Zama Rides the Privacy Boom",
      "Ethereum Price Prediction: zk.money and ETH's Privacy Catalyst",
    ])
      expect(PRICE_CHATTER.test(t), t).toBe(true);
    expect(PRICE_CHATTER.test("Zama cUSDC freeze locks users after Overnight Finance hack")).toBe(false);
    const casino = {
      title: "Best Bitcoin Casinos in USA 2026: Complete Guide",
      text: "Aztec slots and Aztec Gold appear in every crypto casino.",
      url: "https://spam.example/2",
    };
    expect(newsRelevance(casino, ["Aztec"]).ok).toBe(false);
  });

  it("needs more evidence before calling a third-party web page an audit", () => {
    const landing = "Aztec smart contract security audit services. Our team covers any scope you choose. Get a quote.";
    expect(looksLikeAudit(landing)).toBe(true);
    expect(looksLikeAudit(landing, 3)).toBe(false);
  });
});

describe("address registry hygiene (R3-SRC-1)", () => {
  it("mines listings only: table rows, list items and explorer links, never code blocks or prose", () => {
    const md = [
      "## Swap example",
      "```ts",
      "const buyTokenAddress = '0xdAC17F958D2ee523a2206206994597C13D831ec7';",
      "```",
      "The test deployment lands at 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 on Ethereum mainnet.",
      "",
      "| Contract | Address |",
      "|---|---|",
      "| Relay Adapt | 0xAc9f360Ae85469B27aEDdEaFC579Ef2d052aD405 |",
      "- `const x = '`: 0x6818809EefCe719E480a7526D76bD3e561526b46",
    ].join("\n");
    const found = extractAddresses(md, "https://docs.example.org/contracts");
    expect(found.map((f) => [f.address, f.label])).toEqual([
      ["0xAc9f360Ae85469B27aEDdEaFC579Ef2d052aD405", "Relay Adapt"],
      // A list item is a listing, but a label that looks like code is dropped.
      ["0x6818809EefCe719E480a7526D76bD3e561526b46", null],
    ]);
  });

  it("takes the chain from a known explorer, the label from the heading above, and never guesses for unknown explorers", () => {
    const md = [
      "Tempo mainnet predeploys.",
      "### Multicall3",
      "`[0xcA11bde05977b3631167028862bE2a173976CA11](https://explore.tempo.xyz/address/0xcA11bde05977b3631167028862bE2a173976CA11)`",
      "### Fee Manager",
      "`[0xfeEC000000000000000000000000000000000000](https://explore.tempo.xyz/address/0xfeEC000000000000000000000000000000000000)`",
      "On Ethereum mainnet: [0x6818809EefCe719E480a7526D76bD3e561526b46](https://scan.somel2.example/address/0x6818809EefCe719E480a7526D76bD3e561526b46)",
    ].join("\n");
    const found = extractAddresses(md, "https://tempo.xyz/developers/docs/quickstart/predeployed-contracts");
    expect(found.map((f) => [f.label, f.chainId])).toEqual([
      ["Multicall3", 4217],
      ["Fee Manager", 4217],
      // An explorer we don't know: Sourcify decides the chain later, not the word "mainnet" in the prose.
      ["On Ethereum mainnet", null],
    ]);
  });

  it("knows well-known third-party contracts, Hardhat's defaults derived from the test mnemonic", () => {
    expect(thirdPartyContract("0xdAC17F958D2ee523a2206206994597C13D831ec7")).toBe("USDT (TetherToken)");
    expect(thirdPartyContract("0x6818809EefCe719E480a7526D76bD3e561526b46")).toBeNull();
    const account0 = mnemonicToAccount("test test test test test test test test test test test junk").address;
    for (let n = 0; n < 10; n++) {
      const a = getContractAddress({ from: account0, nonce: BigInt(n) }).toLowerCase();
      expect(THIRD_PARTY_CONTRACTS[a], `deployment #${n}`).toBe(`Hardhat/Anvil default deployment #${n}`);
    }
    for (let i = 0; i < 10; i++) {
      const a = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i }).address.toLowerCase();
      expect(THIRD_PARTY_CONTRACTS[a], `account #${i}`).toBe(`Hardhat/Anvil default account #${i}`);
    }
  });

  it("stores one verified source per source, listing every address that runs it, and none for third-party code", () => {
    const pool = (address: string): SourcifyContract => ({
      chainId: 1,
      address,
      match: "exact_match",
      name: "PrivacyPoolComplex",
      fullyQualifiedName: null,
      compiler: null,
      verifiedAt: null,
      proxy: null,
      sources: [{ path: "src/PrivacyPool.sol", content: "contract PrivacyPoolComplex {}", library: false }],
      abiFunctions: [],
    });
    const safe = {
      ...pool("0x41675C099F32341bf84BFc5382aF534df5C7461a"),
      name: "Safe",
      sources: [{ path: "Safe.sol", content: "contract Safe {}", library: false }],
    };
    const rows = [
      {
        address: "0x1111111111111111111111111111111111111111",
        chainId: 1,
        label: "Pool ETH",
        thirdParty: null,
        sourcify: pool("0x1111111111111111111111111111111111111111"),
        implementation: null,
      },
      {
        address: "0x2222222222222222222222222222222222222222",
        chainId: 1,
        label: "Pool USDC",
        thirdParty: null,
        sourcify: pool("0x2222222222222222222222222222222222222222"),
        implementation: null,
      },
      // The project's Safe proxy points at the Safe singleton: boilerplate someone else wrote.
      {
        address: "0x3333333333333333333333333333333333333333",
        chainId: 1,
        label: "Multisig",
        thirdParty: null,
        sourcify: { ...safe, proxy: { isProxy: true, type: "GnosisSafe", implementations: [] } },
        implementation: safe,
      },
      {
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        chainId: 1,
        label: "USDT",
        thirdParty: "USDT (TetherToken)",
        sourcify: pool("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
        implementation: null,
      },
    ];
    const groups = groupVerifiedSources(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.addresses.map((a) => a.label)).toEqual(["Pool ETH", "Pool USDC"]);
  });
});

describe("audit gate and report de-duplication (R3-SRC-4)", () => {
  const anchors = {
    domains: ["tempo.xyz"],
    repos: ["tempoxyz/tempo", "0xbow-io/privacy-pools-core"],
    tokens: ["tempo", "privacypools"],
    addresses: ["0x6818809eefce719e480a7526d76bd3e561526b46"],
  };

  it("ties a third-party document to the project by domain, repo or contract, not by name", () => {
    expect(anchoredToProject("From Noise to Proof: How Tempo Validated Real Risk. Tempo Beverages Ltd.", anchors)).toBe(false);
    expect(anchoredToProject("Scope: tempoxyz/tempo at commit 1234abcd", anchors)).toBe(true);
    expect(anchoredToProject("Scope: the privacy-pools-core repository", anchors)).toBe(true);
    expect(anchoredToProject("Contracts at https://docs.tempo.xyz/x", anchors)).toBe(true);
    expect(anchoredToProject("Entrypoint 0x6818809EefCe719E480a7526D76bD3e561526b46", anchors)).toBe(true);
  });

  it("groups copies of one report and keeps the auditor's own copy", () => {
    const body = (title: string) =>
      `${title}\n${Array.from({ length: 400 }, (_, i) => `Finding ${i}: the withdraw path of the entrypoint does not check fee ${i % 7} under scope item ${i}.`).join(" ")}`;
    const other = Array.from({ length: 400 }, (_, i) => `Issue ${i} concerns circuit constraint ${i * 3} in the merkle verifier for depth ${i % 11}.`).join(
      " ",
    );
    const copies: ReportCopy[] = [
      {
        id: "code",
        url: "https://github.com/0xbow-io/privacy-pools-core/blob/v1.3.0/audit/contracts_audit_oxorio.md",
        text: body("Oxorio contracts audit"),
        length: 39_000,
        auditor: null,
        claimedAuditor: "Oxorio",
        date: "2025-03-18",
        rank: 3,
      },
      {
        url: "https://oxor-io.github.io/public_audits/Privacy%20Pools/Core.pdf",
        text: body("PRIVACY POOLS SMART CONTRACTS AUDIT REPORT"),
        length: 35_000,
        auditor: "Oxorio",
        claimedAuditor: "Oxorio",
        date: "2025-03-18",
        rank: 5,
      },
      {
        id: "stub",
        url: "https://audits.oxor.io/reports/x",
        text: body("Privacy Pools Core | Oxorio Audit Web Report").slice(0, 2100),
        length: 2100,
        auditor: "Oxorio",
        claimedAuditor: "Oxorio",
        date: null,
        rank: 4,
      },
      {
        id: "circuits",
        url: "https://github.com/0xbow-io/privacy-pools-core/blob/v1.3.0/audit/circuits_audit_oxorio.md",
        text: other,
        length: 31_000,
        auditor: null,
        claimedAuditor: "Oxorio",
        date: "2025-02-21",
        rank: 3,
      },
    ];
    const groups = groupReports(copies);
    expect(groups.map((g) => g.map((c) => c.id ?? "pdf"))).toEqual([["pdf", "code", "stub"], ["circuits"]]);
    expect(containment(shingles("a b c d e"), shingles("a b c d e f g"))).toBe(1);
  });
});

describe("news, forum, data, code and X details (R3-SRC-10/12/13/14/15, R3-SRC-6)", () => {
  it("needs two distinct crypto terms near a mention, and 'rollup' alone isn't crypto", () => {
    expect(cryptoTerms("a rollup and a mainnet")).toEqual({ distinct: 2, strong: false });
    const wrestling = {
      title: "Tempo pins the champion with a rollup",
      text: "Tempo won the match with a rollup in the final minute; the mainnet event drew a crowd.",
      url: "https://prowrestling.example/results",
    };
    expect(newsRelevance(wrestling, ["Tempo"]).ok).toBe(false);
    const real = {
      title: "Tempo opens its rollup to stablecoin issuers",
      text: "Tempo's blockchain now settles stablecoin payments.",
      url: "https://n.example/t",
    };
    expect(newsRelevance(real, ["Tempo"]).ok).toBe(true);
  });

  it("ranks the project's own recent threads above old chatter", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const hits = new Map([
      [1, { topic: { id: 1, title: "Delegate Profile Thread", created_at: "2022-03-01T00:00:00Z", views: 9000 }, terms: 1 }],
      [2, { topic: { id: 2, title: "Adding confidential payments with STRK20", created_at: "2026-08-01T00:00:00Z", views: 300 }, terms: 3 }],
    ]);
    expect(rankTopics(hits, 2, { now, aliases: ["STRK20"] }).map((t) => t.id)).toEqual([2, 1]);
    expect(MAX_TOPIC_CHARS).toBe(60_000);
  });

  it("reads the host chain's L2BEAT folder for single-chain projects, and flags template prose", () => {
    expect(hostChainSlug({ chains: ["Starknet"], l2beatSlug: "strk20" })).toBe("starknet");
    expect(hostChainSlug({ chains: ["Ethereum", "Arbitrum"], l2beatSlug: "railgun" })).toBeNull();
    expect(hostChainSlug({ chains: ["Starknet"], l2beatSlug: "starknet" })).toBeNull();
    expect(templateNote("The Security Council ({{scThreshold}}) can upgrade.")).toContain("{{scThreshold}}");
    expect(templateNote("Plain prose.")).toBeNull();
  });

  it("stores X posts per month", () => {
    expect(monthOf("2026-09-30T23:59:00.000Z")).toBe("2026-09");
  });
});

describe("audit recency and what isn't a report", () => {
  it("keeps recent and undated reports, and only the newest two older than three years", () => {
    const cutoff = auditCutoff(Date.parse("2026-10-01"));
    expect(cutoff).toBe("2023-10-01");
    const dates = ["2025-03-01", "2021-04-01", "2022-12-21", null, "2021-11-23", "2023-02-03", "2024-06"];
    // Old: 2021-04-01 (1), 2022-12-21 (2), 2021-11-23 (4), 2023-02-03 (5). Kept: 2023-02-03 and 2022-12-21.
    expect(oldAuditsToDrop(dates, cutoff).sort()).toEqual([1, 4]);
    expect(oldAuditsToDrop(["2025-01-01", null], cutoff)).toEqual([]);
  });

  it("rejects auditor homepages and listings, and treats industry reports as analyses", () => {
    expect(isListingPage("https://zokyo.io/")).toBe(true);
    expect(isListingPage("https://www.certik.com/audits")).toBe(true);
    expect(isListingPage("https://zokyo.io/reports/railgun-2023.pdf")).toBe(false);
    expect(isListingPage("https://github.com/spearbit/portfolio/blob/main/pdfs/Railgun.pdf")).toBe(false);
    expect(INDUSTRY_REPORT.test("[PDF] 2024 Blockchain Security and Anti-Money Laundering Annual Report")).toBe(true);
    expect(INDUSTRY_REPORT.test("Railgun Smart Contracts Security Review")).toBe(false);
  });
});
