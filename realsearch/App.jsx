import { useState } from "react";

const FIELDS = [
  ["Purpose", (d) => d.purpose],
  ["Type", (d) => d.type],
  ["Beds", (d) => d.beds],
  ["Baths", (d) => d.baths],
  ["Size", (d) => (d.area ? `${fmt(d.area)} ${d.areaUnit}` : null)],
  ["Community", (d) => d.community],
  ["Building", (d) => d.tower],
  ["Completion", (d) => d.completion],
  ["Handover", (d) => d.handover],
  ["Developer", (d) => d.developer],
  ["Listed by", (d) => d.brokerage],
  ["Permit no.", (d) => d.permitNumber],
  ["Reference", (d) => d.referenceNo],
  ["Listed", (d) => d.listedAt],
];

function fmt(n) {
  const num = Number(String(n).replace(/[^\d.]/g, ""));
  return Number.isFinite(num) ? num.toLocaleString("en-AE") : n;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  async function lookup() {
    if (!url.trim()) return;
    setStatus("loading");
    setError(null);
    setResult(null);
    setShowRaw(false);

    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ? `${data.error} ${data.detail}` : data.error);
        setStatus("error");
        return;
      }
      setResult(data);
      setStatus("done");
    } catch {
      setError("The local server is not responding. Is `npm run server` running?");
      setStatus("error");
    }
  }

  const d = result?.normalised;
  const rows = d ? FIELDS.filter(([, get]) => get(d) != null) : [];

  return (
    <main className="shell">
      <header className="head">
        <span className="eyebrow">Listing lookup</span>
        <h1>Paste a listing. Get the numbers back.</h1>
        <p className="sub">Bayut, Property Finder and Dubizzle links. Runs through Apify with a UAE residential proxy.</p>
      </header>

      <div className="bar">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          placeholder="https://www.bayut.com/property/details-9232372.html"
          spellCheck={false}
          aria-label="Listing URL"
        />
        <button onClick={lookup} disabled={status === "loading" || !url.trim()}>
          {status === "loading" ? "Fetching" : "Look up"}
        </button>
      </div>

      {status === "loading" && (
        <p className="note">Running the actor. Cold starts take 20 to 60 seconds.</p>
      )}

      {status === "error" && <p className="note error">{error}</p>}

      {status === "idle" && (
        <p className="note">Nothing looked up yet. Paste a link above to start.</p>
      )}

      {d && (
        <section className="card">
          <div className="card-head">
            <h2>{d.title ?? "Untitled listing"}</h2>
            {d.price && (
              <p className="price">
                <span className="cur">{d.currency}</span> {fmt(d.price)}
              </p>
            )}
            {d.area && d.price && (
              <p className="ppsf">
                {fmt(
                  Math.round(
                    Number(String(d.price).replace(/[^\d.]/g, "")) /
                      Number(String(d.area).replace(/[^\d.]/g, ""))
                  )
                )}{" "}
                {d.currency} / {d.areaUnit}
              </p>
            )}
          </div>

          <dl className="grid">
            {rows.map(([label, get]) => (
              <div key={label} className="cell">
                <dt>{label}</dt>
                <dd>{String(get(d))}</dd>
              </div>
            ))}
          </dl>

          {Array.isArray(d.images) && d.images.length > 0 && (
            <div className="strip">
              {d.images.slice(0, 6).map((src, i) => (
                <img key={i} src={typeof src === "string" ? src : src?.url} alt="" loading="lazy" />
              ))}
            </div>
          )}

          <button className="ghost" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Hide raw JSON" : "Show raw JSON"}
          </button>

          {showRaw && <pre className="raw">{JSON.stringify(result.raw, null, 2)}</pre>}
        </section>
      )}
    </main>
  );
}
