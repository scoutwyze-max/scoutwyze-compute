import type { ProviderId } from "../types/schema.js";

export interface BookingParams {
  sku: string;
  region: string;
  hours: number;
  vendorHourly: number;
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
