const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const router = express.Router();

// Generate JWT Token
function generateToken(user) {
  return jwt.sign(
    { 
      id: user._id, 
      email: user.email,
      name: user.name 
    },
    process.env.SESSION_SECRET,
    { expiresIn: '7d' }
  );
}

// Google OAuth login
router.get('/google',
  (req, res, next) => {
    console.log('🔵 Google OAuth initiated');
    next();
  },
  passport.authenticate('google', { 
    scope: ['profile', 'email'],
    prompt: 'select_account'
  })
);

// Google OAuth callback
router.get('/google/callback',
  (req, res, next) => {
    console.log('🔵 Google callback received');
    console.log('Query params:', req.query);
    next();
  },
  passport.authenticate('google', { 
    failureRedirect: `${process.env.FRONTEND_URL}/login?error=auth_failed`,
    session: false
  }),
  (req, res) => {
    try {
      console.log('🟢 Google authentication successful');
      console.log('User:', req.user?.email);

      if (!req.user) {
        console.log('❌ No user object found');
        return res.redirect(`${process.env.FRONTEND_URL}/login?error=no_user`);
      }

      // Check domain restriction
      if (!req.user.email.endsWith('@gncgroup.ca')) {
        console.log('❌ Domain not allowed:', req.user.email);
        return res.redirect(`${process.env.FRONTEND_URL}/login?error=domain_not_allowed`);
      }

      // Generate JWT token
      const token = generateToken(req.user);
      console.log('✅ JWT token generated');
      console.log('Token length:', token.length);

      const redirectUrl = `${process.env.FRONTEND_URL}/auth/callback?token=${token}`;
      console.log('🔄 Redirecting to:', redirectUrl);

      res.redirect(redirectUrl);
    } catch (error) {
      console.error('❌ OAuth callback error:', error);
      res.redirect(`${process.env.FRONTEND_URL}/login?error=callback_failed`);
    }
  }
);

// Check auth status
router.get('/status', (req, res) => {
  const authHeader = req.headers.authorization;
  
  console.log('🔍 Auth status check');
  console.log('Authorization header:', authHeader ? 'Present' : 'Missing');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('❌ No valid auth header');
    return res.json({ isAuthenticated: false });
  }

  const token = authHeader.split(' ')[1];
  console.log('Token received, length:', token.length);

  try {
    const decoded = jwt.verify(token, process.env.SESSION_SECRET);
    console.log('✅ Token valid for user:', decoded.email);
    res.json({ 
      isAuthenticated: true,
      user: {
        email: decoded.email,
        name: decoded.name,
        id: decoded.id
      }
    });
  } catch (error) {
    console.log('❌ Token verification failed:', error.message);
    res.json({ isAuthenticated: false });
  }
});

// Logout
router.post('/logout', (req, res) => {
  console.log('👋 User logged out');
  res.json({ 
    success: true,
    message: 'Logged out successfully' 
  });
});

module.exports = router;