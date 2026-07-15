"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { RedirectToSignIn, Show, UserButton } from "@clerk/nextjs";

type Tab = "magnitude" | "eventAffinity" | "weatherAffinity";

export default function Home() {
  return (
    <>
      <Show when="signed-out">
        {/* Landing goes straight to the sign-in page. */}
        <RedirectToSignIn />
      </Show>
      <Show when="signed-in">
        <AdminGate />
      </Show>
    </>
  );
}

// Signed-in routing: loading, locked-out, or the console.
function AdminGate() {
  const me = useQuery(api.users.me);

  if (me === undefined) {
    return <div className="splash">Loading…</div>;
  }
  if (!me || me.role !== "admin") {
    return (
      <NotAuthorized
        who={me?.email ?? me?.username}
        synced={me?.synced ?? false}
      />
    );
  }
  return <AdminShell name={me.username ?? me.email ?? "Admin"} />;
}

function NotAuthorized({ who, synced }: { who?: string; synced: boolean }) {
  return (
    <div className="gatewrap">
      <div className="gatecard">
        <div className="brand">
          Fore<span>Shift</span>
        </div>
        <h2>No admin access</h2>
        <p className="sub">
          You&apos;re signed in{who ? ` as ${who}` : ""}, but this account
          isn&apos;t an admin.{" "}
          {synced
            ? "Ask the owner to grant admin, then sign out and back in."
            : "Your account may still be syncing — refresh in a moment."}
        </p>
        <div className="actions">
          <UserButton />
        </div>
      </div>
    </div>
  );
}

function AdminShell({ name }: { name: string }) {
  const [tab, setTab] = useState<Tab>("magnitude");
  const data = useQuery(api.coefficients.adminGetAll);

  return (
    <div className="app">
      <Sidebar tab={tab} setTab={setTab} name={name} />
      <main className="content">
        {data === undefined ? (
          <p className="muted">Loading coefficients…</p>
        ) : (
          <Section tab={tab} data={data} />
        )}
      </main>
    </div>
  );
}

const NAV: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "magnitude", label: "Event Magnitude", icon: <IconBolt /> },
  { id: "eventAffinity", label: "Event Affinity", icon: <IconLink /> },
  { id: "weatherAffinity", label: "Weather Affinity", icon: <IconCloud /> },
];

function Sidebar({
  tab,
  setTab,
  name,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  name: string;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        Fore<span>Shift</span>
      </div>
      <nav className="navwrap">
        <div className="navsection">Coefficients</div>
        {NAV.map((it) => (
          <button
            key={it.id}
            className={"navitem" + (tab === it.id ? " active" : "")}
            onClick={() => setTab(it.id)}
          >
            {it.icon}
            {it.label}
          </button>
        ))}
      </nav>
      <div className="profile">
        <UserButton />
        <div className="pinfo">
          <div className="pname">{name}</div>
          <div className="prole">Administrator</div>
        </div>
      </div>
    </aside>
  );
}

type CoefficientData = {
  eventMagnitude: { eventClass: string; magnitude: number }[];
  eventAffinity: { concept: string; affinity: number }[];
  weatherAffinity: { concept: string; affinity: number }[];
};

function Section({ tab, data }: { tab: Tab; data: CoefficientData }) {
  if (tab === "magnitude") {
    return (
      <>
        <PageHead
          title="Event magnitude"
          subtitle="Crowd weight per event class. A higher number means that class drives a bigger demand lift. 0 or greater."
        />
        <div className="card">
          <table className="coef">
            <tbody>
              {data.eventMagnitude.map((r) => (
                <MagnitudeRow
                  key={r.eventClass}
                  eventClass={r.eventClass}
                  magnitude={r.magnitude}
                />
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  if (tab === "eventAffinity") {
    return (
      <>
        <PageHead
          title="Event affinity"
          subtitle="How strongly nearby events lift each concept. 0 ignores events, 1 is fully exposed to them."
        />
        <div className="card">
          <table className="coef">
            <tbody>
              {data.eventAffinity.map((r) => (
                <AffinityRow
                  key={r.concept}
                  concept={r.concept}
                  affinity={r.affinity}
                  kind="event"
                />
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  return (
    <>
      <PageHead
        title="Weather affinity"
        subtitle="How strongly weather scales each concept's demand. 0 is weather-proof, 1 is fully weather-driven."
      />
      <div className="card">
        <table className="coef">
          <tbody>
            {data.weatherAffinity.map((r) => (
              <AffinityRow
                key={r.concept}
                concept={r.concept}
                affinity={r.affinity}
                kind="weather"
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PageHead({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="pagehead">
      <h1>{title}</h1>
      <p className="sub">{subtitle}</p>
    </header>
  );
}

function MagnitudeRow({
  eventClass,
  magnitude,
}: {
  eventClass: string;
  magnitude: number;
}) {
  const update = useMutation(api.coefficients.adminUpdateEventMagnitude);
  return (
    <CoefficientRow
      label={eventClass}
      value={magnitude}
      min={0}
      max={1_000_000}
      step={1}
      rangeText="0 or greater"
      onSave={(n) => update({ eventClass, magnitude: n })}
    />
  );
}

function AffinityRow({
  concept,
  affinity,
  kind,
}: {
  concept: string;
  affinity: number;
  kind: "event" | "weather";
}) {
  const updateEvent = useMutation(api.coefficients.adminUpdateEventAffinity);
  const updateWeather = useMutation(api.coefficients.adminUpdateWeatherAffinity);
  return (
    <CoefficientRow
      label={concept}
      value={affinity}
      min={0}
      max={1}
      step={0.05}
      rangeText="between 0 and 1"
      onSave={(n) =>
        kind === "event"
          ? updateEvent({ concept, affinity: n })
          : updateWeather({ concept, affinity: n })
      }
    />
  );
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

function CoefficientRow({
  label,
  value,
  min,
  max,
  step,
  rangeText,
  onSave,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  rangeText: string;
  onSave: (n: number) => Promise<unknown>;
}) {
  const [val, setVal] = useState(String(value));
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setVal(String(value));
  }, [value]);

  const dirty = val.trim() !== "" && Number(val) !== value;

  async function save() {
    const n = Number(val);
    if (!Number.isFinite(n) || n < min || n > max) {
      setErr(`Enter a number ${rangeText}.`);
      setStatus("error");
      return;
    }
    setStatus("saving");
    setErr(null);
    try {
      await onSave(n);
      setStatus("saved");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
      setStatus("error");
    }
  }

  return (
    <tr>
      <td className="rowlabel">{label}</td>
      <td className="rowinput">
        <input
          className="numin"
          type="number"
          inputMode="decimal"
          step={step}
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            setStatus("idle");
            setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
      </td>
      <td className="rowaction">
        <button
          className="btn primary"
          disabled={!dirty || status === "saving"}
          onClick={() => void save()}
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
        {status === "saved" && !dirty && <span className="ok">Saved</span>}
        {status === "error" && err && <span className="bad">{err}</span>}
      </td>
    </tr>
  );
}

/* ---- icons (line style, match the mockup) ---- */
function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </svg>
  );
}
function IconLink() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}
function IconCloud() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.98 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 6.5 19Z" />
    </svg>
  );
}
