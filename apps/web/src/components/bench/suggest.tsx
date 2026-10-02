import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "../ui/button";
import { Sheet } from "../ui/sheet";

export function SuggestCorrection({
  open,
  onOpenChange,
  projectSlug,
  criterionId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectSlug: string;
  criterionId: string | null;
}) {
  const [message, setMessage] = useState("");
  const [url, setUrl] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api("/api/public/corrections", { json: { projectSlug, criterionId, message, evidenceUrl: url || null, contact: contact || null } });
      toast.success("Thanks. Your correction is in the review queue.");
      onOpenChange(false);
      setMessage("");
      setUrl("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const input = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]";
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Suggest a correction" subtitle={criterionId ?? projectSlug} width={480}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">Corrections go to the editors' review queue. Link a primary source (code, docs, onchain data) where you can.</p>
        <textarea
          className={`${input} min-h-32`}
          placeholder="What's wrong, and what should it say?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <input className={input} placeholder="Evidence URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input className={input} placeholder="Contact (optional)" value={contact} onChange={(e) => setContact(e.target.value)} />
        <Button variant="primary" disabled={busy || message.length < 10} onClick={submit}>
          Send correction
        </Button>
      </div>
    </Sheet>
  );
}
