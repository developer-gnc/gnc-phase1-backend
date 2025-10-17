class SessionStore {
  constructor() {
    this.userSessions = new Map(); // userId -> Set of sessionIds
    this.sessionData = new Map();  // sessionId -> session info
    this.imageOwnership = new Map(); // filename -> userId for quick lookup
  }

  createSession(userId, sessionId, sessionData) {
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    
    this.userSessions.get(userId).add(sessionId);
    
    this.sessionData.set(sessionId, {
      ...sessionData,
      userId,
      createdAt: Date.now(),
      images: new Set()
    });
  }

  registerImage(sessionId, filename, userId) {
    const session = this.sessionData.get(sessionId);
    if (session) {
      session.images.add(filename);
      this.imageOwnership.set(filename, userId);
    }
  }

  validateImageAccess(userId, filename) {
    const ownerUserId = this.imageOwnership.get(filename);
    return ownerUserId === userId;
  }

  validateUserSession(userId, sessionId) {
    const userSessions = this.userSessions.get(userId);
    return userSessions && userSessions.has(sessionId);
  }

  removeSession(userId, sessionId) {
    const session = this.sessionData.get(sessionId);
    if (session && session.userId === userId) {
      for (const filename of session.images) {
        this.imageOwnership.delete(filename);
      }
      
      const userSessions = this.userSessions.get(userId);
      if (userSessions) {
        userSessions.delete(sessionId);
        if (userSessions.size === 0) {
          this.userSessions.delete(userId);
        }
      }
      
      this.sessionData.delete(sessionId);
      return true;
    }
    return false;
  }

  getUserSessions(userId) {
    const userSessions = this.userSessions.get(userId);
    if (!userSessions) return [];
    
    return Array.from(userSessions).map(sessionId => {
      const data = this.sessionData.get(sessionId);
      return {
        sessionId,
        createdAt: data?.createdAt,
        imageCount: data?.images?.size || 0
      };
    });
  }

  cleanupOldSessions(maxAge = 2 * 60 * 60 * 1000) {
    const now = Date.now();
    const expiredSessions = [];
    
    for (const [sessionId, data] of this.sessionData.entries()) {
      if (now - data.createdAt > maxAge) {
        expiredSessions.push({ sessionId, userId: data.userId });
      }
    }
    
    expiredSessions.forEach(({ sessionId, userId }) => {
      this.removeSession(userId, sessionId);
    });
    
    return expiredSessions;
  }
}

module.exports = new SessionStore();