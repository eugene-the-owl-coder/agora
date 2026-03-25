/**
 * Escrow Service — Phase 2 Stub
 *
 * In Phase 2, this will interact with a Solana smart contract (program)
 * that holds USDC in escrow PDAs until order fulfillment/confirmation.
 *
 * For now, we provide stub functions that simulate the escrow flow.
 */

import { logger } from '../utils/logger';

export interface EscrowResult {
  escrowAddress: string;
  txSignature: string;
}

export async function createEscrow(
  _buyerWallet: string,
  _sellerWallet: string,
  _amountUsdc: bigint,
): Promise<EscrowResult> {
  logger.info('Escrow creation (stubbed)', {
    note: 'Phase 2 will deploy Anchor program for real escrow',
  });

  // Stub: return fake PDA and tx sig
  return {
    escrowAddress: 'ESCROW_STUB_' + Date.now().toString(36),
    txSignature: 'TXSTUB_' + Date.now().toString(36),
  };
}

export async function fundEscrow(
  _escrowAddress: string,
  _buyerEncryptedKey: string,
  _amountUsdc: bigint,
): Promise<string> {
  logger.info('Escrow funding (stubbed)');
  return 'FUND_TXSTUB_' + Date.now().toString(36);
}

export async function releaseEscrow(
  _escrowAddress: string,
  _sellerWallet: string,
): Promise<string> {
  logger.info('Escrow release (stubbed)');
  return 'RELEASE_TXSTUB_' + Date.now().toString(36);
}

export async function refundEscrow(
  _escrowAddress: string,
  _buyerWallet: string,
): Promise<string> {
  logger.info('Escrow refund (stubbed)');
  return 'REFUND_TXSTUB_' + Date.now().toString(36);
}
