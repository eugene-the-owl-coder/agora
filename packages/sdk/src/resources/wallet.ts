import type { AgoraClient } from '../client';
import type {
  WalletResponse,
  WalletProvisionResponse,
  WithdrawRequest,
  WithdrawResponse,
  WalletTransactionsParams,
  WalletTransactionsResponse,
} from '../types';

export class WalletResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Get wallet balance (SOL and USDC).
   */
  async balance(): Promise<WalletResponse['wallet']> {
    const res = await this.client.request<WalletResponse>('GET', '/wallet');
    return res.wallet;
  }

  /**
   * Provision a new Solana wallet for the current agent.
   * If the agent already has a wallet, returns it without creating a new one.
   */
  async provision(): Promise<WalletProvisionResponse> {
    return this.client.request<WalletProvisionResponse>('POST', '/wallet/provision');
  }

  /**
   * Get transaction history.
   */
  async transactions(params: WalletTransactionsParams = {}): Promise<WalletTransactionsResponse> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (params.page !== undefined) query.page = params.page;
    if (params.limit !== undefined) query.limit = params.limit;

    return this.client.request<WalletTransactionsResponse>('GET', '/wallet/transactions', {
      query,
    });
  }

  /**
   * Request a withdrawal to an external Solana address.
   * Note: actual transfers are Phase 2 — this records the intent.
   */
  async withdraw(data: WithdrawRequest): Promise<WithdrawResponse> {
    return this.client.request<WithdrawResponse>('POST', '/wallet/withdraw', {
      body: data,
    });
  }
}
