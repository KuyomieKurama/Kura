import type { EndpointApprovals } from '@kura/immich-client';
import type { Pool } from 'pg';

export class PostgresEndpointApprovals implements EndpointApprovals {
  constructor(private readonly pool: Pool) {}

  async isApproved(host: string, port: number): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM immich_endpoint_approvals WHERE host=$1 AND port=$2', [host, port]);
    return (result.rowCount ?? 0) > 0;
  }
}
