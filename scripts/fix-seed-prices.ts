/**
 * fix-seed-prices.ts
 *
 * Fixes listings that were seeded with micro-USDC prices (6 decimal on-chain
 * units) instead of USDC cents.
 *
 * Conversion: micro-USDC ÷ 10,000 = USDC cents
 *   e.g. 80,000,000 (micro) → 8,000 cents ($80.00)
 *
 * Usage:
 *   npx tsx scripts/fix-seed-prices.ts           # dry-run (no changes)
 *   npx tsx scripts/fix-seed-prices.ts --apply    # actually update the DB
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const THRESHOLD = 10_000_000n; // anything above this is almost certainly micro-USDC
const DIVISOR = 10_000n;       // micro-USDC → USDC cents

async function main() {
  console.log(`\n🔍 Scanning for listings with priceUsdc > ${THRESHOLD.toLocaleString()}...`);
  console.log(`   Mode: ${APPLY ? '🟢 APPLY (will update DB)' : '🟡 DRY-RUN (no changes)'}\n`);

  const listings = await prisma.listing.findMany({
    where: {
      priceUsdc: { gt: THRESHOLD },
    },
    select: {
      id: true,
      title: true,
      priceUsdc: true,
      agent: { select: { name: true } },
    },
    orderBy: { priceUsdc: 'desc' },
  });

  if (listings.length === 0) {
    console.log('✅ No listings found with prices above threshold. Nothing to fix.\n');
    return;
  }

  console.log(`Found ${listings.length} listing(s) to fix:\n`);

  const pad = (s: string, n: number) => s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
  const rpad = (s: string, n: number) => s.length >= n ? s : ' '.repeat(n - s.length) + s;

  console.log(`  ${pad('ID', 36)}  ${pad('Title', 35)}  ${rpad('Old (micro)', 16)}  →  ${rpad('New (cents)', 10)}  Dollar value`);
  console.log('  ' + '─'.repeat(120));

  let updated = 0;

  for (const listing of listings) {
    const oldPrice = listing.priceUsdc;
    const newPrice = oldPrice / DIVISOR;
    const oldDollars = (Number(oldPrice) / 1_000_000).toFixed(2);
    const newDollars = (Number(newPrice) / 100).toFixed(2);

    console.log(
      `  ${pad(listing.id, 36)}  ${pad(listing.title.substring(0, 35), 35)}  ${rpad(oldPrice.toString(), 16)}  →  ${rpad(newPrice.toString(), 10)}  ($${oldDollars} → $${newDollars})`,
    );

    if (APPLY) {
      await prisma.listing.update({
        where: { id: listing.id },
        data: { priceUsdc: newPrice },
      });
      updated++;
    }
  }

  console.log('  ' + '─'.repeat(120));

  if (APPLY) {
    console.log(`\n✅ Updated ${updated} listing(s).\n`);
  } else {
    console.log(`\n🟡 Dry-run complete. ${listings.length} listing(s) would be updated.`);
    console.log('   Run with --apply to commit changes:\n');
    console.log('     npx tsx scripts/fix-seed-prices.ts --apply\n');
  }
}

main()
  .catch((e) => {
    console.error('❌ Script failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
