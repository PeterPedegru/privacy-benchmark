import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

/**
 * The whole Railway project, as code. Replaces railway.json (Config as Code, retired 2026-12-01).
 *
 * Applies delete what this file omits, so every live resource, domain and variable is declared. Variables are
 * preserve(): Railway keeps the stored value and no secret is written here. A variable added in the dashboard
 * must be added below (as preserve()) before the next apply, or the apply removes it.
 */
export default defineRailway(() => {
  // The database. The web service reaches it on the private network; the local CLI (`pnpm bench`, through
  // `railway run`) through its public URL.
  const db = postgres("postgres", { region: "us-east4-eqdc4a" });
  // The public TCP proxy behind DATABASE_PUBLIC_URL (password-protected, TLS). postgres() doesn't take networking.
  db.networking = { tcpProxies: { "5432": {} } };
  // Railway references, resolved by Railway: no credential is written here.
  db.variables = {
    DATABASE_PUBLIC_URL: {
      type: "literal",
      value: "postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}/${{PGDATABASE}}",
    },
  };

  // Logical backups (daily and before migrations) live here, and the SQLite database the app ran on before Postgres,
  // which the first Postgres boot imports and leaves as it was.
  const webVolume = volume("web-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-east4-eqdc4a",
    sizeMB: 50000,
  });

  const web = service("web", {
    source: github("rolldavid/privacy-benchmark", { branch: "main", checkSuites: false }),
    build: {
      builder: "RAILPACK",
      buildEnvironment: "V3",
      buildCommand: "pnpm --filter @pb/web build && pnpm --filter @pb/server build",
      watchPatterns: ["apps/**", "packages/**", "evals/sample/**", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".railway/**", ".node-version"],
    },
    // The regexp flag bounds backtracking on untrusted page content.
    start: "node --enable-source-maps --enable-experimental-regexp-engine-on-excessive-backtracks apps/server/dist/index.js",
    healthcheck: "/api/health",
    // The first boot on Postgres imports the SQLite database before it listens.
    healthcheckTimeout: 600,
    deploy: {
      // In-flight requests and the evaluation queue get 25 s to finish (the server drains on SIGTERM).
      drainingSeconds: 25,
      // Restart policy is Railway's default (on failure, up to 10 restarts), which Railway stores as unset, so it
      // isn't declared: declaring it leaves a permanent diff in every plan.
      runtime: "V2",
      useLegacyStacker: false,
      ipv6EgressEnabled: false,
    },
    replicas: { "us-east4-eqdc4a": 1 },
    // The custom domain is registered in the dashboard (configuration can't register one); declared as it's stored.
    networking: {
      customDomains: { "privacybenchmark.org": { port: 8787 } },
      serviceDomains: { "web-production-2e4ac.up.railway.app": { port: 8787 } },
    },
    volumeMounts: { "/data": webVolume },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      // Knowledge bases are built by the local CLI, with every lane; the server evaluates with what's there.
      KB_BUILD: "local",
      ADMIN_PASSWORD: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      EVAL_COST_CAP_USD: preserve(),
      EVAL_MAX_CONCURRENT_PROJECTS: preserve(),
      EVAL_MAX_INFLIGHT_CALLS: preserve(),
      EXA_API_KEY: preserve(),
      GITHUB_AGENT_TOKEN: preserve(),
      GITHUB_TOKEN: preserve(),
      MODEL_GATHER: preserve(),
      MODEL_REASON: preserve(),
      MODEL_WRITE: preserve(),
      NEWSAPI_AI_KEY: preserve(),
      NODE_ENV: preserve(),
      PORT: preserve(),
      PUBLIC_URL: preserve(),
      SESSION_SECRET: preserve(),
      VERSION_CHECK_INTERVAL_HOURS: preserve(),
      X_BEARER_TOKEN: preserve(),
    },
  });

  // The local CLI's variables, and nothing else (`railway run --service bench-cli -- pnpm bench …`): no admin password
  // or session secret on the laptop. It connects as `bench_cli` (apps/server/src/scripts/setup-bench-role.ts), which
  // can't change the published record and isn't a superuser, over TLS pinned to the database's own CA. No source
  // (Railway stores none as unset): it never deploys.
  const benchCli = service("bench-cli", {
    env: {
      BENCH_DB_PASSWORD: preserve(),
      DATABASE_PUBLIC_URL: {
        type: "literal",
        value:
          "postgresql://bench_cli:${{BENCH_DB_PASSWORD}}@${{postgres.RAILWAY_TCP_PROXY_DOMAIN}}:${{postgres.RAILWAY_TCP_PROXY_PORT}}/${{postgres.PGDATABASE}}",
      },
      // The database's CA (Railway generates one per database, valid to 2028-12-29). If the database is recreated,
      // fetch the new one: openssl s_client -starttls postgres -connect <proxy host:port> -showcerts (the root).
      PGSSL_CA: {
        type: "literal",
        value: `-----BEGIN CERTIFICATE-----
MIIDBTCCAe2gAwIBAgIUZTi1Ehp/9j9vvGWH/1C0nDBSNAEwDQYJKoZIhvcNAQEL
BQAwEjEQMA4GA1UEAwwHcm9vdC1jYTAeFw0yNjEwMDExNDAyMDFaFw0yODEyMjkx
NDAyMDFaMBIxEDAOBgNVBAMMB3Jvb3QtY2EwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQCtT/uMg6hIpH3+8lvgYMpq8KWFWxn7/MGzvb7q/c9LXcydWYlw
x7jMxMNWBgmF939ueNR5vhrkk/w9P8H7jI1OFUTIobF0y69JbvivHOIfMbd0sf2o
dr01upH+bioegt+ZgoPJdC5a2bd+yHMXG3TWSB6pF+A+Qc1ZvAG/mgU9cL6jGV+Y
t4iD09RpabxQ7wtgEsB5TeztQEyPNQkOfx7ce2SiTUj7hBoi/NLxi/kLDSqC2/lG
VCrhAHvLvk0ohcJ569TA5k3rtxKk0OBVfmvODsZG8k1LrSQqd6XmtX0rowpzfKSb
Dk2KB4YNBv2HCqPw1zo7xbiJdlWup5J52v/5AgMBAAGjUzBRMB0GA1UdDgQWBBT8
wqOG98qT49HCj2IHm+jhykspDjAfBgNVHSMEGDAWgBT8wqOG98qT49HCj2IHm+jh
ykspDjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBT+NPTfM1q
0nDD7LVj3VZ8ORcjskjubak4VCsIO8Z0JDbgGu4yauJt/nZJ2ahKS1iQSSO7Px1O
rGALTgGXzN7alYjmEbGTtCG7msE54BLlKbPFCD1KszWYjQydz2g+bogvm5fMA4UU
2qDXUG1moToniKHnkQlMvuHOdVOzqdYweJ8CYeLTrkbD2JE/L9VH9DgTOCyrqvR0
kCvoqxYT9rInp5jYf38e7LfUPEeuNtnByxg3XlZh//MTm3OuIvPgRst+Isa88Ct6
FVBkLkovzwiQx0yp34EBW02NqMVIQwpUXKnqiaEG3b2vMwJQJdSlZmaog8B2NSJv
ZjuWv55vfR9L
-----END CERTIFICATE-----`,
      },
      // No ANTHROPIC_API_KEY: local runs go through Claude Code on the editor's login and never call the API.
      EXA_API_KEY: web.env.EXA_API_KEY,
      NEWSAPI_AI_KEY: web.env.NEWSAPI_AI_KEY,
      X_BEARER_TOKEN: web.env.X_BEARER_TOKEN,
      GITHUB_TOKEN: web.env.GITHUB_TOKEN,
      GITHUB_AGENT_TOKEN: web.env.GITHUB_AGENT_TOKEN,
      MODEL_GATHER: web.env.MODEL_GATHER,
      MODEL_WRITE: web.env.MODEL_WRITE,
      MODEL_REASON: web.env.MODEL_REASON,
      PUBLIC_URL: web.env.PUBLIC_URL,
      // Claude Code sessions running at once (seven research suites, judge votes, the code check, the skeptic).
      BENCH_CLAUDE_CONCURRENCY: "8",
    },
  });

  return project("bench", {
    resources: [db, web, webVolume, benchCli],
  });
});
