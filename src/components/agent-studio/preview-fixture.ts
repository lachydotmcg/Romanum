import type { ActionProposal, Discovery } from "../../../packages/studio-bridge/src/index.ts";
import { workflowRequest } from "../../lib/agent-api-studio-workflow/contracts.ts";
import type { Selection, WorkflowAction, WorkflowRequest } from "../../lib/agent-api-studio-workflow/contracts.ts";
import { StudioClientError } from "./gateway.ts";
import type { StudioGateway, StudioSnapshot } from "./gateway.ts";

export const PREVIEW_PROJECT_ID = "9be76076-6243-4084-bb61-48c02c3c1d40";
export const PREVIEW_SOURCE = "local Theme = {}\n\nTheme.Accent = Color3.fromRGB(214, 77, 77)\nTheme.Spacing = 8\nTheme.CornerRadius = 6\n\nreturn Theme";
type FixtureState = { version: 1; source: string; selection: Selection | null; actions: WorkflowAction[]; receipts: Record<string,{ request: string; resourceId: string }> };
type Storage = Pick<globalThis.Storage,"getItem" | "setItem">;
const STORE = "romanum-authored-studio-preview-v1";
const uuid = () => crypto.randomUUID();
const copy = <T,>(value: T): T => structuredClone(value);
const fail = (status: number, message: string): never => { throw new StudioClientError(status,message); };
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes),byte => byte.toString(16).padStart(2,"0")).join("");
}

/** Browser-only authored simulation. No fetch, account, SQL, Studio, helper or
 * access token. Its session storage contains sample text/IDs only. Browser QA
 * separately drives the same UI through the real fixture SQL service/handler.
 */
export function createBrowserFixtureGateway(storage?: Storage): StudioGateway {
  let state: FixtureState = { version:1,source:PREVIEW_SOURCE,selection:null,actions:[],receipts:{} };
  try { const saved = storage?.getItem(STORE); if (saved) { const parsed = JSON.parse(saved); if (parsed.version===1 && typeof parsed.source==="string" && parsed.source.length<=4000 && Array.isArray(parsed.actions) && parsed.actions.length<=32 && parsed.receipts && typeof parsed.receipts==="object") state=parsed; } } catch { /* A damaged authored preview starts fresh. */ }
  let scenario: "normal" | "hold" | "uncertain" = "normal";
  const waits = new Map<string,(action: WorkflowAction) => void>();
  const save = () => { try { storage?.setItem(STORE,JSON.stringify(state)); } catch { /* The preview remains usable without storage. */ } };
  const discovery: Discovery = { connectionId:"offline-authored-fixture",sessions:[{ studioId:"studio-a",name:"Authored lobby fixture",placeId:"101" },{ studioId:"studio-b",name:"Authored UI fixture",placeId:"202" }],capabilities:[] };
  const find = (id: string): WorkflowAction => state.actions.find(action => action.actionId===id) ?? fail(404,"Fixture action not found.");
  function snapshot(): StudioSnapshot {
    for (const action of state.actions) action.recoverable=action.status==="running" && !!action.leaseExpiresAt && Date.parse(action.leaseExpiresAt)<=Date.now();
    return copy({ discovery,connectionAvailable:true,checkpoint:{ actions:state.actions,selection:state.selection,requiresSelection:!state.selection } });
  }
  async function send(input: WorkflowRequest): Promise<Selection | WorkflowAction> {
    const parsed = workflowRequest.safeParse(input);
    if (!parsed.success) return fail(400,"Invalid authored fixture request.");
    const request = parsed.data;
    if (request.projectId!==PREVIEW_PROJECT_ID) return fail(404,"This preview only contains its authored fixture project.");
    const requestText=JSON.stringify(request), prior=state.receipts[request.key];
    if (prior) {
      if (prior.request!==requestText) return fail(409,"That fixture request key belongs to a different action.");
      return copy(request.operation==="select" ? state.selection ?? fail(409,"Choose a fixture Studio again.") : find(prior.resourceId));
    }
    const receipt = (id: string) => { state.receipts[request.key]={ request:requestText,resourceId:id }; save(); };
    if (request.operation==="select") {
      const session=discovery.sessions.find(item=>item.studioId===request.studioId) ?? fail(404,"Choose one of the authored Studio fixtures.");
      state.selection={ selectionId:uuid(),target:{ ...session,connectionId:discovery.connectionId,selectionId:uuid() } };
      receipt(state.selection.selectionId); return copy(state.selection);
    }
    if (request.operation==="inspect" || request.operation==="propose") {
      const selection=state.selection ?? fail(409,"Explicitly select a fixture Studio first.");
      let inspection: WorkflowAction | null = null;
      if (request.operation==="inspect" && request.selectionId!==selection.selectionId) return fail(409,"Choose the current fixture selection.");
      if (request.operation==="propose") {
        inspection=find(request.inspectionId);
        if (inspection.proposal.effect!=="read" || inspection.status!=="succeeded" || inspection.selectionId!==selection.selectionId || Date.parse(inspection.expiresAt)<=Date.now()) return fail(409,"Inspect the selected fixture again.");
        if (state.actions.some(action=>action.proposal.effect==="write" && ["proposed","approved","running","uncertain"].includes(action.status))) return fail(409,"Resolve the existing fixture action before another change.");
        const latestWrite=state.actions.find(action=>action.proposal.effect==="write" && action.status==="succeeded");
        if (latestWrite && state.actions.indexOf(inspection)>state.actions.indexOf(latestWrite)) return fail(409,"Inspect again after the completed fixture change.");
      }
      const actionId=uuid(), tool=inspection?"multi_edit":"get_studio_state";
      const proposal: ActionProposal={ actionId,target:selection.target,tool,effect:inspection?"write":"read",version:"authored-browser-fixture-v1",input:request.operation==="propose"?request.input:{},digest:"",requiresConfirmation:!!inspection };
      proposal.digest=await digest(proposal);
      const action: WorkflowAction={ actionId,selectionId:selection.selectionId,inspectionId:inspection?.actionId??null,proposal,digest:await digest({project:PREVIEW_PROJECT_ID,proposal,inspection:inspection?.actionId}),status:inspection?"proposed":"succeeded",dispatchPhase:"pending",result:inspection?null:{structuredContent:{ source:state.source,studio_id:selection.target.studioId,mock:true },content:[]},errorCode:null,expiresAt:new Date(Date.now()+30_000).toISOString(),leaseExpiresAt:null,recoverable:false };
      state.actions.unshift(action); state.actions=state.actions.slice(0,32); receipt(actionId); return copy(action);
    }
    const action=find(request.actionId);
    if (request.operation==="review" || request.operation==="execute") {
      if (action.proposal.target.selectionId!==state.selection?.target.selectionId) return fail(409,"The fixture selection changed. Inspect and propose again.");
      if (Date.parse(action.expiresAt)<=Date.now()) return fail(409,"This fixture review expired. Cancel it and inspect again.");
    }
    if (request.operation==="review") {
      if (action.status!=="proposed" || request.digest!==action.digest) return fail(409,"Review this exact proposed fixture change.");
      action.status=request.approve?"approved":"rejected"; receipt(action.actionId); return copy(action);
    }
    if (request.operation==="cancel" || request.operation==="recover") {
      if (request.operation==="recover" && (action.status!=="running" || !snapshot().checkpoint.actions.find(item=>item.actionId===action.actionId)?.recoverable)) return fail(409,"Only an expired fixture attempt can be recovered.");
      if (["proposed","approved","running"].includes(action.status)) action.status=action.status==="running" && action.dispatchPhase==="dispatching"?"uncertain":"cancelled";
      action.errorCode=action.status==="uncertain"?"reconciliation_required":"cancelled"; action.leaseExpiresAt=null; action.recoverable=false;
      receipt(action.actionId); waits.get(action.actionId)?.(copy(action)); waits.delete(action.actionId); return copy(action);
    }
    if (action.status!=="approved") return fail(409,"This fixture change cannot execute again.");
    action.status="running"; action.dispatchPhase="dispatching"; action.leaseExpiresAt=new Date(Date.now()+60_000).toISOString(); receipt(action.actionId);
    const mode=scenario; scenario="normal";
    if (mode==="hold") return new Promise(resolve=>waits.set(action.actionId,resolve));
    const edits=action.proposal.input.edits;
    if (Array.isArray(edits)) for (const edit of edits) if (edit && typeof edit==="object" && !Array.isArray(edit) && typeof edit.oldText==="string" && typeof edit.newText==="string") state.source=state.source.replace(edit.oldText,edit.newText);
    action.status=mode==="uncertain"?"uncertain":"succeeded"; action.errorCode=mode==="uncertain"?"reconciliation_required":null; action.result=mode==="uncertain"?null:{ structuredContent:{ applied:true,source:state.source,mock:true },content:[] }; action.leaseExpiresAt=null; save(); return copy(action);
  }
  return { load:async()=>snapshot(),send,fixtureScenario(mode) {
    if (mode!=="expire") { scenario=mode; return; }
    const running=state.actions.find(action=>action.status==="running");
    if (running) running.leaseExpiresAt=new Date(Date.now()-1000).toISOString();
    save();
  } };
}
