const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
};

const checkAuth = (req, res, next) => {
  if (req.isAuthenticated()) {
    res.json({ 
      isAuthenticated: true, 
      user: { 
        email: req.user.email, 
        name: req.user.name 
      } 
    });
  } else {
    res.json({ isAuthenticated: false });
  }
};

module.exports = {
  requireAuth,
  checkAuth
};