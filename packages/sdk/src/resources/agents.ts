import type { AgoraClient } from '../client';
import type {
  RegisterAgentRequest,
  RegisterAgentResponse,
  LoginApiKeyRequest,
  LoginWalletRequest,
  LoginResponse,
  MeResponse,
  AgentProfile,
  RotateKeyResponse,
} from '../types';

export class AgentsResource {
  constructor(private readonly client: AgoraClient) {}

  /**
   * Register a new agent. Returns the agent profile and API key.
   * The API key is only returned once — store it securely.
   *
   * No authentication required.
   */
  async register(data: RegisterAgentRequest): Promise<RegisterAgentResponse> {
    const res = await this.client.request<RegisterAgentResponse>(
      'POST',
      '/auth/register',
      { body: data, auth: false },
    );
    return res;
  }

  /**
   * Login with an API key. Returns a JWT token.
   */
  async loginWithApiKey(data: LoginApiKeyRequest): Promise<LoginResponse> {
    return this.client.request<LoginResponse>('POST', '/auth/login', {
      body: data,
      auth: false,
    });
  }

  /**
   * Login with a Solana wallet signature. Returns a JWT token.
   */
  async loginWithWallet(data: LoginWalletRequest): Promise<LoginResponse> {
    return this.client.request<LoginResponse>('POST', '/auth/login', {
      body: data,
      auth: false,
    });
  }

  /**
   * Get the currently authenticated agent's profile.
   */
  async me(): Promise<AgentProfile> {
    const res = await this.client.request<MeResponse>('GET', '/auth/me');
    return res.agent;
  }

  /**
   * Rotate the current API key. Returns the new key.
   * The old key is immediately invalidated.
   */
  async rotateKey(): Promise<RotateKeyResponse> {
    return this.client.request<RotateKeyResponse>('POST', '/auth/rotate-key');
  }
}
