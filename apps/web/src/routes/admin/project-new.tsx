import { useNavigate } from "@tanstack/react-router";
import { Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { toast } from "sonner";
import { Field, Input, ListInput, PageHeader, Panel, Select, Textarea, useAdminAction } from "@/components/admin/kit";
import { Chip } from "@/components/ui/badges";
import { Button } from "@/components/ui/button";
import { ProjectMark } from "@/components/ui/project-mark";
import { api } from "@/lib/api";

type Intake = {
  url: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  tagline: string;
  description: string;
  category: string;
  mechanism: string;
  attributes: string[];
  chains: string[];
  githubRepos: string[];
  xHandle: string | null;
  docsUrl: string | null;
  links: Record<string, string[]>;
  aiSuggested: boolean;
  warning: string | null;
};

export const CATEGORIES = ["l1", "l2", "privacy_pool", "privacy_app", "coprocessor", "appchain", "wallet", "other"];
export const MECHANISMS = ["pool", "shielded_ledger", "stealth_address", "confidential_amounts", "private_execution", "none"];

export function AdminProjectNew() {
  const [url, setUrl] = useState("");
  const [form, setForm] = useState<Intake | null>(null);
  const nav = useNavigate();
  const intake = useAdminAction((u: string) => api<Intake>("/api/admin/projects/intake", { json: { url: u } }), { invalidate: false });
  const create = useAdminAction(
    (f: Intake) =>
      api<{ id: string }>("/api/admin/projects", {
        json: {
          slug: f.slug,
          name: f.name,
          websiteUrl: f.url,
          logoUrl: f.logoUrl,
          tagline: f.tagline,
          description: f.description,
          category: f.category,
          mechanism: f.mechanism,
          attributes: f.attributes,
          chains: f.chains,
          githubRepos: f.githubRepos,
          xHandle: f.xHandle || null,
          docsUrl: f.docsUrl || null,
        },
      }),
    { success: "Project added", invalidate: [["projects"], ["overview"]] },
  );
  const upd = (patch: Partial<Intake>) => setForm((f) => (f ? { ...f, ...patch } : f));
  return (
    <>
      <PageHeader
        title="Add project"
        subtitle="Paste the project's website. Intake reads the page for name, logo, links and GitHub repos; Claude Sonnet 5.5 suggests neutral metadata."
      />
      <Panel>
        <form
          className="flex flex-col gap-3 p-4 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            intake.mutate(url, { onSuccess: (r) => setForm(r) });
          }}
        >
          <Input autoFocus type="url" required placeholder="https://example.org" value={url} onChange={(e) => setUrl(e.target.value)} className="h-10 flex-1" />
          <Button type="submit" variant="primary" size="lg" disabled={intake.isPending} icon={<Wand2 className="size-4" />}>
            {intake.isPending ? "Reading…" : "Run intake"}
          </Button>
        </form>
      </Panel>
      <AnimatePresence>
        {form && (
          <m.div initial={{ opacity: 0, y: 8, filter: "blur(3px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} className="mt-6">
            <Panel
              title={
                <span className="flex items-center gap-2">
                  <ProjectMark name={form.name} logoUrl={form.logoUrl} size={20} /> Review metadata
                  {form.aiSuggested && (
                    <Chip tone="accent">
                      <Sparkles className="size-3" /> Suggested by Sonnet 5.5
                    </Chip>
                  )}
                </span>
              }
            >
              {form.warning && (
                <div className="flex items-start gap-2 border-b border-line bg-fair-bg px-4 py-2.5 text-sm text-fair-fg">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {form.warning}
                </div>
              )}
              <div className="grid gap-4 p-4 md:grid-cols-2">
                <Field label="Name">
                  <Input value={form.name} onChange={(e) => upd({ name: e.target.value })} />
                </Field>
                <Field label="Slug" hint="Used in URLs; lowercase letters, numbers and dashes.">
                  <Input value={form.slug} onChange={(e) => upd({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-") })} />
                </Field>
                <Field label="Tagline" className="md:col-span-2">
                  <Input value={form.tagline} onChange={(e) => upd({ tagline: e.target.value })} />
                </Field>
                <Field label="Description" className="md:col-span-2">
                  <Textarea value={form.description} onChange={(e) => upd({ description: e.target.value })} />
                </Field>
                <Field label="Category">
                  <Select value={form.category} onChange={(e) => upd({ category: e.target.value })}>
                    {CATEGORIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Privacy mechanism">
                  <Select value={form.mechanism} onChange={(e) => upd({ mechanism: e.target.value })}>
                    {MECHANISMS.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Chains" hint="Comma-separated">
                  <ListInput value={form.chains} onChange={(chains) => upd({ chains })} />
                </Field>
                <Field label="GitHub repos to watch" hint="owner/name, comma-separated. New releases are triaged by Claude Sonnet 5.5.">
                  <ListInput value={form.githubRepos} onChange={(githubRepos) => upd({ githubRepos })} />
                </Field>
                <Field label="Docs URL" hint="Root of the docs site, crawled into the knowledge base">
                  <Input value={form.docsUrl ?? ""} onChange={(e) => upd({ docsUrl: e.target.value || null })} placeholder="https://docs.example.org" />
                </Field>
                <Field label="X handle" hint="Official account, for announcements">
                  <Input value={form.xHandle ?? ""} onChange={(e) => upd({ xHandle: e.target.value || null })} placeholder="@example" />
                </Field>
                <Field label="Logo URL" className="md:col-span-2">
                  <Input value={form.logoUrl ?? ""} onChange={(e) => upd({ logoUrl: e.target.value || null })} />
                </Field>
                <div className="md:col-span-2">
                  <div className="text-xs font-medium text-fg-3">Links found</div>
                  <div className="mt-2 flex flex-col gap-1 text-xs text-muted">
                    {Object.entries(form.links).map(([k, v]) =>
                      v.length ? (
                        <div key={k}>
                          <span className="capitalize">{k}</span>: {v.slice(0, 4).join(" · ")}
                        </div>
                      ) : null,
                    )}
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
                <Button onClick={() => setForm(null)}>Discard</Button>
                <Button
                  variant="primary"
                  disabled={create.isPending}
                  onClick={() =>
                    create.mutate(form, {
                      onSuccess: (r) => nav({ to: "/admin/projects/$id", params: { id: r.id } }),
                      onError: (e) => (e as Error).message === "slug_taken" && toast.error("That slug is taken."),
                    })
                  }
                >
                  Save project
                </Button>
              </div>
            </Panel>
          </m.div>
        )}
      </AnimatePresence>
    </>
  );
}
