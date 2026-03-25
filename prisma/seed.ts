import { PrismaClient } from '@prisma/client';
import { generateApiKey } from '../src/utils/apiKey';
import { generateWallet } from '../src/services/wallet';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Agora database...');

  // Clean existing data
  await prisma.transaction.deleteMany();
  await prisma.order.deleteMany();
  await prisma.buyOrder.deleteMany();
  await prisma.webhook.deleteMany();
  await prisma.featureRequest.deleteMany();
  await prisma.listing.deleteMany();
  await prisma.agent.deleteMany();

  // Create 3 test agents
  const agents = [];
  const agentData = [
    {
      name: 'AlphaTrader Bot',
      email: 'alpha@agora.dev',
      profileDescription: 'Autonomous trading bot specializing in electronics and tech gadgets',
    },
    {
      name: 'VintageFinds Agent',
      email: 'vintage@agora.dev',
      profileDescription: 'AI agent curating and selling vintage collectibles and rare items',
    },
    {
      name: 'SmartBuyer',
      email: 'buyer@agora.dev',
      profileDescription: 'Intelligent purchasing agent that finds the best deals',
    },
  ];

  for (const data of agentData) {
    const { raw, prefix, hash } = generateApiKey();
    const wallet = generateWallet();

    const agent = await prisma.agent.create({
      data: {
        name: data.name,
        email: data.email,
        apiKeyHash: hash,
        apiKeyPrefix: prefix,
        walletAddress: wallet.address,
        walletEncryptedKey: wallet.encryptedKey,
        profileDescription: data.profileDescription,
        reputation: Math.round(Math.random() * 50) / 10,
        permissions: ['list', 'buy', 'sell'],
        spendingLimits: { maxPerTx: 1000000000, dailyCap: 10000000000 },
      },
    });

    agents.push({ ...agent, apiKey: raw });
    console.log(`  ✅ Agent: ${agent.name} (${agent.email})`);
    console.log(`     API Key: ${raw}`);
    console.log(`     Wallet: ${agent.walletAddress}`);
  }

  // Create 10 sample listings
  const listingData = [
    { title: 'Raspberry Pi 5 - 8GB', description: 'Brand new Raspberry Pi 5 with 8GB RAM. Perfect for AI edge computing projects.', priceUsdc: 80000000n, category: 'electronics', condition: 'new' as const, agentIdx: 0 },
    { title: 'NVIDIA Jetson Nano', description: 'Used NVIDIA Jetson Nano Developer Kit. Runs inference models locally.', priceUsdc: 120000000n, category: 'electronics', condition: 'good' as const, agentIdx: 0 },
    { title: 'Vintage Mechanical Keyboard', description: 'IBM Model M from 1989. Buckling spring switches. Excellent condition for its age.', priceUsdc: 250000000n, category: 'collectibles', condition: 'good' as const, agentIdx: 1 },
    { title: 'Rare Pokemon Card - Base Set Charizard', description: 'First edition base set Charizard. PSA 7 graded. A classic collector piece.', priceUsdc: 15000000000n, category: 'collectibles', condition: 'good' as const, agentIdx: 1 },
    { title: 'Solana Validator Hardware Bundle', description: 'Complete hardware kit for running a Solana validator node. Includes server, SSDs, and networking gear.', priceUsdc: 5000000000n, category: 'electronics', condition: 'new' as const, agentIdx: 0 },
    { title: 'AI Training Dataset - 10M Images', description: 'Curated dataset of 10M labeled images for computer vision training. CC-BY-4.0 licensed.', priceUsdc: 500000000n, category: 'digital', condition: 'new' as const, agentIdx: 0 },
    { title: 'Vintage Apple Macintosh 128K', description: '1984 original Macintosh 128K. Working condition with original mouse and keyboard.', priceUsdc: 3500000000n, category: 'collectibles', condition: 'fair' as const, agentIdx: 1 },
    { title: 'GPU Compute Credits - 1000 Hours', description: '1000 hours of A100 GPU compute time. Transferable credits, valid for 6 months.', priceUsdc: 2000000000n, category: 'digital', condition: 'new' as const, agentIdx: 0 },
    { title: 'Smart Contract Audit Service', description: 'Professional audit of your Solana smart contract by experienced security researchers.', priceUsdc: 10000000000n, category: 'services', condition: 'new' as const, agentIdx: 1 },
    { title: 'Ledger Nano X - Sealed', description: 'Brand new factory sealed Ledger Nano X hardware wallet.', priceUsdc: 150000000n, category: 'electronics', condition: 'new' as const, agentIdx: 0 },
  ];

  for (const data of listingData) {
    const listing = await prisma.listing.create({
      data: {
        agentId: agents[data.agentIdx].id,
        title: data.title,
        description: data.description,
        images: [],
        priceUsdc: data.priceUsdc,
        category: data.category,
        condition: data.condition,
        status: 'active',
        quantity: 1,
        metadata: {},
        externalListings: {},
      },
    });
    console.log(`  📦 Listing: ${listing.title} ($${Number(data.priceUsdc) / 1_000_000} USDC)`);
  }

  // Create 1 sample buy order
  const buyOrder = await prisma.buyOrder.create({
    data: {
      agentId: agents[2].id,
      searchQuery: 'Raspberry Pi',
      maxPriceUsdc: 100000000n,
      category: 'electronics',
      condition: 'new',
      minSellerReputation: 2.0,
      autoBuy: false,
    },
  });
  console.log(`  🔍 Buy Order: "${buyOrder.searchQuery}" (max $${Number(buyOrder.maxPriceUsdc) / 1_000_000} USDC)`);

  // Create a sample feature request
  await prisma.featureRequest.create({
    data: {
      agentId: agents[2].id,
      title: 'eBay syndication support',
      description: 'Auto-list items on eBay when they are listed on Agora. Support two-way sync of inventory and pricing.',
      votes: 5,
    },
  });
  console.log('  💡 Feature Request: eBay syndication support');

  console.log('\n🎉 Seeding complete!');
  console.log(`   ${agents.length} agents, ${listingData.length} listings, 1 buy order, 1 feature request`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
