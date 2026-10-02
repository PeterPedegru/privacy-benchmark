import { describe, expect, it } from "vitest";
import {
  aliasMentions,
  auditorForUrl,
  buildInterestedParties,
  canonicalKey,
  classifyUrl,
  createRegistry,
  deriveAliases,
  detectAuditor,
  docsRootOf,
  dropReason,
  githubBlobToRaw,
  githubRawToBlob,
  isLegalPath,
  isLegalTitle,
  isLocalePath,
  isNameDomain,
  isNamePath,
  mergeRegistries,
  normalizeUrl,
  passesRelevanceGate,
  registrableDomain,
  sameSite,
  wwwVariant,
} from "../src/services/classify.ts";

const aztec = createRegistry({
  name: "Aztec",
  slug: "aztec",
  websiteUrl: "https://aztec.network",
  websiteFinalUrl: "https://aztec.network/",
  docsRoots: [{ url: "https://docs.aztec.network/", prefix: "" }],
  githubRepos: ["AztecProtocol/aztec-packages"],
  githubProfiles: [{ login: "AztecProtocol", blog: "https://aztec.network" }],
  xHandles: ["aztecnetwork"],
  forumHosts: ["forum.aztec.network"],
});

const pp = createRegistry({
  name: "Privacy Pools",
  slug: "privacy-pools",
  websiteUrl: "https://privacypools.com",
  docsRoots: [{ url: "https://docs.privacypools.com/" }],
  githubRepos: ["0xbow-io/privacy-pools-core"],
  extraDomains: ["0xbow.io", "medium.com/@0xbow", "github.com/0xbow-labs"],
  xProfileUrls: ["https://0xbow.io", "https://linktr.ee/0xbow"],
});

const tempo = createRegistry({
  name: "Tempo",
  slug: "tempo",
  websiteUrl: "https://tempo.xyz",
  docsRoots: [{ url: "https://tempo.xyz/developers", prefix: "/developers" }],
});

describe("ownership registry", () => {
  it("collects owned domains, paths, GitHub owners and docs roots", () => {
    expect(aztec.domains).toContain("aztec.network");
    expect(aztec.githubOwners).toEqual(["aztecprotocol"]);
    expect(aztec.docsRoots).toEqual([{ host: "docs.aztec.network", prefix: "" }]);
    expect(pp.domains).toEqual(expect.arrayContaining(["privacypools.com", "0xbow.io"]));
    // Link hubs on a profile are never owned; platform paths and GitHub orgs from the editor list are.
    expect(pp.domains).not.toContain("linktr.ee");
    expect(pp.ownedPaths).toContain("medium.com/@0xbow");
    expect(pp.githubOwners).toEqual(expect.arrayContaining(["0xbow-io", "0xbow-labs"]));
    expect(tempo.docsRoots).toEqual([{ host: "tempo.xyz", prefix: "/developers" }]);
  });

  it("derives prose aliases without parenthetical qualifiers", () => {
    expect(deriveAliases("STRK20 (Starknet)")).toEqual(["STRK20"]);
    expect(deriveAliases("Privacy Pools", ["0xbow"])).toEqual(["Privacy Pools", "PrivacyPools", "0xbow"]);
  });

  it("treats domains named after the project as owned (only ever lowering weight)", () => {
    expect(isNameDomain(aztec, "aztec-labs.com")).toBe(true);
    expect(isNameDomain(aztec, "aztec.medium.com")).toBe(true);
    expect(isNameDomain(aztec, "aztecgold-casino.com")).toBe(false);
    expect(isNameDomain(pp, "privacypools.com")).toBe(true);
  });

  it("merges a persisted registry with current configuration", () => {
    const merged = mergeRegistries(
      aztec,
      createRegistry({ name: "Aztec", slug: "aztec", websiteUrl: "https://aztec.network", extraDomains: ["aztec-labs.com"] }),
    );
    expect(merged.domains).toEqual(expect.arrayContaining(["aztec.network", "aztec-labs.com"]));
    expect(merged.forumHosts).toContain("forum.aztec.network");
  });
});

describe("classifyUrl", () => {
  const c = (url: string, lane: Parameters<typeof classifyUrl>[1] = "analysis", extra: Partial<Parameters<typeof classifyUrl>[2]> = {}) =>
    classifyUrl(url, lane, { registry: aztec, ...extra });

  it("keeps docs pages official whichever lane finds them (SRC-1)", () => {
    for (const lane of ["docs", "website", "analysis", "agent"] as const) {
      const r = c("https://docs.aztec.network/participate/governance/upgrades", lane);
      expect(r).toMatchObject({ drop: null, sourceClass: "official_docs", kind: "docs", owner: "project", docsRoot: true });
    }
    expect(classifyUrl("https://tempo.xyz/developers/docs/zones", "website", { registry: tempo })).toMatchObject({
      docsRoot: true,
      sourceClass: "official_docs",
    });
    expect(classifyUrl("https://tempo.xyz/developersfoo", "website", { registry: tempo }).docsRoot).toBe(false);
  });

  it("classifies the project's own site: blog posts are marketing, other pages official", () => {
    expect(c("https://aztec.network/blog/alpha-network-security-what-to-expect", "website")).toMatchObject({ kind: "blog", sourceClass: "marketing" });
    expect(c("https://aztec.network/", "website")).toMatchObject({ kind: "website", sourceClass: "marketing" });
    expect(c("https://aztec.network/security", "website")).toMatchObject({ kind: "website", sourceClass: "official_docs" });
    // The corporate blog of the team behind the project is not independent (SRC-9).
    // The corporate blog of the team behind the project is never independent (SRC-9); a domain named after the
    // project is the project's own once it links back to a verified domain (R3-SRC-11).
    expect(c("https://aztec-labs.com/blog/aztec-2-incident", "analysis", { links: ["https://aztec.network/"] })).toMatchObject({
      owner: "project",
      sourceClass: "marketing",
    });
    expect(c("https://aztec-labs.com/blog/aztec-2-incident")).toMatchObject({ owner: "third_party", sourceClass: "marketing" });
    expect(classifyUrl("https://medium.com/@0xbow/privacy-pools-launch", "analysis", { registry: pp })).toMatchObject({
      owner: "project",
      sourceClass: "marketing",
    });
  });

  it("splits the project's GitHub into code, docs and changes", () => {
    expect(c("https://github.com/AztecProtocol/aztec-packages/blob/v5.2.0/l1-contracts/src/governance/Governance.sol")).toMatchObject({
      owner: "project_github",
      kind: "code",
      sourceClass: "code_onchain",
    });
    expect(c("https://raw.githubusercontent.com/AztecProtocol/aztec-packages/v5.2.0/SECURITY.md")).toMatchObject({
      kind: "docs",
      sourceClass: "official_docs",
    });
    expect(c("https://github.com/AztecProtocol/aztec-packages/issues/123")).toMatchObject({ kind: "docs", sourceClass: "official_docs" });
    expect(c("https://github.com/AztecProtocol/aztec-packages/pull/9")).toMatchObject({ sourceClass: "official_docs" });
    expect(c("https://github.com/AztecProtocol/aztec-packages/commit/abc123")).toMatchObject({ kind: "changes", sourceClass: "code_onchain" });
  });

  it("treats audit reports by their auditor, not their host", () => {
    const report = "Security Review\nRailgun Smart Contracts\nPrepared by HashCloak Inc.\nFindings: 3 high";
    const onProjectHost = classifyUrl("https://assets.railgun.org/docs/audits/2022-08-29%20Hashcloak.pdf", "audits", {
      registry: createRegistry({ name: "Railgun", slug: "railgun", websiteUrl: "https://railgun.org" }),
      title: "Railgun Smart Contracts Security Review",
      text: report,
    });
    // The project's copy names its auditor, but only the auditor's own host proves authorship (R3-SEC-4).
    expect(onProjectHost).toMatchObject({ kind: "audit", sourceClass: "official_docs", claimedAuditor: "HashCloak" });
    expect(onProjectHost.auditor).toBeUndefined();
    const anonymous = classifyUrl("https://railgun.org/audits/self-review.pdf", "audits", {
      registry: createRegistry({ name: "Railgun", slug: "railgun", websiteUrl: "https://railgun.org" }),
      text: "Internal notes",
    });
    expect(anonymous).toMatchObject({ kind: "audit", sourceClass: "official_docs" });
    expect(c("https://github.com/trailofbits/publications/blob/master/reviews/aztec.pdf")).toMatchObject({
      owner: "auditor",
      auditor: "Trail of Bits",
      kind: "audit",
    });
    expect(c("https://veridise.com/audits-archive/company/aztec/bigfield-2025-09-18/")).toMatchObject({ kind: "audit", sourceClass: "independent" });
  });

  it("drops mirrors, AI summaries, SEO farms and third-party GitHub activity", () => {
    for (const url of [
      "https://deepwiki.com/AztecProtocol/aztec-packages/2.3-note-management",
      "https://nitter.jaydenha.uk/0xbowio/status/2102783020990070931",
      "https://freedium-mirror.cfd/https:/medium.com/p/7dfa6d26f8a1",
      "https://github.laiyagushi.com/starkware-libs/starknet-privacy",
      "https://exa.ai/library/publication/xyp94p33jtp",
      "https://stg-www.weex.tech/news/detail/ethereum-l2beat-ranks",
      "https://hindenrank.com/blog/is-railgun-safe",
      "https://www.dextools.io/tutorials/what-is-railgun",
      "https://github.com/guil-lambert/defipunkd/commit/261bead891cbec56306ad697c74211944760dbec",
      "https://gist.github.com/someone/c0b4d01dfda4cfbaa47e58d50f9a1d8f",
    ]) {
      expect(c(url).drop, url).not.toBeNull();
    }
    expect(dropReason("https://www.theblock.co/post/405207/aztec-investigates")).toBeNull();
  });

  it("classes L2BEAT's GitHub configs like l2beat.com, as the data lane and tools store them (R4-28)", () => {
    for (const lane of ["agent", "data", "analysis"] as const)
      for (const url of [
        "https://github.com/l2beat/l2beat/blob/main/packages/config/src/projects/aztec/aztec.ts",
        "https://raw.githubusercontent.com/l2beat/l2beat/main/packages/config/src/projects/aztec/riskSummary.md",
        "https://l2beat.com/scaling/projects/aztec",
      ])
        expect(c(url, lane), `${lane} ${url}`).toMatchObject({ drop: null, kind: "l2beat", sourceClass: "independent", owner: "data" });
    // Other repositories of the org, and activity on the repository, are not L2BEAT's assessment.
    expect(c("https://github.com/l2beat/tools/blob/main/README.md").sourceClass).toBe("third_party");
    expect(c("https://github.com/l2beat/l2beat/pull/123").drop).not.toBeNull();
  });

  it("makes press releases and social posts marketing", () => {
    expect(c("https://www.globenewswire.com/news-release/2026/aztec", "news")).toMatchObject({ kind: "news", sourceClass: "marketing" });
    expect(c("https://example-news.com/story", "news", { dataType: "pr" })).toMatchObject({ sourceClass: "marketing" });
    expect(c("https://x.com/aztecnetwork/status/1", "agent")).toMatchObject({ owner: "project", kind: "announcement", sourceClass: "marketing" });
    expect(c("https://x.com/randomuser/status/1", "agent")).toMatchObject({ owner: "third_party", sourceClass: "marketing" });
  });

  it("classifies forum posts by author role", () => {
    expect(c("https://forum.aztec.network/t/request-for-comments-aztec-governance/7413", "forum", { authorRole: "staff" })).toMatchObject({
      kind: "governance",
      sourceClass: "official_docs",
    });
    // A member's post is a community view hosted by the project, not independent analysis (R3-SEC-4).
    expect(c("https://forum.aztec.network/t/on-an-aztec-multisig/8280", "forum", { authorRole: "member" })).toMatchObject({ sourceClass: "third_party" });
  });

  it("stores third parties only when they are about the project", () => {
    const relevant = c("https://www.halborn.com/blog/post/explained-the-aztec-connect-hack-june-2026", "analysis", {
      title: "Explained: The Aztec Connect Hack (June 2026)",
      text: "In June 2026 Aztec Connect was exploited.",
      requireRelevance: true,
    });
    expect(relevant).toMatchObject({ drop: null, owner: "auditor", sourceClass: "independent", kind: "analysis" });
    const generic = c("https://forum.l2beat.com/t/the-data-availability-risk-framework/318", "analysis", {
      title: "The data availability risk framework",
      text: "L2BEAT's framework for data availability. Rollups post data to Ethereum.",
      requireRelevance: true,
    });
    expect(generic.drop).toBe("not about the project");
    const twoMentions = c("https://protocols-made-fun.com/aztec-governance.html", "analysis", {
      title: "Governance analysis",
      text: "This post looks at Aztec governance. The Aztec rollup has a governance proposer.",
      requireRelevance: true,
    });
    // A blog post by a third party is third_party, not independent analysis (R3-JDG-6).
    expect(twoMentions).toMatchObject({ drop: null, sourceClass: "third_party", owner: "third_party" });
    expect(c("https://l2beat.com/scaling/projects/aztecnetwork")).toMatchObject({ kind: "l2beat", sourceClass: "independent" });
  });

  it("splits third parties into independent work and third-party writing (R3-JDG-6)", () => {
    const about = { title: "Aztec governance and the Aztec escape hatch", text: "Aztec Aztec", requireRelevance: true };
    // Independent: auditors, L2BEAT, data providers, academic and research venues, incident trackers, advisories.
    for (const url of [
      "https://www.halborn.com/blog/post/explained-the-aztec-connect-hack-june-2026",
      "https://l2beat.com/scaling/projects/aztecnetwork",
      "https://defillama.com/protocol/aztec",
      "https://dune.com/someone/aztec-dashboard",
      "https://arxiv.org/abs/2606.25926",
      "https://eprint.iacr.org/2025/123",
      "https://www.usenix.org/conference/usenixsecurity25/presentation/aztec",
      "https://rekt.news/aztec-rekt",
      "https://github.com/advisories/GHSA-778c-2h5c-8r96",
    ]) {
      expect(c(url, "analysis", about).sourceClass, url).toBe("independent");
    }
    // Third party: news sites, blogs, Medium and Substack posts by others, aggregators, SEO glossaries.
    for (const url of [
      "https://www.theblock.co/post/405207/aztec-investigates",
      "https://cryptobriefing.com/aztec-news",
      "https://medium.com/@someone/aztec-deep-dive",
      "https://someone.substack.com/p/aztec-review",
      "https://www.anchain.ai/blog/aztec-demystified",
      "https://academy.example-exchange.com/glossary/aztec",
      "https://github.com/someone/aztec-hackathon",
    ]) {
      expect(c(url, "analysis", about).sourceClass, url).toBe("third_party");
    }
    // Code4rena: only the published findings report is an audit; contest repos are sponsor material.
    expect(c("https://github.com/code-423n4/2024-05-aztec/blob/main/README.md", "analysis", about).drop).not.toBeNull();
    expect(c("https://github.com/code-423n4/2024-05-aztec-findings/issues/7", "analysis", about).drop).not.toBeNull();
    expect(c("https://github.com/code-423n4/2024-05-aztec-findings/blob/main/report.md", "analysis", about)).toMatchObject({
      auditor: "Code4rena",
      sourceClass: "independent",
    });
    // An auditor org's tool repos aren't reports.
    expect(auditorForUrl("https://github.com/zksecurity/zkao/blob/main/src/lib.rs")).toBeNull();
    expect(auditorForUrl("https://github.com/zksecurity/audit-reports/blob/main/aztec.pdf")).toBe("zkSecurity");
  });

  it("treats other benchmarked projects and competitors as interested parties (marketing)", () => {
    const railgun = createRegistry({ name: "Railgun", slug: "railgun", websiteUrl: "https://railgun.org", githubRepos: ["Railgun-Privacy/contract"] });
    const interested = buildInterestedParties(aztec, [railgun, createRegistry({ name: "Aztec copy", slug: "x", websiteUrl: "https://aztec.network" })]);
    expect(interested.domains).toEqual(expect.arrayContaining(["railgun.org", "hinkal.io"]));
    // Nothing the project owns, and no shared platforms, become interested parties.
    expect(interested.domains).not.toContain("aztec.network");
    expect(interested.githubOwners).toContain("railgun-privacy");
    const about = { title: "Aztec vs Railgun: which privacy system?", text: "Aztec and Aztec", requireRelevance: true, interested };
    expect(c("https://www.railgun.org/blog/railgun-vs-aztec", "analysis", about)).toMatchObject({ owner: "interested_party", sourceClass: "marketing" });
    expect(c("https://hinkal.io/blog/aztec-comparison", "analysis", about)).toMatchObject({ owner: "interested_party", sourceClass: "marketing" });
    expect(c("https://github.com/Railgun-Privacy/contract/blob/main/README.md", "analysis", about)).toMatchObject({ sourceClass: "marketing" });
    // Unrelated pages of an interested party are still dropped when relevance is required.
    expect(c("https://www.railgun.org/blog/other", "analysis", { title: "Fees", text: "Railgun fees", requireRelevance: true, interested }).drop).toBe(
      "not about the project",
    );
  });

  it("needs a domain named after the project to be verified before it counts as the project's (R3-SRC-11)", () => {
    const tempoNews = { title: "Tempo blockchain partners with a bank", text: "Tempo said its Tempo blockchain pilot", requireRelevance: true };
    // TEMPO.CO is an Indonesian newspaper: a name match alone is a third party, never official docs.
    expect(classifyUrl("https://en.tempo.co/read/1", "agent", { registry: tempo, ...tempoNews })).toMatchObject({
      owner: "third_party",
      sourceClass: "third_party",
      docsRoot: false,
    });
    expect(classifyUrl("https://en.tempo.co/read/2", "agent", { registry: tempo, title: "Elections", text: "Politics", requireRelevance: true }).drop).toBe(
      "not about the project",
    );
    // Linked from the project's homepage: verified.
    const linked = createRegistry({
      name: "Tempo",
      slug: "tempo",
      websiteUrl: "https://tempo.xyz",
      siteLinks: ["https://tempo-labs.com/about", "https://partner.example/"],
    });
    expect(linked.domains).toContain("tempo-labs.com");
    expect(linked.domains).not.toContain("partner.example");
    expect(classifyUrl("https://tempo-labs.com/security", "agent", { registry: linked })).toMatchObject({ owner: "project", sourceClass: "official_docs" });
  });

  it("keeps the record in the dedupe key where a fragment names one (R3-SRC-6)", () => {
    expect(canonicalKey("https://x.com/tempo#2026-08")).not.toBe(canonicalKey("https://x.com/tempo#2026-09"));
    expect(canonicalKey("https://defillama.com/hacks#aztec-bridge-2026-06-17")).not.toBe(canonicalKey("https://defillama.com/hacks#aztec-connect-2026-06-14"));
    expect(canonicalKey("evm://1/0xabc#inspect")).not.toBe(canonicalKey("evm://1/0xabc#1a2b3c"));
    expect(canonicalKey("https://docs.aztec.network/a#section")).toBe(canonicalKey("https://docs.aztec.network/a"));
  });

  it("drops reposts and mirrors, and files landing and customer pages as marketing (R3-SRC-14)", () => {
    for (const url of ["https://cyfar.ca/posts/auditing-in-the-age-of-good-enough-ai", "https://arxiv.gg/abs/2606.25926", "https://mirror.glasslane.io/x"]) {
      expect(c(url).drop, url).not.toBeNull();
    }
    expect(c("https://tg.me/railgunproject").sourceClass).toBe("marketing");
    expect(classifyUrl("https://tempo.xyz/customer-stories/acme", "website", { registry: tempo })).toMatchObject({ sourceClass: "marketing" });
    expect(classifyUrl("https://tempo.xyz/solutions/payments", "website", { registry: tempo })).toMatchObject({ sourceClass: "marketing" });
    expect(c("https://aztec.network/developers", "website")).toMatchObject({ sourceClass: "marketing" });
    expect(c("https://aztec.network/developers/guides/private-state", "website")).toMatchObject({ sourceClass: "official_docs" });
  });
});

describe("relevance and auditors", () => {
  it("matches aliases on word boundaries, respecting capitalised names", () => {
    expect(aliasMentions("Aztecs and aztec.network", ["Aztec"]).length).toBe(0);
    expect(aliasMentions("Aztec Network shipped", ["Aztec"]).length).toBe(1);
    expect(aliasMentions("keep the tempo up", ["Tempo"]).length).toBe(0);
    expect(aliasMentions("Tempo, the Stripe-backed chain", ["Tempo"]).length).toBe(1);
    expect(passesRelevanceGate("Unrelated title", "Railgun is a privacy system. RAILGUN shields tokens.", ["Railgun"])).toBe(true);
    expect(passesRelevanceGate("Unrelated title", `${"x ".repeat(2000)} Railgun Railgun`, ["Railgun"])).toBe(false);
  });

  it("finds the auditor on the first page and by URL", () => {
    expect(detectAuditor("AUDIT REPORT\nRailgun Privacy Contract\nAbout ABDK\nABDK Consulting")).toBe("ABDK");
    expect(detectAuditor(`${"filler ".repeat(600)} reviewed by Zellic`)).toBeNull();
    expect(auditorForUrl("https://github.com/code-423n4/2024-05-aztec-findings/blob/main/report.md")).toBe("Code4rena");
    expect(auditorForUrl("https://reports.zellic.io/publications/aztec")).toBe("Zellic");
    expect(auditorForUrl("https://github.com/OpenZeppelin/openzeppelin-contracts")).toBeNull();
    expect(auditorForUrl("https://github.com/Consensys/aztec-audit-report-2019-04")).toBe("Consensys Diligence");
    expect(auditorForUrl("https://oxor-io.github.io/public_audits/Privacy%20Pools/Report.pdf")).toBe("Oxorio");
  });

  it("names the author, not a firm whose libraries the report mentions", () => {
    const report =
      "Privacy Pools Batch Relayer\nThe contracts inherit OpenZeppelin Contracts' Ownable and use @openzeppelin/contracts.\nPrepared by Auditware\nFindings: 2 low";
    expect(detectAuditor(report)).toBe("Auditware");
    expect(detectAuditor("This document presents the security audit conducted by Oxorio for Privacy Pools.")).toBe("Oxorio");
  });

  it("drops an auditor's report about another project when relevance is required", () => {
    const r = classifyUrl("https://github.com/code-423n4/2023-04-caviar-findings/blob/main/report.md", "analysis", {
      registry: pp,
      title: "PrivatePool allows the use of Stolen NFTs",
      text: "The PrivatePool contract of Caviar lets anyone deposit stolen NFTs.",
      requireRelevance: true,
    });
    expect(r.drop).toBe("not about the project");
    // Findings issues are unjudged warden submissions, not the auditor's report (R3-SEC-4).
    expect(classifyUrl("https://github.com/code-423n4/2023-04-caviar-findings/issues/577", "analysis", { registry: pp }).drop).not.toBeNull();
  });
});

describe("URL normalization and dedupe keys", () => {
  it("normalizes, strips tracking parameters and treats www and apex as one site", () => {
    expect(normalizeUrl("https://Docs.Example.org/a/b/#frag")).toBe("https://docs.example.org/a/b");
    expect(normalizeUrl("https://example.org/p?utm_source=x&id=3&ref=y", { keepQuery: true })).toBe("https://example.org/p?id=3");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(sameSite("https://www.miden.xyz/a", "https://miden.xyz/b")).toBe(true);
    expect(wwwVariant("https://miden.xyz/a")).toBe("https://www.miden.xyz/a");
    expect(wwwVariant("https://www.miden.xyz/a")).toBe("https://miden.xyz/a");
  });

  it("collapses markdown twins, index pages and www variants", () => {
    const k = canonicalKey("https://docs.zama.org/protocol/governance/pausing");
    expect(canonicalKey("https://docs.zama.org/protocol/governance/pausing.md")).toBe(k);
    expect(canonicalKey("https://docs.zama.org/protocol/governance/pausing/")).toBe(k);
    expect(canonicalKey("https://www.docs.zama.org/protocol/governance/pausing")).toBe(k);
    expect(canonicalKey("https://docs.zama.org/protocol/index.html")).toBe(canonicalKey("https://docs.zama.org/protocol"));
  });

  it("maps GitHub blob and raw URLs both ways", () => {
    const blob = "https://github.com/zama-ai/fhevm/blob/main/fhevm-whitepaper.pdf";
    expect(githubBlobToRaw(blob)).toBe("https://raw.githubusercontent.com/zama-ai/fhevm/main/fhevm-whitepaper.pdf");
    expect(githubRawToBlob(githubBlobToRaw(blob))).toBe(blob);
  });

  it("knows registrable domains on shared platforms", () => {
    expect(registrableDomain("docs.zama.org")).toBe("zama.org");
    expect(registrableDomain("railgun.gitbook.io")).toBe("railgun.gitbook.io");
    expect(registrableDomain("rya-sge.github.io")).toBe("rya-sge.github.io");
    expect(registrableDomain("www.example.co.uk")).toBe("example.co.uk");
  });

  it("recognises locale and legal paths", () => {
    expect(isLocalePath("/ja/blog/post")).toBe(true);
    expect(isLocalePath("/zh-CN/")).toBe(true);
    expect(isLocalePath("/pt-br/docs")).toBe(true);
    expect(isLocalePath("/javascript/guide")).toBe(false);
    expect(isLocalePath("/developers")).toBe(false);
    expect(isLegalPath("/terms-of-service")).toBe(true);
    expect(isLegalPath("/legal/privacy-policy")).toBe(true);
    expect(isLegalPath("/privacy/viewing-keys")).toBe(false);
    // Aztec's site keeps legal pages under product names.
    expect(isLegalPath("/staking-terms-conditions")).toBe(true);
    expect(isLegalPath("/token-sale-disclaimer")).toBe(true);
    expect(isLegalPath("/token-sale-privacy-policy")).toBe(true);
    expect(isLegalPath("/risk-toolkit")).toBe(false);
    expect(isLegalPath("/participate/governance/terminology")).toBe(false);
    expect(isLegalTitle("Terms of Use | Privacy Pools Documentation")).toBe(true);
    expect(isLegalTitle("Privacy Policy - Aztec")).toBe(true);
    expect(isLegalTitle("Privacy model | Aztec")).toBe(false);
  });

  it("treats blog publications named after the project as its own", () => {
    expect(isNamePath(aztec, "https://medium.com/aztec-protocol/aztec-labs-announces-our-largest-ever-bug-bounty")).toBe(true);
    expect(isNamePath(aztec, "https://medium.com/@hisoka-labs/raven-for-railgun")).toBe(false);
    // Unverified it's a third party (still marketing, being a blog); linking back to the site verifies it.
    expect(classifyUrl("https://medium.com/aztec-protocol/bug-bounty", "analysis", { registry: aztec })).toMatchObject({
      owner: "third_party",
      sourceClass: "marketing",
    });
    expect(classifyUrl("https://medium.com/aztec-protocol/bug-bounty", "analysis", { registry: aztec, links: ["https://aztec.network/"] })).toMatchObject({
      owner: "project",
      sourceClass: "marketing",
    });
  });

  it("finds the most specific docs root", () => {
    const reg = createRegistry({
      name: "STRK20",
      slug: "strk20",
      websiteUrl: "https://www.starknet.io",
      docsRoots: [{ url: "https://docs.starknet.io/build/starknet-privacy" }, { url: "https://strk20.starknet.io/" }],
    });
    expect(docsRootOf(reg, "https://docs.starknet.io/build/starknet-privacy/overview")?.prefix).toBe("/build/starknet-privacy");
    expect(docsRootOf(reg, "https://docs.starknet.io/build/corelib/core-array")).toBeNull();
    expect(docsRootOf(reg, "https://strk20.starknet.io/spec")?.host).toBe("strk20.starknet.io");
  });
});
