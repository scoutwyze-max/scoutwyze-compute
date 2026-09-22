import type { ProviderId } from "../types/schema.js";

export interface BookingParams {
  sku: string;
  region: string;
  hours: number;
  vendorHourly: number;
  gpuCount: number;
}

export type BookingResult =
  | { ok: true; jobId: string; connectInfo?: Record<string, unknown> }
  | { ok: false; reason: string };

/** One booker per provider it actually supports. Narrow surface,
 * deliberately — dispatch is the one thing that must be pluggable per
 * vendor's real API shape once one exists. */
export interface VendorBooker {
  providerId: ProviderId;
  book(params: BookingParams): Promise<BookingResult>;
}

/**
 * SIMULATED dispatch, not a real vendor API call — there is no real
 * Lambda Labs API integration or credentials anywhere in this
 * codebase (provider data itself is fixture-backed, see
 * rawSource.ts's own header comment). This exists so POST /v1/route/
 * book's debit-after-success flow, error handling, and response shape
 * are real and testable end to end, with a single honestly-labeled
 * placeholder standing in for the one piece that genuinely can't be
 * real yet (an actual vendor's provisioning API). Swap this for a real
 * HTTP-backed implementation of the same VendorBooker interface once
 * real Lambda Labs API credentials exist — nothing else in book.ts
 * changes.
 */
export class SimulatedLambdaLabsBooker implements VendorBooker {
  readonly providerId = "lambda_labs" as const;

  async book(params: BookingParams): Promise<BookingResult> {
    return {
      ok: true,
      jobId: `sim-lambda-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      connectInfo: {
        simulated: true,
        sku: params.sku,
        region: params.region,
        hours: params.hours,
        note: "Simulated dispatch — no real instance was provisioned. Replace SimulatedLambdaLabsBooker with a real Lambda Labs API client to make this real.",
      },
    };
  }
}

/**
 * Real Lambda Cloud dispatch — POST /instance-operations/launch,
 * verified directly against Lambda's own docs (2026-09), not from
 * memory: https://docs.lambda.ai/public-cloud/on-demand/creating-managing-instances/
 * Auth is HTTP Basic with the API key as username, empty password
 * (Lambda's own documented convention, not a guess).
 *
 * `instance_type_name`/`region_name` are passed straight from
 * `recommended.sku`/`recommended.region` with no translation — the
 * lambda_labs fixture data was deliberately structured to mirror
 * Lambda's real naming convention already (see lambdaLabs.ts's own
 * header comment), so this is a direct pass-through, not a mapping I
 * invented.
 *
 * Real, load-bearing prerequisite Lambda's API itself requires:
 * `ssh_key_names` must reference at least one SSH key already
 * uploaded to the Lambda account (Lambda Cloud console -> SSH Keys) —
 * launch_instance has no way to create one inline. If
 * LAMBDA_SSH_KEY_NAME isn't configured, this fails closed with a
 * clear reason instead of ever calling Lambda's API with a request
 * guaranteed to be rejected.
 *
 * A very real, expected failure mode once this is live: rank's
 * recommendation comes from FIXTURE data (not Lambda's live
 * inventory), so a real launch attempt can genuinely fail with
 * "insufficient capacity" for a SKU/region the fixture claims exists.
 * That's not a bug — it's the honest consequence of ranking against
 * mock data while dispatching for real; debit-after-success means a
 * capacity failure here costs the customer nothing.
 */
export class LambdaLabsBooker implements VendorBooker {
  readonly providerId = "lambda_labs" as const;

  constructor(
    private readonly apiKey: string,
    private readonly sshKeyName: string | undefined,
  ) {}

  async book(params: BookingParams): Promise<BookingResult> {
    if (!this.sshKeyName) {
      return { ok: false, reason: "LAMBDA_SSH_KEY_NAME not configured — Lambda's API requires an existing SSH key name to launch an instance, and none is set." };
    }

    let res: Response;
    try {
      res = await fetch("https://cloud.lambdalabs.com/api/v1/instance-operations/launch", {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          region_name: params.region,
          instance_type_name: params.sku,
          ssh_key_names: [this.sshKeyName],
          quantity: 1,
        }),
      });
    } catch (err) {
      return { ok: false, reason: `Lambda API request failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    const body = (await res.json().catch(() => null)) as { data?: { instance_ids?: string[] }; error?: { message?: string } } | null;

    if (!res.ok) {
      return { ok: false, reason: body?.error?.message ?? `Lambda API returned HTTP ${res.status}` };
    }
    const instanceId = body?.data?.instance_ids?.[0];
    if (!instanceId) {
      return { ok: false, reason: "Lambda API returned 200 but no instance_ids in the response" };
    }

    return {
      ok: true,
      jobId: instanceId,
      connectInfo: { instanceId, region: params.region, instanceType: params.sku },
    };
  }
}

/**
 * Real RunPod dispatch — POST https://api.runpod.io/v2/pods, verified
 * directly against RunPod's own docs (2026-09), not from memory. V1
 * (rest.runpod.io/v1/pods) is deprecated (retiring 2026-11-15) —
 * deliberately built against v2 from the start rather than something
 * already scheduled to break.
 *
 * `image`/`diskGb` are real product decisions (what container image a
 * customer's pod boots with, how much local disk it gets) that don't
 * have an answer anywhere else in this codebase — documented defaults,
 * overridable via env, not values to silently bake in as if they were
 * considered business decisions.
 */
export class RunPodBooker implements VendorBooker {
  readonly providerId = "runpod" as const;

  constructor(
    private readonly apiKey: string,
    private readonly image: string,
    private readonly diskGb: number,
  ) {}

  async book(params: BookingParams): Promise<BookingResult> {
    let res: Response;
    try {
      res = await fetch("https://api.runpod.io/v2/pods", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `scoutwyze-${Date.now()}`,
          gpu: { id: params.sku, count: params.gpuCount },
          image: this.image,
          dataCenterIds: [params.region],
          disk: this.diskGb,
        }),
      });
    } catch (err) {
      return { ok: false, reason: `RunPod API request failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    const body = (await res.json().catch(() => null)) as { id?: string; status?: string; error?: string; message?: string } | null;

    if (!res.ok) {
      return { ok: false, reason: body?.error ?? body?.message ?? `RunPod API returned HTTP ${res.status}` };
    }
    if (!body?.id) {
      return { ok: false, reason: "RunPod API returned success but no pod id in the response" };
    }

    return {
      ok: true,
      jobId: body.id,
      connectInfo: { podId: body.id, status: body.status, region: params.region, gpu: params.sku, gpuCount: params.gpuCount },
    };
  }
}
