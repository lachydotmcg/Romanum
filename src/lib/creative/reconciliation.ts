import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../history/database.ts";
import { releaseReservation, settleReservation } from "../credits/ledger.ts";
import { inspectPng } from "./image-provider.ts";
import { idSchema, ownerIdSchema } from "./schema.ts";
import { CreativeError, insertAsset, transactionDatabase } from "./storage.ts";
import { readCreativeJob } from "./workflow.ts";

const common = z.object({
  ownerId: ownerIdSchema, projectId: idSchema, jobId: idSchema, resolutionId: idSchema,
  operatorId: ownerIdSchema,
  // An operator must independently verify the worker has stopped and the
  // provider outcome. A timeout, missing output or model guess is not evidence.
  workerStopped: z.literal(true),
  evidenceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
});
const resolutionSchema = z.discriminatedUnion("outcome", [
  common.extend({ outcome: z.literal("not_charged"), actualCredits: z.literal(0) }).strict(),
  common.extend({ outcome: z.literal("charged_without_output"), actualCredits: z.number().int().min(1).max(1000) }).strict(),
  common.extend({ outcome: z.literal("recovered"), actualCredits: z.number().int().min(0).max(1000), output: z.object({ bytes: z.instanceof(Uint8Array), mimeType: z.literal("image/png") }).strict() }).strict(),
]);
export type CreativeResolution = z.infer<typeof resolutionSchema>;
type ResolutionRow = {
  id: string; job_id: string; owner_id: string; project_id: string;
  outcome: CreativeResolution["outcome"]; actual_credits: number;
  output_asset_id: string | null; fingerprint: string;
};
const summary = (row: ResolutionRow) => ({
  id: row.id, jobId: row.job_id, outcome: row.outcome, actualCredits: row.actual_credits,
  outputAssetId: row.output_asset_id, status: row.outcome === "recovered" ? "succeeded" : "failed",
});

// Trusted operator service, never a model tool or anonymous route. This is
// test-credit reconciliation only. Production needs authenticated operator
// authority and actual provider-receipt verification before accepting money.
export async function reconcileCreativeJob(database: Database, input: CreativeResolution) {
  const data = resolutionSchema.parse(input);
  let outputBytes: Uint8Array | null = null;
  let outputHash: string | null = null;
  if (data.outcome === "recovered") {
    inspectPng(data.output.bytes);
    outputBytes = Uint8Array.from(data.output.bytes);
    outputHash = createHash("sha256").update(outputBytes).digest("hex");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    ownerId: data.ownerId, projectId: data.projectId, jobId: data.jobId, resolutionId: data.resolutionId,
    operatorId: data.operatorId, evidenceId: data.evidenceId, outcome: data.outcome,
    actualCredits: data.actualCredits, outputHash,
  })).digest("hex");
  return database.transaction(async (sql) => {
    const initial = await readCreativeJob(sql, data.ownerId, data.jobId);
    if (initial.project_id !== data.projectId) throw new CreativeError("not_found");
    // Queueing also locks workflow first. Serializing here makes a recovered
    // charge visible before another job checks its remaining workflow budget.
    await sql.query("SELECT id FROM creative_workflows WHERE id=$1 AND owner_id=$2 FOR UPDATE", [initial.workflow_id, data.ownerId]);
    const job = await readCreativeJob(sql, data.ownerId, data.jobId, true);
    if (job.provider_mode !== "test") throw new CreativeError("unavailable");
    const prior = await sql.query<ResolutionRow>("SELECT * FROM creative_reconciliations WHERE job_id=$1 OR id=$2", [job.id, data.resolutionId]);
    if (prior.rows.length) {
      if (prior.rows.length !== 1 || prior.rows[0].fingerprint !== fingerprint) throw new CreativeError("conflict");
      return summary(prior.rows[0]);
    }
    if (job.status !== "uncertain" || data.actualCredits > job.quoted_credits) throw new CreativeError("conflict");
    let assetId: string | null = null;
    if (outputBytes) {
      assetId = await insertAsset(sql, { ownerId: data.ownerId, projectId: data.projectId, bytes: outputBytes, kind: "generated", metadata: {
        jobId: job.id, workflowId: job.workflow_id, stage: job.stage, assetKey: job.asset_key,
        provider: job.provider_id, model: job.provider_model, mode: job.provider_mode, reconciliationId: data.resolutionId,
      } });
    }
    const inserted = await sql.query<ResolutionRow>("INSERT INTO creative_reconciliations(id,job_id,owner_id,project_id,operator_id,evidence_id,outcome,actual_credits,output_asset_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *", [data.resolutionId, job.id, data.ownerId, data.projectId, data.operatorId, data.evidenceId, data.outcome, data.actualCredits, assetId, fingerprint]);
    if (!inserted.rows.length) throw new CreativeError("conflict");
    const ledger = transactionDatabase(sql), operationId = `creative:${job.id}`;
    if (data.outcome === "not_charged") await releaseReservation(ledger, { ownerId: data.ownerId, operationId });
    else await settleReservation(ledger, { ownerId: data.ownerId, operationId, actualCost: data.actualCredits });
    await sql.query("UPDATE creative_jobs SET status=$2,output_asset_id=$3,error_code=$4,finished_at=now() WHERE id=$1", [job.id, assetId ? "succeeded" : "failed", assetId, assetId ? null : data.outcome === "not_charged" ? "reconciled_not_charged" : "reconciled_without_output"]);
    return summary(inserted.rows[0]);
  });
}
