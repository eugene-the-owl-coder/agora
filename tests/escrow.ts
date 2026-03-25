import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { assert } from 'chai';

// Import the generated types
import { Escrow } from '../target/types/escrow';

describe('escrow', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Escrow as Program<Escrow>;

  // Test keypairs
  let buyer: Keypair;
  let seller: Keypair;
  let platformAuthority: Keypair;

  // Token accounts
  let usdcMint: PublicKey;
  let buyerTokenAccount: PublicKey;
  let sellerTokenAccount: PublicKey;
  let platformTokenAccount: PublicKey;

  const orderId = 'TEST_ORDER_001';
  const amount = new anchor.BN(100_000_000); // 100 USDC (6 decimals)
  const tier = 1;
  const disputeWindowHours = 72;
  const platformFeeBps = 250; // 2.5%
  const sellerBondAmount = new anchor.BN(0); // no bond for tier 1

  before(async () => {
    buyer = Keypair.generate();
    seller = Keypair.generate();
    platformAuthority = Keypair.generate();

    // Airdrop SOL to all parties
    const airdropBuyer = await provider.connection.requestAirdrop(
      buyer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(airdropBuyer);

    const airdropSeller = await provider.connection.requestAirdrop(
      seller.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(airdropSeller);

    const airdropPlatform = await provider.connection.requestAirdrop(
      platformAuthority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(airdropPlatform);

    // Create USDC mint
    usdcMint = await createMint(
      provider.connection,
      buyer as any,
      buyer.publicKey,
      null,
      6, // 6 decimals like real USDC
    );

    // Create token accounts
    buyerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      buyer as any,
      usdcMint,
      buyer.publicKey,
    );

    sellerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      seller as any,
      usdcMint,
      seller.publicKey,
    );

    platformTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      platformAuthority as any,
      usdcMint,
      platformAuthority.publicKey,
    );

    // Mint USDC to buyer
    await mintTo(
      provider.connection,
      buyer as any,
      usdcMint,
      buyerTokenAccount,
      buyer.publicKey,
      1_000_000_000, // 1000 USDC
    );
  });

  // Derive PDAs
  function getEscrowPDA() {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), Buffer.from(orderId)],
      program.programId,
    );
  }

  function getVaultPDA() {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), Buffer.from(orderId)],
      program.programId,
    );
  }

  it('creates an escrow', async () => {
    const [escrowPDA] = getEscrowPDA();
    const [vaultPDA] = getVaultPDA();

    await program.methods
      .createEscrow(
        orderId,
        amount,
        tier,
        disputeWindowHours,
        platformFeeBps,
        sellerBondAmount,
      )
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        platformAuthority: platformAuthority.publicKey,
        escrow: escrowPDA,
        vault: vaultPDA,
        tokenMint: usdcMint,
        buyerTokenAccount: buyerTokenAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    // Verify escrow state
    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    assert.equal(escrow.orderId, orderId);
    assert.ok(escrow.buyer.equals(buyer.publicKey));
    assert.ok(escrow.seller.equals(seller.publicKey));
    assert.equal(escrow.amount.toNumber(), amount.toNumber());
    assert.equal(escrow.tier, tier);
    assert.deepEqual(escrow.status, { created: {} });

    // Verify vault received USDC
    const vaultAccount = await getAccount(provider.connection, vaultPDA);
    assert.equal(Number(vaultAccount.amount), amount.toNumber());

    // Verify buyer balance decreased
    const buyerAccount = await getAccount(provider.connection, buyerTokenAccount);
    assert.equal(Number(buyerAccount.amount), 1_000_000_000 - amount.toNumber());
  });

  it('marks order as shipped', async () => {
    const [escrowPDA] = getEscrowPDA();

    await program.methods
      .markShipped('TRACK123456789', 'fedex')
      .accounts({
        seller: seller.publicKey,
        escrow: escrowPDA,
      })
      .signers([seller])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    assert.deepEqual(escrow.status, { shipped: {} });
    assert.equal(escrow.trackingNumber, 'TRACK123456789');
    assert.equal(escrow.carrier, 'fedex');
    assert.ok(escrow.shippedAt.toNumber() > 0);
  });

  it('marks delivery confirmed (platform oracle)', async () => {
    const [escrowPDA] = getEscrowPDA();

    await program.methods
      .markDelivered()
      .accounts({
        platformAuthority: platformAuthority.publicKey,
        escrow: escrowPDA,
      })
      .signers([platformAuthority])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    assert.deepEqual(escrow.status, { delivered: {} });
    assert.ok(escrow.deliveredAt.toNumber() > 0);
  });

  it('releases escrow to seller (buyer confirmation)', async () => {
    const [escrowPDA] = getEscrowPDA();
    const [vaultPDA] = getVaultPDA();

    const sellerBalanceBefore = await getAccount(provider.connection, sellerTokenAccount);

    await program.methods
      .releaseEscrow()
      .accounts({
        caller: buyer.publicKey,
        escrow: escrowPDA,
        vault: vaultPDA,
        sellerTokenAccount: sellerTokenAccount,
        platformTokenAccount: platformTokenAccount,
        bondVault: null,
        sellerTokenAccountForBond: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    assert.deepEqual(escrow.status, { completed: {} });

    // Verify seller received payment (minus platform fee)
    const platformFee = Math.floor((amount.toNumber() * platformFeeBps) / 10000);
    const expectedSellerAmount = amount.toNumber() - platformFee;

    const sellerBalanceAfter = await getAccount(provider.connection, sellerTokenAccount);
    assert.equal(
      Number(sellerBalanceAfter.amount) - Number(sellerBalanceBefore.amount),
      expectedSellerAmount,
    );

    // Verify platform received fee
    const platformBalance = await getAccount(provider.connection, platformTokenAccount);
    assert.equal(Number(platformBalance.amount), platformFee);
  });
});

describe('escrow - cancellation', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Escrow as Program<Escrow>;

  let buyer: Keypair;
  let seller: Keypair;
  let platformAuthority: Keypair;
  let usdcMint: PublicKey;
  let buyerTokenAccount: PublicKey;

  const cancelOrderId = 'TEST_CANCEL_001';
  const amount = new anchor.BN(50_000_000); // 50 USDC

  before(async () => {
    buyer = Keypair.generate();
    seller = Keypair.generate();
    platformAuthority = Keypair.generate();

    const airdropBuyer = await provider.connection.requestAirdrop(
      buyer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(airdropBuyer);

    usdcMint = await createMint(
      provider.connection,
      buyer as any,
      buyer.publicKey,
      null,
      6,
    );

    buyerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      buyer as any,
      usdcMint,
      buyer.publicKey,
    );

    await mintTo(
      provider.connection,
      buyer as any,
      usdcMint,
      buyerTokenAccount,
      buyer.publicKey,
      500_000_000,
    );
  });

  it('creates and cancels an escrow', async () => {
    const [escrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), Buffer.from(cancelOrderId)],
      program.programId,
    );
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), Buffer.from(cancelOrderId)],
      program.programId,
    );

    const balanceBefore = await getAccount(provider.connection, buyerTokenAccount);

    // Create escrow
    await program.methods
      .createEscrow(
        cancelOrderId,
        amount,
        1, // tier
        72, // dispute window
        250, // fee bps
        new anchor.BN(0), // no bond
      )
      .accounts({
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        platformAuthority: platformAuthority.publicKey,
        escrow: escrowPDA,
        vault: vaultPDA,
        tokenMint: usdcMint,
        buyerTokenAccount: buyerTokenAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    // Verify funds in vault
    const vaultBalance = await getAccount(provider.connection, vaultPDA);
    assert.equal(Number(vaultBalance.amount), amount.toNumber());

    // Cancel escrow
    await program.methods
      .cancelEscrow()
      .accounts({
        caller: buyer.publicKey,
        escrow: escrowPDA,
        vault: vaultPDA,
        buyerTokenAccount: buyerTokenAccount,
        bondVault: null,
        sellerTokenAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    // Verify escrow cancelled
    const escrow = await program.account.escrowAccount.fetch(escrowPDA);
    assert.deepEqual(escrow.status, { cancelled: {} });

    // Verify buyer got refund
    const balanceAfter = await getAccount(provider.connection, buyerTokenAccount);
    assert.equal(Number(balanceAfter.amount), Number(balanceBefore.amount));
  });
});
