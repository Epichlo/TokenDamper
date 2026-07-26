import type { GatewaySession, SessionContentEntry, SessionTurn } from './types';

/**
 * Stateful in-memory session manager for cross-turn context deduplication.
 */
export class GatewaySessionStore {
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;

  constructor(options: { sessionTtlMs?: number; maxSessions?: number } = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? 60 * 60 * 1000; // 1 hour default
    this.maxSessions = options.maxSessions ?? 100;
  }

  /**
   * Retrieves an existing session or creates a new session if it does not exist.
   */
  public getOrCreateSession(sessionId: string): GatewaySession {
    this.pruneExpired();

    let session = this.sessions.get(sessionId);
    const now = Date.now();

    if (!session) {
      if (this.sessions.size >= this.maxSessions) {
        this.evictOldestSession();
      }

      session = {
        sessionId,
        createdAt: now,
        lastActiveAt: now,
        turnCount: 0,
        seenBlockHashes: new Set<string>(),
        contentByHash: new Map<string, string>(),
        turns: [],
      };
      this.sessions.set(sessionId, session);
    } else {
      session.lastActiveAt = now;
    }

    return session;
  }

  /**
   * Records a turn result into the active session state.
   */
  public recordTurn(
    sessionId: string,
    turn: Omit<SessionTurn, 'turnIndex' | 'timestamp'>,
    newBlocks: ReadonlyArray<string | SessionContentEntry>,
  ): GatewaySession {
    const session = this.getOrCreateSession(sessionId);
    const now = Date.now();

    session.turnCount += 1;
    session.lastActiveAt = now;

    const fullTurn: SessionTurn = {
      ...turn,
      turnIndex: session.turnCount,
      timestamp: now,
    };

    session.turns.push(fullTurn);

    for (const block of newBlocks) {
      const hash = typeof block === 'string' ? block : block.hash;
      session.seenBlockHashes.add(hash);
      if (typeof block !== 'string') {
        session.contentByHash.set(hash, block.content);
      }
    }

    return session;
  }

  /**
   * Stores original raw content by hash for later rehydration.
   */
  public storeContent(sessionId: string, hash: string, content: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.seenBlockHashes.add(hash);
    session.contentByHash.set(hash, content);
  }

  /**
   * Retrieves original raw content by full content hash, short ref, or elision marker.
   */
  public getContent(sessionId: string, hashOrRef: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const normalizedRef = normalizeHashOrRef(hashOrRef);
    const exactMatch = session.contentByHash.get(normalizedRef);
    if (exactMatch !== undefined) {
      return exactMatch;
    }

    const prefixMatches: string[] = [];
    for (const [hash, content] of session.contentByHash.entries()) {
      if (hash.startsWith(normalizedRef)) {
        prefixMatches.push(content);
      }
    }

    return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
  }

  /**
   * Returns whether a block hash has been observed in previous turns of this session.
   */
  public hasBlockHash(sessionId: string, hash: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.seenBlockHashes.has(hash);
  }

  /**
   * Clears expired sessions based on TTL.
   */
  public pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActiveAt > this.sessionTtlMs) {
        this.sessions.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Returns total active session count.
   */
  public get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Evicts the least recently active session.
   */
  private evictOldestSession(): void {
    let oldestId: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [id, session] of this.sessions.entries()) {
      if (session.lastActiveAt < oldestTimestamp) {
        oldestTimestamp = session.lastActiveAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.sessions.delete(oldestId);
    }
  }

  /**
   * Clears all stored sessions.
   */
  public clear(): void {
    this.sessions.clear();
  }
}

function normalizeHashOrRef(hashOrRef: string): string {
  const elisionRef = /\bref=([A-Za-z0-9_-]+)/.exec(hashOrRef);
  if (elisionRef?.[1]) {
    return elisionRef[1];
  }

  return hashOrRef.trim();
}
