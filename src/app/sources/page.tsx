import { requireUser } from "@/lib/auth/current-user";
import { loadFeeds } from "@/lib/sources/adapters/news";
import { adapterStatuses } from "@/lib/sources/registry";
import { Badge, Card } from "../components";

const yes = "bg-emerald-50 text-emerald-800 ring-emerald-600/20";
const no = "bg-slate-100 text-slate-600 ring-slate-500/20";
const warn = "bg-amber-50 text-amber-800 ring-amber-600/20";

export default async function SourcesPage() {
  await requireUser("/sources");
  const adapters = adapterStatuses();
  const feeds = loadFeeds();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Sources</h1>
        <p className="text-sm text-slate-600">
          What the app reads, whether it's switched on and connected, and what we know about each source's terms. See docs/connecting.md to connect the rest.
        </p>
      </div>
      <Card title="Adapters">
        <ul className="divide-y divide-slate-100">
          {adapters.map((a) => (
            <li key={a.id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium text-slate-900">{a.id}</span>
                <Badge className={a.enabled ? yes : no}>{a.enabled ? "On" : "Off"}</Badge>
                {a.credential && <Badge className={a.configured ? yes : warn}>{a.configured ? "Key set" : `Needs ${a.credential}`}</Badge>}
                <Badge className={a.formatVerified ? yes : warn}>{a.formatVerified ? "Format checked" : "Format not yet checked live"}</Badge>
              </div>
              <p className="text-sm text-slate-600">{a.description}</p>
              <p className="text-xs text-slate-500">Terms: {a.termsNote}</p>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Feeds (data/news-feeds.json)">
        <ul className="divide-y divide-slate-100 text-sm">
          {feeds.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-1.5 py-1.5">
              <span className="text-slate-900">{f.name}</span>
              <Badge className={no}>{f.kind}</Badge>
              <Badge className={f.enabled && f.url ? yes : no}>{f.enabled && f.url ? "On" : "Off"}</Badge>
              {!f.verified && <Badge className={warn}>Not yet checked live</Badge>}
              {f.note && <span className="text-xs text-slate-500">{f.note}</span>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
