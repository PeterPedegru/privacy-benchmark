import { describe, expect, it } from "vitest";
import { env } from "../src/env.ts";
import {
  AUDIT_FILE,
  fileTier,
  isExcludedPath,
  isGeneratedHeader,
  isTsPrimary,
  latestDeploymentTag,
  latestStableFromTags,
  latestStableTag,
  MIN_MONITOR_SCORE,
  type OrgRepo,
  pickMonitoredRepos,
  pickPreviousTag,
  type ReleaseInfo,
  rankRepos,
  repoBudgets,
  selectFiles,
  selectReleases,
} from "../src/services/lanes/code.ts";

describe("code file tiering (SRC-6)", () => {
  it("excludes generated bindings, test stubs, test programs, mocks, examples and versioned copies", () => {
    for (const p of [
      "gateway-contracts/rust_bindings/src/gateway_config.rs",
      "contracts/teststubs/TestERC20.sol",
      "noir-projects/contract-snapshots/test_programs/execution_success/main.nr",
      "barretenberg/acir_tests/flows/prove.sh",
      "sdk/js-sdk/contracts/src/v0.12.0/ACL.sol",
      "packages/sdk/0.13.0/contracts/FHE.sol",
      "docs/network_versioned_docs/version-v5.0.1/operators/governance.md",
      "coprocessor/fhevm-engine/stress-test-generator/src/dex.rs",
      "noir-projects/mock-protocol-circuits/crates/mock-private-kernel/src/main.nr",
      "contracts/test/Pool.t.sol",
      "examples/token/src/main.nr",
      "fuzz/fuzz_targets/deposit.rs",
      "packages/relayer/src/__tests__/relayer.test.ts",
      "packages/sdk/src/index.d.ts",
      "lib/openzeppelin-contracts/contracts/access/Ownable.sol",
      "typechain-types/Pool.ts",
    ]) {
      expect(fileTier(p), p).toBeNull();
    }
    expect(isExcludedPath("l1-contracts/src/governance/Governance.sol")).toBe(false);
  });

  it("puts SECURITY.md, audit reports and deployment files in tier 0", () => {
    expect(fileTier("SECURITY.md")).toBe(0);
    expect(fileTier("audit/2025-03-veridise.md")).toBe(0);
    expect(fileTier("audits/README.md")).toBe(0);
    expect(fileTier("docs/docs/deployments.md")).toBe(0);
    expect(fileTier("deployments/mainnet/Entrypoint.json")).toBe(0);
    expect(fileTier("broadcast/Deploy.s.sol/1/run-latest.json")).toBe(0);
    expect(fileTier("contracts/addresses.json")).toBe(0);
    // Fixtures that only look like tier 0.
    expect(fileTier("test/fixtures/deployments.json")).toBeNull();
    expect(fileTier("lib/forge-std/SECURITY.md")).toBeNull();
    expect(AUDIT_FILE.test("audit/2025-03-veridise.md")).toBe(true);
    expect(AUDIT_FILE.test("audits/README.md")).toBe(false);
  });

  it("reads deploy scripts, other languages, specifications and protocol configs (tier 2), not tool configs", () => {
    expect(fileTier("contracts/script/Deploy.s.sol")).toBe(2);
    expect(fileTier("specs/phase0/beacon-chain.md")).toBe(2);
    expect(fileTier("EIPS/eip-5564.md")).toBe(2);
    expect(fileTier("src/ethereum/prague/fork.py")).toBe(2);
    expect(fileTier("canton/community/base/src/main/scala/Sequencer.scala")).toBe(2);
    expect(fileTier("daml/Splice/Amulet.daml")).toBe(1);
    expect(fileTier("config/genesis.json")).toBe(2);
    expect(fileTier("tsconfig.json")).toBeNull();
    expect(fileTier("tests/test_fork.py")).toBeNull();
    expect(fileTier("src/ethereum/fork_test.py")).toBeNull();
  });

  it("ranks contracts and circuits above Rust, and admits TypeScript only from security-relevant packages", () => {
    expect(fileTier("l1-contracts/src/core/Rollup.sol")).toBe(1);
    expect(fileTier("noir-projects/noir-protocol-circuits/crates/private-kernel/src/main.nr")).toBe(1);
    expect(fileTier("crates/node/src/lib.rs")).toBe(2);
    expect(fileTier("docs/ARCHITECTURE.md")).toBe(2);
    expect(fileTier("yarn-project/pxe/src/key_store/key_store.ts")).toBe(3);
    expect(fileTier("packages/relayer/src/handlers/withdraw.ts")).toBe(3);
    expect(fileTier("apps/site/src/components/Button.tsx")).toBeNull();
  });

  it("selects tier 0 first, de-duplicates blobs and caps TypeScript at 35%", () => {
    const entries = [
      ...Array.from({ length: 30 }, (_, i) => ({ path: `yarn-project/pxe/src/key_store/k${i}.ts`, type: "blob", size: 100, sha: `ts${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ path: `contracts/src/C${i}.sol`, type: "blob", size: 100, sha: `sol${i}` })),
      { path: "contracts/src/Copy.sol", type: "blob", size: 100, sha: "sol0" },
      { path: "SECURITY.md", type: "blob", size: 100, sha: "sec" },
      { path: "audit/report.md", type: "blob", size: 100, sha: "aud" },
      { path: "README.md", type: "blob", size: 100, sha: "readme" },
      { path: "big/Huge.sol", type: "blob", size: 3_000_000, sha: "huge" },
    ];
    const sel = selectFiles(entries, { files: 20, bytes: 10_000_000 });
    expect(sel.picked.slice(0, 2).map((p) => p.path)).toEqual(["SECURITY.md", "audit/report.md"]);
    expect(sel.duplicates).toBe(1);
    expect(sel.picked.filter((p) => p.path.endsWith(".ts")).length).toBe(7); // 35% of 20
    expect(sel.picked.some((p) => p.path === "big/Huge.sol")).toBe(false);
    expect(sel.picked.filter((p) => p.path.endsWith(".sol")).length).toBe(6);
  });

  it("ranks a TypeScript-native service's own code as code, without the cap for SDKs beside contracts", () => {
    // Like matter-labs/prividium-core: a permissions API in TypeScript with SQL migrations, and no contracts.
    const entries = [
      ...Array.from({ length: 40 }, (_, i) => ({ path: `apps/permissions-api/src/routes/r${i}.ts`, type: "blob", size: 100, sha: `api${i}` })),
      ...Array.from({ length: 10 }, (_, i) => ({ path: `packages/access-control/src/policy${i}.ts`, type: "blob", size: 100, sha: `acl${i}` })),
      ...Array.from({ length: 8 }, (_, i) => ({ path: `apps/permissions-api/migrations/00${i}_roles.sql`, type: "blob", size: 100, sha: `sql${i}` })),
      { path: "apps/permissions-api/src/routes/r0.test.ts", type: "blob", size: 100, sha: "t0" },
      { path: "packages/api-types/src/index.d.ts", type: "blob", size: 100, sha: "d0" },
      { path: "packages/access-control/vitest.config.mts", type: "blob", size: 100, sha: "cfg" },
      { path: "README.md", type: "blob", size: 100, sha: "readme" },
    ];
    expect(isTsPrimary(entries)).toBe(true);
    const sel = selectFiles(entries, { files: 100, bytes: 10_000_000 });
    expect(sel.picked.filter((p) => p.path.endsWith(".ts")).length).toBe(50);
    expect(sel.picked.filter((p) => p.path.endsWith(".sql")).length).toBe(8);
    // Tests, type declarations and tool configs stay out.
    expect(sel.picked.some((p) => /\.test\.ts$|\.d\.ts$|\.config\.mts$/.test(p.path))).toBe(false);
    // Access-control code ranks ahead of plain routes.
    expect(sel.picked.findIndex((p) => p.path.includes("access-control"))).toBeLessThan(sel.picked.findIndex((p) => p.path.endsWith("r1.ts")));
    // One contract makes it a contracts repository, where TypeScript is an SDK and keeps its cap.
    expect(isTsPrimary([...entries, { path: "contracts/src/Bridge.sol", type: "blob", size: 100, sha: "sol" }])).toBe(false);
  });

  it("recognises generated-file headers", () => {
    expect(isGeneratedHeader("// Code generated by abigen. DO NOT EDIT.\npackage x")).toBe(true);
    expect(isGeneratedHeader("/* @generated */ export const x = 1")).toBe(true);
    expect(isGeneratedHeader(`// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n${" ".repeat(400)}// auto-generated later`)).toBe(false);
  });
});

describe("refs and releases (SRC-7, SRC-14)", () => {
  const rel = (tag: string, date: string, prerelease = false, body = "Release notes with enough text to keep."): ReleaseInfo => ({
    tag_name: tag,
    name: tag,
    body,
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    published_at: `${date}T00:00:00Z`,
    draft: false,
    prerelease,
  });

  it("breaks same-day ties by semver in previousTag (v1.2.1 before v1.2.0)", () => {
    const versions = [
      { id: "a", tag: "v1.2.0", releasedAt: "2026-03-08" },
      { id: "b", tag: "v1.2.1", releasedAt: "2026-03-08" },
      { id: "c", tag: "v1.3.0", releasedAt: "2026-08-31" },
      { id: "d", tag: "v1.0.0", releasedAt: "2025-03-31" },
    ];
    expect(pickPreviousTag(versions, { id: "c", tag: "v1.3.0", releasedAt: "2026-08-31" })).toBe("v1.2.1");
    expect(pickPreviousTag([...versions].reverse(), { id: "c", tag: "v1.3.0", releasedAt: "2026-08-31" })).toBe("v1.2.1");
  });

  it("skips pre-releases and later versions when choosing the diff base", () => {
    const versions = [
      { id: "a", tag: "v5.1.0", releasedAt: "2026-07-22" },
      { id: "b", tag: "v5.2.0-rc.1", releasedAt: "2026-08-01" },
      { id: "c", tag: "v5.2.0", releasedAt: "2026-08-17" },
      { id: "d", tag: "v5.3.0", releasedAt: "2026-08-10" },
    ];
    expect(pickPreviousTag(versions, { id: "c", tag: "v5.2.0", releasedAt: "2026-08-17" })).toBe("v5.1.0");
    expect(pickPreviousTag(versions, { id: "a", tag: "v5.1.0", releasedAt: "2026-07-22" })).toBeNull();
  });

  it("picks the latest stable release tag by semver", () => {
    expect(
      latestStableTag([rel("v5.2.0", "2026-08-17"), rel("v5.3.0-rc.1", "2026-09-01", true), rel("v5.1.0", "2026-09-02"), rel("nightly", "2026-09-03")]),
    ).toBe("v5.2.0");
    expect(latestStableTag([rel("v1.0.0-beta", "2026-01-01", true)])).toBeNull();
  });

  it("falls back to tags when a repo publishes none as releases (R3-SRC-12)", () => {
    // tempoxyz/zones: tags v0.1.0 … v0.3.3, no releases.
    expect(latestStableFromTags(["v0.3.2", "v0.3.3", "v0.2.2", "v0.1.0"])).toBe("v0.3.3");
    // Prefixed tags count; release candidates never do.
    expect(latestStableFromTags(["PRIVACY-1.2.0", "PRIVACY-1.10.0", "PRIVACY-2.0.0-RC.1"])).toBe("PRIVACY-1.10.0");
    // starkware-libs/starknet-privacy: only RCs, plus tags marking mainnet deployments.
    const strk = ["PRIVACY-0.14.3-RC.8", "SCREENER-0.14.2-RC.1", "CONTRACT_V1_DEPLOYED_MAINNET_2026-04-20", "CONTRACT_V2_DEPLOYED_MAINNET_2026-07-08"];
    expect(latestStableFromTags(strk)).toBeNull();
    expect(latestDeploymentTag(strk)).toBe("CONTRACT_V2_DEPLOYED_MAINNET_2026-07-08");
    expect(latestDeploymentTag(["v1.0.0"])).toBeNull();
  });

  it("doesn't treat deployment how-to guides as address lists (R3-SRC-14)", () => {
    expect(fileTier("gateway-contracts/docs/getting-started/deployment/deploy-gateway.md")).not.toBe(0);
    expect(fileTier("deployments/mainnet.json")).toBe(0);
    expect(fileTier("deployments/addresses.md")).toBe(0);
  });

  it("keeps stable releases and only pre-releases newer than the latest stable or the previous evaluated version", () => {
    const rels = [
      rel("v0.16.1", "2026-09-25"),
      rel("v0.17.0-alpha.1", "2026-09-28", true),
      rel("v0.16.0-rc.1", "2026-08-01", true),
      rel("v0.15.0", "2026-06-01"),
      rel("v0.1.0-alpha", "2024-02-01", true),
      rel("v0.14.0", "2026-03-01", false, "short"),
    ];
    expect(selectReleases(rels).map((r) => r.tag_name)).toEqual(["v0.17.0-alpha.1", "v0.16.1", "v0.15.0"]);
    expect(selectReleases(rels, { sinceDate: "2026-07-01T00:00:00Z" }).map((r) => r.tag_name)).toEqual([
      "v0.17.0-alpha.1",
      "v0.16.1",
      "v0.16.0-rc.1",
      "v0.15.0",
    ]);
  });
});

describe("repo suggestions", () => {
  it("ranks protocol repos above docs, forks and archived ones", () => {
    const now = Date.parse("2026-09-30");
    const ranked = rankRepos(
      [
        {
          full_name: "Railgun-Privacy/contract",
          name: "contract",
          language: "Solidity",
          pushed_at: "2026-08-01",
          archived: false,
          fork: false,
          stargazers_count: 120,
          description: null,
        },
        {
          full_name: "Railgun-Privacy/circuits-v2",
          name: "circuits-v2",
          language: "Circom",
          pushed_at: "2026-06-01",
          archived: false,
          fork: false,
          stargazers_count: 40,
          description: null,
        },
        {
          full_name: "Railgun-Community/engine",
          name: "engine",
          language: "TypeScript",
          pushed_at: "2026-09-01",
          archived: false,
          fork: false,
          stargazers_count: 60,
          description: null,
        },
        {
          full_name: "Railgun-Community/docs",
          name: "docs",
          language: "MDX",
          pushed_at: "2026-09-01",
          archived: false,
          fork: false,
          stargazers_count: 5,
          description: null,
        },
        {
          full_name: "Railgun-Community/old-contract",
          name: "old-contract",
          language: "Solidity",
          pushed_at: "2021-01-01",
          archived: true,
          fork: false,
          stargazers_count: 10,
          description: null,
        },
        {
          full_name: "Railgun-Community/forge-std",
          name: "forge-std",
          language: "Solidity",
          pushed_at: "2026-01-01",
          archived: false,
          fork: true,
          stargazers_count: 0,
          description: null,
        },
      ],
      ["Railgun-Privacy/contract"],
      now,
    );
    expect(ranked.slice(0, 3).map((r) => r.repo)).toEqual(["Railgun-Privacy/contract", "Railgun-Privacy/circuits-v2", "Railgun-Community/engine"]);
    expect(ranked[0]?.configured).toBe(true);
    expect(ranked.slice(3).map((r) => r.repo)).toEqual(
      expect.arrayContaining(["Railgun-Community/docs", "Railgun-Community/old-contract", "Railgun-Community/forge-std"]),
    );
    expect(ranked.find((r) => r.repo.endsWith("old-contract"))?.reasons).toEqual(expect.arrayContaining(["archived", "no push in 2 years"]));
  });
});

describe("monitoring an org's repositories", () => {
  const now = Date.parse("2026-10-01");
  const repo = (full: string, o: Partial<OrgRepo> = {}): OrgRepo => ({
    full_name: full,
    name: full.split("/")[1]!,
    language: null,
    pushed_at: "2026-09-20",
    archived: false,
    fork: false,
    stargazers_count: 100,
    description: null,
    size: 1000,
    ...o,
  });

  it("ranks Ethereum's specifications and reference client, and drops deprecated, mock and template repos", () => {
    const ranked = rankRepos(
      [
        repo("ethereum/consensus-specs", { language: "Python", stargazers_count: 3700, description: "Ethereum Proof-of-Stake Consensus Specifications" }),
        repo("ethereum/execution-specs", { language: "Python", stargazers_count: 900, description: "Specification for the Execution Layer" }),
        repo("ethereum/go-ethereum", { language: "Go", stargazers_count: 48000, description: "Go implementation of the Ethereum protocol" }),
        repo("ethereum/ERCs", { language: "Solidity", stargazers_count: 600 }),
        repo("ethereum/ethereum-org-website", { language: "TypeScript", stargazers_count: 5000 }),
        repo("zama-ai/fhevm-mocks", { language: "TypeScript", stargazers_count: 20 }),
        repo("zama-ai/fhevm-foundry-template", { language: "Solidity", stargazers_count: 20 }),
        repo("AztecProtocol/aztec-connect-contracts", { language: "Solidity", stargazers_count: 300, description: "Deprecated: Aztec Connect was sunset" }),
      ],
      [],
      now,
    );
    const score = (r: string) => ranked.find((x) => x.repo === r)!.score;
    for (const r of ["ethereum/consensus-specs", "ethereum/execution-specs", "ethereum/go-ethereum", "ethereum/ERCs"])
      expect(score(r), r).toBeGreaterThanOrEqual(MIN_MONITOR_SCORE);
    for (const r of ["ethereum/ethereum-org-website", "zama-ai/fhevm-mocks", "zama-ai/fhevm-foundry-template"])
      expect(score(r), r).toBeLessThan(MIN_MONITOR_SCORE);
    // A deprecated repo is never monitored, whatever else it has going for it.
    expect(ranked.find((x) => x.repo === "AztecProtocol/aztec-connect-contracts")!.deprecated).toBe(true);
    expect(
      pickMonitoredRepos(ranked, { dedicatedOwners: ["aztecprotocol", "ethereum", "zama-ai"], tokens: [], limit: 20, now }).map((r) => r.repo),
    ).not.toContain("AztecProtocol/aztec-connect-contracts");
  });

  it("monitors active, relevant repos of the project's own org, and only repos naming the project in a shared org", () => {
    const ranked = rankRepos(
      [
        repo("ethereum/consensus-specs", { language: "Python", stargazers_count: 3700, description: "Consensus specifications" }),
        repo("ethereum/old-contracts", { language: "Solidity", pushed_at: "2024-01-01" }),
        repo("ethereum/empty-contracts", { language: "Solidity", size: 0 }),
        repo("ethereum/forked-contracts", { language: "Solidity", fork: true }),
        repo("starkware-libs/starkex-contracts", { language: "Solidity", stargazers_count: 5000 }),
        repo("starkware-libs/strk20-contracts", { language: "Cairo", stargazers_count: 10 }),
      ],
      ["starkware-libs/starknet-privacy"],
      now,
    );
    const picked = pickMonitoredRepos(ranked, { dedicatedOwners: ["ethereum"], tokens: ["strk20", "ethereum"], limit: 8, now }).map((r) => r.repo);
    expect(picked).toEqual(expect.arrayContaining(["ethereum/consensus-specs", "starkware-libs/strk20-contracts"]));
    expect(picked).not.toContain("starkware-libs/starkex-contracts");
    expect(picked).not.toContain("ethereum/old-contracts");
    expect(picked).not.toContain("ethereum/empty-contracts");
    expect(picked).not.toContain("ethereum/forked-contracts");
    expect(pickMonitoredRepos(ranked, { dedicatedOwners: ["ethereum"], tokens: [], limit: 1, now })).toHaveLength(1);
  });

  it("keeps the configured repos' budget, and gives discovered repos their own (all of it with none configured)", () => {
    const b = repoBudgets(2, 4);
    expect(b.configured.files).toBe(Math.floor(env.kb.maxCodeFiles / 2));
    expect(b.discovered.files).toBe(Math.floor(env.kb.maxDiscoveredCodeFiles / 4));
    expect(repoBudgets(0, 5).discovered.files).toBe(Math.floor((env.kb.maxCodeFiles + env.kb.maxDiscoveredCodeFiles) / 5));
  });
});
