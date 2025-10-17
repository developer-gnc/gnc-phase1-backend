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
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ 
        error: 'Authentication failed',
        message: 'User not found' 
      });
    }

    if (!user.email.endsWith('@gncgroup.ca')) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'Domain not allowed' 
      });
    }

    req.user = user;
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

const checkAuth = (req, res, next) => {
  res.json({ isAuthenticated: false });
};

module.exports = {
  requireAuth,
  checkAuth
};