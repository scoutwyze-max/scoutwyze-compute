import type { BookingParams, BookingResult, VendorBooker } from "../../src/engine/vendorBooker.js";
import type { ProviderId } from "../../src/types/schema.js";

/** Test double for VendorBooker — controllable success/failure, no
 * real (or simulated-with-fixed-behavior) dispatch, so tests can
 * exercise both the debit and no-debit-on-failure paths deterministically. */
export class FakeVendorBooker implements VendorBooker {
  private shouldSucceed = true;
  private failureReason = "vendor declined";
  public lastParams: BookingParams | undefined;

  constructor(public readonly providerId: ProviderId) {}

  setShouldSucceed(succeed: boolean, failureReason = "vendor declined"): void {
    this.shouldSucceed = succeed;
    this.failureReason = failureReason;
  }

  async book(params: BookingParams): Promise<BookingResult> {
    this.lastParams = params;
    if (!this.shouldSucceed) return { ok: false, reason: this.failureReason };
    return { ok: true, jobId: `fake-job-${this.providerId}`, connectInfo: { fake: true } };
  }
}
