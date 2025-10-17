const jwt = require('jsonwebtoken');
const User = require('../models/User');

const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'No token provided' 
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.SESSION_SECRET);
    
    // Fetch fresh user data to ensure user still exists and is valid
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ 
        error: 'Authentication failed',
        message: 'User not found' 
      });
    }

    // Verify domain restriction
    if (!user.email.endsWith('@gncgroup.ca')) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'Domain not allowed' 
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'Account is deactivated' 
      });
    }

    // Update last login timestamp
    user.lastLogin = new Date();
    await user.save();

    // Attach user to request object with essential fields only
    req.user = {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      profilePicture: user.profilePicture,
      lastLogin: user.lastLogin
    };
    
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Authentication failed',
        message: 'Invalid token' 
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Authentication failed',
        message: 'Token expired' 
      });
    }

    console.error('Auth middleware error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Authentication check failed' 
    });
  }
};

// Optional middleware for routes that work with or without auth
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(); // Continue without user
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.SESSION_SECRET);
    const user = await User.findById(decoded.id);

    if (user && user.email.endsWith('@gncgroup.ca') && user.isActive) {
      req.user = {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePicture: user.profilePicture,
        lastLogin: user.lastLogin
      };
    }

    next();
  } catch (error) {
    // Ignore auth errors for optional auth
    next();
  }
};

// Rate limiting per user
const createUserRateLimit = (maxRequests = 10, windowMs = 15 * 60 * 1000) => {
  const userRequests = new Map();

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required for rate limiting' });
    }

    const userId = req.user.id;
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get user's requests
    if (!userRequests.has(userId)) {
      userRequests.set(userId, []);
    }

    const requests = userRequests.get(userId);
    
    // Remove old requests outside the window
    const validRequests = requests.filter(timestamp => timestamp > windowStart);
    userRequests.set(userId, validRequests);

    // Check if user has exceeded the limit
    if (validRequests.length >= maxRequests) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests. Limit: ${maxRequests} per ${windowMs / 1000 / 60} minutes`,
        retryAfter: Math.ceil((validRequests[0] - windowStart) / 1000)
      });
    }

    // Add current request
    validRequests.push(now);
    userRequests.set(userId, validRequests);

    next();
  };
};

const checkAuth = (req, res, next) => {
  res.json({ isAuthenticated: false });
};

module.exports = {
  requireAuth,
  optionalAuth,
  createUserRateLimit,
  checkAuth
};