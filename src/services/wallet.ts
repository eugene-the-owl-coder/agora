import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { config } from '../config';
import { encrypt, decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';

const connection = new Connection(
  config.solana.heliusApiKey
    ? `https://devnet.helius-rpc.com/?api-key=${config.solana.heliusApiKey}`
    : config.solana.clusterUrl,
  'confirmed',
);

const USDC_MINT = new PublicKey(config.solana.usdcMint);

export interface WalletInfo {
  address: string;
  encryptedKey: string;
}

export function generateWallet(): WalletInfo {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const secretKeyBase64 = Buffer.from(keypair.secretKey).toString('base64');
  const encryptedKey = encrypt(secretKeyBase64);

  logger.info('Generated new Solana wallet', { address });
  return { address, encryptedKey };
}

export function validateWalletAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export function decryptWalletKey(encryptedKey: string): Keypair {
  const secretKeyBase64 = decrypt(encryptedKey);
  const secretKey = Buffer.from(secretKeyBase64, 'base64');
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

export async function getBalances(
  walletAddress: string,
): Promise<{ sol: number; usdc: number; solLamports: bigint; usdcRaw: bigint }> {
  try {
    const pubkey = new PublicKey(walletAddress);

    // SOL balance
    const solLamports = BigInt(await connection.getBalance(pubkey));
    const sol = Number(solLamports) / LAMPORTS_PER_SOL;

    // USDC balance
    let usdcRaw = BigInt(0);
    let usdc = 0;
    try {
      const ata = await getAssociatedTokenAddress(USDC_MINT, pubkey);
      const tokenAccount = await getAccount(connection, ata);
      usdcRaw = tokenAccount.amount;
      usdc = Number(usdcRaw) / 1_000_000; // USDC has 6 decimals
    } catch {
      // Token account doesn't exist yet — balance is 0
    }

    return { sol, usdc, solLamports, usdcRaw };
  } catch (err) {
    logger.error('Failed to fetch wallet balances', {
      walletAddress,
      error: (err as Error).message,
    });
    throw err;
  }
}

export { connection, USDC_MINT };
