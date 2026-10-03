import { createRoot } from "react-dom/client";
import { StudioWorkspace } from "../../src/components/agent-studio/workspace.tsx";
import { createBrowserFixtureGateway, PREVIEW_PROJECT_ID } from "../../src/components/agent-studio/preview-fixture.ts";
import type { StudioGateway } from "../../src/components/agent-studio/gateway.ts";

declare global { interface Window { studioTestGateway?: StudioGateway; studioTestProjectId?: string; studioPreviewReady?: boolean } }
const gateway=window.studioTestGateway ?? createBrowserFixtureGateway(sessionStorage);
createRoot(document.getElementById("root")!).render(<StudioWorkspace projectId={window.studioTestProjectId ?? PREVIEW_PROJECT_ID} projectName="Authored UI fixture" fixture gateway={gateway}/>);
window.studioPreviewReady=true;
