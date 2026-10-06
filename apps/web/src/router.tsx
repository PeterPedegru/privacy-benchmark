import { QueryClient } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Link, lazyRouteComponent } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { RouteError } from "./components/route-error";
import { PublicLayout } from "./components/shell";
import { ButtonLink } from "./components/ui/button";
import { retryDelay, retryQuery } from "./lib/api";
import { compareQuery, defaultRefs, leaderboardQuery, metaQuery, pollQuery, projectQuery, releasesQuery, weightingQuery, weightingsQuery } from "./lib/queries";
import { chunk } from "./lib/recovery";

// Network errors and 5xx retry with backoff; 4xx (a missing project) never does (R3-REL-14).
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: retryQuery, retryDelay, refetchOnWindowFocus: false } } });

/**
 * Route loaders start a page's requests in parallel with its code chunk, and on hover through
 * `defaultPreload: "intent"`. They don't wait for the data: pages keep rendering their own loading states.
 * prefetchQuery is a no-op while the cached data is fresh, and errors surface through the page's useQuery.
 */
const prefetchLeaderboard = () => void queryClient.prefetchQuery(leaderboardQuery);

/**
 * A lazily loaded page wrapped in the tooltip provider. Radix Tooltip brings Popper and floating-ui (~30 kB),
 * so it ships with the pages that show tooltips rather than in the main bundle.
 */
function page<T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T & string) {
  return lazyRouteComponent(
    chunk(async () => {
      const [mod, { TooltipProvider }] = await Promise.all([load(), import("./components/ui/tooltip")]);
      const Page = mod[name] as ComponentType;
      return {
        default: function TooltipPage() {
          return (
            <TooltipProvider>
              <Page />
            </TooltipProvider>
          );
        },
      };
    }),
  );
}

/** An admin page: its own lazy chunk, recovered like the public ones when a deploy removed it. */
function adminPage<T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T & string) {
  return lazyRouteComponent(chunk(load), name);
}

const rootRoute = createRootRoute({
  notFoundComponent: () => (
    <div className="mx-auto flex max-w-lg flex-col items-center px-6 py-32 text-center">
      <div className="eyebrow">404</div>
      <h1 className="mt-3 text-3xl font-medium tracking-[-0.01em]">
        Not found. <span className="text-muted">This page stayed private.</span>
      </h1>
      <ButtonLink to="/" variant="secondary" className="mt-8">
        Back home
      </ButtonLink>
      <Link to="/benchmarks" className="mt-3 text-sm text-muted hover:text-fg">
        Or open the benchmark table
      </Link>
    </div>
  ),
});

// Meta feeds the demo banner, footer and release sync on every public page.
const publicLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "public",
  loader: () => void queryClient.prefetchQuery(metaQuery),
  component: PublicLayout,
});

const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);

const home = createRoute({
  getParentRoute: () => publicLayout,
  path: "/",
  loader: prefetchLeaderboard,
  component: page(() => import("./routes/home"), "HomePage"),
});

export type BenchSearch = { p?: string; focus?: string; open?: string; heat?: boolean; suites?: string };
const bench = createRoute({
  getParentRoute: () => publicLayout,
  path: "/benchmarks",
  validateSearch: (s: Record<string, unknown>): BenchSearch => ({
    p: str(s.p),
    focus: str(s.focus),
    open: str(s.open),
    heat: s.heat === true || s.heat === "1" ? true : undefined,
    suites: str(s.suites),
  }),
  loaderDeps: ({ search }) => ({ p: search.p }),
  loader: ({ deps }) => {
    const picked = deps.p?.split(",").filter(Boolean) ?? [];
    if (picked.length) {
      // Picked columns don't depend on the leaderboard: both requests start now.
      void queryClient.prefetchQuery(compareQuery(picked));
      prefetchLeaderboard();
      return;
    }
    // Default columns come from the leaderboard, so their request starts as soon as it arrives instead of
    // after the page chunk has loaded and rendered.
    void queryClient
      .ensureQueryData(leaderboardQuery)
      .then((lb) => {
        const refs = defaultRefs(lb);
        return refs.length ? queryClient.prefetchQuery(compareQuery(refs)) : undefined;
      })
      .catch(() => {});
  },
  component: page(() => import("./routes/benchmarks"), "BenchmarksPage"),
});

export type RankSearch = { tab?: string; preset?: string; w?: string };
const rankings = createRoute({
  getParentRoute: () => publicLayout,
  path: "/rankings",
  validateSearch: (s: Record<string, unknown>): RankSearch => ({ tab: str(s.tab), preset: str(s.preset), w: str(s.w) }),
  loader: prefetchLeaderboard,
  component: page(() => import("./routes/rankings"), "RankingsPage"),
});

const projects = createRoute({
  getParentRoute: () => publicLayout,
  path: "/projects",
  loader: prefetchLeaderboard,
  component: page(() => import("./routes/projects"), "ProjectsPage"),
});

export type ProjectSearch = { version?: string; tab?: string };
const project = createRoute({
  getParentRoute: () => publicLayout,
  path: "/projects/$slug",
  validateSearch: (s: Record<string, unknown>): ProjectSearch => ({ version: str(s.version), tab: str(s.tab) }),
  loaderDeps: ({ search }) => ({ version: search.version }),
  loader: ({ params, deps }) => {
    void queryClient.prefetchQuery(projectQuery(params.slug, deps.version));
    prefetchLeaderboard();
  },
  component: page(() => import("./routes/project"), "ProjectPage"),
});

export type CardSearch = { id?: string; p?: string; focus?: string; t?: string; rows?: string; size?: string; theme?: string; accent?: string };
const cards = createRoute({
  getParentRoute: () => publicLayout,
  path: "/cards",
  validateSearch: (s: Record<string, unknown>): CardSearch => ({
    id: str(s.id),
    p: str(s.p),
    focus: str(s.focus),
    t: str(s.t),
    rows: str(s.rows),
    size: str(s.size),
    theme: str(s.theme),
    accent: str(s.accent),
  }),
  loader: prefetchLeaderboard,
  component: page(() => import("./routes/cards"), "CardsPage"),
});

const methodology = createRoute({
  getParentRoute: () => publicLayout,
  path: "/methodology",
  loader: prefetchLeaderboard,
  component: page(() => import("./routes/methodology"), "MethodologyPage"),
});
const releases = createRoute({
  getParentRoute: () => publicLayout,
  path: "/releases",
  loader: () => void queryClient.prefetchQuery(releasesQuery),
  component: page(() => import("./routes/releases"), "ReleasesPage"),
});

export type WeightingSearch = { x?: string };
const weighting = createRoute({
  getParentRoute: () => publicLayout,
  path: "/weighting",
  // ?x= is where Sign in with X sends the voter back: ok, denied, young, expired, limited, unavailable or error.
  validateSearch: (s: Record<string, unknown>): WeightingSearch => ({ x: str(s.x) }),
  loader: () => {
    void queryClient.prefetchQuery(pollQuery);
    void queryClient.prefetchQuery(weightingsQuery);
    prefetchLeaderboard();
  },
  component: page(() => import("./routes/weighting"), "WeightingPage"),
});
const weightingVersion = createRoute({
  getParentRoute: () => publicLayout,
  path: "/weighting/$ref",
  loader: ({ params }) => void queryClient.prefetchQuery(weightingQuery(params.ref)),
  component: page(() => import("./routes/weighting-version"), "WeightingVersionPage"),
});

// ---------- admin (separate lazy chunk) ----------
const admin = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: page(() => import("./routes/admin/layout"), "AdminLayout"),
});
const ad0 = createRoute({ getParentRoute: () => admin, path: "/", component: adminPage(() => import("./routes/admin/overview"), "AdminOverview") });
const ad1 = createRoute({
  getParentRoute: () => admin,
  path: "/projects",
  component: adminPage(() => import("./routes/admin/projects"), "AdminProjects"),
});
const ad2 = createRoute({
  getParentRoute: () => admin,
  path: "/projects/new",
  component: adminPage(() => import("./routes/admin/project-new"), "AdminProjectNew"),
});
const ad3 = createRoute({
  getParentRoute: () => admin,
  path: "/projects/$id",
  component: adminPage(() => import("./routes/admin/project-detail"), "AdminProjectDetail"),
});
const ad4 = createRoute({
  getParentRoute: () => admin,
  path: "/updates",
  component: adminPage(() => import("./routes/admin/updates"), "AdminUpdates"),
});
const ad5 = createRoute({ getParentRoute: () => admin, path: "/runs", component: adminPage(() => import("./routes/admin/runs"), "AdminRuns") });
const ad6 = createRoute({
  getParentRoute: () => admin,
  path: "/runs/new",
  component: adminPage(() => import("./routes/admin/run-new"), "AdminRunNew"),
});
const ad7 = createRoute({
  getParentRoute: () => admin,
  path: "/runs/$id",
  component: adminPage(() => import("./routes/admin/run-detail"), "AdminRunDetail"),
});
const ad8 = createRoute({
  getParentRoute: () => admin,
  path: "/review",
  component: adminPage(() => import("./routes/admin/review"), "AdminReviewList"),
});
const ad9 = createRoute({
  getParentRoute: () => admin,
  path: "/review/$id",
  component: adminPage(() => import("./routes/admin/review-detail"), "AdminReviewDetail"),
});
const ad10 = createRoute({
  getParentRoute: () => admin,
  path: "/releases",
  component: adminPage(() => import("./routes/admin/releases"), "AdminReleases"),
});
const ad11 = createRoute({
  getParentRoute: () => admin,
  path: "/corrections",
  component: adminPage(() => import("./routes/admin/corrections"), "AdminCorrections"),
});
const ad12 = createRoute({
  getParentRoute: () => admin,
  path: "/settings",
  component: adminPage(() => import("./routes/admin/settings"), "AdminSettings"),
});
const ad13 = createRoute({
  getParentRoute: () => admin,
  path: "/weighting",
  component: adminPage(() => import("./routes/admin/weighting"), "AdminWeighting"),
});
const adminRoutes = [ad0, ad1, ad2, ad3, ad4, ad5, ad6, ad7, ad8, ad9, ad10, ad11, ad12, ad13] as const;

const routeTree = rootRoute.addChildren([
  publicLayout.addChildren([home, bench, rankings, projects, project, cards, methodology, releases, weighting, weightingVersion]),
  admin.addChildren([...adminRoutes]),
]);

export const router = createRouter({
  routeTree,
  defaultErrorComponent: RouteError,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingMinMs: 0,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
