const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');

// IMPORTANT: Always use absolute backend URL for Google callback
const callbackURL = `${process.env.BACKEND_URL}/api/auth/google/callback`;

console.log('Google OAuth Callback URL:', callbackURL);

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: callbackURL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    
    console.log('Google OAuth - Email received:', email);
    
    // Check if email is from allowed domain
    if (!email.endsWith('@gncgroup.ca')) {
      console.log('Domain not allowed:', email);
      return done(null, false, { message: 'domain_not_allowed' });
    }
    
    // Find or create user
    let user = await User.findOne({ googleId: profile.id });
    
    if (!user) {
      console.log('Creating new user:', email);
      user = await User.create({
        googleId: profile.id,
        email: email,
        name: profile.displayName,
        profilePicture: profile.photos?.[0]?.value,
        lastLogin: new Date()
      });
    } else {
      console.log('Existing user logged in:', email);
      user.lastLogin = new Date();
      await user.save();
    }
    
    return done(null, user);
  } catch (error) {
    console.error('Passport Google Strategy Error:', error);
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