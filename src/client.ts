import { Collection, type RecordData } from './collection.js';
import { HttpClient, type ClientOptions } from './http.js';

export interface ConnectionInfo {
  id: string;
  name: string;
  adapterType: string;
  mode: 'read_only' | 'read_write';
  status: string;
}

export interface CollectionInfo {
  name: string;
  displayName: string;
  fields: Array<{ name: string; type: string; required: boolean; primaryKey: boolean }>;
}

/**
 * The entry point of the SDK.
 *
 *   const cms = new SethuClient({ baseUrl: 'https://cms.example.com', token });
 *   const orders = cms.collection('conn_123', 'orders');
 *   const page = await orders.where(eq('status', 'paid')).orderBy('created_at', 'desc').limit(20).list();
 */
export class SethuClient {
  private readonly http: HttpClient;

  constructor(options: ClientOptions) {
    this.http = new HttpClient(options);
  }

  collection<T extends RecordData = RecordData>(connectionId: string, name: string): Collection<T> {
    return new Collection<T>(this.http, connectionId, name);
  }

  async connections(options: { signal?: AbortSignal } = {}): Promise<ConnectionInfo[]> {
    const response = await this.http.request<{ data: ConnectionInfo[] }>({ method: 'GET', path: '/v1/connections', ...options });
    return response.data;
  }

  async collections(connectionId: string, options: { signal?: AbortSignal } = {}): Promise<CollectionInfo[]> {
    const response = await this.http.request<{ data: CollectionInfo[] }>({
      method: 'GET',
      path: `/v1/connections/${encodeURIComponent(connectionId)}/collections`,
      ...options,
    });
    return response.data;
  }

  /** True when the gateway reports that it is ready. Never throws. */
  async isHealthy(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    try {
      await this.http.request<unknown>({ method: 'GET', path: '/v1/health', ...options });
      return true;
    } catch {
      return false;
    }
  }
}
