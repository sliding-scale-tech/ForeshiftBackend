"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { RedirectToSignIn, Show, UserButton } from "@clerk/nextjs";

type Tab = "magnitude" | "eventAffinity" | "weatherAffinity" | "saveToBubble";

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
  // Owned here, not inside SaveToBubbleSection: that component only exists
  // while its tab is selected, so state stored on it would vanish the moment
  // the admin switches tabs mid-sync — the loader would just disappear even
  // though the Bubble writes are still running in the background. AdminShell
  // stays mounted for the whole session, so the in-flight sync survives tab
  // switches and picks the loader back up when they return.
  const saveToBubble = useSaveToBubble();

  return (
    <div className="app">
      <Sidebar
        tab={tab}
        setTab={setTab}
        name={name}
        savingToBubble={saveToBubble.status === "saving"}
      />
      <main className="content">
        {data === undefined ? (
          <p className="muted">Loading coefficients…</p>
        ) : (
          <Section tab={tab} data={data} saveToBubble={saveToBubble} />
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

const ACTIONS_NAV: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "saveToBubble", label: "Save to Bubble", icon: <IconUpload /> },
];

function Sidebar({
  tab,
  setTab,
  name,
  savingToBubble,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  name: string;
  savingToBubble: boolean;
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
        <div className="navsection">Actions</div>
        {ACTIONS_NAV.map((it) => (
          <button
            key={it.id}
            className={"navitem" + (tab === it.id ? " active" : "")}
            onClick={() => setTab(it.id)}
          >
            {it.icon}
            {it.label}
            {it.id === "saveToBubble" && savingToBubble && (
              <span className="navspinner" aria-label="Syncing…" />
            )}
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

function Section({
  tab,
  data,
  saveToBubble,
}: {
  tab: Tab;
  data: CoefficientData;
  saveToBubble: SaveToBubbleState;
}) {
  if (tab === "saveToBubble") {
    return <SaveToBubbleSection state={saveToBubble} />;
  }
  if (tab === "magnitude") {
    return (
      <>
        <PageHead
          title="Event magnitude"
          subtitle="Crowd weight per event class. A higher number means that class drives a bigger demand lift. 0 or greater."
        />
        <FormulaPanel highlight="magnitude" />
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
        <FormulaPanel highlight="event_affinity" />
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
      <FormulaPanel highlight="weather_affinity" />
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

type FormulaHighlight = "magnitude" | "event_affinity" | "weather_affinity";

const HIGHLIGHT_TERM: Record<FormulaHighlight, string> = {
  magnitude: "event_magnitude",
  event_affinity: "concept_event_affinity",
  weather_affinity: "concept_weather_affinity",
};

function Term({ name, highlight }: { name: string; highlight: FormulaHighlight }) {
  if (name === HIGHLIGHT_TERM[highlight]) {
    return <span className="formula-hl">{name}</span>;
  }
  return <>{name}</>;
}

function FormulaPanel({ highlight }: { highlight: FormulaHighlight }) {
  const editNote =
    highlight === "magnitude"
      ? "Values below set event_magnitude for each event class."
      : highlight === "event_affinity"
        ? "Values below set concept_event_affinity for each concept."
        : "Values below set concept_weather_affinity for each concept.";

  return (
    <section className="formulacard" aria-label="Zone demand formula">
      <div className="formulatitle">Zone demand formula</div>
      <pre className="formulablock">
        <code>
          <span className="formula-comment"># Final zone-demand score</span>
          {"\n"}
          final = MIN( (base_score + event_lift) × weather_factor , 150 )
          {"\n\n"}
          <span className="formula-comment"># where</span>
          {"\n"}
          event_lift = SUM per event ({" "}
          <Term name="event_magnitude" highlight={highlight} /> ×{" "}
          <Term name="concept_event_affinity" highlight={highlight} /> × proximity )
          {"\n"}
          weather_factor = 1 − ( weather_severity ×{" "}
          <Term name="concept_weather_affinity" highlight={highlight} /> )
        </code>
      </pre>
      <p className="formulanote">{editNote} Changes apply on the next demand request.</p>
    </section>
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

/* ---- Save to Bubble ---- */
type SaveResult = {
  total: number;
  created: number;
  updated: number;
  deleted: number;
};

// Cosmetic only — the real work is one action call with no server-side
// progress ticks, so this just narrates roughly what that call is doing under
// the hood, cycling while we wait, to reassure the admin nothing is stuck.
const SYNC_PHASES = [
  "Resolving zone × concept × day…",
  "Applying live events & weather…",
  "Writing rows to Bubble…",
];

function useCyclingPhase(active: boolean, intervalMs: number): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) {
      setPhase(0);
      return;
    }
    const id = setInterval(() => {
      setPhase((p) => (p + 1) % SYNC_PHASES.length);
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return phase;
}

// Lives in AdminShell (mounted for the whole session) rather than inside
// SaveToBubbleSection (mounted only while that tab is selected) — see the
// comment on AdminShell for why: switching tabs must not lose track of an
// in-flight sync.
function useSaveToBubble() {
  const sync = useAction(api.operatorWeek.adminSyncResolvedDemandToBubble);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [result, setResult] = useState<SaveResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function run() {
    setConfirming(false);
    setStatus("saving");
    setErr(null);
    try {
      const r = await sync({});
      if (!mountedRef.current) return;
      setResult(r);
      setStatus("saved");
    } catch (e) {
      if (!mountedRef.current) return;
      setErr(e instanceof Error ? e.message : "Save failed.");
      setStatus("error");
    }
  }

  return {
    status,
    result,
    err,
    confirming,
    openConfirm: () => setConfirming(true),
    cancelConfirm: () => setConfirming(false),
    run,
  };
}

type SaveToBubbleState = ReturnType<typeof useSaveToBubble>;

function SaveToBubbleSection({ state }: { state: SaveToBubbleState }) {
  const { status, result, err, confirming, openConfirm, cancelConfirm, run } =
    state;
  const saving = status === "saving";
  const phase = useCyclingPhase(saving, 1400);

  return (
    <>
      <PageHead
        title="Save to Bubble"
        subtitle="Recompute zone demand for every zone × concept × day and push it into Bubble's ResolvedDemand table right now."
      />
      <div className="card savepanel">
        <p className="savenote">
          This resolves the current Monday–Sunday week using the coefficients
          set above and overwrites Bubble&apos;s ResolvedDemand table
          immediately — operators see the new numbers on their next dashboard
          load. The same recompute also runs automatically every Monday via
          the scheduled sync; use this only to push a change early.
        </p>

        {saving ? (
          <div className="syncing" role="status" aria-live="polite">
            <div className="syncring">
              <span className="syncring-track" />
              <span className="syncring-arc" />
              <IconUpload />
            </div>
            <div className="syncbar">
              <span className="syncbar-fill" />
            </div>
            <p className="syncphase">{SYNC_PHASES[phase]}</p>
            <p className="syncnote">
              Please wait while rows are being updated in Bubble — this
              usually takes a few minutes.
            </p>
          </div>
        ) : (
          <button className="btn danger" onClick={openConfirm}>
            Update demand scores in Bubble
          </button>
        )}

        {status === "saved" && result && (
          <p className="saveresult ok">
            Done — {result.total} rows resolved ({result.created} created,{" "}
            {result.updated} updated, {result.deleted} removed).
          </p>
        )}
        {status === "error" && err && <p className="saveresult bad">{err}</p>}

        <LastPushInfo />
      </div>

      {confirming && (
        <div className="modalbackdrop" onClick={cancelConfirm}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Are you sure?</h3>
            <p>
              This will instantly update demand scores in Bubble for the
              current week, Monday to Monday.
            </p>
            <div className="modalactions">
              <button className="btn" onClick={cancelConfirm}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void run()}>
                Yes, update Bubble
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Reads from the server-side sync log (bubbleSyncLog), not client state — so
// it's correct on a fresh page load, after a reload mid-sync, or from a
// different admin's browser entirely, not just within the session that
// triggered the push.
function LastPushInfo() {
  const last = useQuery(api.operatorWeek.getLastAdminSync);

  if (last === undefined) {
    return <p className="lastpush muted">Checking last update…</p>;
  }
  if (last === null) {
    return (
      <p className="lastpush muted">
        No manual push yet — Bubble currently reflects the last scheduled
        Monday sync.
      </p>
    );
  }

  const when = new Date(last.finishedAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const who = last.triggeredBy ?? "an admin";

  if (last.status === "error") {
    return (
      <p className="lastpush bad">
        Last manual push attempt failed — {when} by {who}: {last.error}
      </p>
    );
  }

  return (
    <p className="lastpush muted">
      Last pushed to Bubble {when} by {who} — {last.total} rows (
      {last.created} created, {last.updated} updated, {last.deleted} removed).
    </p>
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
function IconUpload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4M12 4 7 9M12 4l5 5" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
