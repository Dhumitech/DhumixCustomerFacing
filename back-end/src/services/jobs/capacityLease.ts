export interface CapacityLease {
  readonly resourceId: string;
  readonly token: string;
}

export interface CapacityLeaseStore {
  acquire(resourceId: string, ttlMs: number): Promise<CapacityLease | null>;
  renew(lease: CapacityLease, ttlMs: number): Promise<boolean>;
  release(lease: CapacityLease): Promise<boolean>;
  close(): Promise<void>;
}
