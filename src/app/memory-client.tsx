"use client";

import { useEffect, useRef, useState } from "react";

/** Tells the server the seller has seen this account, after the page has actually rendered. */
export function MarkViewed({ accountId }: { accountId: string }) {
  useEffect(() => {
    const id = setTimeout(() => void fetch(`/api/accounts/${accountId}/viewed`, { method: "POST" }).catch(() => {}), 1500);
    return () => clearTimeout(id);
  }, [accountId]);
  return null;
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> & { length: number } }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

/** Quick-add note with optional voice dictation (the browser's own speech recognition). */
export function NoteForm({ accountId, action }: { accountId: string; action: (f: FormData) => Promise<void> }) {
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("note");
  const [listening, setListening] = useState(false);
  const [voiceUsed, setVoiceUsed] = useState(false);
  const [supported, setSupported] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    setSupported(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);

  const toggleVoice = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "en-AU";
    r.interimResults = false;
    r.continuous = true;
    const start = body;
    r.onresult = (e) => {
      const text = Array.from({ length: e.results.length }, (_, i) => e.results[i]![0]!.transcript).join(" ");
      setBody(`${start}${start ? " " : ""}${text}`.trim());
      setVoiceUsed(true);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  };

  return (
    <form
      ref={form}
      action={async (f) => {
        await action(f);
        setBody("");
        setVoiceUsed(false);
      }}
      className="space-y-2"
    >
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="inputMethod" value={voiceUsed ? "voice" : "typed"} />
      <div className="flex gap-2">
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
          <option value="note">Note</option>
          <option value="meeting">Meeting</option>
          <option value="outcome">Outcome</option>
          <option value="opportunity">Opportunity</option>
          <option value="next_step">Next step</option>
        </select>
        <input type="date" name="occurredOn" className="rounded-md border border-slate-300 px-2 py-1 text-sm" title="When it happened (default: today)" />
        {kind === "next_step" && <input type="date" name="dueOn" className="rounded-md border border-slate-300 px-2 py-1 text-sm" title="Due" />}
      </div>
      <textarea name="body" required rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happened, what you learned, what's next" className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      <div className="flex items-center gap-2">
        <button className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Save</button>
        {supported && (
          <button type="button" onClick={toggleVoice} className={`rounded-lg border px-3 py-1.5 text-sm ${listening ? "border-red-300 bg-red-50 text-red-700" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}>
            {listening ? "Stop dictation" : "Dictate"}
          </button>
        )}
      </div>
    </form>
  );
}
