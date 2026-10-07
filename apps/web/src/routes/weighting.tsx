import type { PollInfo, PollResponse, WeightingSummary } from "@pb/core";
import { type Ballot, resolveWeighting, sharesOf, type Weighting } from "@pb/rubric";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Check, Clock, LogOut, RotateCcw, Users, Vote } from "lucide-react";
import { m } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Chip } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { LoadError, Skeleton } from "@/components/ui/misc";
import { ballotFrom, ballotKey, clearDraft, type Draft, draftFrom, loadDraft, movedCount, saveDraft } from "@/components/weighting/draft";
import { WeightTree } from "@/components/weighting/tree";
import { focusIn } from "@/design/motion";
import { ApiError, api } from "@/lib/api";
import { usePoll, useWeightings } from "@/lib/queries";
import { cn, fmtDate } from "@/lib/utils";

/** What Sign in with X reports back in ?x=. */
const X_MESSAGES: Record<string, [kind: "success" | "error" | "warning", text: string]> = {
  ok: ["success", "Signed in with X. Your vote counts once, however often you change it."],
  denied: ["warning", "X sign-in was cancelled."],
  young: ["error", "Only X accounts at least 30 days old can vote."],
  expired: ["warning", "The sign-in took too long or didn't match. Try again."],
  limited: ["error", "Too many sign-in attempts from here. Try again later."],
  unavailable: ["error", "Sign in with X isn't available right now."],
  error: ["error", "X sign-in failed. Try again."],
};

export function WeightingPage() {
  const search = useSearch({ from: "/public/weighting" });
  const navigate = useNavigate({ from: "/weighting" });
  const poll = usePoll();
  const weightings = useWeightings();

  useEffect(() => {
    if (!search.x) return;
    const [kind, text] = X_MESSAGES[search.x] ?? X_MESSAGES.error!;
    toast[kind](text);
    void navigate({ search: {}, replace: true });
  }, [search.x, navigate]);

  const open = poll.data?.poll ?? null;
  return (
    <div className="mx-auto max-w-[var(--container-page)] px-4 pt-10 pb-32 sm:px-6 md:pt-14">
      <m.div variants={focusIn} initial="hidden" animate="show" className="max-w-3xl">
        <div className="eyebrow mb-3">Community weighting</div>
        <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.02em] text-balance md:text-5xl md:leading-[1.06]">
          Help set the weights. <span className="text-muted">One ballot each, five days, and the result scores the next run.</span>
        </h1>
      </m.div>

      {poll.isLoading && <Skeleton className="mt-10 h-40" />}
      {poll.isError && !poll.data && <LoadError title="Couldn't load the poll." busy={poll.isFetching} onRetry={() => void poll.refetch()} />}
      {/* Keyed by poll: a new poll starts from its own base, not the last one's draft. */}
      {poll.data && (open ? <OpenPoll key={open.id} data={poll.data} /> : <NoPoll last={poll.data.lastClosed} />)}

      <div className="mt-14 grid gap-6 lg:grid-cols-2">
        <HowItWorks poll={open} />
        <WhatWeStore />
      </div>

      <PastWeightings list={weightings.data} loading={weightings.isLoading} />
    </div>
  );
}

// ---------- the open poll ----------

function useNow(everyMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function timeLeft(closesAt: string, now: number): string {
  const ms = Date.parse(closesAt) - now;
  if (ms <= 0) return "closing now";
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d} day${d === 1 ? "" : "s"} ${h % 24} h left`;
  if (h >= 1) return `${h} h ${Math.floor((ms % 3_600_000) / 60_000)} min left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}

function OpenPoll({ data }: { data: PollResponse }) {
  const poll = data.poll!;
  const voter = data.voter;
  const qc = useQueryClient();
  const now = useNow();
  const base = useMemo(() => resolveWeighting(poll.baseConfig) as Weighting, [poll.baseConfig]);
  const baseShares = useMemo(() => sharesOf(base), [base]);
  // A draft saved before a sign-in round trip wins over the stored ballot, which wins over the current weights.
  const [draft, setDraft] = useState<Draft>(() => draftFrom(baseShares, loadDraft(poll.id) ?? voter.ballot));
  useEffect(() => {
    // The stored ballot arrives after a refetch (a sign-in in another tab): adopt it unless this page holds edits.
    if (!loadDraft(poll.id) && voter.ballot) setDraft(draftFrom(baseShares, voter.ballot));
  }, [voter.ballot, baseShares, poll.id]);
  const ballot: Ballot = useMemo(() => ballotFrom(draft, baseShares), [draft, baseShares]);
  // What the voter sees as their changes: the sliders they moved. The ballot itself holds only what differs.
  const moved = movedCount(draft, baseShares);
  const changed = Object.keys(ballot).length > 0;
  useEffect(() => {
    if (changed) saveDraft(poll.id, ballot);
    else clearDraft(poll.id);
  }, [ballot, changed, poll.id]);

  const needsSignIn = poll.requireX && !voter.signedIn;
  const voted = !!voter.votedAt;
  // The saved ballot as this page would send it, to tell unsaved edits from what's already counted.
  const saved = useMemo(() => (voter.ballot ? ballotFrom(draftFrom(baseShares, voter.ballot), baseShares) : null), [voter.ballot, baseShares]);
  const edited = voted && ballotKey(ballot) !== ballotKey(saved);
  // One answer for both vote buttons (the card at the top and the bar at the bottom): what voting does right now.
  const action: VoteAction = needsSignIn ? "sign-in" : voted ? (edited ? "update" : "saved") : changed ? "submit" : "keep";
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["poll"] });

  const submit = async (b: Ballot) => {
    setBusy(true);
    try {
      await api(`/api/public/polls/${poll.id}/ballot`, { json: b });
      clearDraft(poll.id);
      toast.success(Object.keys(b).length ? "Vote saved. You can change it until the poll closes." : "Vote saved: keep the current weights.");
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "sign_in_required") signIn();
      else toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    setBusy(true);
    try {
      await api(`/api/public/polls/${poll.id}/ballot`, { method: "DELETE" });
      toast.success("Vote withdrawn.");
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const signIn = () => {
    // Only real changes survive the round trip; otherwise the stored ballot (if any) shows when they're back.
    if (changed) saveDraft(poll.id, ballot);
    location.href = "/api/public/auth/x/start?next=/weighting";
  };
  const signOut = async () => {
    await api("/api/public/auth/x/logout", { json: {} }).catch(() => {});
    await refresh();
  };
  const vote = () => {
    if (action === "sign-in") signIn();
    else if (action !== "saved") void submit(ballot);
  };
  const resetToCurrent = () => setDraft(draftFrom(baseShares));
  const discardEdits = () => setDraft(draftFrom(baseShares, voter.ballot));

  return (
    <>
      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="rounded-2xl border border-line bg-bg-2 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="strong">
              <span className="pulse-dot size-1.5 rounded-full bg-strong-fg" /> Open
            </Chip>
            <Chip>
              <Clock className="size-3" /> {timeLeft(poll.closesAt, now)}
            </Chip>
            <Chip>
              <Users className="size-3" /> {poll.ballots} ballot{poll.ballots === 1 ? "" : "s"}
            </Chip>
            <span className="text-xs text-muted">
              Closes {fmtDate(poll.closesAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
            </span>
          </div>
          <div className="mt-3 text-lg font-semibold tracking-[-0.01em]">{poll.title}</div>
          {poll.description && <p className="mt-1 max-w-2xl text-sm text-fg-3">{poll.description}</p>}
          <p className="mt-2 max-w-2xl text-sm text-muted">
            The sliders start at the current weights ({poll.base.label}, {poll.base.title.toLowerCase()}). Move only what you'd change; anything you leave alone
            counts as a vote for the current value.
          </p>
        </div>
        <QuickVote
          poll={poll}
          voter={voter}
          xEnabled={data.xEnabled}
          action={action}
          moved={moved}
          busy={busy}
          onVote={vote}
          onReset={resetToCurrent}
          onDiscard={discardEdits}
          onSignOut={() => void signOut()}
          onWithdraw={() => void withdraw()}
        />
      </div>

      {/* No preview of how projects would rank: a vote is on what should matter, not on which project it would help. */}
      <div className="mt-8 min-w-0">
        <div className="mb-3">
          <div className="text-xl font-semibold tracking-[-0.015em]">Adjust what matters to you</div>
          <div className="text-sm text-muted">Suites first; open one to weigh its benchmarks, criteria and partial credit.</div>
        </div>
        <WeightTree base={baseShares} draft={draft} onChange={setDraft} />
      </div>

      <ActionBar
        action={action}
        moved={moved}
        signInAvailable={data.xEnabled}
        busy={busy}
        revisionsLeft={voter.revisionsLeft}
        onReset={resetToCurrent}
        onVote={vote}
      />
    </>
  );
}

/**
 * What voting does right now, shown the same way by the card at the top and the bar at the bottom: sign in first;
 * keep every weight as it is; submit the changes; update a saved vote with edits; or nothing (the vote is saved).
 */
type VoteAction = "sign-in" | "keep" | "submit" | "update" | "saved";

const VOTE_LABEL: Record<VoteAction, [full: string, short: string]> = {
  "sign-in": ["Sign in with X to vote", "Sign in to vote"],
  keep: ["Vote: keep the current weights", "Vote"],
  submit: ["Submit my vote", "Submit vote"],
  update: ["Update my vote", "Update vote"],
  saved: ["Vote saved", "Saved"],
};

function QuickVote({
  poll,
  voter,
  xEnabled,
  action,
  moved,
  busy,
  onVote,
  onReset,
  onDiscard,
  onSignOut,
  onWithdraw,
}: {
  poll: PollInfo;
  voter: PollResponse["voter"];
  xEnabled: boolean;
  action: VoteAction;
  moved: number;
  busy: boolean;
  onVote: () => void;
  onReset: () => void;
  onDiscard: () => void;
  onSignOut: () => void;
  onWithdraw: () => void;
}) {
  const weights = `${moved} weight${moved === 1 ? "" : "s"}`;
  const savedAt = fmtDate(voter.votedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-bg p-5">
      {action === "sign-in" ? (
        <>
          <div className="text-[15px] font-semibold">Sign in with X to vote</div>
          <p className="mt-1 text-sm text-muted">
            One ballot per X account, from accounts at least 30 days old. We read your account's id and age, nothing else, and never post.
            {moved ? ` Your ${weights} changed stay here while you sign in.` : ""}
          </p>
          <Button variant="primary" className="mt-4" disabled={!xEnabled} icon={<XLogo />} onClick={onVote}>
            Sign in with X
          </Button>
          {!xEnabled && <p className="mt-2 text-xs text-poor-fg">Sign-in isn't available right now; try again later.</p>}
        </>
      ) : action === "keep" ? (
        <>
          <div className="text-[15px] font-semibold">Happy with the current weights?</div>
          <p className="mt-1 text-sm text-muted">One click votes to keep every weight as it is. Or adjust any of them below.</p>
          <Button variant="primary" className="mt-4" disabled={busy} icon={<Vote className="size-4" />} onClick={onVote}>
            Keep the current weights
          </Button>
        </>
      ) : action === "submit" ? (
        <>
          <div className="text-[15px] font-semibold">Ready to vote?</div>
          <p className="mt-1 text-sm text-muted">You changed {weights}. Everything you didn't touch counts as a vote for its current value.</p>
          <Button variant="primary" className="mt-4" disabled={busy} icon={<Vote className="size-4" />} onClick={onVote}>
            Submit my vote
          </Button>
          <Button variant="ghost" size="sm" className="mt-2 self-start" disabled={busy} onClick={onReset}>
            Reset to the current weights
          </Button>
        </>
      ) : action === "update" ? (
        <>
          <div className="text-[15px] font-semibold">You have unsaved changes</div>
          <p className="mt-1 text-sm text-muted">Your vote saved {savedAt} still counts until you update it.</p>
          <Button variant="primary" className="mt-4" disabled={busy} icon={<Vote className="size-4" />} onClick={onVote}>
            Update my vote
          </Button>
          <Button variant="ghost" size="sm" className="mt-2 self-start" disabled={busy} onClick={onDiscard}>
            Discard changes
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="flex size-5 items-center justify-center rounded-full bg-strong-bg text-strong-fg">
              <Check className="size-3.5" strokeWidth={3} />
            </span>
            Your vote is in
          </div>
          <p className="mt-1 text-sm text-muted">Saved {savedAt}. Change any weight below to update it, or withdraw it, until the poll closes.</p>
          <Button variant="ghost" size="sm" className="mt-3 self-start" disabled={busy} onClick={onWithdraw}>
            Withdraw my vote
          </Button>
        </>
      )}
      {voter.kind === "x" && voter.signedIn && (
        <button type="button" onClick={onSignOut} className="mt-auto inline-flex items-center gap-1 self-start pt-4 text-xs text-muted hover:text-fg">
          <LogOut className="size-3" /> Signed in with X · sign out
        </button>
      )}
      {!poll.requireX && <p className="mt-auto pt-4 text-xs text-faint">This poll counts one ballot per browser.</p>}
    </div>
  );
}

function ActionBar({
  action,
  moved,
  signInAvailable,
  busy,
  revisionsLeft,
  onReset,
  onVote,
}: {
  action: VoteAction;
  moved: number;
  signInAvailable: boolean;
  busy: boolean;
  revisionsLeft: number;
  onReset: () => void;
  onVote: () => void;
}) {
  const [label, short] = VOTE_LABEL[action];
  const note =
    action === "saved"
      ? " · your vote is saved"
      : action === "update"
        ? " · not saved yet"
        : moved
          ? " · everything else stays as it is"
          : " · a vote for the current weights";
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[var(--container-page)] items-center gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-semibold whitespace-nowrap">{moved ? `${moved} weight${moved === 1 ? "" : "s"} changed` : "No changes"}</span>
          <span className="hidden text-muted sm:inline">
            {note}
            {action === "update" && revisionsLeft < 5 ? ` · ${revisionsLeft} edit${revisionsLeft === 1 ? "" : "s"} left` : ""}
          </span>
        </div>
        <Button variant="ghost" size="sm" icon={<RotateCcw className="size-3.5" />} disabled={!moved || busy} onClick={onReset} aria-label="Reset">
          <span className="hidden sm:inline">Reset</span>
        </Button>
        <Button
          variant="primary"
          disabled={busy || action === "saved" || (action === "sign-in" && !signInAvailable) || (action === "update" && revisionsLeft <= 0)}
          icon={action === "sign-in" ? <XLogo /> : action === "saved" ? <Check className="size-4" /> : <Vote className="size-4" />}
          onClick={onVote}
          aria-label={label}
        >
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{short}</span>
        </Button>
      </div>
    </div>
  );
}

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

// ---------- no poll open ----------

function NoPoll({ last }: { last: PollInfo | null }) {
  return (
    <div className="mt-10 rounded-2xl border border-dashed border-line-strong p-6">
      <div className="text-[15px] font-semibold">No poll is open right now.</div>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Polls open before a benchmark run and last five days. Until the next one, results are scored with the current weighting, listed below.
      </p>
      {last && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Last poll:</span>
          <span className="font-medium">{last.title}</span>
          <span className="text-muted">
            · closed {fmtDate(last.closesAt)} · {last.ballots} ballot{last.ballots === 1 ? "" : "s"} ·{" "}
          </span>
          {last.outcome === "adopted" && last.result ? (
            <Link to="/weighting/$ref" params={{ ref: last.result.label }} className="font-medium text-accent-fg hover:underline">
              adopted as {last.result.label}
            </Link>
          ) : (
            <span className="text-muted">too few ballots; the weights didn't change</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- explanations ----------

function Explainer({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line p-5">
      <div className="text-[15px] font-semibold">{title}</div>
      <ul className="mt-3 flex flex-col gap-2 text-[13px] leading-[1.55] text-fg-2">{children}</ul>
    </div>
  );
}

function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}

function HowItWorks({ poll }: { poll: PollInfo | null }) {
  return (
    <Explainer title="How the result is decided">
      <Point>
        Every weight's result is the median of all ballots, where a ballot that left it alone counts as a vote for the current value. A minority can't move a
        weight; a majority moves it only as far as its middle voter.
      </Point>
      <Point>Each group is then rescaled to 100%: suites in the overall score, benchmarks in a suite, criteria in a benchmark.</Point>
      <Point>
        The best answer to a criterion always earns full credit and the riskiest none, so unknowns keep scoring as the riskiest answer. Badges (Public,
        Operator, Walkaway) don't depend on weights.
      </Point>
      <Point>
        After five days{poll ? `, with at least ${poll.minBallots} ballot${poll.minBallots === 1 ? "" : "s"},` : ""} the result becomes the next weighting
        version and scores the next run. Every published result names the weighting it was scored with.
      </Point>
    </Explainer>
  );
}

function WhatWeStore() {
  return (
    <Explainer title="What we store">
      <Point>
        Your ballot, under a key derived from your X account id (or a random browser id) with a secret that's different for every poll, so ballots can't be
        linked across polls.
      </Point>
      <Point>
        Sign in with X reads your account's id and creation date once; the access token is revoked straight away. We never read your handle or post.
      </Point>
      <Point>
        No IP addresses. To limit repeat voting, a salted hash of your network (its /24) caps how many ballots one network casts; it's erased when the poll
        closes.
      </Point>
      <Point>Ballot counts and how many ballots changed each weight are published with the result; individual ballots never are.</Point>
    </Explainer>
  );
}

function PastWeightings({ list, loading }: { list?: WeightingSummary[]; loading: boolean }) {
  return (
    <section className="mt-14">
      <div className="text-xl font-semibold tracking-[-0.015em]">Weighting versions</div>
      <div className="text-sm text-muted">Every set of weights results have been scored with. Each is frozen and hashed; published results link to theirs.</div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-line">
        {loading &&
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="border-b border-line p-4 last:border-0">
              <Skeleton className="h-6" />
            </div>
          ))}
        {list?.map((w) => (
          <Link
            key={w.id}
            to="/weighting/$ref"
            params={{ ref: w.label }}
            className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-3 transition-colors last:border-0 hover:bg-bg-2"
          >
            <span className="text-[15px] font-semibold tabular">{w.label}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{w.title}</span>
              <span className="block truncate text-xs text-muted">
                {w.source === "poll" && w.poll ? `${w.poll.ballots} ballots · ` : ""}
                {fmtDate(w.createdAt)} · {w.results} published result{w.results === 1 ? "" : "s"}
              </span>
            </span>
            <span className="flex flex-wrap justify-end gap-1.5">
              {w.current && <Chip tone="accent">current</Chip>}
              {w.retired && <Chip>retired</Chip>}
              <Chip className={cn(w.source === "poll" ? "" : "text-muted")}>{w.source === "poll" ? "poll" : "rubric"}</Chip>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
