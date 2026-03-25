/**
 * Escrow Service — Solana Smart Contract Integration
 *
 * Replaces Phase 1 stubs with real Anchor program calls.
 * Uses @coral-xyz/anchor to interact with the deployed escrow program.
 *
 * In development (no PLATFORM_AUTHORITY_KEYPAIR), falls back to stub mode.
 */

import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { config } from '../config';
import { logger } from '../utils/logger';

// Import the generated IDL type — will exist after `anchor build`
// eslint-disable-next-line @typescript-eslint/no-var-requires
let ESCROW_IDL: any;
try {
  ESCROW_IDL = require('../../target/idl/escrow.json');
} catch {
  // IDL not built yet — stub mode
  ESCROW_IDL = null;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface EscrowResult {
  escrowAddress: string;
  vaultAddress: string;
  txSignature: string;
}

export interface EscrowConfig {
  orderId: string;
  buyerWallet: string;
  sellerWallet: string;
  amountUsdc: bigint;
  tier: number;
  disputeWindowHours: number;
  platformFeeBps: number;
  sellerBondAmount: bigint;
}

// ── Constants ──────────────────────────────────────────────────────────────

const USDC_MINT = new PublicKey(config.solana.usdcMint);
const ESCROW_PROGRAM_ID = ESCROW_IDL?.address
  ? new PublicKey(ESCROW_IDL.address)
  : new PublicKey('5xdcfLVGm56Fd8twF4L1vqrqsnSj2QybNF5rbRJTbfri');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Derive escrow PDA from order_id */
function getEscrowPDA(orderId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), Buffer.from(orderId)],
    ESCROW_PROGRAM_ID,
  );
}

/** Derive vault PDA from order_id */
function getVaultPDA(orderId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), Buffer.from(orderId)],
    ESCROW_PROGRAM_ID,
  );
}

/** Derive bond vault PDA from order_id */
function getBondVaultPDA(orderId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bond'), Buffer.from(orderId)],
    ESCROW_PROGRAM_ID,
  );
}

/** Check if we're in stub mode (no real Solana connection) */
function isStubMode(): boolean {
  return !process.env.PLATFORM_AUTHORITY_KEYPAIR || !ESCROW_IDL;
}

/** Get the platform authority keypair */
function getPlatformKeypair(): Keypair {
  const keypairStr = process.env.PLATFORM_AUTHORITY_KEYPAIR;
  if (!keypairStr) {
    throw new Error('PLATFORM_AUTHORITY_KEYPAIR not configured');
  }

  try {
    const bytes = JSON.parse(keypairStr);
    return Keypair.fromSecretKey(new Uint8Array(bytes));
  } catch {
    const bs58 = require('bs58');
    return Keypair.fromSecretKey(bs58.decode(keypairStr));
  }
}

/** Get Anchor program instance */
function getEscrowProgram(keypair?: Keypair): Program {
  const connection = new Connection(config.solana.clusterUrl, 'confirmed');
  const kp = keypair || getPlatformKeypair();
  const wallet = new Wallet(kp);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  return new Program(ESCROW_IDL, provider);
}

// ── Tier Configuration ─────────────────────────────────────────────────────

/** Default escrow parameters by tier */
export function getTierConfig(tier: number): {
  disputeWindowHours: number;
  platformFeeBps: number;
  requiresBond: boolean;
  bondPercentage: number;
} {
  switch (tier) {
    case 1:
      return { disputeWindowHours: 72, platformFeeBps: 250, requiresBond: false, bondPercentage: 0 };
    case 2:
      return { disputeWindowHours: 168, platformFeeBps: 250, requiresBond: false, bondPercentage: 0 };
    case 3:
      return { disputeWindowHours: 336, platformFeeBps: 250, requiresBond: true, bondPercentage: 10 };
    case 4:
      return { disputeWindowHours: 168, platformFeeBps: 200, requiresBond: true, bondPercentage: 10 };
    default:
      return { disputeWindowHours: 72, platformFeeBps: 250, requiresBond: false, bondPercentage: 0 };
  }
}

/** Determine tier from USDC amount (6 decimals) */
export function determineTier(amountUsdc: bigint): number {
  const dollars = Number(amountUsdc) / 1_000_000;
  if (dollars < 100) return 1;
  if (dollars <= 500) return 2;
  return 3;
}

// ── Escrow Operations ──────────────────────────────────────────────────────

/**
 * Create escrow — buyer deposits USDC to vault PDA.
 */
export async function createEscrow(
  buyerWallet: string,
  sellerWallet: string,
  amountUsdc: bigint,
  orderId?: string,
): Promise<EscrowResult> {
  // Generate order ID if not provided
  const escrowOrderId = orderId || `ORD_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const tier = determineTier(amountUsdc);
  const tierConfig = getTierConfig(tier);

  if (isStubMode()) {
    logger.info('Escrow creation (stub mode)', {
      orderId: escrowOrderId,
      amount: amountUsdc.toString(),
      tier,
      note: 'Set PLATFORM_AUTHORITY_KEYPAIR to use real Solana escrow',
    });

    const [escrowPDA] = getEscrowPDA(escrowOrderId);
    const [vaultPDA] = getVaultPDA(escrowOrderId);

    return {
      escrowAddress: escrowPDA.toBase58(),
      vaultAddress: vaultPDA.toBase58(),
      txSignature: 'STUB_' + Date.now().toString(36),
    };
  }

  // Real Solana call
  const program = getEscrowProgram();
  const [escrowPDA] = getEscrowPDA(escrowOrderId);
  const [vaultPDA] = getVaultPDA(escrowOrderId);

  const buyerPubkey = new PublicKey(buyerWallet);
  const sellerPubkey = new PublicKey(sellerWallet);
  const platformAuthority = getPlatformKeypair();

  const buyerTokenAccount = await getAssociatedTokenAddress(USDC_MINT, buyerPubkey);

  // Calculate seller bond
  const bondAmount = tierConfig.requiresBond
    ? BigInt(Math.ceil(Number(amountUsdc) * tierConfig.bondPercentage / 100))
    : BigInt(0);

  const txSig = await program.methods
    .createEscrow(
      escrowOrderId,
      new BN(amountUsdc.toString()),
      tier,
      tierConfig.disputeWindowHours,
      tierConfig.platformFeeBps,
      new BN(bondAmount.toString()),
    )
    .accounts({
      buyer: buyerPubkey,
      seller: sellerPubkey,
      platformAuthority: platformAuthority.publicKey,
      escrow: escrowPDA,
      vault: vaultPDA,
      tokenMint: USDC_MINT,
      buyerTokenAccount,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  logger.info('Escrow created on-chain', {
    orderId: escrowOrderId,
    escrow: escrowPDA.toBase58(),
    vault: vaultPDA.toBase58(),
    txSignature: txSig,
    tier,
    amount: amountUsdc.toString(),
  });

  return {
    escrowAddress: escrowPDA.toBase58(),
    vaultAddress: vaultPDA.toBase58(),
    txSignature: txSig,
  };
}

/**
 * Fund escrow — kept for backward compatibility.
 * In the new design, create_escrow handles both creation and funding.
 */
export async function fundEscrow(
  _escrowAddress: string,
  _buyerEncryptedKey: string,
  _amountUsdc: bigint,
): Promise<string> {
  logger.info('Escrow funding — handled by createEscrow in new design');
  return 'FUND_HANDLED_BY_CREATE';
}

/**
 * Mark order as shipped on-chain.
 */
export async function markShippedOnChain(
  orderId: string,
  sellerWallet: string,
  trackingNumber: string,
  carrier: string,
): Promise<string> {
  if (isStubMode()) {
    logger.info('Mark shipped (stub mode)', { orderId, trackingNumber, carrier });
    return 'SHIP_STUB_' + Date.now().toString(36);
  }

  const program = getEscrowProgram();
  const [escrowPDA] = getEscrowPDA(orderId);
  const sellerPubkey = new PublicKey(sellerWallet);

  const txSig = await program.methods
    .markShipped(trackingNumber, carrier)
    .accounts({
      seller: sellerPubkey,
      escrow: escrowPDA,
    })
    .rpc();

  logger.info('Order marked shipped on-chain', { orderId, txSignature: txSig });
  return txSig;
}

/**
 * Mark delivery confirmed on-chain (platform oracle).
 */
export async function markDeliveredOnChain(orderId: string): Promise<string> {
  if (isStubMode()) {
    logger.info('Mark delivered (stub mode)', { orderId });
    return 'DELIVER_STUB_' + Date.now().toString(36);
  }

  const platformKeypair = getPlatformKeypair();
  const program = getEscrowProgram(platformKeypair);
  const [escrowPDA] = getEscrowPDA(orderId);

  const txSig = await program.methods
    .markDelivered()
    .accounts({
      platformAuthority: platformKeypair.publicKey,
      escrow: escrowPDA,
    })
    .rpc();

  logger.info('Delivery confirmed on-chain', { orderId, txSignature: txSig });
  return txSig;
}

/**
 * Release escrow — send funds to seller.
 */
export async function releaseEscrow(
  escrowAddress: string,
  sellerWallet: string,
  orderId?: string,
): Promise<string> {
  if (isStubMode()) {
    logger.info('Escrow release (stub mode)', { escrowAddress, sellerWallet });
    return 'RELEASE_STUB_' + Date.now().toString(36);
  }

  if (!orderId) {
    throw new Error('orderId required for on-chain escrow release');
  }

  const program = getEscrowProgram();
  const [escrowPDA] = getEscrowPDA(orderId);
  const [vaultPDA] = getVaultPDA(orderId);

  const sellerPubkey = new PublicKey(sellerWallet);
  const sellerTokenAccount = await getAssociatedTokenAddress(USDC_MINT, sellerPubkey);
  const platformKeypair = getPlatformKeypair();
  const platformTokenAccount = await getAssociatedTokenAddress(USDC_MINT, platformKeypair.publicKey);

  const txSig = await program.methods
    .releaseEscrow()
    .accounts({
      caller: platformKeypair.publicKey,
      escrow: escrowPDA,
      vault: vaultPDA,
      sellerTokenAccount,
      platformTokenAccount,
      bondVault: null as any,
      sellerTokenAccountForBond: null as any,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  logger.info('Escrow released on-chain', { orderId, txSignature: txSig });
  return txSig;
}

/**
 * Open dispute on-chain.
 */
export async function openDisputeOnChain(
  orderId: string,
  buyerWallet: string,
  reason: string,
): Promise<string> {
  if (isStubMode()) {
    logger.info('Open dispute (stub mode)', { orderId, reason });
    return 'DISPUTE_STUB_' + Date.now().toString(36);
  }

  const program = getEscrowProgram();
  const [escrowPDA] = getEscrowPDA(orderId);
  const buyerPubkey = new PublicKey(buyerWallet);

  const txSig = await program.methods
    .openDispute(reason)
    .accounts({
      buyer: buyerPubkey,
      escrow: escrowPDA,
    })
    .rpc();

  logger.info('Dispute opened on-chain', { orderId, txSignature: txSig });
  return txSig;
}

/**
 * Cancel escrow — refund buyer.
 */
export async function refundEscrow(
  escrowAddress: string,
  buyerWallet: string,
  orderId?: string,
): Promise<string> {
  if (isStubMode()) {
    logger.info('Escrow refund (stub mode)', { escrowAddress, buyerWallet });
    return 'REFUND_STUB_' + Date.now().toString(36);
  }

  if (!orderId) {
    throw new Error('orderId required for on-chain escrow cancellation');
  }

  const program = getEscrowProgram();
  const [escrowPDA] = getEscrowPDA(orderId);
  const [vaultPDA] = getVaultPDA(orderId);

  const buyerPubkey = new PublicKey(buyerWallet);
  const buyerTokenAccount = await getAssociatedTokenAddress(USDC_MINT, buyerPubkey);
  const platformKeypair = getPlatformKeypair();

  const txSig = await program.methods
    .cancelEscrow()
    .accounts({
      caller: platformKeypair.publicKey,
      escrow: escrowPDA,
      vault: vaultPDA,
      buyerTokenAccount,
      bondVault: null as any,
      sellerTokenAccount: null as any,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  logger.info('Escrow cancelled on-chain', { orderId, txSignature: txSig });
  return txSig;
}

// ── Utility Exports ────────────────────────────────────────────────────────

export { getEscrowPDA, getVaultPDA, getBondVaultPDA, ESCROW_PROGRAM_ID };
