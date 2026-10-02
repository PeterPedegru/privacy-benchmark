/**
 * Deterministic source classification. Who stands behind a URL decides its source class, never the lane that
 * happened to find it or a model's guess:
 *
 * - the project's own hosts are `official_docs` (blog and announcement paths are `marketing`);
 * - the project's GitHub is `code_onchain` for source files at a ref and `official_docs` for issues, PRs and docs;
 *   an audit report kept there is `official_docs` too, with the auditor it names in `claimedAuditor` (R3-SEC-4);
 * - auditors on their own hosts and report repositories are `independent` (kind `audit`), as are L2BEAT, DefiLlama,
 *   Dune, academic venues, incident trackers and the GitHub advisory database (R3-JDG-6);
 * - mirrors, AI summaries, SEO farms and staging hosts are dropped;
 * - press releases, social posts and pages by interested parties (other benchmarked projects, known competitors)
 *   are `marketing`;
 * - everything else third-party (news, blogs, Medium and Substack posts, aggregators, forum members) is
 *   `third_party`, and only when it is actually about the project.
 *
 * Everything here is pure (no I/O), so it can be unit-tested and shared by the knowledge-base lanes and the
 * evaluation tools. The ownership registry that drives it is built once per refresh (`createRegistry`) and
 * persisted in `projects.kb_meta.registry`, so tools can classify without network access.
 */

export type SourceClass = "code_onchain" | "independent" | "official_docs" | "third_party" | "marketing";
/** Mirrors `SourceKind` in @pb/core (kept local so this module has no workspace imports). */
export type SourceKind =
  | "docs"
  | "website"
  | "code"
  | "changes"
  | "announcement"
  | "audit"
  | "l2beat"
  | "defillama"
  | "governance"
  | "blog"
  | "news"
  | "analysis"
  | "onchain"
  | "editor_note";

/** The lane (or tool) asking for a classification. Only affects the default kind of third-party pages. */
export type Lane =
  | "docs"
  | "website"
  | "blog"
  | "code"
  | "changes"
  | "advisories"
  | "announcements"
  | "news"
  | "analysis"
  | "audits"
  | "incidents"
  | "data"
  | "forum"
  | "addresses"
  | "agent";

export interface DocsRootRef {
  /** Host without a leading "www.". */
  host: string;
  /** Path prefix, "" for a whole docs host. */
  prefix: string;
}

export interface OwnershipRegistry {
  name: string;
  /** Names the project goes by in prose (for relevance gates). */
  aliases: string[];
  /** Distinctive lowercase name tokens ("aztec", "railgun"), used for name-domain matching. */
  tokens: string[];
  /** Website hosts (original and after redirects), without "www.". */
  siteHosts: string[];
  docsRoots: DocsRootRef[];
  /** Verified owned domains or hosts (website, docs, GitHub org blog, X profile links, editor list). */
  domains: string[];
  /** Owned prefixes on shared platforms, e.g. "medium.com/@0xbow" or "mirror.xyz/railgun.eth". */
  ownedPaths: string[];
  /** GitHub orgs and users whose repos belong to the project (lowercase). */
  githubOwners: string[];
  /** The project's own X accounts (lowercase, no @). */
  xHandles: string[];
  /** Discourse forums the project runs. */
  forumHosts: string[];
}

export interface Classification {
  /** Null when the URL may be stored; otherwise why it must not be. */
  drop: string | null;
  sourceClass: SourceClass;
  kind: SourceKind;
  /**
   * Who publishes it. `interested_party`: another benchmarked project or a known competitor. `research`: an
   * academic venue, incident tracker or advisory database.
   */
  owner: "project" | "project_github" | "auditor" | "data" | "research" | "interested_party" | "third_party";
  /** The URL is under one of the project's docs roots, so the docs lane owns it. */
  docsRoot: boolean;
  /** The auditor, when the report is on the auditor's own host or report repository. */
  auditor?: string;
  /** An auditor the text names, when the report is hosted elsewhere (not proof that the firm wrote it). */
  claimedAuditor?: string;
}

/** Domains, GitHub owners and blog-platform paths of parties with a stake in the result (R3-JDG-6). */
export interface InterestedParties {
  domains: string[];
  githubOwners: string[];
  ownedPaths: string[];
}

export interface ClassifyContext {
  registry: OwnershipRegistry;
  /** Other benchmarked projects and known competitors: their pages about this project are marketing. */
  interested?: InterestedParties | null;
  title?: string | null;
  /** Page text; enables auditor detection and, with `requireRelevance`, the relevance gate. */
  text?: string | null;
  /** Links on the page, when known: a page on a domain named after the project counts as its own only when it links back. */
  links?: string[] | null;
  /** Event Registry data type ("news", "pr", "blog"). */
  dataType?: string | null;
  /** Discourse author role, when known. */
  authorRole?: "staff" | "member" | null;
  /** Drop third-party pages that don't pass the relevance gate (needs `text` or `title`). */
  requireRelevance?: boolean;
}

// ---------- hosts and URLs ----------

/** Hosts where each subdomain belongs to a different owner (a tiny public-suffix list for the platforms we see). */
const SHARED_SUFFIXES = [
  "github.io",
  "gitbook.io",
  "medium.com",
  "substack.com",
  "mirror.xyz",
  "vercel.app",
  "netlify.app",
  "notion.site",
  "eth.limo",
  "eth.link",
  "pages.dev",
  "readthedocs.io",
  "blogspot.com",
  "wordpress.com",
  "co.uk",
  "com.au",
  "co.jp",
  "com.br",
  "co.kr",
  "com.cn",
  "org.uk",
];

export function hostKey(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

export function hostOf(url: string): string | null {
  try {
    return hostKey(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Same site when the hosts match ignoring a leading "www.". */
export function sameSite(a: string, b: string): boolean {
  const ha = a.includes("/") ? hostOf(a) : hostKey(a);
  const hb = b.includes("/") ? hostOf(b) : hostKey(b);
  return !!ha && ha === hb;
}

/** The registrable domain (eTLD+1), with a small built-in list of shared suffixes. */
export function registrableDomain(host: string): string {
  const h = hostKey(host);
  const labels = h.split(".");
  for (const suffix of SHARED_SUFFIXES) {
    if (h === suffix) return h;
    if (h.endsWith(`.${suffix}`)) {
      const n = suffix.split(".").length + 1;
      return labels.slice(-n).join(".");
    }
  }
  return labels.slice(-2).join(".");
}

const TRACKING_PARAM = /^(utm_\w+|ref|ref_src|source|fbclid|gclid|mc_cid|mc_eid|_hs\w+|igshid|s|t|si|trk|cmpid)$/i;

/**
 * Canonical form of a URL for storage: http(s) only, lowercase host, no fragment, no trailing slash, no tracking
 * parameters. `keepQuery: false` (the crawler's default) drops the whole query string.
 */
export function normalizeUrl(u: string, opts: { keepQuery?: boolean } = {}): string | null {
  try {
    const x = new URL(u);
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    x.hash = "";
    x.hostname = x.hostname.toLowerCase();
    if (opts.keepQuery) {
      const keep = [...x.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
      x.search = keep.length ? `?${new URLSearchParams(keep).toString()}` : "";
    } else {
      x.search = "";
    }
    if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, "");
    return x.toString();
  } catch {
    return null;
  }
}

/** The URL with "www." toggled (www.x.org ⇄ x.org), for finding a page stored under the other form. */
export function wwwVariant(url: string): string | null {
  try {
    const x = new URL(url);
    x.hostname = x.hostname.startsWith("www.") ? x.hostname.slice(4) : `www.${x.hostname}`;
    return x.toString();
  } catch {
    return null;
  }
}

/**
 * URLs whose fragment names a different record, not a place on one page: X posts stored per period
 * (x.com/tempo#2026-09), DefiLlama hack records, and synthetic schemes (evm://, attestation://, note://).
 */
function fragmentIsIdentity(url: string): boolean {
  try {
    const x = new URL(url);
    if (x.protocol !== "http:" && x.protocol !== "https:") return true;
    const h = hostKey(x.hostname);
    return /^(x|twitter)\.com$/.test(h) || (h === "defillama.com" && x.pathname.startsWith("/hacks"));
  } catch {
    return false;
  }
}

/**
 * Identity of a page for de-duplication: host without www, path without trailing slash, ".md" twin suffix or
 * "/index.html", and the non-tracking query. The fragment is kept where it identifies a record (R3-SRC-6).
 */
export function canonicalKey(url: string): string {
  const n = normalizeUrl(url, { keepQuery: true }) ?? url;
  try {
    const x = new URL(n);
    const path = x.pathname
      .replace(/\/index\.html?$/i, "")
      .replace(/\.md$/i, "")
      .replace(/\/+$/, "");
    const hash = fragmentIsIdentity(url) ? new URL(url).hash : "";
    return `${hostKey(x.hostname)}${path || "/"}${x.search}${hash}`;
  } catch {
    return n;
  }
}

/** github.com/{o}/{r}/blob/{ref}/{path} → raw.githubusercontent.com/{o}/{r}/{ref}/{path}; other URLs unchanged. */
export function githubBlobToRaw(url: string): string {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url;
}

/** raw.githubusercontent.com/{o}/{r}/{ref}/{path} → github.com/{o}/{r}/blob/{ref}/{path}; other URLs unchanged. */
export function githubRawToBlob(url: string): string {
  const m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (!m) return url;
  const rest = m[3]!.replace(/^refs\/heads\//, "");
  return `https://github.com/${m[1]}/${m[2]}/blob/${rest}`;
}

/** Owner and repo of a github.com or raw.githubusercontent.com URL. */
export function githubParts(url: string): { owner: string; repo: string | null; rest: string } | null {
  try {
    const x = new URL(url);
    const h = hostKey(x.hostname);
    const segs = x.pathname.split("/").filter(Boolean);
    if (h === "github.com" && segs[0]) return { owner: segs[0], repo: segs[1] ?? null, rest: segs.slice(2).join("/") };
    if (h === "raw.githubusercontent.com" && segs[0]) return { owner: segs[0], repo: segs[1] ?? null, rest: `raw/${segs.slice(2).join("/")}` };
    if (h.endsWith(".github.io")) return { owner: h.slice(0, -".github.io".length), repo: null, rest: segs.join("/") };
    return null;
  } catch {
    return null;
  }
}

// ---------- policy lists ----------

/** Hosts that are never sources: mirrors, AI summaries, SEO farms, staging copies and search engines. */
const DROP_HOSTS: [RegExp, string][] = [
  [/(^|\.)deepwiki\.com$/, "AI-generated summary"],
  [/(^|\.)(devin\.ai|codewiki\.\w+|gitingest\.com|repomix\.com)$/, "AI-generated summary"],
  [/(^|\.)nitter\.|(^|\.)xcancel\.com$|(^|\.)twstalker\.com$|(^|\.)sotwe\.com$|(^|\.)twittervideodownloader/, "social-media mirror"],
  [/(^|\.)freedium[\w-]*\.\w+$|(^|\.)scribe\.rip$|(^|\.)archive\.(ph|is|today|org)$|(^|\.)ghostarchive\.org$/, "page mirror"],
  [/(^|\.)github\.laiyagushi\.com$|githubmirror|(^|\.)gitee\.com$|(^|\.)githubhelp\.com$|(^|\.)gitmemory\.com$/, "code mirror"],
  [/(^|\.)layerthelatestinalattice\.com$|(^|\.)paperswithcode\.com$|(^|\.)semanticscholar\.org$|(^|\.)scholar\.archive\.org$|(^|\.)arxiv\.gg$/, "paper mirror"],
  // Reposts of other people's posts, rewritten or summarised by a model (R3-SRC-4, R3-SRC-14).
  [/(^|\.)cyfar\.ca$|(^|\.)mirror\.glasslane\.io$/, "AI-generated repost"],
  [/(^|\.)exa\.ai$/, "search-engine page"],
  [/^stg[-.]|^staging[-.]|^dev-www\.|^preview[-.]/, "staging copy"],
  [
    /(^|\.)(hindenrank\.com|dextools\.io|cryptogloss\.io|ogaudit\.com|sentinacle\.\w+|odinscan\.ai|blockvet\.io|itokenly\.com|cryptoadventure\.com|coinlore\.com|coincodex\.com|coinbureau\.com|bitget\.com|binance\.com|mexc\.com|bitrue\.com|kucoin\.com|btcc\.com|weex\.tech|lbank\.com|phemex\.com|cryptorank\.io|coinmarketcap\.com|coingecko\.com|outposts\.io|cx\.ua|eno\.cx\.ua|0xposed\.io|tokenterminal\.com|messari\.io|trustblock\.run|safeedges\.in|cryptosmedia\.com|tradersunion\.com)$/,
    "SEO or aggregator page",
  ],
];

/** Third-party GitHub URLs that are never analyses (commits, gists, compare views). */
const THIRD_PARTY_GITHUB_DROP = /^(commit|commits|compare|pull|issues|actions|network|stargazers|forks)(\/|$)/;

/** Security firms. A report hosted by one of them, or naming one on its first page, is an independent audit. */
export const AUDITORS: { name: string; hosts: string[]; github: string[]; re: RegExp }[] = [
  { name: "OpenZeppelin", hosts: ["openzeppelin.com"], github: [], re: /\bOpenZeppelin\b/ },
  { name: "Trail of Bits", hosts: ["trailofbits.com"], github: ["trailofbits/publications"], re: /\bTrail of Bits\b/i },
  {
    name: "Consensys Diligence",
    hosts: ["diligence.consensys.io", "consensys.io/diligence", "diligence.consensys.net"],
    github: [],
    re: /\bConsen[sS]ys Diligence\b/,
  },
  { name: "Spearbit", hosts: ["spearbit.com"], github: ["spearbit/portfolio"], re: /\bSpearbit\b/ },
  { name: "Cantina", hosts: ["cantina.xyz"], github: [], re: /\bCantina\b/ },
  { name: "Code4rena", hosts: ["code4rena.com"], github: ["code-423n4"], re: /\bCode4rena\b|\bC4 audit\b/i },
  {
    name: "Sherlock",
    hosts: ["sherlock.xyz", "audits.sherlock.xyz"],
    github: ["sherlock-protocol/sherlock-reports"],
    re: /\bSherlock (audit|contest|security|protocol)\b/i,
  },
  { name: "Zellic", hosts: ["zellic.io", "reports.zellic.io"], github: ["zellic/publications"], re: /\bZellic\b/ },
  { name: "Veridise", hosts: ["veridise.com"], github: ["veridise"], re: /\bVeridise\b/ },
  { name: "ABDK", hosts: ["abdk.consulting"], github: ["abdk-consulting"], re: /\bABDK\b/ },
  { name: "Zokyo", hosts: ["zokyo.io"], github: ["zokyo-sec"], re: /\bZokyo\b/i },
  { name: "HashCloak", hosts: ["hashcloak.com"], github: [], re: /\bHash[Cc]loak\b/ },
  { name: "Nethermind", hosts: ["nethermind.io"], github: ["nethermindeth/publicauditreports"], re: /\bNethermind( Security)?\b/ },
  { name: "Cyfrin", hosts: ["cyfrin.io"], github: ["cyfrin/cyfrin-audit-reports"], re: /\bCyfrin\b/ },
  { name: "Certora", hosts: ["certora.com"], github: ["certora/security-reports"], re: /\bCertora\b/ },
  { name: "ChainSecurity", hosts: ["chainsecurity.com"], github: [], re: /\bChainSecurity\b/ },
  { name: "Quantstamp", hosts: ["quantstamp.com", "certificate.quantstamp.com"], github: [], re: /\bQuantstamp\b/ },
  { name: "Halborn", hosts: ["halborn.com"], github: ["halbornsecurity/publicreports"], re: /\bHalborn\b/ },
  { name: "Hacken", hosts: ["hacken.io"], github: [], re: /\bHacken\b/ },
  { name: "Least Authority", hosts: ["leastauthority.com"], github: [], re: /\bLeast Authority\b/ },
  { name: "NCC Group", hosts: ["nccgroup.com", "research.nccgroup.com"], github: [], re: /\bNCC Group\b/ },
  { name: "Sigma Prime", hosts: ["sigmaprime.io"], github: [], re: /\bSigma Prime\b/ },
  { name: "Runtime Verification", hosts: ["runtimeverification.com"], github: [], re: /\bRuntime Verification\b/ },
  { name: "Kudelski Security", hosts: ["kudelskisecurity.com"], github: [], re: /\bKudelski\b/ },
  { name: "Cure53", hosts: ["cure53.de"], github: [], re: /\bCure53\b/ },
  { name: "X41 D-Sec", hosts: ["x41-dsec.de"], github: [], re: /\bX41 D-Sec\b/i },
  { name: "MixBytes", hosts: ["mixbytes.io"], github: ["mixbytes/audits_public"], re: /\bMixBytes\b/ },
  { name: "Pessimistic", hosts: ["pessimistic.io"], github: ["pessimistic-io/audits"], re: /\bPessimistic\b/ },
  { name: "Statemind", hosts: ["statemind.io"], github: [], re: /\bStatemind\b/ },
  { name: "zkSecurity", hosts: ["zksecurity.xyz", "reports.zksecurity.xyz"], github: ["zksecurity"], re: /\bzkSecurity\b/ },
  { name: "OtterSec", hosts: ["osec.io", "ottersec.io"], github: ["otter-sec"], re: /\bOtter ?Sec\b/i },
  { name: "Macro", hosts: ["0xmacro.com"], github: [], re: /\b0xMacro\b|\bMacro (audit|security)\b/i },
  { name: "Dedaub", hosts: ["dedaub.com"], github: [], re: /\bDedaub\b/ },
  { name: "Coinspect", hosts: ["coinspect.com"], github: [], re: /\bCoinspect\b/ },
  { name: "iosiro", hosts: ["iosiro.com"], github: [], re: /\biosiro\b/i },
  { name: "Trust Security", hosts: ["trust-security.xyz"], github: ["trust1995"], re: /\bTrust Security\b/ },
  { name: "Pashov Audit Group", hosts: ["pashov.net"], github: ["pashov/audits"], re: /\bPashov\b/ },
  { name: "Hexens", hosts: ["hexens.io"], github: [], re: /\bHexens\b/ },
  { name: "FuzzingLabs", hosts: ["fuzzinglabs.com"], github: [], re: /\bFuzzingLabs\b/ },
  { name: "Guardian Audits", hosts: ["guardianaudits.com"], github: ["guardianaudits"], re: /\bGuardian Audits\b/ },
  { name: "BlockSec", hosts: ["blocksec.com"], github: [], re: /\bBlockSec\b/ },
  { name: "PeckShield", hosts: ["peckshield.com"], github: [], re: /\bPeckShield\b/i },
  { name: "SlowMist", hosts: ["slowmist.com", "slowmist.medium.com"], github: ["slowmist"], re: /\bSlowMist\b/i },
  { name: "Ackee Blockchain", hosts: ["ackee.xyz"], github: ["ackee-blockchain"], re: /\bAckee\b/ },
  { name: "Oak Security", hosts: ["oaksecurity.io"], github: ["oak-security/audit-reports"], re: /\bOak Security\b/ },
  { name: "Informal Systems", hosts: ["informal.systems"], github: [], re: /\bInformal Systems\b/ },
  { name: "Three Sigma", hosts: ["threesigma.xyz"], github: [], re: /\bThree Sigma\b/ },
  { name: "Electisec", hosts: ["electisec.com", "reports.electisec.com", "reports.yaudit.dev"], github: [], re: /\bElectisec\b|\byAudit\b/ },
  { name: "Composable Security", hosts: ["composable-security.com"], github: [], re: /\bComposable Security\b/ },
  { name: "Inference", hosts: ["inference.ag"], github: [], re: /\bInference AG\b/ },
  { name: "Solidified", hosts: ["solidified.io"], github: ["solidified-platform/audits"], re: /\bSolidified\b/ },
  { name: "Omniscia", hosts: ["omniscia.io"], github: [], re: /\bOmniscia\b/ },
  { name: "Sec3", hosts: ["sec3.dev"], github: [], re: /\bSec3\b/ },
  { name: "Neodyme", hosts: ["neodyme.io"], github: [], re: /\bNeodyme\b/ },
  { name: "Beosin", hosts: ["beosin.com"], github: [], re: /\bBeosin\b/ },
  { name: "Zenith", hosts: ["zenith.security"], github: [], re: /\bZenith (audit|security)\b/i },
  { name: "Riley Holterhus", hosts: [], github: [], re: /\bRiley Holterhus\b/ },
  { name: "Oxorio", hosts: ["oxor.io", "audits.oxor.io", "oxor-io.github.io"], github: ["oxor-io"], re: /\bOxorio\b|\bOXORIO\b/ },
  { name: "Auditware", hosts: ["auditware.io"], github: ["auditware"], re: /\bAuditware\b/i },
  { name: "CertiK", hosts: ["certik.com", "skynet.certik.com"], github: ["certikproject"], re: /\bCertiK\b/ },
  { name: "Shieldify", hosts: ["shieldify.org"], github: ["shieldify-security"], re: /\bShieldify\b/ },
  { name: "ChainLight", hosts: ["chainlight.io"], github: [], re: /\bChainLight\b/ },
  { name: "Asymmetric Research", hosts: ["asymmetric.re"], github: [], re: /\bAsymmetric Research\b/ },
  { name: "Offside Labs", hosts: ["offside.io"], github: [], re: /\bOffside Labs\b/ },
  { name: "Decurity", hosts: ["decurity.io"], github: [], re: /\bDecurity\b/ },
  { name: "Bailsec", hosts: ["bailsec.io"], github: [], re: /\bBailsec\b/ },
  { name: "Obsidian Audits", hosts: ["obsidianaudits.com"], github: [], re: /\bObsidian Audits\b/ },
];

/** Independent data providers and explorers. */
const DATA_HOSTS: [RegExp, SourceKind, SourceClass][] = [
  // The data sites themselves; their forums and blogs go through the relevance gate like any third party.
  [/^l2beat\.com$/, "l2beat", "independent"],
  [/^defillama\.com$|(^|\.)llama\.fi$/, "defillama", "independent"],
  [/^dune\.com$/, "analysis", "independent"],
  [/(^|\.)sourcify\.dev$/, "code", "code_onchain"],
  [
    /(^|\.)(etherscan\.io|basescan\.org|arbiscan\.io|optimistic\.etherscan\.io|polygonscan\.com|bscscan\.com|blockscout\.com|voyager\.online|starkscan\.co)$/,
    "onchain",
    "code_onchain",
  ],
];

/**
 * Venues whose publications are independent work (R3-JDG-6): academic papers and preprints, research forums,
 * incident trackers and vulnerability databases. Everything else written by a third party is `third_party`.
 */
const RESEARCH_HOSTS =
  /(^|\.)(iacr\.org|arxiv\.org|ethresear\.ch|ethereum-magicians\.org|usenix\.org|dl\.acm\.org|ieeexplore\.ieee\.org|link\.springer\.com|ssrn\.com|petsymposium\.org|ndss-symposium\.org|rekt\.news|hacked\.slowmist\.io|osv\.dev|nvd\.nist\.gov|cve\.org|cve\.mitre\.org)$/;
const PRESS_HOSTS =
  /(^|\.)(prnewswire\.com|businesswire\.com|globenewswire\.com|accesswire\.com|newsfilecorp\.com|einpresswire\.com|chainwire\.org|prweb\.com|newswire\.com|marketwatch\.com\/press-release|financialcontent\.com|digitaljournal\.com\/pr|benzinga\.com\/pressreleases)$/;
const SOCIAL_HOSTS =
  /(^|\.)(x\.com|twitter\.com|t\.co|reddit\.com|t\.me|tg\.me|telegram\.me|discord\.gg|discord\.com|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|linkedin\.com|warpcast\.com|farcaster\.xyz)$/;

/**
 * Privacy projects outside the benchmark directory whose pages about a benchmarked project are written by a
 * competitor (marketing). Each domain was checked to be the named project's site on 2026-10-01.
 */
export const COMPETITOR_DOMAINS = [
  "hinkal.io",
  "veil.cash",
  "pantherprotocol.io",
  "penumbra.zone",
  "namada.net",
  "z.cash",
  "electriccoin.co",
  "getmonero.org",
  "aleo.org",
  "scrt.network",
  "ironfish.network",
  "zkbob.com",
  "payy.network",
  "fhenix.io",
  "inco.org",
  "arcium.com",
  "lightprotocol.com",
  "nocturne.xyz",
  "railway.xyz",
  "permissionless-technologies.com",
  "silentswap.com",
];

const FORUM_SUBDOMAIN = /^(forum|forums|community|gov|governance|research|discuss|discourse)\./;
const BLOG_PATH = /(^|\/)(blog|blogs|news|posts?|announcements?|updates?|articles?|press|press-releases?|insights|stories|newsroom|media)(\/|$)/i;
const MARKETING_PATH =
  /(^|\/)(ecosystem|community|careers|jobs|brand|press-kit|events?|team|partners?|grants?|ambassadors?|swag|merch|newsletter|customer-stories|case-studies|customers|solutions|institutions|enterprise|use-cases|dapps|apps|videos?|webinars?|podcasts?|tutorials?)(\/|$)/i;
/** Top-level landing pages for audiences ("/developers", "/builders") on a website, not documentation. */
const LANDING_PATH = /^\/(developers?|builders?|build|start|get-started|learn)\/?$/i;
/** SEO article trees on a website ("cross-border payments in Latin America"): marketing unless under a docs root (R3-SRC-15). */
const SEO_PATH = /^\/(learn|articles?|glossary|academy|explainers?|what-is)\//i;
const DOCS_HOST = /^(docs|doc|developers?|dev|learn|wiki|guide|guides|book|handbook|specs?)\./;
const AUDIT_PATH = /(^|\/)(audits?|audit-reports?|security-reviews?|reports?)\/[^/]+\.(pdf|md)$/i;

// ---------- registry ----------

const GENERIC_NAME_WORDS = new Set([
  "network",
  "protocol",
  "labs",
  "the",
  "finance",
  "chain",
  "foundation",
  "project",
  "app",
  "dao",
  "xyz",
  "io",
  "privacy",
  "pool",
  "pools",
  "wallet",
  "token",
  "tokens",
  "cash",
  "money",
  "l1",
  "l2",
]);

/** Distinctive lowercase tokens of a project's name and slug ("Privacy Pools" has none on its own; the joined form is used). */
export function nameTokens(name: string, slug = ""): string[] {
  const words = `${name} ${slug}`
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  const joined = name
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const out = [...new Set(words)];
  if (joined.length >= 5 && !out.includes(joined)) out.push(joined);
  return out;
}

/**
 * Names used in prose: the project name without a parenthetical qualifier, its joined form for multi-word names,
 * and any editor-supplied aliases. "STRK20 (Starknet)" → ["STRK20"]; "Privacy Pools" → ["Privacy Pools", "PrivacyPools"].
 */
export function deriveAliases(name: string, extra: string[] = []): string[] {
  const base = name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const out = new Set<string>();
  if (base) out.add(base);
  const words = base.split(/\s+/).filter(Boolean);
  if (words.length > 1) out.add(words.join(""));
  for (const a of extra) if (a.trim().length >= 2) out.add(a.trim());
  return [...out];
}

export interface RegistryInput {
  name: string;
  slug: string;
  websiteUrl: string;
  /** The website URL after redirects, when known. */
  websiteFinalUrl?: string | null;
  docsUrl?: string | null;
  docsRoots?: { url: string; prefix?: string }[];
  githubRepos?: string[];
  extraDomains?: string[];
  newsAliases?: string[];
  xHandles?: string[];
  /** GitHub org/user profiles of the project: their `blog` field is an owned site. */
  githubProfiles?: { login: string; blog?: string | null }[];
  /** Links on the project's verified X profile. */
  xProfileUrls?: string[];
  forumHosts?: string[];
  /** Extra GitHub owners verified by other means (e.g. linked from the website). */
  githubOwners?: string[];
  /**
   * Links on the project's homepage. Domains among them that are named after the project (aztec-labs.com) are
   * verified as owned; other linked domains (partners, investors) are not (R3-SRC-11).
   */
  siteLinks?: string[];
}

/** Platforms and link hubs: a profile can link them, but nobody owns the whole registrable domain. */
const NOT_OWNABLE = new Set([
  "linktr.ee",
  "link3.to",
  "bio.link",
  "beacons.ai",
  "lnk.bio",
  "t.me",
  "telegram.me",
  "discord.gg",
  "discord.com",
  "github.com",
  "githubusercontent.com",
  "medium.com",
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "mirror.xyz",
  "substack.com",
  "paragraph.xyz",
  "hackmd.io",
  "notion.site",
  "google.com",
  "bit.ly",
  "t.co",
  "gitbook.io",
  "reddit.com",
  "warpcast.com",
  "farcaster.xyz",
  "instagram.com",
  "facebook.com",
  "tiktok.com",
  "github.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "eth.limo",
]);

/** The registrable domain to treat as owned, or null for platforms nobody owns as a whole. */
function ownableDomain(host: string): string | null {
  const r = registrableDomain(host);
  return NOT_OWNABLE.has(r) ? null : r;
}

/** Adds an editor- or profile-supplied domain: a host, a URL, a "github.com/<org>" owner, or an owned path on a blog platform. */
function addDomain(set: Set<string>, paths: Set<string>, owners: Set<string>, raw: string | null | undefined) {
  if (!raw) return;
  const s = raw.trim();
  if (!s) return;
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    const host = hostKey(u.hostname);
    const path = u.pathname.replace(/\/+$/, "");
    if (host === "github.com") {
      const owner = path.split("/")[1];
      if (owner) owners.add(owner.toLowerCase());
      return;
    }
    if (path && path !== "/" && /(medium\.com|mirror\.xyz|substack\.com|paragraph\.xyz|hackmd\.io)$/.test(host)) {
      paths.add(`${host}${path}`.toLowerCase());
      return;
    }
    const d = ownableDomain(host);
    if (d) set.add(d);
  } catch {
    // not a URL
  }
}

/** Builds the ownership registry from configuration plus whatever discovery found (all inputs optional but the first three). */
export function createRegistry(input: RegistryInput): OwnershipRegistry {
  const domains = new Set<string>();
  const paths = new Set<string>();
  const siteHosts = new Set<string>();
  const githubOwners = new Set<string>();
  for (const u of [input.websiteUrl, input.websiteFinalUrl]) {
    const h = u ? hostOf(u) : null;
    if (h) {
      siteHosts.add(h);
      const d = ownableDomain(h);
      domains.add(d ?? h);
    }
  }
  const docsRoots: DocsRootRef[] = [];
  // A configured root's path is its scope; a bare docs URL on a docs host (docs.x.org/wiki) covers the whole host.
  const addRoot = (url: string, prefix?: string, wholeDocsHost = false) => {
    try {
      const u = new URL(url);
      const host = hostKey(u.hostname);
      const raw = prefix ?? (wholeDocsHost && DOCS_HOST.test(host) ? "" : u.pathname);
      const p = raw.replace(/\/+$/, "");
      if (!docsRoots.some((r) => r.host === host && r.prefix === p)) docsRoots.push({ host, prefix: p });
      // A docs host on a platform (railgun.gitbook.io) is owned as a host; on the project's own domain, the domain is.
      domains.add(ownableDomain(host) ?? host);
    } catch {
      // ignore
    }
  };
  for (const r of input.docsRoots ?? []) addRoot(r.url, r.prefix);
  if (input.docsUrl) addRoot(input.docsUrl, undefined, true);
  for (const d of input.extraDomains ?? []) addDomain(domains, paths, githubOwners, d);
  for (const p of input.githubProfiles ?? []) addDomain(domains, paths, githubOwners, p.blog);
  for (const u of input.xProfileUrls ?? []) addDomain(domains, paths, githubOwners, u);
  for (const r of input.githubRepos ?? []) {
    const owner = r.split("/")[0]?.toLowerCase();
    if (owner) githubOwners.add(owner);
  }
  for (const p of input.githubProfiles ?? []) githubOwners.add(p.login.toLowerCase());
  for (const o of input.githubOwners ?? []) githubOwners.add(o.toLowerCase());
  const tokens = nameTokens(input.name, input.slug);
  for (const l of input.siteLinks ?? []) {
    const h = hostOf(l);
    const d = h ? ownableDomain(h) : null;
    if (d && isNameLabel(tokens, d.split(".")[0] ?? "")) domains.add(d);
  }
  return {
    name: input.name,
    aliases: deriveAliases(input.name, input.newsAliases ?? []),
    tokens,
    siteHosts: [...siteHosts],
    docsRoots,
    domains: [...domains],
    ownedPaths: [...paths],
    githubOwners: [...githubOwners],
    xHandles: (input.xHandles ?? []).map((h) => h.toLowerCase().replace(/^@/, "")),
    forumHosts: (input.forumHosts ?? []).map(hostKey),
  };
}

/** Union of two registries (a persisted one from the last refresh and one from current configuration). Pure. */
export function mergeRegistries(a: OwnershipRegistry, b: OwnershipRegistry): OwnershipRegistry {
  const u = <T>(x: T[], y: T[]) => [...new Set([...x, ...y])];
  const roots = [...a.docsRoots];
  for (const r of b.docsRoots) if (!roots.some((x) => x.host === r.host && x.prefix === r.prefix)) roots.push(r);
  return {
    name: b.name || a.name,
    aliases: u(b.aliases, a.aliases),
    tokens: u(b.tokens, a.tokens),
    siteHosts: u(a.siteHosts, b.siteHosts),
    docsRoots: roots,
    domains: u(a.domains, b.domains),
    ownedPaths: u(a.ownedPaths, b.ownedPaths),
    githubOwners: u(a.githubOwners, b.githubOwners),
    xHandles: u(a.xHandles, b.xHandles),
    forumHosts: u(a.forumHosts, b.forumHosts),
  };
}

/** True when the host is one of the registry's verified domains or a subdomain of one. */
export function isOwnedHost(reg: OwnershipRegistry, host: string): boolean {
  const h = hostKey(host);
  return reg.domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Domains named after the project (zama.ai, aztec-labs.com, aztec.medium.com). A name alone proves nothing (TEMPO.CO
 * is an Indonesian newspaper), so such a domain counts as the project's only when it is verified: in the registry
 * (linked from the site, the X profile or the GitHub org) or linking back to a registry domain (R3-SRC-11).
 */
export function isNameDomain(reg: OwnershipRegistry, host: string): boolean {
  const reg2 = registrableDomain(host);
  return isNameLabel(reg.tokens, reg2.split(".")[0] ?? "");
}

function isNameLabel(tokens: string[], raw: string): boolean {
  const label = raw.toLowerCase().replace(/^@/, "").replace(/[-_.]/g, "");
  if (!label) return false;
  return tokens.some(
    (t) => t.length >= 4 && (label === t || new RegExp(`^${t}(labs|protocol|network|foundation|dao|association|hq|xyz|io|app|official|eth)$`).test(label)),
  );
}

/** A publication on a blog platform named after the project (medium.com/aztec-protocol, mirror.xyz/railgun.eth). Unverified, like name domains. */
export function isNamePath(reg: OwnershipRegistry, url: string): boolean {
  try {
    const u = new URL(url);
    if (!/(^|\.)(medium\.com|mirror\.xyz|paragraph\.xyz|hackmd\.io)$/.test(hostKey(u.hostname))) return false;
    return isNameLabel(reg.tokens, u.pathname.split("/").filter(Boolean)[0] ?? "");
  } catch {
    return false;
  }
}

/** True when any of the page's links points at one of the registry's verified domains. */
export function linksBack(reg: OwnershipRegistry, links: string[] | null | undefined): boolean {
  for (const l of links ?? []) {
    const h = hostOf(l);
    if (h && isOwnedHost(reg, h)) return true;
  }
  return false;
}

/** The interested party behind a URL (another benchmarked project or a competitor), or null. */
export function interestedPartyOf(interested: InterestedParties | null | undefined, url: string): string | null {
  if (!interested) return null;
  const host = hostOf(url);
  if (!host) return null;
  const d = interested.domains.find((x) => host === x || host.endsWith(`.${x}`));
  if (d) return d;
  const gh = githubParts(url);
  if (gh && interested.githubOwners.includes(gh.owner.toLowerCase())) return `github.com/${gh.owner.toLowerCase()}`;
  try {
    const u = new URL(url);
    const key = `${hostKey(u.hostname)}${u.pathname}`.toLowerCase();
    return interested.ownedPaths.find((p) => key === p || key.startsWith(`${p}/`)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Interested parties from other projects' registries plus the competitor list, minus anything the project itself
 * owns and the platforms nobody owns as a whole. Pure.
 */
export function buildInterestedParties(own: OwnershipRegistry, others: OwnershipRegistry[], competitors: string[] = COMPETITOR_DOMAINS): InterestedParties {
  const domains = new Set<string>();
  const owners = new Set<string>();
  const paths = new Set<string>();
  const ownsHost = (h: string) => isOwnedHost(own, h) || own.domains.some((d) => d === h || d.endsWith(`.${h}`));
  for (const r of others) {
    for (const d of r.domains) if (!ownsHost(d) && !NOT_OWNABLE.has(registrableDomain(d)) && !auditorForHost(d)) domains.add(hostKey(d));
    for (const o of r.githubOwners) if (!own.githubOwners.includes(o)) owners.add(o.toLowerCase());
    for (const p of r.ownedPaths) if (!own.ownedPaths.includes(p)) paths.add(p);
  }
  for (const d of competitors) if (!ownsHost(d)) domains.add(d);
  return { domains: [...domains], githubOwners: [...owners], ownedPaths: [...paths] };
}

function auditorForHost(host: string): boolean {
  return AUDITORS.some((a) => a.hosts.some((h) => !h.includes("/") && (host === h || host.endsWith(`.${h}`))));
}

export function isOwnedPath(reg: OwnershipRegistry, url: string): boolean {
  try {
    const u = new URL(url);
    const key = `${hostKey(u.hostname)}${u.pathname}`.toLowerCase();
    return reg.ownedPaths.some((p) => key === p || key.startsWith(`${p}/`));
  } catch {
    return false;
  }
}

/** The docs root a URL falls under, if any (www and apex treated as one). */
export function docsRootOf(reg: OwnershipRegistry, url: string): DocsRootRef | null {
  try {
    const u = new URL(url);
    const host = hostKey(u.hostname);
    const path = u.pathname.replace(/\/+$/, "");
    let best: DocsRootRef | null = null;
    for (const r of reg.docsRoots) {
      if (r.host !== host) continue;
      if (r.prefix && !(path === r.prefix || path.startsWith(`${r.prefix}/`))) continue;
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
    return best;
  } catch {
    return null;
  }
}

export function isProjectGithub(reg: OwnershipRegistry, url: string): boolean {
  const g = githubParts(url);
  return !!g && reg.githubOwners.includes(g.owner.toLowerCase());
}

export function isForumHost(reg: OwnershipRegistry, host: string): boolean {
  const h = hostKey(host);
  return reg.forumHosts.includes(h) || (FORUM_SUBDOMAIN.test(h) && isOwnedHost(reg, h));
}

// ---------- policy ----------

/** Why a URL must never be stored as a source, or null. Independent of the project. */
export function dropReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "invalid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "not http(s)";
  const host = hostKey(u.hostname);
  for (const [re, why] of DROP_HOSTS) if (re.test(host)) return why;
  return null;
}

/** A repo name that holds reports, for auditors listed by GitHub owner only (their orgs also publish tools). */
const REPORT_REPO = /audit|report|publication|portfolio|review|security|findings/i;

/**
 * The auditor behind a URL: its own host, or one of its report repositories. This is the only way a report becomes
 * `independent`; a firm named in a document's text proves nothing about who wrote it (R3-SEC-4).
 */
export function auditorForUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = hostKey(u.hostname);
  const hostPath = `${host}${u.pathname}`.toLowerCase();
  const gh = githubParts(url);
  for (const a of AUDITORS) {
    if (a.hosts.some((h) => (h.includes("/") ? hostPath.startsWith(h) : host === h || host.endsWith(`.${h}`)))) return a.name;
    if (!gh) continue;
    const owner = gh.owner.toLowerCase();
    const full = `${owner}/${gh.repo ?? ""}`.toLowerCase();
    if (a.name === "Code4rena") {
      // Only the published findings report of a contest: contest repos hold sponsor-written READMEs and "known
      // issues", and findings issues are unjudged warden submissions.
      if (owner === "code-423n4" && /-findings$/i.test(gh.repo ?? "") && /^(blob|raw)\/[^/]+\/report\.md$/i.test(gh.rest)) return a.name;
      continue;
    }
    if (a.github.some((g) => g.includes("/") && full === g)) return a.name;
    if (a.github.some((g) => !g.includes("/") && owner === g) && (REPORT_REPO.test(gh.repo ?? "") || /\.pdf$/i.test(u.pathname))) return a.name;
    // ConsenSys Diligence publishes reports as repos named after the audit under the ConsenSys org.
    if (a.name === "Consensys Diligence" && owner === "consensys" && /audit/i.test(gh.repo ?? "")) return a.name;
  }
  return null;
}

/** The auditor named in a report's title or first page, or null. Only the start is read: later pages cite others. */
export function detectAuditor(text: string | null | undefined): string | null {
  if (!text) return null;
  const head = text.slice(0, 3000);
  let best: { name: string; score: number } | null = null;
  for (const a of AUDITORS) {
    const re = new RegExp(a.re.source, a.re.flags.includes("g") ? a.re.flags : `${a.re.flags}g`);
    let score = 0;
    for (const m of head.matchAll(re)) {
      const at = m.index ?? 0;
      const after = head.slice(at + m[0].length, at + m[0].length + 30);
      const before = head.slice(Math.max(0, at - 60), at);
      // Mentions of a firm's open-source libraries ("OpenZeppelin Contracts", "@openzeppelin/...") don't make it the author.
      if (/^\s*(contracts|library|libraries|implementation|upgradeable|'s (erc|implementation|library))/i.test(after) || /[@/]\s*$/.test(before)) continue;
      // "Prepared by X", "Auditor: X", "© X" name the author; earlier mentions weigh more.
      const authored =
        /(prepared|conducted|performed|written|audited|reviewed|assessed|delivered)\s+(by|for)?\s*:?\s*$|auditors?\s*:?\s*$|©\s*(\d{4}\s*)?$|copyright\s*(\(c\)\s*)?(\d{4}\s*)?$/i.test(
          before,
        );
      score += (authored ? 10 : 1) + (at < 600 ? 2 : 0);
    }
    if (score && (!best || score > best.score)) best = { name: a.name, score };
  }
  return best?.name ?? null;
}

// ---------- relevance ----------

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary matcher for an alias; letters and digits count as word characters (so "Aztec" ≠ "Aztecs"' stem is fine, "defi" ≠ "definitely"). */
export function aliasRegex(alias: string, flags = "giu"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(alias)}(?![\\p{L}\\p{N}_])`, flags);
}

/**
 * Mentions of any alias. A capitalised alias ("Tempo") doesn't match the all-lowercase common word ("tempo"),
 * because news prose writes proper nouns with capitals.
 */
export function aliasMentions(text: string, aliases: string[]): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  for (const a of aliases) {
    const caseMatters = /[A-Z]/.test(a);
    for (const m of text.matchAll(aliasRegex(a))) {
      if (caseMatters && m[0] === m[0].toLowerCase()) continue;
      out.push({ index: m.index ?? 0, text: m[0] });
    }
  }
  return out.sort((x, y) => x.index - y.index);
}

/** Exa/analysis gate: an alias in the title, or at least two mentions in the first 3,000 characters. */
export function passesRelevanceGate(title: string, text: string, aliases: string[]): boolean {
  if (aliasMentions(title, aliases).length) return true;
  return aliasMentions(text.slice(0, 3000), aliases).length >= 2;
}

// ---------- classification ----------

function thirdPartyKind(lane: Lane): SourceKind {
  if (lane === "news") return "news";
  if (lane === "forum") return "governance";
  if (lane === "audits") return "audit";
  return "analysis";
}

function githubClass(rest: string, path: string, ctx: ClassifyContext): Pick<Classification, "kind" | "sourceClass" | "claimedAuditor"> {
  if (AUDIT_PATH.test(path) || /(^|\/)audits?\//i.test(path)) {
    // A report the project keeps in its own repo is the project's copy: official docs, whoever it says wrote it.
    const claimed = detectAuditor(`${ctx.title ?? ""}\n${ctx.text ?? ""}`);
    return { kind: "audit", sourceClass: "official_docs", ...(claimed ? { claimedAuditor: claimed } : {}) };
  }
  if (/^(issues|pull|pulls|discussions)(\/|$)/.test(rest)) return { kind: "docs", sourceClass: "official_docs" };
  if (/^(security\/advisories|security)(\/|$)/.test(rest)) return { kind: "changes", sourceClass: "official_docs" };
  if (/^(releases|tags)(\/|$)/.test(rest)) return { kind: "changes", sourceClass: "official_docs" };
  if (/^(commit|commits|compare)(\/|$)/.test(rest)) return { kind: "changes", sourceClass: "code_onchain" };
  if (/^(blob|raw|tree)\//.test(rest)) {
    if (/\.(md|mdx|rst|txt|adoc)$/i.test(path)) return { kind: "docs", sourceClass: "official_docs" };
    if (/^tree\//.test(rest) && !/\.\w+$/.test(path)) return { kind: "code", sourceClass: "code_onchain" };
    return { kind: "code", sourceClass: "code_onchain" };
  }
  return { kind: "docs", sourceClass: "official_docs" };
}

/** A blog, newsletter or post path, or a blog platform: someone's write-up rather than reference material. */
function isBlogLike(host: string, path: string): boolean {
  return (
    BLOG_PATH.test(path) || /^(blog|news|medium|mirror)\./.test(host) || /(^|\.)(medium\.com|mirror\.xyz|substack\.com|paragraph\.xyz|hackmd\.io)$/.test(host)
  );
}

/**
 * Classifies a URL for a project. The rules are deterministic and depend on who publishes the URL, not on the
 * lane that found it. `lane` only picks the kind of an ordinary third-party page (news vs analysis).
 */
export function classifyUrl(url: string, lane: Lane, ctx: ClassifyContext): Classification {
  const reg = ctx.registry;
  const base = (c: Partial<Classification>): Classification => ({
    drop: null,
    sourceClass: "third_party",
    kind: thirdPartyKind(lane),
    owner: "third_party",
    docsRoot: false,
    ...c,
  });
  const dropped = dropReason(url);
  if (dropped) return base({ drop: dropped });
  const u = new URL(url);
  const host = hostKey(u.hostname);
  const path = u.pathname;
  const firstPage = `${ctx.title ?? ""}\n${(ctx.text ?? "").slice(0, 3000)}`;
  const irrelevant = () => !!ctx.requireRelevance && !!(ctx.text || ctx.title) && !passesRelevanceGate(ctx.title ?? "", ctx.text ?? "", reg.aliases);

  // The project's GitHub.
  const gh = githubParts(url);
  if (gh && reg.githubOwners.includes(gh.owner.toLowerCase())) {
    return base({ owner: "project_github", ...githubClass(gh.rest, path, ctx) });
  }

  // Auditors' own sites and report repositories.
  const auditor = auditorForUrl(url);
  if (auditor) {
    // An auditor's report about another project is still irrelevant: the project must appear on its first page.
    if (ctx.requireRelevance && (ctx.text || ctx.title) && !aliasMentions(firstPage, reg.aliases).length) {
      return base({ drop: "not about the project", owner: "auditor", auditor });
    }
    const blogPost = !/\.pdf$/i.test(path) && BLOG_PATH.test(path) && !/audit|review|assessment|report/i.test(`${path} ${ctx.title ?? ""}`);
    return base({ owner: "auditor", auditor, kind: blogPost ? "analysis" : "audit", sourceClass: "independent" });
  }

  // Data providers.
  for (const [re, kind, sourceClass] of DATA_HOSTS) if (re.test(host)) return base({ owner: "data", kind, sourceClass });

  // Social media: the project's own account is an announcement; anything else is hearsay. Both are marketing.
  if (SOCIAL_HOSTS.test(host)) {
    const handle = /^(x|twitter)\.com$/.test(host) ? (path.split("/")[1] ?? "").toLowerCase() : "";
    const own = !!handle && reg.xHandles.includes(handle);
    return base({ owner: own ? "project" : "third_party", kind: own ? "announcement" : "news", sourceClass: "marketing" });
  }

  // Third-party GitHub: commits, gists, diffs, issues and contest repos are not analyses; the global advisory
  // database is independent.
  if (gh || host === "gist.github.com") {
    if (host === "gist.github.com") return base({ drop: "third-party gist" });
    if (gh!.owner.toLowerCase() === "advisories" && /^GHSA-/i.test(gh!.repo ?? ""))
      return base({ owner: "research", kind: "changes", sourceClass: "independent" });
    if (THIRD_PARTY_GITHUB_DROP.test(gh!.rest)) return base({ drop: "third-party GitHub activity" });
    if (gh!.owner.toLowerCase() === "code-423n4") return base({ drop: "Code4rena contest material (not the published report)" });
    // L2BEAT's project configs, which the data lane and the L2BEAT tools read from GitHub: L2BEAT's own assessment,
    // classed like l2beat.com (R4-28).
    if (gh!.owner.toLowerCase() === "l2beat" && gh!.repo?.toLowerCase() === "l2beat")
      return base({ owner: "data", kind: "l2beat", sourceClass: "independent" });
  }

  // The project's own hosts and pages. A domain or blog publication named after the project counts only when it is
  // verified (in the registry) or links back to one of the registry's domains (R3-SRC-11).
  const named = isNameDomain(reg, host) || isNamePath(reg, url);
  const owned = isOwnedHost(reg, host) || isOwnedPath(reg, url) || (named && linksBack(reg, ctx.links));
  if (owned) {
    if (isForumHost(reg, host)) {
      // A forum member's post is a community view hosted by the project, not independent analysis.
      return base({ owner: "project", kind: "governance", sourceClass: ctx.authorRole === "member" ? "third_party" : "official_docs" });
    }
    const root = docsRootOf(reg, url);
    if (root) return base({ owner: "project", kind: "docs", sourceClass: "official_docs", docsRoot: true });
    if (AUDIT_PATH.test(path) || (/\.pdf$/i.test(path) && /audit|security review|assessment/i.test(`${path} ${ctx.title ?? ""}`))) {
      // The project's copy of a report: official docs, with the auditor it names recorded as a claim.
      const claimed = detectAuditor(`${ctx.title ?? ""}\n${ctx.text ?? ""}`);
      return base({ owner: "project", kind: "audit", sourceClass: "official_docs", ...(claimed ? { claimedAuditor: claimed } : {}) });
    }
    if (isBlogLike(host, path) || isOwnedPath(reg, url)) return base({ owner: "project", kind: "blog", sourceClass: "marketing" });
    if (DOCS_HOST.test(host)) return base({ owner: "project", kind: "docs", sourceClass: "official_docs" });
    if (path === "/" || path === "" || MARKETING_PATH.test(path) || LANDING_PATH.test(path) || SEO_PATH.test(path)) {
      return base({ owner: "project", kind: "website", sourceClass: "marketing" });
    }
    return base({ owner: "project", kind: "website", sourceClass: "official_docs" });
  }

  // Anyone with a stake in the result: another benchmarked project, or a competitor.
  if (interestedPartyOf(ctx.interested, url)) {
    if (irrelevant()) return base({ drop: "not about the project", owner: "interested_party" });
    return base({ owner: "interested_party", kind: isBlogLike(host, path) ? "blog" : thirdPartyKind(lane), sourceClass: "marketing" });
  }

  // Press releases are the project talking, wherever they're hosted.
  if (ctx.dataType === "pr" || PRESS_HOSTS.test(host) || /\/press-?releases?\//i.test(path) || /^press release\b|\(press release\)/i.test(ctx.title ?? "")) {
    return base({ kind: "news", sourceClass: "marketing" });
  }

  // Third parties are stored only when they are about the project.
  if (irrelevant()) return base({ drop: "not about the project" });

  // An unverified domain or publication named after the project: never the project's docs, at most a third party,
  // and a blog post there is treated like the project's own marketing.
  if (named) return base({ sourceClass: isBlogLike(host, path) ? "marketing" : "third_party" });

  // A report that names an auditor but isn't on the auditor's host: the firm is a claim, not the publisher.
  const claimed =
    lane === "audits" || /audit|security review|security assessment/i.test(ctx.title ?? "") ? detectAuditor(`${ctx.title ?? ""}\n${ctx.text ?? ""}`) : null;
  if (claimed) return base({ kind: "audit", claimedAuditor: claimed });
  // Academic venues, research forums, incident trackers and vulnerability databases are independent work.
  if (RESEARCH_HOSTS.test(host)) return base({ owner: "research", kind: lane === "news" ? "news" : "analysis", sourceClass: "independent" });
  // News sites, blogs, aggregators and everything else written by a third party.
  return base({});
}

// ---------- crawl hygiene shared with the lanes ----------

const LOCALES =
  "ar|bg|bn|cs|da|de|el|es|fa|fi|fr|he|hi|hu|id|it|ja|jp|ko|kr|ms|nl|no|pl|pt|pt-br|ro|ru|sk|sv|th|tr|uk|ur|vi|zh|zh-cn|zh-tw|zh-hans|zh-hant|cn|tw";
const LOCALE_SEG = new RegExp(`^/(${LOCALES})(?:[-_][a-z]{2,4})?(/|$)`, "i");

/** A path under a non-English locale prefix (/ja/, /zh-CN/, /pt-br/...). */
export function isLocalePath(pathname: string): boolean {
  return LOCALE_SEG.test(pathname);
}

/** Legal boilerplate: terms, privacy policy, cookies, imprint. */
export function isLegalPath(pathname: string): boolean {
  // Whole segments ("/terms", "/legal/...") or hyphenated parts ("/staking-terms-conditions", "/token-sale-disclaimer").
  return (
    /(^|\/)(terms|tos|legal|imprint|impressum|gdpr)(\/|$|\.)/i.test(pathname) ||
    /(^|[/_-])(terms[-_](of[-_](service|use)|and[-_]conditions|conditions)|privacy[-_](policy|notice)|cookies?[-_]policy|cookies|disclaimer|aml[-_]policy|risk[-_]disclosure)([/_.-]|$)/i.test(
      pathname,
    )
  );
}

/** A legal page by its title ("Terms of Use | Docs"), for sites that keep legal text under unremarkable paths. */
export function isLegalTitle(title: string): boolean {
  const first = title.split(/\s[|–—-]\s/)[0]?.trim() ?? "";
  return /^(terms( of (use|service)| and conditions| & conditions)?|privacy (policy|notice|statement)|cookie (policy|notice|settings)|legal( notice| disclaimer)?|imprint|impressum|disclaimer|risk disclosure)$/i.test(
    first,
  );
}
