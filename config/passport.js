const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');

// Use environment-specific callback URL
const callbackURL = process.env.NODE_ENV === 'production' 
  ? `${process.env.BACKEND_URL}/api/auth/google/callback`
  : '/api/auth/google/callback';

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: callbackURL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    
    // Check if email is from allowed domain
    if (!email.endsWith('@gncgroup.ca')) {
      return done(null, false, { message: 'domain_not_allowed' });
    }
    
    // Find or create user
    let user = await User.findOne({ googleId: profile.id });
    
    if (!user) {
      user = await User.create({
        googleId: profile.id,
        email: email,
        name: profile.displayName,
        profilePicture: profile.photos?.[0]?.value,
        lastLogin: new Date()
      });
    } else {
      // Update last login
      user.lastLogin = new Date();
      await user.save();
    }
    
    return done(null, user);
  } catch (error) {
    return done(error, null);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});