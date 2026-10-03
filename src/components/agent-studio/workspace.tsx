"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, CircleAlert, Eye, FileCode2, RefreshCw, Square, Unplug } from "lucide-react";
import type { WorkflowAction, WorkflowRequest } from "../../lib/agent-api-studio-workflow/contracts.ts";
import { actionRequest, createPrivateStudioGateway, reviewRequest, StudioClientError } from "./gateway.ts";
import type { StudioGateway, StudioSnapshot } from "./gateway.ts";
import { replacementDiff } from "./diff.ts";
import "./workspace.css";

const STATUS: Record<string,string> = { proposed: "Awaiting your review", approved: "Approved · ready to execute", running: "Action in progress", succeeded: "Completed", failed: "Stopped before completion", cancelled: "Cancelled", rejected: "Change rejected", uncertain: "Outcome uncertain" };
function sourceOf(action?: WorkflowAction): string {
  const content = action?.result?.structuredContent;
  return content && typeof content === "object" && !Array.isArray(content) && typeof content.source === "string" ? content.source : "";
}
function ActionDiff({ action }: { action: WorkflowAction }) {
  const edits = action.proposal.input.edits;
  if (!Array.isArray(edits)) return null;
  return <div className="studio-diffs">{edits.map((edit,index) => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit) || typeof edit.oldText !== "string" || typeof edit.newText !== "string") return null;
    const lines = replacementDiff(edit.oldText, edit.newText);
    return <section key={index} className="studio-diff" aria-label={`Change in ${edit.path}`}>
      <div className="studio-file"><FileCode2 size={16}/><code>{String(edit.path)}</code><span>{lines.filter(line => line.kind === "added").length} added · {lines.filter(line => line.kind === "removed").length} removed</span></div>
      <div className="studio-diff-lines">{lines.map((line,row) => <div key={row} className={`studio-diff-line ${line.kind}`}>
        <span className="studio-line-number" aria-hidden="true">{line.before ?? line.after}</span><span className="studio-line-sign" aria-label={line.kind}>{line.kind === "removed" ? "−" : line.kind === "added" ? "+" : " "}</span><code>{line.text || " "}</code>
      </div>)}</div>
    </section>;
  })}</div>;
}

export function StudioWorkspace({ projectId, projectName, archived = false, gateway: supplied, fixture = false }: { projectId: string; projectName: string; archived?: boolean; gateway?: StudioGateway; fixture?: boolean }) {
  const gateway = useMemo(() => supplied ?? createPrivateStudioGateway(projectId), [supplied,projectId]);
  const [snapshot,setSnapshot] = useState<StudioSnapshot | null>(null);
  const [fresh,setFresh] = useState(false);
  const [studioId,setStudioId] = useState("");
  const [path,setPath] = useState("ReplicatedStorage.UI.Theme");
  const [replacement,setReplacement] = useState("");
  const [busy,setBusy] = useState<string | null>(null);
  const [error,setError] = useState("");
  const [acceptedDigest,setAcceptedDigest] = useState<string | null>(null);
  const [draftMode,setDraftMode] = useState(false);
  const [clock,setClock] = useState(() => Date.now());
  const actions = snapshot?.checkpoint.actions ?? [];
  const write = actions.find(action => action.proposal.effect === "write");
  const accepted = !!write && acceptedDigest === write.digest;
  const inspection = actions.find(action => action.proposal.effect === "read" && action.status === "succeeded");
  const pendingRead = actions.find(action => action.proposal.effect === "read" && ["approved","running"].includes(action.status));
  const selection = snapshot?.checkpoint.selection ?? null;
  const before = sourceOf(inspection);
  const expired = !!write && Date.parse(write.expiresAt) <= clock;
  const inspectionFresh = !!inspection && Date.parse(inspection.expiresAt) > clock;
  const sameSelection = !!write && selection?.target.selectionId === write.proposal.target.selectionId;
  const available = fresh && !!snapshot?.connectionAvailable && !archived;
  const refresh = useCallback(async () => {
    try {
      const next = await gateway.load();
      setSnapshot(next); setFresh(true); setError("");
      return next;
    } catch (failure) {
      setFresh(false); setError(failure instanceof Error ? failure.message : "Unable to refresh Studio status.");
      if (failure instanceof StudioClientError && [401,404].includes(failure.status)) { setSnapshot(null); setReplacement(""); setStudioId(""); }
      return null;
    }
  },[gateway]);
  useEffect(() => { let active = true; void gateway.load().then(next => { if (active) { setSnapshot(next); setFresh(true); } }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : "Studio review unavailable."); }); return () => { active = false; }; },[gateway]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()),1000); return () => clearInterval(timer); },[]);
  useEffect(() => { if (busy !== "execute" && busy !== "inspect" && write?.status !== "running" && !pendingRead) return; const timer = setInterval(() => { void refresh(); },500); return () => clearInterval(timer); },[busy,write?.status,pendingRead,refresh]);

  async function perform(request: WorkflowRequest) {
    if (!fresh) return;
    setBusy(request.operation); setError("");
    try {
      const result = await gateway.send(request);
      if ("actionId" in result && result.proposal.effect === "write") setDraftMode(false);
      if ("actionId" in result) setSnapshot(current => current ? { ...current, checkpoint: { ...current.checkpoint, actions: [result,...current.checkpoint.actions.filter(action => action.actionId !== result.actionId)] } } : current);
      const latest = await refresh();
      if (request.operation === "inspect" && latest) {
        const read = latest.checkpoint.actions.find(action => action.proposal.effect === "read" && action.status === "succeeded");
        setReplacement(sourceOf(read).replace("214, 77, 77","80, 145, 230").replace("'red'","'blue'"));
      }
    } catch (failure) {
      await refresh();
      setError(failure instanceof Error ? failure.message : "This action could not be completed. Refresh status before continuing.");
    } finally { setBusy(null); }
  }
  const unique = (operation: string) => `ui:${operation}:${crypto.randomUUID()}`;
  const propose = () => inspection && perform({ projectId, operation: "propose", key: unique("propose"), inspectionId: inspection.actionId, input: { datamodel_type: "Edit", edits: [{ path,oldText: before,newText: replacement }] } });
  const selectedTarget = write?.proposal.target ?? selection?.target;
  const canEdit = available && !!selection && inspectionFresh && inspection?.selectionId === selection.selectionId && (!write || (["cancelled","rejected","failed","succeeded"].includes(write.status) && inspection?.actionId !== write.inspectionId));
  const canReview = available && sameSelection && !expired && write?.status === "proposed" && !busy;
  const canExecute = available && sameSelection && !expired && write?.status === "approved" && !busy;
  const canCancel = fresh && !!write && ["proposed","approved","running"].includes(write.status) && (!busy || busy === "execute");
  const showReview = !!write && (!draftMode || ["proposed","approved","running","uncertain"].includes(write.status));
  return <main className="studio-workspace" id="main-content">
    <div className="studio-breadcrumb"><span>Romanum</span><ChevronRight size={13}/><span>{projectName}</span><ChevronRight size={13}/><span>Studio review</span></div>
    <header className="studio-heading"><div><p className="studio-eyebrow">PROJECT WORKSPACE</p><h1>Review before it runs.</h1><p>Inspect a chosen Studio, review the exact change, then decide what happens.</p></div><span className={`studio-mode ${fixture ? "fixture" : ""}`}><Unplug size={14}/>{fixture ? "Authored fixture" : "Private project"}</span></header>
    {fixture && <div className="studio-fixture-notice"><span className="studio-dot"/><span><strong>No live Studio connection.</strong> This preview uses authored sample code and simulated actions. It creates no access grants or credentials.</span></div>}
    {archived && <div className="studio-notice">This project is archived. History and cancellation remain available.</div>}
    {snapshot && !snapshot.connectionAvailable && <div className="studio-notice" role="status">Studio is disconnected. Saved status, cancellation and expired-attempt recovery remain available. Reconnect and explicitly select a Studio before any new action.</div>}
    {error && <div className="studio-error" role="alert"><CircleAlert size={16}/><span>{error}</span><button onClick={() => { void refresh(); }}>Refresh status</button></div>}
    <nav className="studio-progress" aria-label="Workflow progress">{["Choose Studio","Inspect","Review change","Execute"].map((step,index) => <span key={step} className={(index===0&&selection)||(index===1&&inspection)||(index===2&&write)||(index===3&&write?.status==="succeeded") ? "done" : ""}><span>{index+1}</span>{step}</span>)}</nav>
    <div className="studio-grid">
      <div className="studio-main-column">
        <section className="studio-panel studio-selection"><div className="studio-section-heading"><h2>Connected Studio</h2><span>{selection ? "Explicitly selected" : "Choose one to continue"}</span></div>
          <div className="studio-select-row"><label>Studio session<select value={studioId || selection?.target.studioId || ""} onChange={event => setStudioId(event.target.value)} disabled={!available || !!busy}><option value="">Choose a Studio…</option>{snapshot?.discovery.sessions.map(session => <option key={session.studioId} value={session.studioId}>{session.name ?? session.studioId} · Place {session.placeId ?? "not reported"}</option>)}</select></label><button className="studio-secondary" disabled={!available || !studioId || !!busy} onClick={() => { void perform({ projectId,operation:"select",key:unique("select"),studioId }); }}>Select Studio</button><button className="studio-secondary" disabled={!available || !selection || !!busy} onClick={() => { if (selection) void perform({ projectId,operation:"inspect",key:unique("inspect"),selectionId:selection.selectionId }); }}><Eye size={15}/>{busy === "inspect" ? "Inspecting…" : "Inspect"}</button></div>
          {selection && <p className="studio-subtext">{selection.target.name ?? selection.target.studioId} · Place {selection.target.placeId ?? "not reported"} · {selection.target.studioId}</p>}
          {snapshot?.checkpoint.requiresSelection && actions.length>0 && <p className="studio-notice">The previous connection is no longer selected. Choose a Studio and inspect it again; saved approval does not reconnect it.</p>}
        </section>
        {pendingRead && <section className="studio-panel"><div className="studio-section-heading"><h2>Unfinished inspection</h2><span>{pendingRead.status === "running" ? "Waiting for a result" : "Not dispatched"}</span></div><p className="studio-subtext">Read status is saved. Cancel this inspection or recover its expired attempt; neither sends another inspection.</p><div className="studio-action-footer"><button className="studio-text-button" onClick={() => { void refresh(); }}><RefreshCw size={14}/>Refresh status</button><button className="studio-secondary" disabled={!fresh || (!!busy && busy !== "inspect")} onClick={() => { void perform(actionRequest(projectId,"cancel",pendingRead.actionId)); }}>Cancel inspection</button>{pendingRead.recoverable && <button className="studio-secondary" disabled={!fresh || (!!busy && busy !== "inspect")} onClick={() => { void perform(actionRequest(projectId,"recover",pendingRead.actionId)); }}>Recover expired inspection</button>}<code>{pendingRead.actionId}</code></div></section>}
        {!showReview && <section className="studio-panel"><div className="studio-section-heading"><h2>Propose a change</h2><span>{inspection ? "From the inspected fixture" : "Inspection required"}</span></div>
          <label>Script path<input value={path} onChange={event => setPath(event.target.value)} maxLength={300} disabled={!canEdit || !!busy}/></label>
          <div className="studio-editors"><label>Inspected replacement text<textarea value={before} readOnly aria-label="Inspected replacement text" placeholder="Inspect the selected Studio to read the fixture code."/></label><label>Proposed replacement<textarea value={replacement} onChange={event => setReplacement(event.target.value)} maxLength={4000} disabled={!canEdit || !!busy} placeholder="Your proposed change appears here after inspection."/></label></div>
          <div className="studio-editor-footer"><span>Nothing runs when you create a proposal.</span><button className="studio-primary" disabled={!canEdit || !before || !path || before === replacement || !!busy} onClick={() => { void propose(); }}>Review change <ChevronRight size={15}/></button></div>
        </section>}
        {write && showReview && <section className="studio-panel studio-review"><div className="studio-section-heading"><div><p className="studio-eyebrow">EXACT CHANGE</p><h2>Review the replacement</h2></div><span className={`studio-status ${write.status}`} data-testid="action-status">{STATUS[write.status]}</span></div>
          <p className="studio-review-target">{write.proposal.target.name ?? write.proposal.target.studioId} · Place {write.proposal.target.placeId ?? "not reported"} <span>· Edit mode</span></p>
          <ActionDiff action={write}/>
          {write.status === "proposed" && <div className="studio-review-controls"><label className="studio-checkbox"><input type="checkbox" checked={accepted} onChange={event => setAcceptedDigest(event.target.checked ? write.digest : null)} disabled={!canReview}/>I reviewed this exact change and the selected Studio.</label><div><button className="studio-secondary" disabled={!canReview} onClick={() => { void perform(reviewRequest(projectId,write,false)); }}>Reject change</button><button className="studio-primary" disabled={!canReview || !accepted} onClick={() => { void perform(reviewRequest(projectId,write,true)); }}><Check size={16}/>Approve this change</button></div></div>}
          {write.status === "approved" && <div className="studio-review-controls"><p>Approved for this exact Studio and replacement. Execution is a separate action.</p><button className="studio-primary" disabled={!canExecute} onClick={() => { void perform(actionRequest(projectId,"execute",write.actionId)); }}>{fixture ? "Execute fixture change" : "Execute approved change"}<ChevronRight size={15}/></button></div>}
          {(expired || !sameSelection) && ["proposed","approved"].includes(write.status) && <p className="studio-notice">{expired ? "This review has expired." : "The selected Studio has changed."} Cancel the proposal, then inspect and create a new change.</p>}
          {write.status === "running" && <p className="studio-subtext">Waiting for a verified result. Reloading or refreshing will read status, without sending another action.</p>}
          {write.status === "uncertain" && <div className="studio-uncertain"><CircleAlert size={20}/><div><h3>Stop here. The outcome needs verification.</h3><p>The write may have reached Studio. Cancellation does not prove it stopped or rolled back. Another write to this Studio is blocked until trusted reconciliation.</p><p>Keep this action ID and compare the selected place with the exact change above. This milestone has no reconciliation override.</p></div></div>}
          {write.status === "succeeded" && <p className="studio-result"><Check size={17}/>The {fixture ? "authored fixture" : "selected Studio"} returned a completed result. Repeated execution uses the saved outcome.</p>}
          {["cancelled","rejected","failed"].includes(write.status) && <p className="studio-subtext">This action cannot execute. A new change needs an explicit selection, inspection and review.</p>}
          <div className="studio-action-footer"><button className="studio-text-button" onClick={() => { void refresh(); }}><RefreshCw size={14}/>Refresh status</button>{canCancel && <button className="studio-secondary" onClick={() => { void perform(actionRequest(projectId,"cancel",write.actionId)); }}><Square size={13}/>Cancel action</button>}{write.recoverable && <button className="studio-secondary" disabled={!fresh || (!!busy && busy !== "execute")} onClick={() => { void perform(actionRequest(projectId,"recover",write.actionId)); }}>Recover expired attempt</button>}{["succeeded","cancelled","rejected","failed"].includes(write.status) && <button className="studio-secondary" disabled={!available || !!busy} onClick={() => { setDraftMode(true); setReplacement(""); }}>New change</button>}</div>
        </section>}
      </div>
      <aside className="studio-side-column"><section className="studio-panel studio-evidence"><p className="studio-eyebrow">ACTION EVIDENCE</p><h2>{write ? "Bound to this review" : "Your selection stays explicit"}</h2><dl><dt>Project</dt><dd>{projectName}</dd><dt>Studio / place</dt><dd>{selectedTarget ? `${selectedTarget.name ?? selectedTarget.studioId} / ${selectedTarget.placeId ?? "not reported"}` : "None selected"}</dd><dt>Action</dt><dd>{write?.proposal.tool ?? "Inspection first"}</dd><dt>Review expiry</dt><dd>{write ? expired ? "Expired" : `${Math.max(0,Math.ceil((Date.parse(write.expiresAt)-clock)/1000))} seconds remaining` : "Starts when a change is proposed"}</dd><dt>Dispatch evidence</dt><dd>{write?.dispatchPhase === "dispatching" ? "Dispatch marker saved" : "No write dispatch recorded"}</dd></dl>
        {write && <details><summary>Review identifiers</summary><p>Action <code>{write.actionId}</code></p><p>Exact review digest <code>{write.digest}</code></p>{write.leaseExpiresAt && <p>Attempt lease <code>{write.leaseExpiresAt}</code></p>}</details>}
        <p className="studio-subtext">A selection or approval never grants general access to a Studio.</p>
      </section>
      <section className="studio-panel studio-history"><h2>Recent actions</h2>{actions.length ? <ol>{actions.slice(0,6).map(action => <li key={action.actionId}><span className={`studio-history-dot ${action.status}`}/><div><strong>{action.proposal.effect === "read" ? "Inspect Studio" : "Review replacement"}</strong><span>{STATUS[action.status]} · {action.proposal.target.studioId}</span></div></li>)}</ol> : <p className="studio-subtext">Inspection and review results will appear here.</p>}</section>
      {gateway.fixtureScenario && <details className="studio-panel studio-fixture-controls"><summary>Fixture scenarios</summary><p>Only the authored sample changes. These controls simulate transport failure and an expired attempt.</p><div><button onClick={() => gateway.fixtureScenario?.("hold")}>Pause next write</button><button onClick={() => gateway.fixtureScenario?.("uncertain")}>Lose next response</button><button onClick={() => { gateway.fixtureScenario?.("expire"); void refresh(); }}>Expire attempt lease</button></div></details>}
      </aside>
    </div>
  </main>;
}
