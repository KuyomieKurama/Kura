export interface WriteContext {
  ownerUserId: string;
}

export interface WriteSession {
  id: string;
}

export interface Digest {
  algorithm: 'sha256';
  value: Uint8Array;
}

export interface ObjectRef {
  id: string;
}

export interface ObjectStat {
  size: number;
}

export interface DeletionPermit {
  id: string;
}

export interface StoredObject {
  id: string;
}

export interface RemovalResult {
  removed: boolean;
}

export interface StorageBackend {
  beginWrite(context: WriteContext): Promise<WriteSession>;
  append(session: WriteSession, chunk: Uint8Array): Promise<void>;
  finalize(session: WriteSession, digest: Digest): Promise<StoredObject>;
  openRead(object: ObjectRef): AsyncIterable<Uint8Array>;
  stat(object: ObjectRef): Promise<ObjectStat>;
  remove(object: ObjectRef, permit: DeletionPermit): Promise<RemovalResult>;
  abort(session: WriteSession): Promise<void>;
}
