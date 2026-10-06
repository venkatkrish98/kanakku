import { describe, it, expect } from 'vitest';
import {
  isAuthorizedForLedgerWrite,
  assertAuthorizedForLedgerWrite,
  AuthorizationError,
  isConfirmationIntent,
  isCancellationIntent,
} from './authorization';

describe('Shared Authorization Boundary & Unambiguous Confirmation Safety', () => {
  describe('Role-based Ledger Write Permissions', () => {
    it('authorizes owner and accountant roles', () => {
      expect(isAuthorizedForLedgerWrite('owner')).toBe(true);
      expect(isAuthorizedForLedgerWrite('accountant')).toBe(true);
    });

    it('rejects member and unknown/undefined roles', () => {
      expect(isAuthorizedForLedgerWrite('member')).toBe(false);
      expect(isAuthorizedForLedgerWrite('viewer')).toBe(false);
      expect(isAuthorizedForLedgerWrite(undefined)).toBe(false);
      expect(isAuthorizedForLedgerWrite('')).toBe(false);
    });

    it('assertAuthorizedForLedgerWrite throws AuthorizationError for unauthorized roles', () => {
      expect(() => assertAuthorizedForLedgerWrite('member')).toThrow(AuthorizationError);
      expect(() => assertAuthorizedForLedgerWrite(undefined)).toThrow(AuthorizationError);
      expect(() => assertAuthorizedForLedgerWrite('owner')).not.toThrow();
      expect(() => assertAuthorizedForLedgerWrite('accountant')).not.toThrow();
    });
  });

  describe('isConfirmationIntent: Unambiguous Intent vs. Contradictions/Conditions', () => {
    it('rejects contradictory or conditional utterances that start with affirmative words', () => {
      // The exact critical regression case from review:
      expect(isConfirmationIntent("Yes, but don't post it yet")).toBe(false);
      expect(isConfirmationIntent("yes, but don't post it yet")).toBe(false);

      // Additional contradictory and conditional variants:
      expect(isConfirmationIntent('Yes, but wait')).toBe(false);
      expect(isConfirmationIntent('Yes, except check the total first')).toBe(false);
      expect(isConfirmationIntent('Sure, but hold on')).toBe(false);
      expect(isConfirmationIntent('Confirm, if the date is today')).toBe(false);
      expect(isConfirmationIntent('Okay, unless we already paid it')).toBe(false);
      expect(isConfirmationIntent('Yes, but cancel instead')).toBe(false);
      expect(isConfirmationIntent('Proceed, but pause a second')).toBe(false);
      expect(isConfirmationIntent("Don't confirm this")).toBe(false);
      expect(isConfirmationIntent('Never mind, stop')).toBe(false);
    });

    it('accepts unambiguous affirmative confirmation utterances', () => {
      expect(isConfirmationIntent('confirm')).toBe(true);
      expect(isConfirmationIntent('Confirm')).toBe(true);
      expect(isConfirmationIntent('Confirm it')).toBe(true);
      expect(isConfirmationIntent('confirm this transaction')).toBe(true);
      expect(isConfirmationIntent('yes')).toBe(true);
      expect(isConfirmationIntent('Yes')).toBe(true);
      expect(isConfirmationIntent('Yes, please')).toBe(true);
      expect(isConfirmationIntent('Yes, please confirm this transaction')).toBe(true);
      expect(isConfirmationIntent('Proceed')).toBe(true);
      expect(isConfirmationIntent('Proceed and confirm')).toBe(true);
      expect(isConfirmationIntent('Approve')).toBe(true);
      expect(isConfirmationIntent('Looks good')).toBe(true);
      expect(isConfirmationIntent('Go ahead and post it')).toBe(true);
      expect(isConfirmationIntent('Save it')).toBe(true);
      expect(isConfirmationIntent('Sure, go ahead')).toBe(true);
      expect(isConfirmationIntent('Okay, confirm that')).toBe(true);
    });

    it('rejects general queries or unrelated instructions', () => {
      expect(isConfirmationIntent('What is my cash balance?')).toBe(false);
      expect(isConfirmationIntent('Record expense 500 for dinner')).toBe(false);
      expect(isConfirmationIntent('Who owes me money?')).toBe(false);
      expect(isConfirmationIntent('')).toBe(false);
    });
  });

  describe('isCancellationIntent: Unambiguous Intent vs. Contradictions/Conditions', () => {
    it('rejects contradictory or hesitant cancellation utterances starting with "No" or "Cancel"', () => {
      // The exact critical regression case from review:
      expect(isCancellationIntent("No, don't cancel yet")).toBe(false);
      expect(isCancellationIntent("no, don't cancel yet")).toBe(false);

      // Additional contradictory, hesitant, or conditional cancellation variants:
      expect(isCancellationIntent("No, don't cancel")).toBe(false);
      expect(isCancellationIntent('No, wait a minute')).toBe(false);
      expect(isCancellationIntent('No, keep it')).toBe(false);
      expect(isCancellationIntent('Cancel if it is over 500')).toBe(false);
      expect(isCancellationIntent('No, hold on')).toBe(false);
      expect(isCancellationIntent('Wait, do not cancel')).toBe(false);
      expect(isCancellationIntent('No, I want to confirm')).toBe(false);
      expect(isCancellationIntent('Cancel, but check the invoice first')).toBe(false);
      expect(isCancellationIntent('No, save the draft')).toBe(false);
    });

    it('accepts unambiguous cancellation utterances', () => {
      expect(isCancellationIntent('cancel')).toBe(true);
      expect(isCancellationIntent('Cancel')).toBe(true);
      expect(isCancellationIntent('Cancel it')).toBe(true);
      expect(isCancellationIntent('cancel this draft')).toBe(true);
      expect(isCancellationIntent('no, cancel it')).toBe(true);
      expect(isCancellationIntent('No, cancel this transaction')).toBe(true);
      expect(isCancellationIntent('discard')).toBe(true);
      expect(isCancellationIntent('discard it')).toBe(true);
      expect(isCancellationIntent('abort')).toBe(true);
      expect(isCancellationIntent('reject')).toBe(true);
      expect(isCancellationIntent('nevermind')).toBe(true);
      expect(isCancellationIntent("don't do that")).toBe(true);
      expect(isCancellationIntent("No, don't do that")).toBe(true);
    });

    it('rejects general non-cancellation utterances', () => {
      expect(isCancellationIntent('What are my expenses?')).toBe(false);
      expect(isCancellationIntent('Create an invoice')).toBe(false);
      expect(isCancellationIntent('')).toBe(false);
    });
  });
});
